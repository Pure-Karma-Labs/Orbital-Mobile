#import "OrbitalMediaTranscoder.h"

#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreVideo/CoreVideo.h>
#import <ImageIO/ImageIO.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>

#include <atomic>

// Error codes. Messages never carry paths, filenames, or user content — only
// a non-identifying reason (an OS error constant or a fixed phrase).
static NSString *const kOMTErrNotFound = @"ENOENT";
static NSString *const kOMTErrTranscode = @"ETRANSCODE";
static NSString *const kOMTErrCancelled = @"ECANCELLED";
static NSString *const kOMTErrMetadata = @"EMETADATA";
static NSString *const kOMTErrThumbnail = @"ETHUMBNAIL";
static NSString *const kOMTErrImage = @"EIMAGE";

static const NSTimeInterval kOMTProgressMinInterval = 0.5;
static const double kOMTProgressMinDelta = 0.01;
static const int kOMTAudioBitrate = 128000;

// AVFoundation infers container format from the path EXTENSION, not content;
// the pipeline's staging files are extension-less (`<id>-staging.bin`), which
// yields zero tracks on read. A hardlink alias with a movie extension makes
// the same inode readable without copying. The alias suffix `-staging.mp4`
// keeps it under the orphan GC if a crash strands it.
static NSString *_Nullable OMTMovieAliasIfNeeded(NSString *path)
{
  static NSSet<NSString *> *known;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    known = [NSSet setWithArray:@[ @"mp4", @"mov", @"m4v" ]];
  });
  if ([known containsObject:path.pathExtension.lowercaseString]) {
    return nil;
  }
  NSString *alias = [path stringByAppendingString:@"-alias-staging.mp4"];
  [[NSFileManager defaultManager] removeItemAtPath:alias error:nil];
  if (link(path.fileSystemRepresentation, alias.fileSystemRepresentation) != 0) {
    return nil; // fall through to the original path; the caller surfaces the error
  }
  return alias;
}

/**
 * Per-job state. Created, mutated, and destroyed only on the module queue, with
 * exactly one deliberate exception: `cancelled` is ATOMIC because the video and
 * audio sample loops poll it on _videoQueue/_audioQueue while a cancel request
 * arrives on the module queue.
 *
 * Setting that flag is the ONLY thing a cancel may do cross-queue (#726). The
 * reader and writer must never be cancelled while the loops may be inside
 * -copyNextSampleBuffer: tearing the decode session down underneath an
 * in-flight copy crashes in FigVisualContextGetEarliestSequentialImageTime.
 * Teardown belongs to -finishTranscode:job:, which runs on the module queue
 * only after both loops have drained.
 */
@interface OrbitalTranscodeJob : NSObject
@property (nonatomic, copy) NSString *destPath;
@property (nonatomic, copy) RCTPromiseResolveBlock resolve;
@property (nonatomic, copy) RCTPromiseRejectBlock reject;
@property (nonatomic, strong, nullable) AVAssetReader *reader;
@property (nonatomic, strong, nullable) AVAssetWriter *writer;
/**
 * Atomic (seq-cst), set once via -markCancelled and never cleared. Readable
 * from any queue; the sample loops poll it between samples.
 */
@property (nonatomic, readonly, getter=isCancelled) BOOL cancelled;
/**
 * YES once requestMediaDataWhenReadyOnQueue: has installed the sample loops and
 * a dispatch_group_notify is therefore pending. Module queue only.
 */
@property (nonatomic, assign) BOOL mediaLoopsInstalled;
@property (nonatomic, assign) double lastProgress;
@property (nonatomic, assign) NSTimeInterval lastProgressAt;
- (void)markCancelled;
@end

@implementation OrbitalTranscodeJob {
  std::atomic<bool> _cancelled;
}

- (instancetype)init
{
  if (self = [super init]) {
    _cancelled.store(false);
  }
  return self;
}

// Hand-written accessors: implementing the getter of the readonly property
// suppresses auto-synthesis, so `cancelled`/`isCancelled` resolve to the atomic
// ivar rather than a plain BOOL. Sequentially consistent by default, which is
// what the loops' between-sample polling wants.
- (BOOL)isCancelled
{
  return _cancelled.load();
}

- (void)markCancelled
{
  _cancelled.store(true);
}

@end

@implementation OrbitalMediaTranscoder {
  dispatch_queue_t _queue;
  dispatch_queue_t _videoQueue;
  dispatch_queue_t _audioQueue;
  NSMutableDictionary<NSString *, OrbitalTranscodeJob *> *_jobs;
  BOOL _invalidated;
}

RCT_EXPORT_MODULE()

- (instancetype)init
{
  if (self = [super init]) {
    _queue = dispatch_queue_create("org.orbitl.mediatranscoder", DISPATCH_QUEUE_SERIAL);
    _videoQueue = dispatch_queue_create("org.orbitl.mediatranscoder.video", DISPATCH_QUEUE_SERIAL);
    _audioQueue = dispatch_queue_create("org.orbitl.mediatranscoder.audio", DISPATCH_QUEUE_SERIAL);
    _jobs = [NSMutableDictionary new];
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
  return std::make_shared<facebook::react::NativeOrbitalMediaTranscoderSpecJSI>(params);
}

#pragma mark - Lifecycle

/**
 * Metro Fast Refresh tears the module down mid-transcode. Without this, the
 * reader/writer keep running into an orphaned staging file and late progress
 * emits fire against a dead event-emitter callback.
 *
 * Unlike -cancelTranscode:, the rejection here CANNOT be drain-deferred: the JS
 * runtime is being torn down, so the promise blocks must not fire afterwards.
 * We therefore settle immediately and unregister the job. We still leave the
 * reader/writer strictly alone (#726) — cancelling them here would race the
 * sample loops the same way a cancel does. -finishTranscode:job: then finds the
 * job unregistered, settles nothing, and tears the pipeline down once for real
 * after the loops drain.
 *
 * No [super invalidate]: the generated spec base is a bare NSObject.
 */
- (void)invalidate
{
  dispatch_sync(_queue, ^{
    self->_invalidated = YES;
    NSArray<NSString *> *jobIds = self->_jobs.allKeys;
    for (NSString *jobId in jobIds) {
      OrbitalTranscodeJob *job = self->_jobs[jobId];
      if (job == nil) {
        continue;
      }
      [job markCancelled];
      [self removeFileAtPath:job.destPath];
      [self->_jobs removeObjectForKey:jobId];
      job.reject(kOMTErrCancelled, @"module invalidated", nil);
    }
  });
}

#pragma mark - transcodeVideo

- (void)transcodeVideo:(NSString *)jobId
            sourcePath:(NSString *)sourcePath
              destPath:(NSString *)destPath
               options:(JS::NativeOrbitalMediaTranscoder::VideoTranscodeOptions &)options
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  // The options struct only wraps the bridged NSDictionary — read it before
  // hopping queues.
  double maxDimension = options.maxDimension();
  double bitrate = options.bitrate();

  dispatch_async(_queue, ^{
    [self startTranscode:jobId
                  source:sourcePath
                    dest:destPath
            maxDimension:maxDimension
                 bitrate:bitrate
                 resolve:resolve
                  reject:reject];
  });
}

- (void)startTranscode:(NSString *)jobId
                source:(NSString *)sourcePath
                  dest:(NSString *)destPath
          maxDimension:(double)maxDimension
               bitrate:(double)bitrate
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  if (_invalidated) {
    reject(kOMTErrCancelled, @"module invalidated", nil);
    return;
  }
  if (![[NSFileManager defaultManager] fileExistsAtPath:sourcePath]) {
    reject(kOMTErrNotFound, @"source unavailable", nil);
    return;
  }
  // Documented overwrite semantics, identical on both platforms.
  [self removeFileAtPath:destPath];

  OrbitalTranscodeJob *job = [OrbitalTranscodeJob new];
  job.destPath = destPath;
  job.resolve = resolve;
  job.reject = reject;
  job.lastProgress = -1.0;
  job.lastProgressAt = 0;
  _jobs[jobId] = job;

  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:sourcePath] options:nil];
  [asset loadTracksWithMediaType:AVMediaTypeVideo
               completionHandler:^(NSArray<AVAssetTrack *> *_Nullable videoTracks,
                                   NSError *_Nullable trackError) {
                 dispatch_async(self->_queue, ^{
                   if (trackError != nil || videoTracks.count == 0) {
                     [self failJob:jobId code:kOMTErrTranscode reason:@"no decodable video track"];
                     return;
                   }
                   [asset loadTracksWithMediaType:AVMediaTypeAudio
                                completionHandler:^(NSArray<AVAssetTrack *> *_Nullable audioTracks,
                                                    NSError *_Nullable audioError) {
                                  dispatch_async(self->_queue, ^{
                                    if (audioError != nil) {
                                      // An audio-track load ERROR must fail the transcode (routes to the
                                      // TS pass-through branch); only a genuinely audio-free asset may
                                      // proceed video-only.
                                      [self failJob:jobId
                                               code:kOMTErrTranscode
                                             reason:@"audio track load failed"];
                                      return;
                                    }
                                    [self runTranscode:jobId
                                                 asset:asset
                                            videoTrack:videoTracks.firstObject
                                            audioTrack:audioTracks.firstObject
                                          maxDimension:maxDimension
                                               bitrate:bitrate];
                                  });
                                }];
                 });
               }];
}

/**
 * Builds and starts the reader/writer pipeline. Runs on _queue.
 *
 * Cancellation correctness (#726) depends on three properties of this method,
 * all of which a future refactor could silently break:
 *   (a) it is ATOMIC with respect to _queue — it never awaits or hops queues,
 *       so the dispatch_group_notify it schedules on _queue cannot run until it
 *       has returned, which is what makes `mediaLoopsInstalled = YES` at the
 *       very end a sound "a notify is pending" flag;
 *   (b) every early exit after the reader/writer are assigned to the job calls
 *       -failJob:, so no job is ever left registered with no pending notify;
 *   (c) settle-once: every path that removes a job from _jobs also settles its
 *       promise, and no path settles a job it did not remove.
 * Adding an early `return` or an async hop below breaks (a) or (b) and will
 * strand a cancelled job's promise forever.
 */
- (void)runTranscode:(NSString *)jobId
               asset:(AVURLAsset *)asset
          videoTrack:(AVAssetTrack *)videoTrack
          audioTrack:(nullable AVAssetTrack *)audioTrack
        maxDimension:(double)maxDimension
             bitrate:(double)bitrate
{
  OrbitalTranscodeJob *job = _jobs[jobId];
  if (job == nil || job.cancelled) {
    return;
  }

  // Synchronous property reads are safe here: loadTracksWithMediaType: has
  // already parsed the asset. The sync accessors are soft-deprecated in favour
  // of Swift async properties that have no Obj-C equivalent.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  CGSize naturalSize = videoTrack.naturalSize;
  CGAffineTransform preferredTransform = videoTrack.preferredTransform;
  CMTime assetDuration = asset.duration;
  NSArray *audioFormatDescriptions = audioTrack.formatDescriptions;
#pragma clang diagnostic pop

  CGSize displaySize = CGSizeApplyAffineTransform(naturalSize, preferredTransform);
  double displayLongSide = MAX(fabs(displaySize.width), fabs(displaySize.height));
  if (displayLongSide <= 0) {
    [self failJob:jobId code:kOMTErrTranscode reason:@"unreadable video dimensions"];
    return;
  }
  // Never upscale. The writer input keeps the preferred transform, so target
  // dimensions are derived from the natural (pre-rotation) size.
  double scale = MIN(1.0, maxDimension / displayLongSide);
  NSInteger targetWidth = [self evenDimension:naturalSize.width * scale];
  NSInteger targetHeight = [self evenDimension:naturalSize.height * scale];

  NSError *error = nil;
  AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
  if (reader == nil) {
    [self failJob:jobId code:kOMTErrTranscode reason:@"reader init failed"];
    return;
  }
  // destPath ends in .mp4 (enforced by the JS wrapper); AVAssetWriter derives
  // the container from the extension and AVFileTypeMPEG4 yields a
  // non-fragmented MP4 with a top-level moov, which mp4GpsSanitizer requires.
  AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:[NSURL fileURLWithPath:job.destPath]
                                                    fileType:AVFileTypeMPEG4
                                                       error:&error];
  if (writer == nil) {
    [self failJob:jobId code:kOMTErrTranscode reason:@"writer init failed"];
    return;
  }
  writer.shouldOptimizeForNetworkUse = YES;
  // Belt-and-braces: mp4GpsSanitizer remains the authoritative GPS strip.
  writer.metadata = @[];

  job.reader = reader;
  job.writer = writer;

  AVAssetReaderTrackOutput *videoOutput = [[AVAssetReaderTrackOutput alloc]
      initWithTrack:videoTrack
     outputSettings:@{
       (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
     }];
  videoOutput.alwaysCopiesSampleData = NO;

  AVAssetWriterInput *videoInput = [[AVAssetWriterInput alloc]
      initWithMediaType:AVMediaTypeVideo
         outputSettings:@{
           AVVideoCodecKey : AVVideoCodecTypeH264,
           AVVideoWidthKey : @(targetWidth),
           AVVideoHeightKey : @(targetHeight),
           AVVideoCompressionPropertiesKey : @{
             AVVideoAverageBitRateKey : @((NSInteger)bitrate),
             AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel,
           },
         }];
  videoInput.expectsMediaDataInRealTime = NO;
  videoInput.transform = preferredTransform;

  if (![reader canAddOutput:videoOutput] || ![writer canAddInput:videoInput]) {
    [self failJob:jobId code:kOMTErrTranscode reason:@"video pipeline rejected"];
    return;
  }
  [reader addOutput:videoOutput];
  [writer addInput:videoInput];

  AVAssetReaderTrackOutput *audioOutput = nil;
  AVAssetWriterInput *audioInput = nil;
  if (audioTrack != nil) {
    audioOutput = [[AVAssetReaderTrackOutput alloc] initWithTrack:audioTrack
                                                  outputSettings:@{
                                                    AVFormatIDKey : @(kAudioFormatLinearPCM),
                                                    AVLinearPCMBitDepthKey : @16,
                                                    AVLinearPCMIsBigEndianKey : @NO,
                                                    AVLinearPCMIsFloatKey : @NO,
                                                    AVLinearPCMIsNonInterleaved : @NO,
                                                  }];
    audioOutput.alwaysCopiesSampleData = NO;

    double sampleRate = 44100;
    UInt32 channels = 2;
    CMFormatDescriptionRef formatDescription =
        (__bridge CMFormatDescriptionRef)audioFormatDescriptions.firstObject;
    if (formatDescription != NULL) {
      const AudioStreamBasicDescription *asbd =
          CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription);
      if (asbd != NULL) {
        if (asbd->mSampleRate > 0) {
          sampleRate = asbd->mSampleRate;
        }
        // The AAC encoder needs an explicit channel layout above stereo.
        if (asbd->mChannelsPerFrame > 0) {
          channels = MIN((UInt32)2, asbd->mChannelsPerFrame);
        }
      }
    }

    audioInput = [[AVAssetWriterInput alloc] initWithMediaType:AVMediaTypeAudio
                                               outputSettings:@{
                                                 AVFormatIDKey : @(kAudioFormatMPEG4AAC),
                                                 AVSampleRateKey : @(sampleRate),
                                                 AVNumberOfChannelsKey : @(channels),
                                                 AVEncoderBitRateKey : @(kOMTAudioBitrate),
                                               }];
    audioInput.expectsMediaDataInRealTime = NO;

    if ([reader canAddOutput:audioOutput] && [writer canAddInput:audioInput]) {
      [reader addOutput:audioOutput];
      [writer addInput:audioInput];
    } else {
      // Silently dropping audio would be permanent loss in an E2EE archive;
      // failing routes to the TS pass-through branch (original + audio intact).
      [self failJob:jobId code:kOMTErrTranscode reason:@"audio pipeline rejected"];
      return;
    }
  }

  if (![reader startReading] || ![writer startWriting]) {
    [self failJob:jobId code:kOMTErrTranscode reason:@"pipeline start failed"];
    return;
  }
  [writer startSessionAtSourceTime:kCMTimeZero];

  double durationSeconds = CMTIME_IS_NUMERIC(assetDuration) ? CMTimeGetSeconds(assetDuration) : 0;
  dispatch_group_t group = dispatch_group_create();

  dispatch_group_enter(group);
  __block BOOL videoFinished = NO;
  [videoInput requestMediaDataWhenReadyOnQueue:_videoQueue
                                    usingBlock:^{
                                      if (videoFinished) {
                                        return;
                                      }
                                      while (videoInput.isReadyForMoreMediaData) {
                                        CMSampleBufferRef sample = NULL;
                                        if (!job.cancelled) {
                                          sample = [videoOutput copyNextSampleBuffer];
                                        }
                                        if (sample == NULL) {
                                          videoFinished = YES;
                                          [videoInput markAsFinished];
                                          dispatch_group_leave(group);
                                          return;
                                        }
                                        CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
                                        BOOL appended = [videoInput appendSampleBuffer:sample];
                                        CFRelease(sample);
                                        if (!appended) {
                                          videoFinished = YES;
                                          [videoInput markAsFinished];
                                          dispatch_group_leave(group);
                                          return;
                                        }
                                        if (durationSeconds > 0 && CMTIME_IS_NUMERIC(pts)) {
                                          [self emitProgressForJob:jobId
                                                          progress:CMTimeGetSeconds(pts) /
                                                                   durationSeconds];
                                        }
                                      }
                                    }];

  if (audioInput != nil) {
    dispatch_group_enter(group);
    AVAssetWriterInput *strongAudioInput = audioInput;
    AVAssetReaderTrackOutput *strongAudioOutput = audioOutput;
    __block BOOL audioFinished = NO;
    [strongAudioInput requestMediaDataWhenReadyOnQueue:_audioQueue
                                            usingBlock:^{
                                              if (audioFinished) {
                                                return;
                                              }
                                              while (strongAudioInput.isReadyForMoreMediaData) {
                                                CMSampleBufferRef sample = NULL;
                                                if (!job.cancelled) {
                                                  sample = [strongAudioOutput copyNextSampleBuffer];
                                                }
                                                if (sample == NULL) {
                                                  audioFinished = YES;
                                                  [strongAudioInput markAsFinished];
                                                  dispatch_group_leave(group);
                                                  return;
                                                }
                                                BOOL appended =
                                                    [strongAudioInput appendSampleBuffer:sample];
                                                CFRelease(sample);
                                                if (!appended) {
                                                  audioFinished = YES;
                                                  [strongAudioInput markAsFinished];
                                                  dispatch_group_leave(group);
                                                  return;
                                                }
                                              }
                                            }];
  }

  // The notify captures the job so that teardown works even after the job has
  // been unregistered from _jobs (invalidate).
  dispatch_group_notify(group, _queue, ^{
    [self finishTranscode:jobId job:job];
  });

  // MUST stay the final statement, immediately after the notify is scheduled:
  // the flag being YES then structurally implies "a notify is pending", which
  // is exactly the precondition -cancelTranscode: relies on to defer settling.
  job.mediaLoopsInstalled = YES;
}

/**
 * Runs on _queue once both sample loops have drained, so the reader/writer are
 * now safe to tear down. `job` is the job this pipeline belongs to; it may no
 * longer be the job registered under `jobId` (invalidate unregisters).
 */
- (void)finishTranscode:(NSString *)jobId job:(OrbitalTranscodeJob *)job
{
  AVAssetReader *reader = job.reader;
  AVAssetWriter *writer = job.writer;

  OrbitalTranscodeJob *current = _jobs[jobId];
  if (current == nil) {
    // -invalidate unregistered and already rejected this job. Tear the pipeline
    // down now that the loops have drained — this is what releases the encoder
    // session and the writer's open fd — but settle NOTHING: re-rejecting an
    // already-settled promise violates RN's single-settle contract.
    [reader cancelReading];
    [writer cancelWriting];
    return;
  }
  if (current != job) {
    // Unreachable today: jobId is a fresh UUID per uploadMedia call
    // (mediaUploadService.ts:250), so no successor can reuse this id. Defensive
    // against future id reuse: tear down OUR pipeline and reject OUR orphaned
    // promise directly. Not via -failJob:, which would remove the SUCCESSOR
    // from _jobs, settle its promise, and delete the file it now owns.
    [reader cancelReading];
    [writer cancelWriting];
    job.reject(kOMTErrCancelled, @"transcode superseded", nil);
    return;
  }

  // The cancelled check stays AHEAD of the failed-status check: a cancel that
  // also trips a reader/writer failure must still report ECANCELLED, because JS
  // duck-types cancellation on that code alone (isCancellation).
  if (job.cancelled) {
    [reader cancelReading];
    [writer cancelWriting];
    [self failJob:jobId code:kOMTErrCancelled reason:@"transcode cancelled"];
    return;
  }
  if (reader.status == AVAssetReaderStatusFailed || writer.status == AVAssetWriterStatusFailed) {
    [reader cancelReading];
    [writer cancelWriting];
    [self failJob:jobId code:kOMTErrTranscode reason:@"read or write failed"];
    return;
  }

  [writer finishWritingWithCompletionHandler:^{
    dispatch_async(self->_queue, ^{
      OrbitalTranscodeJob *pending = self->_jobs[jobId];
      if (pending != job) {
        if (pending == nil) {
          // -invalidate ran while finalization was in flight: it deleted
          // destPath and rejected, then finishWriting RECREATED the file at
          // that path. Delete the resurrected plaintext.
          [self removeFileAtPath:job.destPath];
        }
        // Otherwise a successor owns this id (see above) — never touch its
        // promise or its file.
        return;
      }
      if (writer.status == AVAssetWriterStatusCompleted && !pending.cancelled) {
        [self->_jobs removeObjectForKey:jobId];
        pending.resolve(nil);
      } else {
        [self failJob:jobId
                 code:pending.cancelled ? kOMTErrCancelled : kOMTErrTranscode
               reason:pending.cancelled ? @"transcode cancelled" : @"finalize failed"];
      }
    });
  }];
}

/** Removes the job, deletes any partial output, and rejects. Module queue only. */
- (void)failJob:(NSString *)jobId code:(NSString *)code reason:(NSString *)reason
{
  OrbitalTranscodeJob *job = _jobs[jobId];
  if (job == nil) {
    return;
  }
  [_jobs removeObjectForKey:jobId];
  [self removeFileAtPath:job.destPath];
  job.reject(code, reason, nil);
}

/**
 * Cancellation is a REQUEST, not a teardown (#726).
 *
 * Cancelling the reader/writer here used to crash: the sample loops run on
 * _videoQueue/_audioQueue and may be inside -copyNextSampleBuffer at the exact
 * moment a cancel arrives on the module queue, and pulling the decode session
 * out from under them SIGSEGVs in
 * FigVisualContextGetEarliestSequentialImageTime. So a cancel now only sets the
 * atomic flag; the loops observe it between samples, finish, and
 * -finishTranscode:job: does the teardown and the settling once they have
 * drained.
 *
 * The JS contract is shape-identical, latency-deferred: JS discriminates
 * cancellation solely on the code ECANCELLED delivered through the transcode
 * promise, which still arrives — just after the drain rather than immediately.
 * The cancelling-label affordance in useMediaUploadProgress absorbs a
 * sub-second drain; that UI affordance IS the latency budget. (A JS-side
 * settlement backstop is tracked in #727.)
 */
- (void)cancelTranscode:(NSString *)jobId
{
  dispatch_async(_queue, ^{
    OrbitalTranscodeJob *job = self->_jobs[jobId];
    if (job == nil) {
      // Unknown id, already-settled job, or a call for a path that never
      // enters _jobs at all (image / thumbnail / metadata). Nothing to do.
      return;
    }
    [job markCancelled];

    if (!job.mediaLoopsInstalled) {
      // Still loading tracks: no sample loops are running, no notify is
      // pending, and the reader/writer do not exist yet. This is both the ONLY
      // chance to settle the promise and a safe moment to do it — nothing can
      // be mid-copyNextSampleBuffer. runTranscode later finds the job gone and
      // bails.
      [self failJob:jobId code:kOMTErrCancelled reason:@"transcode cancelled"];
      return;
    }

    // Loops installed: settling is deferred to -finishTranscode:job:. Delete
    // the partial plaintext output NOW anyway, matching Android's immediate
    // delete, so the residue window does not stretch across the drain. Safe on
    // APFS: the writer keeps its fd, its remaining writes land in the now
    // anonymous inode and are reclaimed when -finishTranscode:job: cancels the
    // writer; failJob's later delete no-ops; and -startTranscode: unlinks
    // destPath for any successor anyway.
    [self removeFileAtPath:job.destPath];
    // NOTHING else here: no cancelReading, no cancelWriting, no failJob.
  });
}

- (void)emitProgressForJob:(NSString *)jobId progress:(double)progress
{
  double clamped = MIN(1.0, MAX(0.0, progress));
  dispatch_async(_queue, ^{
    if (self->_invalidated) {
      return;
    }
    OrbitalTranscodeJob *job = self->_jobs[jobId];
    if (job == nil || job.cancelled) {
      return;
    }
    NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
    if (now - job.lastProgressAt < kOMTProgressMinInterval &&
        clamped - job.lastProgress < kOMTProgressMinDelta) {
      return;
    }
    job.lastProgressAt = now;
    job.lastProgress = clamped;
    [self emitOnTranscodeProgress:@{@"jobId" : jobId, @"progress" : @(clamped)}];
  });
}

#pragma mark - getVideoMetadata

- (void)getVideoMetadata:(NSString *)sourcePath
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  if (![[NSFileManager defaultManager] fileExistsAtPath:sourcePath]) {
    reject(kOMTErrNotFound, @"source unavailable", nil);
    return;
  }
  NSString *alias = OMTMovieAliasIfNeeded(sourcePath);
  AVURLAsset *asset =
      [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:alias ?: sourcePath] options:nil];
  void (^cleanupAlias)(void) = ^{
    if (alias != nil) {
      [[NSFileManager defaultManager] removeItemAtPath:alias error:nil];
    }
  };
  [asset loadTracksWithMediaType:AVMediaTypeVideo
               completionHandler:^(NSArray<AVAssetTrack *> *_Nullable tracks,
                                   NSError *_Nullable error) {
                 AVAssetTrack *track = tracks.firstObject;
                 if (error != nil || track == nil) {
                   cleanupAlias();
                   reject(kOMTErrMetadata, @"metadata unavailable", nil);
                   return;
                 }
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
                 CGSize naturalSize = track.naturalSize;
                 CGAffineTransform transform = track.preferredTransform;
                 CMTime duration = asset.duration;
#pragma clang diagnostic pop
                 CGSize display = CGSizeApplyAffineTransform(naturalSize, transform);
                 double seconds = CMTIME_IS_NUMERIC(duration) ? CMTimeGetSeconds(duration) : 0;
                 if (isnan(seconds) || seconds < 0) {
                   seconds = 0;
                 }
                 cleanupAlias();
                 resolve(@{
                   @"width" : @(round(fabs(display.width))),
                   @"height" : @(round(fabs(display.height))),
                   @"duration" : @(seconds),
                 });
               }];
}

#pragma mark - extractThumbnail

- (void)extractThumbnail:(NSString *)sourcePath
                    atMs:(double)atMs
                destPath:(NSString *)destPath
            maxDimension:(double)maxDimension
                 quality:(double)quality
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  if (![[NSFileManager defaultManager] fileExistsAtPath:sourcePath]) {
    reject(kOMTErrNotFound, @"source unavailable", nil);
    return;
  }
  NSString *alias = OMTMovieAliasIfNeeded(sourcePath);
  AVURLAsset *asset =
      [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:alias ?: sourcePath] options:nil];
  void (^cleanupAlias)(void) = ^{
    if (alias != nil) {
      [[NSFileManager defaultManager] removeItemAtPath:alias error:nil];
    }
  };
  [asset loadTracksWithMediaType:AVMediaTypeVideo
               completionHandler:^(NSArray<AVAssetTrack *> *_Nullable tracks,
                                   NSError *_Nullable error) {
                 if (error != nil || tracks.count == 0) {
                   cleanupAlias();
                   reject(kOMTErrThumbnail, @"no decodable video track", nil);
                   return;
                 }
                 AVAssetImageGenerator *generator =
                     [[AVAssetImageGenerator alloc] initWithAsset:asset];
                 generator.appliesPreferredTrackTransform = YES;
                 generator.maximumSize = CGSizeMake(maxDimension, maxDimension);
                 generator.requestedTimeToleranceBefore = CMTimeMakeWithSeconds(0.5, 1000);
                 generator.requestedTimeToleranceAfter = CMTimeMakeWithSeconds(0.5, 1000);

                 CMTime requested = CMTimeMakeWithSeconds(MAX(0, atMs) / 1000.0, 1000);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
                 CMTime duration = asset.duration;
#pragma clang diagnostic pop
                 if (CMTIME_IS_NUMERIC(duration) && CMTimeCompare(requested, duration) > 0) {
                   requested = duration;
                 }

                 NSError *frameError = nil;
                 CGImageRef image = [generator copyCGImageAtTime:requested
                                                     actualTime:NULL
                                                          error:&frameError];
                 if (image == NULL) {
                   cleanupAlias();
                   reject(kOMTErrThumbnail, @"no decodable frame", nil);
                   return;
                 }
                 BOOL written = [self writeImage:image
                                          toPath:destPath
                                            type:UTTypeJPEG
                                         quality:@(quality)];
                 CGImageRelease(image);
                 cleanupAlias();
                 if (!written) {
                   [self removeFileAtPath:destPath];
                   reject(kOMTErrThumbnail, @"thumbnail encode failed", nil);
                   return;
                 }
                 resolve(nil);
               }];
}

#pragma mark - reencodeImage

- (void)reencodeImage:(NSString *)sourcePath
             destPath:(NSString *)destPath
              options:(JS::NativeOrbitalMediaTranscoder::ImageReencodeOptions &)options
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  double maxDimension = options.maxDimension();
  double quality = options.quality();
  NSString *format = options.format();

  dispatch_async(_queue, ^{
    if (![[NSFileManager defaultManager] fileExistsAtPath:sourcePath]) {
      reject(kOMTErrNotFound, @"source unavailable", nil);
      return;
    }
    CGImageSourceRef source = CGImageSourceCreateWithURL(
        (__bridge CFURLRef)[NSURL fileURLWithPath:sourcePath], NULL);
    if (source == NULL) {
      reject(kOMTErrImage, @"undecodable source", nil);
      return;
    }

    CGImageRef image = NULL;
    if (maxDimension > 0) {
      // The thumbnail path is also the orientation path:
      // kCGImageSourceCreateThumbnailWithTransform bakes the EXIF orientation
      // into the pixels, and MaxPixelSize never upscales.
      NSDictionary *thumbOptions = @{
        (id)kCGImageSourceCreateThumbnailWithTransform : @YES,
        (id)kCGImageSourceCreateThumbnailFromImageAlways : @YES,
        (id)kCGImageSourceThumbnailMaxPixelSize : @((NSInteger)maxDimension),
      };
      image = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)thumbOptions);
    } else {
      image = CGImageSourceCreateImageAtIndex(source, 0, NULL);
    }
    CFRelease(source);

    if (image == NULL) {
      reject(kOMTErrImage, @"undecodable source", nil);
      return;
    }

    BOOL isPng = [format isEqualToString:@"png"];
    BOOL written = [self writeImage:image
                             toPath:destPath
                               type:isPng ? UTTypePNG : UTTypeJPEG
                            quality:isPng ? nil : @(quality)];
    CGImageRelease(image);
    if (!written) {
      [self removeFileAtPath:destPath];
      reject(kOMTErrImage, @"image encode failed", nil);
      return;
    }
    resolve(nil);
  });
}

#pragma mark - Helpers

/**
 * Encodes with NO source properties, so the output carries no EXIF/GPS/XMP.
 * Defense in depth only — imageSanitizer's byte-level strip stays authoritative.
 */
- (BOOL)writeImage:(CGImageRef)image
            toPath:(NSString *)destPath
              type:(UTType *)type
           quality:(nullable NSNumber *)quality
{
  [self removeFileAtPath:destPath];
  NSURL *destURL = [NSURL fileURLWithPath:destPath];
  CGImageDestinationRef destination = CGImageDestinationCreateWithURL(
      (__bridge CFURLRef)destURL, (__bridge CFStringRef)type.identifier, 1, NULL);
  if (destination == NULL) {
    return NO;
  }
  NSDictionary *properties =
      quality == nil ? nil : @{(id)kCGImageDestinationLossyCompressionQuality : quality};
  CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)properties);
  BOOL finalized = CGImageDestinationFinalize(destination);
  CFRelease(destination);
  return finalized;
}

- (void)removeFileAtPath:(NSString *)path
{
  if (path.length == 0) {
    return;
  }
  [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
}

/** H.264 requires even dimensions; also clamps to a sane minimum. */
- (NSInteger)evenDimension:(double)value
{
  NSInteger rounded = (NSInteger)llround(value);
  if (rounded < 2) {
    return 2;
  }
  return rounded - (rounded % 2);
}

@end
