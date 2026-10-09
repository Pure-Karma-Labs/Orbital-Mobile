#import "OrbitalMediaExport.h"

#import <Photos/Photos.h>
#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include <errno.h>
#include <sys/clonefile.h>
#include <unistd.h>

/**
 * Error codes. Reject MESSAGES are fixed, non-identifying phrases — never a
 * path, a filename, a media id or an OS error string. index.tsx ignores the
 * message entirely (MediaExportError has no message parameter), so these exist
 * only for a native stack trace.
 *
 * REQUIRED-REASON APIs: this file calls NONE. No -attributesOfItemAtPath:,
 * NSFileSize, NSFileCreationDate/NSFileModificationDate, getattrlist,
 * statfs/statvfs, NSFileSystemFreeSize, volumeAvailableCapacity,
 * NSUserDefaults, or stat/fstat/lstat. Size, existence and free-space checks
 * live in JS (RNFS), which keeps ios/OrbitalMobile/PrivacyInfo.xcprivacy
 * unchanged by construction. The `media-export-native-pins` rule in
 * scripts/check-security-invariants.mjs enforces that.
 */
static NSString *const kOMEErrPermission = @"EPERMISSION";
static NSString *const kOMEErrUnsupported = @"EUNSUPPORTED";
static NSString *const kOMEErrNoSpace = @"ENOSPC";
static NSString *const kOMEErrNotFound = @"ENOENT";
static NSString *const kOMEErrCancelled = @"ECANCELLED";
static NSString *const kOMEErrExport = @"EEXPORT";
static NSString *const kOMEErrInvalidName = @"EINVALIDNAME";

/** Permission strings; narrowed by index.tsx, so these are a contract. */
static NSString *const kOMEPermGranted = @"granted";
static NSString *const kOMEPermDenied = @"denied";
static NSString *const kOMEPermRestricted = @"restricted";
static NSString *const kOMEPermNotDetermined = @"notDetermined";

/** exportFiles resolutions; narrowed by index.tsx. */
static NSString *const kOMEResultSaved = @"saved";
static NSString *const kOMEResultCancelled = @"cancelled";

/**
 * Per-call staging lives under Caches/orbital-export/<uuid>/. Documented as the
 * one exception to the staging LOCATION INVARIANT in
 * src/services/media/stagingResidue.ts, swept whole-directory by localWipe and
 * by the bootstrap orphan GC, and deleted here on every settle path.
 */
static NSString *const kOMEStagingDirName = @"orbital-export";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * C0/DEL only, deliberately NOT -controlCharacterSet (which is Cc + Cf and so
 * also matches ZWJ — a legitimate character in an emoji filename).
 */
static BOOL OMEHasControlCharacter(NSString *name)
{
  for (NSUInteger i = 0; i < name.length; i++) {
    unichar c = [name characterAtIndex:i];
    if (c < 0x20 || c == 0x7f) {
      return YES;
    }
  }
  return NO;
}

/**
 * Re-validate a display name natively. The service produces these names from a
 * closed extension map, but this module must not trust its caller: a name that
 * escapes the staging directory would turn an export into an arbitrary write.
 *
 * Rejects: empty, absolute, containing `/` or `\` or `..`, a leading dot
 * (hidden files, `.` and `..`), control characters (NUL terminates a C path
 * early), and anything past the HFS+/APFS 255-character component limit.
 */
static BOOL OMEIsValidDisplayName(NSString *_Nullable name)
{
  if (![name isKindOfClass:[NSString class]] || name.length == 0 || name.length > 255) {
    return NO;
  }
  if ([name hasPrefix:@"/"] || [name hasPrefix:@"."]) {
    return NO;
  }
  if ([name containsString:@"/"] || [name containsString:@"\\"] || [name containsString:@".."]) {
    return NO;
  }
  return !OMEHasControlCharacter(name);
}

static BOOL OMEIsUsablePath(NSString *_Nullable path)
{
  return [path isKindOfClass:[NSString class]] && [path hasPrefix:@"/"];
}

static NSString *OMEStagingRoot(void)
{
  NSString *caches =
      NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  return [caches stringByAppendingPathComponent:kOMEStagingDirName];
}

static void OMERemoveItem(NSString *_Nullable path)
{
  if (path.length == 0) {
    return;
  }
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
}

static BOOL OMEIsOutOfSpace(NSError *_Nullable error)
{
  if (error == nil) {
    return NO;
  }
  if ([error.domain isEqualToString:NSPOSIXErrorDomain] &&
      (error.code == ENOSPC || error.code == EDQUOT)) {
    return YES;
  }
  return [error.domain isEqualToString:NSCocoaErrorDomain] &&
      error.code == NSFileWriteOutOfSpaceError;
}

static BOOL OMEIsMissingFile(NSError *_Nullable error)
{
  if (error == nil) {
    return NO;
  }
  if ([error.domain isEqualToString:NSPOSIXErrorDomain] && error.code == ENOENT) {
    return YES;
  }
  return [error.domain isEqualToString:NSCocoaErrorDomain] &&
      (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError);
}

/** Map a PhotoKit (or wrapped POSIX/Cocoa) failure onto a MediaExportError code. */
static NSString *OMEPhotosErrorCode(NSError *_Nullable error)
{
  if (error == nil) {
    return kOMEErrExport;
  }
  if ([error.domain isEqualToString:PHPhotosErrorDomain]) {
    switch (error.code) {
      case PHPhotosErrorInvalidResource:
      case PHPhotosErrorChangeNotSupported:
      case PHPhotosErrorRequestNotSupportedForAsset:
        // "Photos will not take this file" — the service offers Save to Files.
        return kOMEErrUnsupported;
      case PHPhotosErrorNotEnoughSpace:
        return kOMEErrNoSpace;
      case PHPhotosErrorAccessRestricted:
      case PHPhotosErrorAccessUserDenied:
        return kOMEErrPermission;
      case PHPhotosErrorMissingResource:
        return kOMEErrNotFound;
      case PHPhotosErrorUserCancelled:
        return kOMEErrCancelled;
      default:
        break;
    }
  }
  NSError *underlying = error.userInfo[NSUnderlyingErrorKey];
  if (OMEIsOutOfSpace(error) || OMEIsOutOfSpace(underlying)) {
    return kOMEErrNoSpace;
  }
  if (OMEIsMissingFile(error) || OMEIsMissingFile(underlying)) {
    return kOMEErrNotFound;
  }
  return kOMEErrExport;
}

typedef NS_ENUM(NSInteger, OMEAliasOutcome) {
  OMEAliasOutcomeOK = 0,
  OMEAliasOutcomeMissingSource,
  OMEAliasOutcomeNoSpace,
  OMEAliasOutcomeFailed,
};

static NSString *OMEAliasOutcomeCode(OMEAliasOutcome outcome)
{
  switch (outcome) {
    case OMEAliasOutcomeMissingSource:
      return kOMEErrNotFound;
    case OMEAliasOutcomeNoSpace:
      return kOMEErrNoSpace;
    case OMEAliasOutcomeOK:
    case OMEAliasOutcomeFailed:
      break;
  }
  return kOMEErrExport;
}

/**
 * Make `destPath` refer to the same bytes as `sourcePath` WITHOUT copying
 * them, and without touching the source.
 *
 * 1. clonefile(2) — APFS copy-on-write; O(1), same volume, creates destPath.
 * 2. link(2) — a second directory entry for the same inode. (PhotoKit reads a
 *    hardlink fine; its documented hardlink caveat applies to moving a file
 *    into the library, which this module never does.)
 * 3. A byte copy, ONLY as a last resort. Never first: media is capped at 50 MB
 *    but a bulk export would otherwise write the whole batch twice.
 *
 * Both no-copy paths fail cleanly if the source is gone (ENOENT), which is how
 * a missing source is detected without ever calling a file-attributes API.
 */
static OMEAliasOutcome OMEAliasFile(NSString *sourcePath, NSString *destPath)
{
  const char *src = sourcePath.fileSystemRepresentation;
  const char *dst = destPath.fileSystemRepresentation;
  if (src == NULL || dst == NULL) {
    return OMEAliasOutcomeFailed;
  }

  if (clonefile(src, dst, 0) == 0) {
    return OMEAliasOutcomeOK;
  }
  const int cloneErrno = errno;

  if (link(src, dst) == 0) {
    return OMEAliasOutcomeOK;
  }
  const int linkErrno = errno;

  if (cloneErrno == ENOENT || linkErrno == ENOENT) {
    return OMEAliasOutcomeMissingSource;
  }
  if (cloneErrno == ENOSPC || cloneErrno == EDQUOT || linkErrno == ENOSPC || linkErrno == EDQUOT) {
    return OMEAliasOutcomeNoSpace;
  }

  NSError *copyError = nil;
  if ([[NSFileManager defaultManager] copyItemAtPath:sourcePath
                                              toPath:destPath
                                               error:&copyError]) {
    return OMEAliasOutcomeOK;
  }
  if (OMEIsOutOfSpace(copyError)) {
    return OMEAliasOutcomeNoSpace;
  }
  if (OMEIsMissingFile(copyError)) {
    return OMEAliasOutcomeMissingSource;
  }
  return OMEAliasOutcomeFailed;
}

static PHAssetResourceType OMEResourceTypeFor(NSString *_Nullable mimeType, UTType *_Nullable type)
{
  if ([mimeType.lowercaseString hasPrefix:@"video/"]) {
    return PHAssetResourceTypeVideo;
  }
  if (type != nil && [type conformsToType:UTTypeMovie]) {
    return PHAssetResourceTypeVideo;
  }
  return PHAssetResourceTypePhoto;
}

static NSString *OMEPermissionString(PHAuthorizationStatus status)
{
  switch (status) {
    case PHAuthorizationStatusAuthorized:
      return kOMEPermGranted;
    case PHAuthorizationStatusLimited:
      // Not reachable for add-only access, which has no "selected photos"
      // state. Mapped to granted defensively: a write still succeeds, and
      // treating it as denied would dead-end the user in Settings.
      return kOMEPermGranted;
    case PHAuthorizationStatusDenied:
      return kOMEPermDenied;
    case PHAuthorizationStatusRestricted:
      return kOMEPermRestricted;
    case PHAuthorizationStatusNotDetermined:
      return kOMEPermNotDetermined;
  }
  return kOMEPermDenied;
}

// ---------------------------------------------------------------------------
// Document-picker session
// ---------------------------------------------------------------------------

/**
 * One in-flight document export. The module RETAINS this object: the picker
 * holds its delegate weakly, so without an owning reference the delegate would
 * be deallocated the moment -exportFiles: returned and the promise could never
 * settle (the #1 failure mode of hand-rolled picker bridges).
 *
 * The promise settles EXACTLY ONCE, from whichever of these arrives first:
 *   - -documentPicker:didPickDocumentsAtURLs:  (user chose a destination)
 *   - -documentPickerWasCancelled:             (user tapped Cancel)
 *   - -presentationControllerDidDismiss:       (user swiped the sheet down)
 *   - -[OrbitalMediaExport invalidate]         (module teardown)
 *   - a presentation that cannot be attempted  (no presenter)
 * The first three regularly arrive in pairs (a pick dismisses the sheet), which
 * is why settle-once is a flag and not a comment.
 *
 * Every settle path deletes the per-call staging directory.
 */
@interface OMEExportSession : NSObject <UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate>
@property (nonatomic, weak, nullable) UIDocumentPickerViewController *picker;
/**
 * `onSettle` takes the session as an ARGUMENT rather than capturing it: a
 * block that captured `session` would be retained by the session it retains,
 * and the module's reference would outlive the export.
 */
- (instancetype)initWithStagingDir:(NSString *)stagingDir
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
                          onSettle:(void (^)(OMEExportSession *settled))onSettle;
- (void)settleSaved;
- (void)settleCancelled;
- (void)settleFailedWithCode:(NSString *)code;
@end

@implementation OMEExportSession {
  NSString *_stagingDir;
  RCTPromiseResolveBlock _resolve;
  RCTPromiseRejectBlock _reject;
  void (^_onSettle)(OMEExportSession *);
  BOOL _settled;
}

- (instancetype)initWithStagingDir:(NSString *)stagingDir
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject
                          onSettle:(void (^)(OMEExportSession *settled))onSettle
{
  if (self = [super init]) {
    _stagingDir = [stagingDir copy];
    _resolve = [resolve copy];
    _reject = [reject copy];
    _onSettle = [onSettle copy];
    _settled = NO;
  }
  return self;
}

- (void)settleSaved
{
  [self settleWithResult:kOMEResultSaved code:nil];
}

- (void)settleCancelled
{
  [self settleWithResult:kOMEResultCancelled code:nil];
}

- (void)settleFailedWithCode:(NSString *)code
{
  [self settleWithResult:nil code:code];
}

- (void)settleWithResult:(nullable NSString *)result code:(nullable NSString *)code
{
  RCTPromiseResolveBlock resolve = nil;
  RCTPromiseRejectBlock reject = nil;
  NSString *stagingDir = nil;
  void (^onSettle)(OMEExportSession *) = nil;

  // @synchronized, not main-queue confinement: -invalidate may settle from the
  // JS thread while a delegate callback settles from the main thread.
  @synchronized(self) {
    if (_settled) {
      return;
    }
    _settled = YES;
    resolve = _resolve;
    reject = _reject;
    stagingDir = _stagingDir;
    onSettle = _onSettle;
    _resolve = nil;
    _reject = nil;
    _onSettle = nil;
    _stagingDir = nil;
  }

  // asCopy:YES means the picker has finished copying by the time it reports a
  // pick, so the aliases are safe to unlink on every path.
  OMERemoveItem(stagingDir);

  if (result != nil && resolve != nil) {
    resolve(result);
  } else if (reject != nil) {
    reject(code ?: kOMEErrExport, @"export failed", nil);
  }
  if (onSettle != nil) {
    onSettle(self);
  }
}

#pragma mark - UIDocumentPickerDelegate

- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls
{
  [self settleSaved];
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller
{
  [self settleCancelled];
}

#pragma mark - UIAdaptivePresentationControllerDelegate

- (void)presentationControllerDidDismiss:(UIPresentationController *)presentationController
{
  // Swipe-to-dismiss does NOT call -documentPickerWasCancelled:.
  [self settleCancelled];
}

@end

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

@implementation OrbitalMediaExport {
  dispatch_queue_t _queue;
  /** Guarded by @synchronized(self). At most one picker at a time. */
  OMEExportSession *_session;
  BOOL _invalidated;
}

RCT_EXPORT_MODULE()

- (instancetype)init
{
  if (self = [super init]) {
    _queue = dispatch_queue_create("org.orbitl.mediaexport", DISPATCH_QUEUE_SERIAL);
    _session = nil;
    _invalidated = NO;
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeOrbitalMediaExportSpecJSI>(params);
}

- (BOOL)isInvalidated
{
  @synchronized(self) {
    return _invalidated;
  }
}

#pragma mark - Lifecycle

/**
 * Module teardown. An outstanding picker owns the only reference to a pending
 * promise, so it is settled here with ECANCELLED (which the service already
 * treats as "user backed out") and the sheet is dismissed. Without this, a
 * Fast Refresh mid-export leaves a modal on screen over a dead runtime.
 *
 * The promise is settled on THIS thread — settling needs no main queue, and a
 * dispatch_sync onto the main queue from the JS thread during teardown is a
 * deadlock the transcoder (#726) taught us not to write. Only the dismissal
 * hops to the main queue, which may therefore land after the runtime is gone;
 * that is a UIKit no-op on a detached view controller.
 *
 * No [super invalidate]: the generated spec base is a bare NSObject.
 */
- (void)invalidate
{
  OMEExportSession *session = nil;
  @synchronized(self) {
    _invalidated = YES;
    session = _session;
    _session = nil;
  }
  if (session == nil) {
    return;
  }
  [session settleFailedWithCode:kOMEErrCancelled];
  dispatch_async(dispatch_get_main_queue(), ^{
    UIDocumentPickerViewController *picker = session.picker;
    if (picker != nil) {
      [picker dismissViewControllerAnimated:NO completion:nil];
    }
  });
}

#pragma mark - Permissions

- (void)getPhotoAddPermission:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
{
  PHAuthorizationStatus status = [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelAddOnly];
  resolve(OMEPermissionString(status));
}

- (void)requestPhotoAddPermission:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject
{
  // Add-only: the system prompt says "Add to Photos", there is no library
  // read, no album, and no limited-selection picker. NSPhotoLibraryAddUsageDescription
  // is the only usage string this path needs.
  [PHPhotoLibrary requestAuthorizationForAccessLevel:PHAccessLevelAddOnly handler:^(PHAuthorizationStatus status) {
    resolve(OMEPermissionString(status));
  }];
}

#pragma mark - saveToPhotoLibrary

- (void)saveToPhotoLibrary:(NSString *)sourcePath
                  mimeType:(NSString *)mimeType
               displayName:(NSString *)displayName
               createdAtMs:(double)createdAtMs
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  if (!OMEIsValidDisplayName(displayName)) {
    reject(kOMEErrInvalidName, @"invalid export filename", nil);
    return;
  }
  if (!OMEIsUsablePath(sourcePath)) {
    reject(kOMEErrNotFound, @"source unavailable", nil);
    return;
  }
  if ([self isInvalidated]) {
    reject(kOMEErrCancelled, @"module invalidated", nil);
    return;
  }

  PHAuthorizationStatus status = [PHPhotoLibrary authorizationStatusForAccessLevel:PHAccessLevelAddOnly];
  if (status != PHAuthorizationStatusAuthorized && status != PHAuthorizationStatusLimited) {
    // The service requests permission before it downloads, so reaching here
    // means a revoke between then and now.
    reject(kOMEErrPermission, @"photo library add access not granted", nil);
    return;
  }

  NSString *const source = [sourcePath copy];
  NSString *const name = [displayName copy];
  NSString *const mime = [mimeType copy];

  dispatch_async(_queue, ^{
    // UTType(mimeType:) is nil for an unknown type. Nil-safe by design: the
    // resource UTI is simply omitted and PhotoKit infers it from the alias
    // extension, which comes from the service's closed extension map.
    UTType *type = mime.length > 0 ? [UTType typeWithMIMEType:mime] : nil;

    NSString *stagingDir = nil;
    NSURL *resourceURL = nil;

    // Alias ONLY when the on-disk extension disagrees with the name we are
    // about to hand Photos. MEDIA_DIR extensions come from the sender's
    // file_name and are therefore unreliable (a .jpg that is really HEIC).
    NSString *sourceExt = source.pathExtension.lowercaseString;
    NSString *wantedExt = name.pathExtension.lowercaseString;
    if (wantedExt.length == 0) {
      wantedExt = type.preferredFilenameExtension.lowercaseString ?: sourceExt;
    }

    if (![sourceExt isEqualToString:wantedExt]) {
      stagingDir = [OMEStagingRoot() stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
      NSError *dirError = nil;
      if (![[NSFileManager defaultManager] createDirectoryAtPath:stagingDir
                                    withIntermediateDirectories:YES
                                                     attributes:nil
                                                          error:&dirError]) {
        OMERemoveItem(stagingDir);
        reject(OMEIsOutOfSpace(dirError) ? kOMEErrNoSpace : kOMEErrExport, @"staging failed", nil);
        return;
      }
      NSString *aliasPath = [stagingDir stringByAppendingPathComponent:name];
      OMEAliasOutcome outcome = OMEAliasFile(source, aliasPath);
      if (outcome != OMEAliasOutcomeOK) {
        OMERemoveItem(stagingDir);
        reject(OMEAliasOutcomeCode(outcome), @"staging failed", nil);
        return;
      }
      resourceURL = [NSURL fileURLWithPath:aliasPath];
    } else {
      resourceURL = [NSURL fileURLWithPath:source];
    }

    PHAssetResourceCreationOptions *options = [PHAssetResourceCreationOptions new];
    options.originalFilename = name;
    if (type != nil) {
      options.uniformTypeIdentifier = type.identifier;
    }
    // The source file is the app's durable archive (the server may evict it
    // after confirmArchived), so the asset is created from a COPY of the
    // bytes. Nothing here moves or unlinks the source.

    PHAssetResourceType resourceType = OMEResourceTypeFor(mime, type);
    NSDate *creationDate =
        createdAtMs > 0 ? [NSDate dateWithTimeIntervalSince1970:createdAtMs / 1000.0] : nil;

    NSString *const stagingToClean = stagingDir;
    [[PHPhotoLibrary sharedPhotoLibrary] performChanges:^{
      PHAssetCreationRequest *request = [PHAssetCreationRequest creationRequestForAsset];
      if (creationDate != nil) {
        // Saved items keep their post date (plan §Open calls 3).
        request.creationDate = creationDate;
      }
      [request addResourceWithType:resourceType fileURL:resourceURL options:options];
    } completionHandler:^(BOOL success, NSError *error) {
      OMERemoveItem(stagingToClean);
      if (success) {
        resolve(nil);
      } else {
        reject(OMEPhotosErrorCode(error), @"photo library write failed", nil);
      }
    }];
  });
}

#pragma mark - exportFiles

- (void)exportFiles:(NSArray *)items
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  if (items.count == 0) {
    reject(kOMEErrExport, @"nothing to export", nil);
    return;
  }

  // Validate EVERYTHING before creating any directory: a batch that cannot be
  // fully staged must leave no residue at all.
  NSMutableArray<NSString *> *sources = [NSMutableArray arrayWithCapacity:items.count];
  NSMutableArray<NSString *> *names = [NSMutableArray arrayWithCapacity:items.count];
  for (id entry in items) {
    if (![entry isKindOfClass:[NSDictionary class]]) {
      reject(kOMEErrExport, @"malformed export item", nil);
      return;
    }
    NSDictionary *item = (NSDictionary *)entry;
    NSString *path = item[@"sourcePath"];
    NSString *name = item[@"displayName"];
    if (!OMEIsValidDisplayName(name)) {
      reject(kOMEErrInvalidName, @"invalid export filename", nil);
      return;
    }
    if (!OMEIsUsablePath(path)) {
      reject(kOMEErrNotFound, @"source unavailable", nil);
      return;
    }
    [sources addObject:path];
    [names addObject:name];
  }

  @synchronized(self) {
    if (_invalidated) {
      reject(kOMEErrCancelled, @"module invalidated", nil);
      return;
    }
    if (_session != nil) {
      // One picker at a time. The bulk runner serializes native writes in JS,
      // so this is a programming error, not a race to recover from.
      reject(kOMEErrExport, @"an export is already in progress", nil);
      return;
    }
  }

  dispatch_async(_queue, ^{
    NSString *stagingDir =
        [OMEStagingRoot() stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
    NSMutableArray<NSURL *> *urls = [NSMutableArray arrayWithCapacity:sources.count];

    for (NSUInteger i = 0; i < sources.count; i++) {
      // One sub-directory per item: the picker shows displayName verbatim, and
      // two items may legitimately share a name.
      NSString *itemDir =
          [stagingDir stringByAppendingPathComponent:[NSString stringWithFormat:@"%lu", (unsigned long)i]];
      NSError *dirError = nil;
      if (![[NSFileManager defaultManager] createDirectoryAtPath:itemDir
                                    withIntermediateDirectories:YES
                                                     attributes:nil
                                                          error:&dirError]) {
        OMERemoveItem(stagingDir);
        reject(OMEIsOutOfSpace(dirError) ? kOMEErrNoSpace : kOMEErrExport, @"staging failed", nil);
        return;
      }
      NSString *aliasPath = [itemDir stringByAppendingPathComponent:names[i]];
      OMEAliasOutcome outcome = OMEAliasFile(sources[i], aliasPath);
      if (outcome != OMEAliasOutcomeOK) {
        OMERemoveItem(stagingDir);
        reject(OMEAliasOutcomeCode(outcome), @"staging failed", nil);
        return;
      }
      [urls addObject:[NSURL fileURLWithPath:aliasPath]];
    }

    __weak OrbitalMediaExport *weakSelf = self;
    OMEExportSession *session = [[OMEExportSession alloc] initWithStagingDir:stagingDir
                                                                    resolve:resolve
                                                                     reject:reject
                                                                   onSettle:^(OMEExportSession *settled) {
      // Drop the module's reference so a later export can run. Weak capture:
      // the module must not be kept alive by its own session.
      [weakSelf clearSession:settled];
    }];

    // Decide under the lock, settle OUTSIDE it: -settle… calls back into
    // -clearSession:, which takes this same lock, and settling while holding
    // it would invert the lock order against a delegate callback on the main
    // thread.
    NSString *rejectCode = nil;
    @synchronized(self) {
      if (self->_invalidated) {
        rejectCode = kOMEErrCancelled;
      } else if (self->_session != nil) {
        rejectCode = kOMEErrExport;
      } else {
        self->_session = session;
      }
    }
    if (rejectCode != nil) {
      [session settleFailedWithCode:rejectCode];
      return;
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      [self presentPickerForURLs:urls session:session];
    });
  });
}

/** Main queue only. */
- (void)presentPickerForURLs:(NSArray<NSURL *> *)urls session:(OMEExportSession *)session
{
  // asCopy:YES: the picker copies our aliases to the chosen destination and
  // leaves them to us to unlink. asCopy:NO would hand the file itself to the
  // destination provider (including third-party File Providers) and can MOVE
  // it — unacceptable for files that live under MEDIA_DIR.
  UIDocumentPickerViewController *picker =
      [[UIDocumentPickerViewController alloc] initForExportingURLs:urls asCopy:YES];
  picker.delegate = session;
  // Set before AND after presentation: before presenting, -presentationController
  // is created on demand for the sheet style and is the swipe-to-dismiss hook;
  // re-setting it in the completion block guarantees it on the controller UIKit
  // actually installed.
  picker.presentationController.delegate = session;
  session.picker = picker;

  UIViewController *presenter = RCTPresentedViewController();
  // Reject rather than hang. -presentViewController: has no failure callback,
  // so an un-presentable state must be detected here: with no presenter, or a
  // presenter that is already presenting or on its way out, UIKit drops the
  // request on the floor and no delegate callback ever arrives.
  if (presenter == nil || presenter.isBeingDismissed || presenter.presentedViewController != nil) {
    [session settleFailedWithCode:kOMEErrCancelled];
    return;
  }
  [presenter presentViewController:picker
                         animated:YES
                       completion:^{
                         picker.presentationController.delegate = session;
                       }];
}

- (void)clearSession:(OMEExportSession *)session
{
  @synchronized(self) {
    if (_session == session) {
      _session = nil;
    }
  }
}

@end
