// OrbitalSignalClient — store-backed protocol operations.
//
// BLOCKED: uniffi 0.31 cannot pass Arc<dyn CallbackInterface> as Object constructor params
// (FfiConverterArc trait bound not satisfied), and libsignal store traits use
// #[async_trait(?Send)] which produces non-Send futures incompatible with uniffi async.
//
// Resolution tracked in follow-up: need either:
// 1. uniffi version with callback interface Arc support in Object constructors, or
// 2. A native-side client (Swift/Kotlin) that holds stores and calls libsignal directly,
//    exposing results to TypeScript through simpler uniffi functions.
//
// For now, session/group/sealed sender functions are exposed as stubs in their
// respective modules to define the API surface.
