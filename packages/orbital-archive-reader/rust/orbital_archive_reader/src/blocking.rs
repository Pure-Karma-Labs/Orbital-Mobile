//! A runtime-free future for uniffi's async exports.
//!
//! This crate deliberately has **no tokio**. uniffi only needs a `Future`: it
//! polls with its own waker from the foreign side, and no `async_runtime`
//! attribute is used, so nothing requires a reactor. Blocking I/O therefore
//! runs on a plain `std::thread` that wakes the poller when it finishes.
//!
//! The thread is detached on purpose: cancellation is cooperative (the job
//! polls a `CancelFlag`), so the wrapper's promise can reject immediately while
//! the thread finishes its current chunk and exits. Nothing is leaked — the
//! `Arc` is dropped by whichever side goes last.
//!
//! If uniffi ever requires a runtime for async exports, the named fallback is
//! tokio with the `rt` feature; do not switch silently.

use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use crate::error::{ArchiveError, ArchiveResult};

struct Inner<T> {
    result: Option<T>,
    waker: Option<Waker>,
}

/// A future whose value is produced by one detached worker thread.
pub struct BlockingJob<T> {
    inner: Arc<Mutex<Inner<T>>>,
}

fn lock<T>(m: &Mutex<Inner<T>>) -> std::sync::MutexGuard<'_, Inner<T>> {
    // A panic inside a blocking job must not poison the whole session, so the
    // poisoned guard is recovered rather than unwrapped.
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Runs `f` on a worker thread and returns a future for its result.
///
/// The return type is deliberately fixed to `ArchiveResult<T>` rather than a
/// free `T`: the two failure modes below have to produce a value, and there is
/// no way to conjure one for an arbitrary `T`.
///
/// * **The job panics.** `catch_unwind` turns it into `Internal`. Without this
///   the result is never stored, no waker is ever called, and the uniffi future
///   stays pending forever — a hung promise in the app with no error to show.
/// * **The OS refuses a thread.** `Builder::spawn` reports that as an `Err`
///   instead of panicking inside the caller, and it also becomes `Internal`.
pub fn spawn_blocking<T, F>(f: F) -> BlockingJob<ArchiveResult<T>>
where
    T: Send + 'static,
    F: FnOnce() -> ArchiveResult<T> + Send + 'static,
{
    let inner = Arc::new(Mutex::new(Inner {
        result: None,
        waker: None,
    }));
    let worker = Arc::clone(&inner);
    let spawned = std::thread::Builder::new()
        .name("orbital-archive-job".to_owned())
        .spawn(move || {
            // AssertUnwindSafe: on a panic the job's partial state is thrown
            // away wholesale. The session's own invariants are restored by the
            // Drop impls that run during the unwind (StagingFile unlinks its
            // partial output, JobGuard deregisters the job, the staging
            // reservation is released), so nothing observable is left
            // half-updated.
            let value = catch_unwind(AssertUnwindSafe(f)).unwrap_or(Err(ArchiveError::Internal));
            let waker = {
                let mut guard = lock(&worker);
                guard.result = Some(value);
                guard.waker.take()
            };
            if let Some(w) = waker {
                w.wake();
            }
        });
    if spawned.is_err() {
        let mut guard = lock(&inner);
        guard.result = Some(Err(ArchiveError::Internal));
    }
    BlockingJob { inner }
}

impl<T> Future for BlockingJob<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut guard = lock(&self.inner);
        match guard.result.take() {
            Some(v) => Poll::Ready(v),
            None => {
                guard.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cancel::CancelFlag;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::task::Wake;
    use std::time::{Duration, Instant};

    struct ThreadWaker(std::thread::Thread);

    impl Wake for ThreadWaker {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }

    /// Minimal executor: the host-side stand-in for uniffi's foreign poller.
    fn block_on<F: Future>(fut: F) -> F::Output {
        let mut fut = Box::pin(fut);
        let waker = Waker::from(Arc::new(ThreadWaker(std::thread::current())));
        let mut cx = Context::from_waker(&waker);
        loop {
            if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
                return v;
            }
            std::thread::park_timeout(Duration::from_millis(50));
        }
    }

    #[test]
    fn completion_wakes_the_poller_and_returns_the_value() {
        let job = spawn_blocking(|| {
            std::thread::sleep(Duration::from_millis(20));
            Ok(41u32 + 1)
        });
        assert_eq!(block_on(job), Ok(42));
    }

    #[test]
    fn a_panicking_job_resolves_as_internal_instead_of_hanging() {
        // The default hook would print a backtrace for a panic the test
        // expects; silence it for the duration and restore it afterwards.
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let job = spawn_blocking(|| -> ArchiveResult<u32> {
            panic!("a hostile archive found an arithmetic edge");
        });
        let out = block_on(job);
        std::panic::set_hook(previous);
        assert_eq!(out, Err(ArchiveError::Internal));
    }

    #[test]
    fn a_cancelled_job_returns_promptly_and_stops_working() {
        let flag = CancelFlag::new();
        let iterations = Arc::new(AtomicU32::new(0));
        let worker_flag = flag.clone();
        let worker_iters = Arc::clone(&iterations);

        let job = spawn_blocking(move || -> Result<u32, ArchiveError> {
            for _ in 0..10_000 {
                worker_flag.check()?;
                worker_iters.fetch_add(1, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(1));
            }
            Ok(0)
        });

        std::thread::spawn({
            let flag = flag.clone();
            move || {
                std::thread::sleep(Duration::from_millis(30));
                flag.cancel();
            }
        });

        let started = Instant::now();
        let out = block_on(job);
        assert_eq!(out, Err(ArchiveError::Cancelled));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancellation must not wait for the whole job"
        );
        let done = iterations.load(Ordering::SeqCst);
        assert!(done > 0, "the job should have made progress before cancel");
        assert!(done < 10_000, "the job should not have run to completion");
    }

    #[test]
    fn many_jobs_complete_independently() {
        let jobs: Vec<_> = (0..4u32)
            .map(|i| spawn_blocking(move || Ok(i * 2)))
            .collect();
        let results: Vec<ArchiveResult<u32>> = jobs.into_iter().map(block_on).collect();
        assert_eq!(results, vec![Ok(0), Ok(2), Ok(4), Ok(6)]);
    }
}
