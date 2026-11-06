//! Admission control for the preview worker. Queued foreground work precedes
//! preloads and metrics; cancelling queued work never starts Python.
use crate::error::AppError;
use std::collections::HashMap;
use std::sync::{atomic::{AtomicU8, Ordering}, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

#[derive(Default)]
struct State {
    next: u64,
    running: Option<u64>,
    jobs: HashMap<u64, (String, u8, Arc<AtomicU8>)>,
    // IPC cancellation can arrive before its generation command is polled.
    cancelled: HashMap<String, (u8, Instant)>,
}

#[derive(Default)]
pub struct Scheduler {
    state: Mutex<State>,
    changed: Notify,
}

static PREVIEW: OnceLock<Scheduler> = OnceLock::new();
pub fn preview() -> &'static Scheduler { PREVIEW.get_or_init(Scheduler::default) }

pub struct Ticket<'a> {
    scheduler: &'a Scheduler,
    key: u64,
    status: Arc<AtomicU8>, // 0 live, 1 discard/skip, 2 interrupt running work
}

impl Scheduler {
    pub fn register(&self, id: Option<String>, priority: u8) -> Ticket<'_> {
        let mut state = self.state.lock().unwrap();
        state.cancelled.retain(|_, (_, time)| time.elapsed() < Duration::from_secs(300));
        state.next += 1;
        let key = state.next;
        let id = id.unwrap_or_else(|| format!("internal-{key}"));
        let cancelled = state.cancelled.get(&id).map_or(0, |(status, _)| *status);
        let status = Arc::new(AtomicU8::new(cancelled));
        state.jobs.insert(key, (id, priority, status.clone()));
        drop(state);
        self.changed.notify_waiters();
        Ticket { scheduler: self, key, status }
    }

    pub fn cancel(&self, ids: &[String], interrupt: bool) {
        let mut state = self.state.lock().unwrap();
        let status = if interrupt { 2 } else { 1 };
        for id in ids {
            let entry = state.cancelled.entry(id.clone()).or_insert((0, Instant::now()));
            entry.0 = entry.0.max(status);
            entry.1 = Instant::now();
            for (job_id, _, flag) in state.jobs.values() {
                if job_id == id { flag.fetch_max(status, Ordering::SeqCst); }
            }
        }
        drop(state);
        self.changed.notify_waiters();
    }
}

impl Ticket<'_> {
    pub fn is_interrupted(&self) -> bool { self.status.load(Ordering::SeqCst) == 2 }
    pub fn check(&self) -> Result<(), AppError> {
        if self.status.load(Ordering::SeqCst) != 0 { Err(AppError::Cancelled) } else { Ok(()) }
    }

    pub async fn acquire(&self) -> Result<(), AppError> {
        loop {
            // Create before inspecting state: notify_waiters also wakes an
            // unpolled Notified, avoiding a release/check race.
            let changed = self.scheduler.changed.notified();
            self.check()?;
            {
                let mut state = self.scheduler.state.lock().unwrap();
                let next = state.jobs.iter()
                    .filter(|(_, (_, _, flag))| flag.load(Ordering::SeqCst) == 0)
                    .min_by_key(|(key, (_, priority, _))| (*priority, **key))
                    .map(|(key, _)| *key);
                if state.running.is_none() && next == Some(self.key) {
                    state.running = Some(self.key);
                    return Ok(());
                }
            }
            changed.await;
        }
    }

    pub async fn interrupted(&self) {
        loop {
            let changed = self.scheduler.changed.notified();
            if self.is_interrupted() { return; }
            changed.await;
        }
    }
}

impl Drop for Ticket<'_> {
    fn drop(&mut self) {
        let mut state = self.scheduler.state.lock().unwrap();
        state.jobs.remove(&self.key);
        if state.running == Some(self.key) { state.running = None; }
        drop(state);
        self.scheduler.changed.notify_waiters();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn foreground_overtakes_background_and_cancelled_jobs_are_skipped() {
        let scheduler = Scheduler::default();
        let active = scheduler.register(Some("active".into()), 0);
        active.acquire().await.unwrap();
        let old = scheduler.register(Some("old".into()), 0);
        let background = scheduler.register(None, 2);
        let latest = scheduler.register(None, 0);
        scheduler.cancel(&["old".into()], false);
        assert!(matches!(old.acquire().await, Err(AppError::Cancelled)));
        drop(active);
        latest.acquire().await.unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(10), background.acquire()).await.is_err());
        drop(latest);
        background.acquire().await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_before_registration_and_explicit_interrupt() {
        let scheduler = Scheduler::default();
        scheduler.cancel(&["late".into()], false);
        let late = scheduler.register(Some("late".into()), 0);
        assert!(late.acquire().await.is_err());
        let active = scheduler.register(Some("active".into()), 0);
        active.acquire().await.unwrap();
        scheduler.cancel(&["active".into()], false);
        assert!(active.check().is_err());
        assert!(tokio::time::timeout(Duration::from_millis(10), active.interrupted()).await.is_err());
        scheduler.cancel(&["active".into()], true);
        active.interrupted().await;
    }
}
