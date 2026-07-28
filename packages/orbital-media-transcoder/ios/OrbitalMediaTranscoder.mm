#import "OrbitalMediaTranscoder.h"

// Stub implementation — codegen shape only. Real AVAssetReader/Writer pipeline
// lands in the next commit.

@implementation OrbitalMediaTranscoder

RCT_EXPORT_MODULE()

- (void)transcodeVideo:(NSString *)jobId
            sourcePath:(NSString *)sourcePath
              destPath:(NSString *)destPath
               options:(JS::NativeOrbitalMediaTranscoder::VideoTranscodeOptions &)options
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject
{
  reject(@"ETRANSCODE", @"not implemented", nil);
}

- (void)cancelTranscode:(NSString *)jobId
{
}

- (void)getVideoMetadata:(NSString *)sourcePath
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  reject(@"EMETADATA", @"not implemented", nil);
}

- (void)extractThumbnail:(NSString *)sourcePath
                    atMs:(double)atMs
                destPath:(NSString *)destPath
            maxDimension:(double)maxDimension
                 quality:(double)quality
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject
{
  reject(@"ETHUMBNAIL", @"not implemented", nil);
}

- (void)reencodeImage:(NSString *)sourcePath
             destPath:(NSString *)destPath
              options:(JS::NativeOrbitalMediaTranscoder::ImageReencodeOptions &)options
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  reject(@"EIMAGE", @"not implemented", nil);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeOrbitalMediaTranscoderSpecJSI>(params);
}

@end
