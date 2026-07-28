#import "OrbitalMediaTranscoderSpec.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * First-party media transcoder.
 *
 * Extends the codegen-generated NativeOrbitalMediaTranscoderSpecBase (which
 * supplies -emitOnTranscodeProgress:) and conforms to the generated
 * NativeOrbitalMediaTranscoderSpec protocol.
 */
@interface OrbitalMediaTranscoder
    : NativeOrbitalMediaTranscoderSpecBase <NativeOrbitalMediaTranscoderSpec>
@end

NS_ASSUME_NONNULL_END
