//! Cooperative cancellation.
//!
//! One `AtomicBool` per job. Setting it is synchronous and lock-free, so
//! `localWipe` phase 1 can cancel every in-flight job without awaiting
//! anything (F3). Every long loop in this crate polls it: the central-directory
//! iterator, the EOCD scan, `read_json` between read and decode, and the copy
//! loop.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::{ArchiveError, ArchiveResult};

/// Shared cancel flag. Cloning shares the flag.
#[derive(Debug, Clone, Default)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }

    /// `Err(Cancelled)` if cancellation was requested. The wrapper surfaces it
    /// as `ECANCELLED`.
    pub fn check(&self) -> ArchiveResult<()> {
        if self.is_cancelled() {
            return Err(ArchiveError::Cancelled);
        }
        Ok(())
    }
}

/// A cancel handle the foreign side holds *before* the job it cancels exists.
///
/// `open_archive` is a cancellable job (F4) but has no session to register a
/// job id against, so the wrapper creates a token, passes it in, and calls
/// `cancel()` on abort.
#[derive(Debug, Default, uniffi::Object)]
pub struct CancelToken {
    flag: CancelFlag,
}

#[uniffi::export]
impl CancelToken {
    #[uniffi::constructor]
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn cancel(&self) {
        self.flag.cancel();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.flag.is_cancelled()
    }
}

impl CancelToken {
    #[must_use]
    pub fn flag(&self) -> CancelFlag {
        self.flag.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flag_is_shared_and_sticky() {
        let a = CancelFlag::new();
        let b = a.clone();
        assert!(a.check().is_ok());
        b.cancel();
        assert_eq!(a.check(), Err(ArchiveError::Cancelled));
        assert!(a.is_cancelled());
    }
}
