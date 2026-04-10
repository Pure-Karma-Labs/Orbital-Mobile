mod error;
mod group;
mod keys;
#[cfg(feature = "dev-roundtrip")]
mod roundtrip;
mod sealed;
mod session;
mod stores;
mod types;
mod util;

// Client is blocked on uniffi FfiConverterArc for Object constructors.
// See client.rs for details. Retained as reference for when the blocker is resolved.
#[allow(dead_code)]
mod client;
// Store adapter structs are blocked on FfiConverterArc (same as client.rs).
// to_protocol_address helper is used by session.rs preloaded store pattern.
#[allow(dead_code)]
mod store_adapters;

pub use error::*;
pub use group::*;
pub use keys::*;
#[cfg(feature = "dev-roundtrip")]
pub use roundtrip::*;
pub use sealed::*;
pub use session::*;
pub use stores::*;
pub use types::*;
pub use util::*;

uniffi::setup_scaffolding!();
