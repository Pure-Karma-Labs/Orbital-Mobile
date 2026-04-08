mod error;
mod group;
mod keys;
mod sealed;
mod session;
mod stores;
mod types;
mod util;

// Store adapters and client are implemented but blocked on uniffi FfiConverterArc.
// See client.rs for details. Retained as reference for when the blocker is resolved.
#[allow(dead_code)]
mod client;
#[allow(dead_code)]
mod store_adapters;

pub use error::*;
pub use group::*;
pub use keys::*;
pub use sealed::*;
pub use session::*;
pub use stores::*;
pub use types::*;
pub use util::*;

uniffi::setup_scaffolding!();
