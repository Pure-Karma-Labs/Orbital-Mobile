#import <React/RCTInvalidating.h>

#import "OrbitalArchiveReaderSpec.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * Platform glue for the archive reader (#920, plan §5 "iOS").
 *
 * HAND-WRITTEN. The sibling `OrbitalArchiveReader` module in this same pod is
 * ubrn-generated and installs the Rust crate's JSI bindings; this one owns
 * everything that needs a platform API or an entitlement: the document picker,
 * security-scoped bookmarks, `NSFileCoordinator`, the read descriptors, and
 * the creation of staging files with an explicit data-protection class.
 *
 * Both modules are declared in the one `OrbitalArchiveReaderSpec` codegen
 * library, which is why a single pod carries both.
 *
 * RCTInvalidating is load-bearing twice over: an outstanding picker owns the
 * only reference to a pending promise, and the descriptor map owns real file
 * descriptors that must be closed when the runtime goes away (a Fast Refresh,
 * a logout that drops the bridge).
 */
@interface OrbitalArchiveAccess : NativeOrbitalArchiveAccessSpecBase <
                                     NativeOrbitalArchiveAccessSpec,
                                     RCTInvalidating>
@end

NS_ASSUME_NONNULL_END
