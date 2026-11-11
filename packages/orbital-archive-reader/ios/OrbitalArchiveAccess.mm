#import "OrbitalArchiveAccess.h"

#import <React/RCTUtils.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/**
 * Error codes. These strings ARE the contract: `GLUE_ERROR_CODES` in
 * src/index.tsx accepts exactly this set and normalises anything else to
 * `ARCHIVE_INTERNAL`.
 *
 * `ARCHIVE_NOT_SEEKABLE` is deliberately absent: on iOS every part is a
 * regular file opened by path, so the pipe case that code exists for (an
 * Android MTP document) cannot arise here. Rust still raises it from `adopt`
 * if an fd ever turns out not to be a regular file.
 *
 * Reject MESSAGES are fixed, non-identifying phrases. This file never puts a
 * path, a file name, a bookmark, a URL or an OS error string into a rejection,
 * and it emits NO diagnostics of any kind — no logging call, no print, no
 * exception. The archive is user data from another service and every byte of
 * it, including its names, stays out of crash reports and breadcrumbs.
 *
 * ONE rejection carries a detail, and it is a single NUMBER: an
 * `ARCHIVE_ACCESS_LOST` from `openParts` rejects with an NSError in
 * `kOAAErrorDomain` whose userInfo holds exactly the key `partIndex`, the
 * zero-based index of the failing part. No other code passes an NSError at
 * all, and no other key is ever put in one — `index.tsx` reads `partIndex`
 * only for that code, so a stray key could not widen the contract, but the
 * discipline is the point. `ArchiveReaderError.partIndex` in src/index.tsx
 * documents the index space for both platforms and for Rust.
 */
static NSString *const kOAAErrPickerBusy = @"PICKER_BUSY";
static NSString *const kOAAErrAccessLost = @"ARCHIVE_ACCESS_LOST";
static NSString *const kOAAErrStagingUnavailable = @"ARCHIVE_STAGING_UNAVAILABLE";
static NSString *const kOAAErrNoSpace = @"ARCHIVE_NO_SPACE";
static NSString *const kOAAErrCancelled = @"ECANCELLED";
static NSString *const kOAAErrInternal = @"ARCHIVE_INTERNAL";

/**
 * The NSError domain for the one rejection that carries a detail.
 *
 * Its own domain, not NSCocoaErrorDomain or RN's: the only NSError this file
 * ever builds exists to transport `partIndex`, and a domain of our own means
 * nothing downstream can mistake it for a system error whose userInfo might
 * hold a path. The error's own `code` is 0 and unused — the STRING code is the
 * contract.
 */
static NSString *const kOAAErrorDomain = @"OrbitalArchiveAccess";

/** The ONLY userInfo key this module produces. A count, never a name. */
static NSString *const kOAAPartIndexKey = @"partIndex";

/**
 * Staging leaf suffix. Rust validates `<uuid>-archive-staging.bin` and keys its
 * live-staging ledger on the lower-cased leaf; `isStagingResidueName` in
 * src/services/media/stagingResidue.ts matches the same suffix at the Caches
 * top level, which is what makes localWipe and the orphan reaper sweep these
 * files without knowing this module exists.
 */
static NSString *const kOAAStagingSuffix = @"-archive-staging.bin";

/** Canonical UUID group lengths, 8-4-4-4-12. */
static const NSUInteger kOAAUuidGroups[5] = {8, 4, 4, 4, 12};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A fixed phrase per code. Never interpolated; never derived from input. */
static NSString *OAAMessageForCode(NSString *code)
{
  if ([code isEqualToString:kOAAErrPickerBusy]) {
    return @"a file picker is already open";
  }
  if ([code isEqualToString:kOAAErrAccessLost]) {
    return @"archive access lost";
  }
  if ([code isEqualToString:kOAAErrStagingUnavailable]) {
    return @"staging unavailable";
  }
  if ([code isEqualToString:kOAAErrNoSpace]) {
    return @"not enough space";
  }
  if ([code isEqualToString:kOAAErrCancelled]) {
    return @"cancelled";
  }
  return @"archive access failed";
}

/**
 * The directory `createStagingFile` writes into, with symlinks resolved the
 * same way Rust resolves them.
 *
 * Rust canonicalises this directory once per session and canonicalises every
 * staging path's parent before opening it, then requires the two to be EQUAL
 * (rust/orbital_archive_reader/src/staging.rs). `std::fs::canonicalize` is
 * `realpath(3)` on Unix, so realpath(3) is used here rather than
 * -stringByResolvingSymlinksInPath, which strips a leading `/private` and
 * would hand back `/var/...` where Rust produces `/private/var/...`. Resolving
 * both sides identically means the comparison does not depend on Rust
 * canonicalising our string a second time.
 *
 * Caches, not tmp: localWipe's suffix sweep and the bootstrap orphan GC both
 * run over the Caches top level.
 */
static NSString *OAAStagingDirectory(void)
{
  static NSString *cached = nil;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    NSString *caches =
        NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
    if (caches.length == 0) {
      return;
    }
    const char *raw = caches.fileSystemRepresentation;
    char resolved[PATH_MAX];
    if (raw != NULL && realpath(raw, resolved) != NULL) {
      cached = [[NSFileManager defaultManager] stringWithFileSystemRepresentation:resolved
                                                                          length:strlen(resolved)];
    } else {
      // Caches always exists, so this is unreachable in practice. Falling back
      // to the unresolved path keeps the module usable: Rust canonicalises the
      // directory it is given, so the comparison still holds.
      cached = [caches copy];
    }
  });
  return cached;
}

/**
 * `true` for exactly `<lower-case canonical UUID>-archive-staging.bin`.
 *
 * Stricter than Rust's `is_valid_staging_name` (which accepts either case):
 * this module only ever mints lower case, and `unlinkStagingFile` is the ONLY
 * delete it exposes, so the narrower rule is the one worth enforcing. The group
 * shape is checked, not just the length and alphabet — 36 dashes would
 * otherwise pass.
 */
static BOOL OAAIsStagingLeaf(NSString *_Nullable leaf)
{
  if (![leaf isKindOfClass:[NSString class]] || ![leaf hasSuffix:kOAAStagingSuffix]) {
    return NO;
  }
  NSString *uuid = [leaf substringToIndex:leaf.length - kOAAStagingSuffix.length];
  NSArray<NSString *> *groups = [uuid componentsSeparatedByString:@"-"];
  if (groups.count != 5) {
    return NO;
  }
  for (NSUInteger i = 0; i < 5; i++) {
    NSString *group = groups[i];
    if (group.length != kOAAUuidGroups[i]) {
      return NO;
    }
    for (NSUInteger j = 0; j < group.length; j++) {
      unichar c = [group characterAtIndex:j];
      if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) {
        return NO;
      }
    }
  }
  return YES;
}

/**
 * `"dev:ino"`, formatted to match Rust's `format!("{}:{}", meta.dev(),
 * meta.ino())` byte for byte — Rust compares the two strings and raises
 * `ReadFailed` on a mismatch, so a formatting difference would break every
 * open. `MetadataExt::dev()` is `st_dev as u64`; on Darwin `st_dev` is a
 * signed 32-bit value, and `as u64` sign-extends, so the cast chain here goes
 * through `long long` to reproduce that exactly.
 */
static NSString *OAAFileIdFromStat(const struct stat *st)
{
  return [NSString stringWithFormat:@"%llu:%llu", (unsigned long long)(long long)st->st_dev,
                                    (unsigned long long)st->st_ino];
}

static BOOL OAAIsOutOfSpace(NSError *_Nullable error)
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

/** A coordinated read that lost to -[NSFileCoordinator cancel]. */
static BOOL OAAIsCancellation(NSError *_Nullable error)
{
  return error != nil && [error.domain isEqualToString:NSCocoaErrorDomain] &&
      error.code == NSUserCancelledError;
}

// ---------------------------------------------------------------------------
// Picker session
// ---------------------------------------------------------------------------

/**
 * One in-flight pick. The module RETAINS it: the picker holds its delegate
 * weakly, so without an owning reference the delegate would be deallocated the
 * moment -pickArchiveParts: returned and the promise could never settle.
 *
 * The promise settles EXACTLY ONCE, from whichever of these arrives first:
 *   - -documentPicker:didPickDocumentsAtURLs:   (refs, after bookmarking)
 *   - -documentPickerWasCancelled:              (Cancel tapped)
 *   - -presentationControllerDidDismiss:        (sheet swiped down)
 *   - -[OrbitalArchiveAccess invalidate]        (module teardown)
 *   - a presentation that cannot be attempted   (no presenter)
 * The first three regularly arrive in pairs, which is why settle-once is a
 * flag and not a comment.
 *
 * A pick CLAIMS the settle synchronously on the main thread and then finishes
 * it on the module queue: bookmarking a File Provider URL can do I/O, and a
 * dismissal callback that arrived in the meantime must not turn a successful
 * pick into a cancellation. Teardown still overrides a claim — a claimed
 * settle that never lands would hang the promise forever.
 */
@interface OAAPickSession : NSObject <UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate>
@property (nonatomic, weak, nullable) UIDocumentPickerViewController *picker;
/**
 * `onSettle` takes the session as an ARGUMENT rather than capturing it: a block
 * that captured `session` would be retained by the session it retains, and the
 * module's reference would outlive the pick.
 */
- (instancetype)initWithQueue:(dispatch_queue_t)queue
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
                     onSettle:(void (^)(OAAPickSession *settled))onSettle;
- (void)settleCancelled;
- (void)settleFailedWithCode:(NSString *)code;
@end

@implementation OAAPickSession {
  dispatch_queue_t _queue;
  RCTPromiseResolveBlock _resolve;
  RCTPromiseRejectBlock _reject;
  void (^_onSettle)(OAAPickSession *);
  BOOL _settled;
  BOOL _claimed;
}

- (instancetype)initWithQueue:(dispatch_queue_t)queue
                      resolve:(RCTPromiseResolveBlock)resolve
                       reject:(RCTPromiseRejectBlock)reject
                     onSettle:(void (^)(OAAPickSession *settled))onSettle
{
  if (self = [super init]) {
    _queue = queue;
    _resolve = [resolve copy];
    _reject = [reject copy];
    _onSettle = [onSettle copy];
    _settled = NO;
    _claimed = NO;
  }
  return self;
}

/**
 * @synchronized, not main-queue confinement: -invalidate may settle from the
 * JS thread while a delegate callback settles from the main thread.
 */
- (void)finishWithRefs:(nullable NSArray<NSString *> *)refs code:(nullable NSString *)code
{
  RCTPromiseResolveBlock resolve = nil;
  RCTPromiseRejectBlock reject = nil;
  void (^onSettle)(OAAPickSession *) = nil;

  @synchronized(self) {
    if (_settled) {
      return;
    }
    _settled = YES;
    resolve = _resolve;
    reject = _reject;
    onSettle = _onSettle;
    _resolve = nil;
    _reject = nil;
    _onSettle = nil;
  }

  if (code != nil) {
    if (reject != nil) {
      reject(code, OAAMessageForCode(code), nil);
    }
  } else if (resolve != nil) {
    // nil refs resolves to JS null, which pickArchiveParts reads as "the user
    // cancelled".
    resolve(refs);
  }
  if (onSettle != nil) {
    onSettle(self);
  }
}

- (void)settleCancelled
{
  @synchronized(self) {
    if (_claimed) {
      // A pick already owns this settle and is bookmarking off the main
      // thread; the dismissal that follows a pick is not a cancellation.
      return;
    }
  }
  [self finishWithRefs:nil code:nil];
}

- (void)settleFailedWithCode:(NSString *)code
{
  [self finishWithRefs:nil code:code];
}

#pragma mark - UIDocumentPickerDelegate

- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls
{
  NSArray<NSURL *> *picked = [urls copy];
  if (picked.count == 0) {
    [self settleCancelled];
    return;
  }
  @synchronized(self) {
    if (_settled || _claimed) {
      return;
    }
    _claimed = YES;
  }

  dispatch_async(_queue, ^{
    NSMutableArray<NSString *> *refs = [NSMutableArray arrayWithCapacity:picked.count];
    for (NSURL *url in picked) {
      // One scope at a time: the per-process extension pool is small (~340),
      // and nothing here needs two parts open at once. The bookmark is what
      // carries access across the multi-select, this process's later
      // openParts, and a cold start.
      BOOL scoped = [url startAccessingSecurityScopedResource];
      NSData *bookmark = [url bookmarkDataWithOptions:0
                      includingResourceValuesForKeys:nil
                                       relativeToURL:nil
                                               error:NULL];
      if (scoped) {
        [url stopAccessingSecurityScopedResource];
      }
      if (bookmark.length == 0) {
        [self settleFailedWithCode:kOAAErrAccessLost];
        return;
      }
      [refs addObject:[bookmark base64EncodedStringWithOptions:0]];
    }
    [self finishWithRefs:refs code:nil];
  });
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

@implementation OrbitalArchiveAccess {
  /** Plan §5: one serial queue for every blocking file operation. */
  dispatch_queue_t _queue;
  /** All guarded by @synchronized(self). */
  OAAPickSession *_session;
  /** handleId -> open read descriptor. The glue owns these until closeParts. */
  NSMutableDictionary<NSString *, NSNumber *> *_fds;
  /** Coordinators of in-flight openParts calls, for cancelOpenParts. */
  NSMutableArray<NSFileCoordinator *> *_coordinators;
  BOOL _invalidated;
}

RCT_EXPORT_MODULE()

- (instancetype)init
{
  if (self = [super init]) {
    _queue = dispatch_queue_create("org.orbitl.archiveaccess", DISPATCH_QUEUE_SERIAL);
    _session = nil;
    _fds = [NSMutableDictionary dictionary];
    _coordinators = [NSMutableArray array];
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
  return std::make_shared<facebook::react::NativeOrbitalArchiveAccessSpecJSI>(params);
}

- (BOOL)isInvalidated
{
  @synchronized(self) {
    return _invalidated;
  }
}

#pragma mark - Lifecycle

/**
 * Module teardown: close every descriptor, cancel every coordinated read, and
 * settle a pending pick.
 *
 * The descriptors are the reason this module conforms to RCTInvalidating at
 * all. Rust holds only dups (F2), so closing ours here is always correct, and
 * a Fast Refresh that dropped the module without this would leak one
 * descriptor per part for the life of the process.
 *
 * Everything is done on THIS thread. Settling needs no main queue, and a
 * dispatch_sync onto the main queue from the JS thread during teardown is a
 * deadlock the transcoder (#726) taught us not to write. Only the dismissal
 * hops to the main queue, which may therefore land after the runtime is gone;
 * that is a no-op on a detached view controller.
 *
 * No [super invalidate]: the generated spec base is a bare NSObject.
 */
- (void)invalidate
{
  OAAPickSession *session = nil;
  NSArray<NSNumber *> *fds = nil;
  NSArray<NSFileCoordinator *> *coordinators = nil;
  @synchronized(self) {
    _invalidated = YES;
    session = _session;
    _session = nil;
    fds = _fds.allValues;
    [_fds removeAllObjects];
    coordinators = [_coordinators copy];
    [_coordinators removeAllObjects];
  }

  for (NSNumber *fd in fds) {
    close(fd.intValue);
  }
  for (NSFileCoordinator *coordinator in coordinators) {
    [coordinator cancel];
  }

  if (session == nil) {
    return;
  }
  [session settleFailedWithCode:kOAAErrCancelled];
  dispatch_async(dispatch_get_main_queue(), ^{
    UIDocumentPickerViewController *picker = session.picker;
    if (picker != nil) {
      [picker dismissViewControllerAnimated:NO completion:nil];
    }
  });
}

- (void)clearSession:(OAAPickSession *)session
{
  @synchronized(self) {
    if (_session == session) {
      _session = nil;
    }
  }
}

#pragma mark - pickArchiveParts

- (void)pickArchiveParts:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  __weak OrbitalArchiveAccess *weakSelf = self;
  OAAPickSession *session = [[OAAPickSession alloc] initWithQueue:_queue
                                                          resolve:resolve
                                                           reject:reject
                                                         onSettle:^(OAAPickSession *settled) {
    // Drop the module's reference so a later pick can run. Weak capture: the
    // module must not be kept alive by its own session.
    [weakSelf clearSession:settled];
  }];

  // Decide under the lock, settle OUTSIDE it: -settle… calls back into
  // -clearSession:, which takes this same lock, and settling while holding it
  // would invert the lock order against a delegate callback on the main thread.
  NSString *rejectCode = nil;
  @synchronized(self) {
    if (_invalidated) {
      rejectCode = kOAAErrCancelled;
    } else if (_session != nil) {
      rejectCode = kOAAErrPickerBusy;
    } else {
      _session = session;
    }
  }
  if (rejectCode != nil) {
    [session settleFailedWithCode:rejectCode];
    return;
  }

  dispatch_async(dispatch_get_main_queue(), ^{
    [self presentPickerForSession:session];
  });
}

/** Main queue only. */
- (void)presentPickerForSession:(OAAPickSession *)session
{
  // asCopy:NO — read the user's file in place. A copying picker would duplicate
  // a multi-gigabyte export into the app container before a single byte was
  // parsed, and would hand back a URL with no bookmark worth persisting, so a
  // cold-start resume would have to re-copy.
  UIDocumentPickerViewController *picker =
      [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[ UTTypeZIP ]
                                                                 asCopy:NO];
  picker.allowsMultipleSelection = YES;
  picker.delegate = session;
  // Set before AND after presentation: before presenting, -presentationController
  // is created on demand for the sheet style and is the swipe-to-dismiss hook;
  // re-setting it in the completion block guarantees it on the controller UIKit
  // actually installed.
  picker.presentationController.delegate = session;
  session.picker = picker;

  UIViewController *presenter = RCTPresentedViewController();
  // Settle rather than hang. -presentViewController: has no failure callback,
  // so an un-presentable state must be detected here: with no presenter, or a
  // presenter that is already presenting or on its way out, UIKit drops the
  // request on the floor and no delegate callback ever arrives.
  if (presenter == nil || presenter.isBeingDismissed || presenter.presentedViewController != nil) {
    [session settleFailedWithCode:kOAAErrCancelled];
    return;
  }
  [presenter presentViewController:picker
                         animated:YES
                       completion:^{
                         picker.presentationController.delegate = session;
                       }];
}

#pragma mark - openParts

/**
 * Open every ref and hand back one borrowed descriptor per part.
 *
 * Per part, in order (plan §5):
 *  1. resolve the bookmark, re-bookmarking if the platform says it is stale;
 *  2. start the security scope;
 *  3. coordinate a read with NSFileCoordinator — ACQUISITION ONLY. This is
 *     what materialises an evicted File Provider (iCloud Drive) file. The read
 *     itself happens later, in Rust, through a dup;
 *  4. inside the coordination block, open(O_RDONLY|O_CLOEXEC) and fstat;
 *  5. leave the block and stop the scope. The descriptor stays valid: the
 *     sandbox extension is consumed by the open, not held by the fd.
 *
 * On ANY failure every descriptor already opened FOR THIS CALL is closed before
 * the rejection, so the caller never has to close handles it was not given
 * (F2). Nothing is published into _fds until the whole batch has succeeded.
 */
- (void)openParts:(NSArray *)refs
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  if (![refs isKindOfClass:[NSArray class]] || refs.count == 0) {
    reject(kOAAErrInternal, OAAMessageForCode(kOAAErrInternal), nil);
    return;
  }
  NSMutableArray<NSString *> *encoded = [NSMutableArray arrayWithCapacity:refs.count];
  for (id ref in refs) {
    if (![ref isKindOfClass:[NSString class]] || ((NSString *)ref).length == 0) {
      reject(kOAAErrInternal, OAAMessageForCode(kOAAErrInternal), nil);
      return;
    }
    [encoded addObject:[(NSString *)ref copy]];
  }

  NSFileCoordinator *coordinator = [[NSFileCoordinator alloc] initWithFilePresenter:nil];
  @synchronized(self) {
    if (_invalidated) {
      reject(kOAAErrCancelled, OAAMessageForCode(kOAAErrCancelled), nil);
      return;
    }
    [_coordinators addObject:coordinator];
  }

  dispatch_async(_queue, ^{
    NSMutableArray<NSDictionary *> *handles = [NSMutableArray arrayWithCapacity:encoded.count];
    NSMutableArray<NSNumber *> *opened = [NSMutableArray arrayWithCapacity:encoded.count];
    NSString *failure = nil;

    for (NSString *ref in encoded) {
      NSString *refreshed = ref;
      int fd = -1;
      struct stat st;
      failure = [self openPart:ref coordinator:coordinator outRef:&refreshed outFd:&fd outStat:&st];
      if (failure != nil) {
        break;
      }
      NSString *handleId = [[NSUUID UUID] UUIDString];
      [opened addObject:@(fd)];
      [handles addObject:@{
        @"handleId" : handleId,
        @"fd" : @(fd),
        @"byteLength" : @((double)st.st_size),
        @"fileId" : OAAFileIdFromStat(&st),
        @"ref" : refreshed,
        // iOS has no persistable-grant concept; the bookmark IS the grant and
        // it needs no release. Android sets this when SAF granted one.
        @"persist" : @(NO),
      }];
    }

    BOOL invalidated = NO;
    @synchronized(self) {
      [self->_coordinators removeObjectIdenticalTo:coordinator];
      invalidated = self->_invalidated;
      if (failure == nil && !invalidated) {
        for (NSUInteger i = 0; i < handles.count; i++) {
          self->_fds[handles[i][@"handleId"]] = handles[i][@"fd"];
        }
      }
    }

    if (failure != nil || invalidated) {
      for (NSNumber *fd in opened) {
        close(fd.intValue);
      }
      NSString *code = failure ?: kOAAErrCancelled;
      // ACCESS_LOST is the one code that says WHICH part failed. Only a part
      // that opened is appended to `handles`, and the loop breaks on the first
      // failure, so handles.count IS the zero-based index of the failing ref in
      // the array JS passed. Every other code — including the invalidated
      // cancel, which is not a statement about a particular part — rejects with
      // nil, so no userInfo reaches JS that the contract does not name.
      //
      // The fixed phrase is still passed as `message`:
      // RCTJSErrorFromCodeMessageAndNSError prefers an explicit message over
      // the NSError's -localizedDescription, so the NSError is purely the
      // transport for the index and contributes no text.
      NSError *detail = nil;
      if ([code isEqualToString:kOAAErrAccessLost]) {
        detail = [NSError errorWithDomain:kOAAErrorDomain
                                     code:0
                                 userInfo:@{kOAAPartIndexKey : @(handles.count)}];
      }
      reject(code, OAAMessageForCode(code), detail);
      return;
    }
    resolve(handles);
  });
}

/**
 * One part. Returns nil on success, or the code to reject with.
 *
 * `outRef` starts out holding the incoming ref and is replaced only when the
 * platform handed back a renewed bookmark, which index.tsx re-encodes into the
 * token the caller persists.
 */
- (nullable NSString *)openPart:(NSString *)ref
                    coordinator:(NSFileCoordinator *)coordinator
                         outRef:(NSString *__strong *)outRef
                          outFd:(int *)outFd
                        outStat:(struct stat *)outStat
{
  NSData *bookmark = [[NSData alloc] initWithBase64EncodedString:ref options:0];
  if (bookmark.length == 0) {
    return kOAAErrAccessLost;
  }

  BOOL stale = NO;
  NSURL *url = [NSURL URLByResolvingBookmarkData:bookmark
                                         options:NSURLBookmarkResolutionWithoutUI
                                   relativeToURL:nil
                             bookmarkDataIsStale:&stale
                                           error:NULL];
  if (url == nil) {
    // NOT "the file was moved or deleted" — a security-scoped bookmark FOLLOWS
    // a move or a rename (that is what `stale` and the re-bookmark below are
    // for), and a Files "Delete" moves the file into Recently Deleted, where
    // the bookmark keeps resolving for up to 30 days. What actually lands here
    // is: the file was purged from Recently Deleted, its File Provider or
    // volume is gone (an unlinked iCloud account, an ejected external drive),
    // or the system refuses the resolution outright. A CONTENT change is not
    // this case at all — the bookmark still resolves and Rust's `fp`
    // fingerprint catches it as ARCHIVE_CHANGED.
    //
    // "Select the file again" is still the only answer, which is what
    // requires-repick means. The 30-day window is also why deleting the
    // PERSISTED TOKEN is iOS's only real revocation — see the token-revocation
    // invariant in the src/index.tsx header (section 4).
    return kOAAErrAccessLost;
  }

  BOOL scoped = [url startAccessingSecurityScopedResource];
  if (stale) {
    // Re-bookmark INSIDE the scope: without it the new bookmark would carry no
    // access. A failure here is not fatal — the resolved URL still works for
    // this call, and the caller keeps the old ref.
    NSData *fresh = [url bookmarkDataWithOptions:0
                  includingResourceValuesForKeys:nil
                                   relativeToURL:nil
                                           error:NULL];
    if (fresh.length > 0) {
      *outRef = [fresh base64EncodedStringWithOptions:0];
    }
  }

  __block int fd = -1;
  __block BOOL statOK = NO;
  __block struct stat st;
  memset(&st, 0, sizeof(st));

  NSError *coordError = nil;
  // options:0 — a plain coordinated read. NSFileCoordinatorReadingWithoutChanges
  // would skip the download an evicted iCloud file needs.
  [coordinator coordinateReadingItemAtURL:url
                                 options:0
                                   error:&coordError
                              byAccessor:^(NSURL *readURL) {
    const char *path = readURL.path.fileSystemRepresentation;
    if (path == NULL) {
      return;
    }
    // Read-only, close-on-exec. This module never opens anything for writing:
    // Rust writes the staging file, through a descriptor it opens itself.
    int opened = open(path, O_RDONLY | O_CLOEXEC);
    if (opened < 0) {
      return;
    }
    if (fstat(opened, &st) == 0 && S_ISREG(st.st_mode)) {
      fd = opened;
      statOK = YES;
      return;
    }
    close(opened);
  }];

  if (scoped) {
    [url stopAccessingSecurityScopedResource];
  }

  if (!statOK || fd < 0) {
    if (fd >= 0) {
      close(fd);
    }
    // A cancelled coordination is the cancelOpenParts path; everything else
    // (EPERM from a revoked extension, a vanished file, a provider error) is
    // access lost.
    return OAAIsCancellation(coordError) ? kOAAErrCancelled : kOAAErrAccessLost;
  }

  *outFd = fd;
  *outStat = st;
  return nil;
}

#pragma mark - closeParts / cancelOpenParts

/**
 * A real close(2), run INLINE on the calling thread rather than on _queue.
 *
 * JS calls this from a `finally` and treats it as done on return. More
 * importantly, _queue may be blocked for a long time inside a coordinated read
 * of an evicted iCloud file, and a close queued behind that would not run until
 * the read finished — which is exactly when the caller is trying to let go.
 * Idempotent; unknown ids are ignored.
 */
- (void)closeParts:(NSArray *)handleIds
{
  if (![handleIds isKindOfClass:[NSArray class]]) {
    return;
  }
  NSMutableArray<NSNumber *> *toClose = [NSMutableArray arrayWithCapacity:handleIds.count];
  @synchronized(self) {
    for (id handleId in handleIds) {
      if (![handleId isKindOfClass:[NSString class]]) {
        continue;
      }
      NSNumber *fd = _fds[(NSString *)handleId];
      if (fd != nil) {
        [toClose addObject:fd];
        [_fds removeObjectForKey:(NSString *)handleId];
      }
    }
  }
  for (NSNumber *fd in toClose) {
    close(fd.intValue);
  }
}

/**
 * Cancel every in-flight coordinated read. Inline, for the same reason as
 * closeParts: the queue it needs to interrupt is the blocked one.
 *
 * Never settles the caller's promise — the cancelled coordination rejects
 * openParts with ECANCELLED on its own.
 */
- (void)cancelOpenParts
{
  NSArray<NSFileCoordinator *> *coordinators = nil;
  @synchronized(self) {
    coordinators = [_coordinators copy];
  }
  for (NSFileCoordinator *coordinator in coordinators) {
    [coordinator cancel];
  }
}

#pragma mark - Staging

- (NSString *)getStagingDirectory
{
  // Synchronous, on the JS thread: openArchive must hand this to Rust before
  // any job starts. Cached after the first realpath(3), so this is a dictionary
  // read in the steady state.
  return OAAStagingDirectory() ?: @"";
}

- (void)createStagingFile:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  NSString *dir = OAAStagingDirectory();
  if (dir.length == 0) {
    reject(kOAAErrStagingUnavailable, OAAMessageForCode(kOAAErrStagingUnavailable), nil);
    return;
  }
  // LOWER CASE: Rust validates the leaf and keys its live-staging ledger on the
  // lower-cased leaf, and -[NSUUID UUIDString] is upper case.
  NSString *name = [[[[NSUUID UUID] UUIDString] lowercaseString]
      stringByAppendingString:kOAAStagingSuffix];
  NSString *path = [dir stringByAppendingPathComponent:name];

  dispatch_async(_queue, ^{
    NSFileManager *fm = [NSFileManager defaultManager];

    // EXCLUSIVE creation, in two parts. -createFileAtPath:contents:attributes:
    // OVERWRITES an existing file rather than failing (the one place plan §5's
    // wording is wrong), and the alternative — open(2) with O_CREAT|O_EXCL —
    // would need a write-mode descriptor, which this module must never hold.
    // So the existence check is explicit. It is a guard against a UUID
    // collision and against a leftover file from a previous run, not a security
    // boundary: the directory is inside the app container, where no other
    // process can plant anything.
    if ([fm fileExistsAtPath:path]) {
      reject(kOAAErrStagingUnavailable, OAAMessageForCode(kOAAErrStagingUnavailable), nil);
      return;
    }

    // NSFileProtectionCompleteUnlessOpen, not the app default: an extract keeps
    // this file open across a device lock, and the pipeline's default class
    // would make the next write fail while locked. The read side (the upload
    // loop) reopens per chunk, which is why smoke step 4 locks the device
    // between an extract and its upload — see the note at the end of this file.
    if (![fm createFileAtPath:path
                     contents:nil
                   attributes:@{NSFileProtectionKey : NSFileProtectionCompleteUnlessOpen}]) {
      unlink(path.fileSystemRepresentation);
      reject(kOAAErrStagingUnavailable, OAAMessageForCode(kOAAErrStagingUnavailable), nil);
      return;
    }

    NSError *excludeError = nil;
    NSURL *url = [NSURL fileURLWithPath:path];
    if (![url setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&excludeError]) {
      // Plaintext media from someone's data export must not travel to iCloud
      // Backup, so a file that cannot be excluded is not a file we will write
      // to. Unlink and fail.
      unlink(path.fileSystemRepresentation);
      NSString *code = OAAIsOutOfSpace(excludeError) ? kOAAErrNoSpace : kOAAErrStagingUnavailable;
      reject(code, OAAMessageForCode(code), nil);
      return;
    }

    resolve(path);
  });
}

/**
 * The ONLY delete this module exposes. Inline, so a `finally` can rely on it.
 *
 * Silently refuses anything that is not exactly
 * `<getStagingDirectory()>/<lower-case uuid>-archive-staging.bin`: the parent
 * must be string-equal to the staging directory (so `<dir>/./x` and any `..`
 * are refused along with every path outside it), and the leaf must be a
 * canonical UUID plus the suffix. unlink(2), not -removeItemAtPath:, so the
 * call can never recurse into a directory. Never throws for a path that is
 * already gone.
 */
- (void)unlinkStagingFile:(NSString *)path
{
  if (![path isKindOfClass:[NSString class]] || path.length == 0) {
    return;
  }
  NSString *dir = OAAStagingDirectory();
  if (dir.length == 0) {
    return;
  }
  if (![[path stringByDeletingLastPathComponent] isEqualToString:dir]) {
    return;
  }
  if (!OAAIsStagingLeaf(path.lastPathComponent)) {
    return;
  }
  const char *raw = path.fileSystemRepresentation;
  if (raw != NULL) {
    unlink(raw);
  }
}

#pragma mark - Persistable grants (Android only)

/**
 * No-ops on iOS: a security-scoped bookmark is not a grant held against a
 * system table, it is a blob the app stores, so there is nothing to release.
 * Dropping the token drops the access. Android's SAF grants are the reason
 * these methods exist at all (plan §10 F3).
 *
 * That makes deleting the persisted token the ONLY revocation on this platform,
 * with the consequences for a cancelled or completed import stated once in the
 * token-revocation invariant in the src/index.tsx header (section 4).
 */
- (void)releaseParts:(NSArray *)refs
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  resolve(nil);
}

- (void)releaseAllPersistedParts:(RCTPromiseResolveBlock)resolve
                          reject:(RCTPromiseRejectBlock)reject
{
  resolve(nil);
}

@end

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
//
// F15, data-protection class: NSFileProtectionCompleteUnlessOpen is used here
// pending smoke step 4 (extract, lock the device for two minutes, then run the
// upload read loop). That leg either confirms this class or switches it to
// NSFileProtectionCompleteUntilFirstUserAuthentication; the invariant pin in
// B6 follows the measurement, so do not pin this string before step 4 reports.
//
// Required-reason APIs: fstat(2) is on Apple's file-timestamp list. The app's
// ios/OrbitalMobile/PrivacyInfo.xcprivacy already declares
// NSPrivacyAccessedAPICategoryFileTimestamp with C617.1 (files in the app
// container — the staging file) and 0A2A.1 (files the user granted access to
// via a document picker — the archive parts), so this module needs no manifest
// change. Nothing here reads disk space or user defaults.
