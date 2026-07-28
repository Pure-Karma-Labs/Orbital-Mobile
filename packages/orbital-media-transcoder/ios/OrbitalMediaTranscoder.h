#import <React/RCTInvalidating.h>

#import "OrbitalMediaTranscoderSpec.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * First-party media transcoder.
 *
 * Extends the codegen-generated NativeOrbitalMediaTranscoderSpecBase (which
 * supplies -emitOnTranscodeProgress:) and conforms to the generated
 * NativeOrbitalMediaTranscoderSpec protocol.
 *
 * RCTInvalidating is what gets -invalidate called on module teardown, so
 * in-flight jobs can be cancelled instead of writing into orphaned files.
 */
@interface OrbitalMediaTranscoder : NativeOrbitalMediaTranscoderSpecBase <
                                       NativeOrbitalMediaTranscoderSpec,
                                       RCTInvalidating>
@end

NS_ASSUME_NONNULL_END
