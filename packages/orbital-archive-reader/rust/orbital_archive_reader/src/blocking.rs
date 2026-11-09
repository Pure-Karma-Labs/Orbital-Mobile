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
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

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
pub fn spawn_blocking<T, F>(f: F) -> BlockingJob<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let inner = Arc::new(Mutex::new(Inner {
        result: None,
        waker: None,
    }));
    let worker = Arc::clone(&inner);
    std::thread::spawn(move || {
        let value = f();
        let waker = {
            let mut guard = lock(&worker);
            guard.result = Some(value);
            guard.waker.take()
        };
        if let Some(w) = waker {
            w.wake();
        }
    });
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
    use crate::error::ArchiveError;
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
            41u32 + 1
        });
        assert_eq!(block_on(job), 42);
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
        let jobs: Vec<_> = (0..4u32).map(|i| spawn_blocking(move || i * 2)).collect();
        let results: Vec<u32> = jobs.into_iter().map(block_on).collect();
        assert_eq!(results, vec![0, 2, 4, 6]);
    }
}
