#import <React/RCTInvalidating.h>

#import "OrbitalMediaExportSpec.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * First-party media/file exporter.
 *
 * Extends the codegen-generated NativeOrbitalMediaExportSpecBase and conforms
 * to the generated NativeOrbitalMediaExportSpec protocol.
 *
 * RCTInvalidating is load-bearing here: an outstanding document picker owns
 * the only reference to a pending promise, and module teardown (Metro Fast
 * Refresh, a logout that drops the runtime) would otherwise leave that promise
 * un-settled forever with a modal still on screen.
 */
@interface OrbitalMediaExport : NativeOrbitalMediaExportSpecBase <
                                   NativeOrbitalMediaExportSpec,
                                   RCTInvalidating>
@end

NS_ASSUME_NONNULL_END
