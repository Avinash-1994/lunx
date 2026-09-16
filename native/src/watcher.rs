/// Native FS Watcher
///
/// Uses the `notify` crate with a 50ms debounce.
/// Ignores heavy trees (node_modules, .git, dist, …) so we do not exhaust
/// inotify watches or panic the Node process. Falls back to chokidar in JS
/// if this module fails to load.
use napi_derive::napi;
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const DEBOUNCE_MS: u64 = 50;

const IGNORED_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    ".lunx",
    ".lunx_cache",
    "target",
    ".next",
    ".nuxt",
    ".output",
    "coverage",
    ".turbo",
    ".cache",
    "build",
];

#[napi(object)]
pub struct WatchEvent {
    /// "create" | "modify" | "delete" | "rename" | "error"
    pub kind: String,
    /// Affected file paths
    pub paths: Vec<String>,
    pub timestamp: f64,
}

fn should_ignore(path: &Path) -> bool {
    path.components().any(|c| {
        c.as_os_str()
            .to_str()
            .map(|s| IGNORED_DIR_NAMES.contains(&s))
            .unwrap_or(false)
    })
}

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Watch each directory non-recursively, skipping ignored trees.
/// Recursive notify on the project root would also watch node_modules and
/// can abort the Node process (inotify flood / panic=abort).
fn watch_filtered(watcher: &mut RecommendedWatcher, root: &Path) {
    if should_ignore(root) || !root.exists() {
        return;
    }
    let _ = watcher.watch(root, RecursiveMode::NonRecursive);
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() && !should_ignore(&p) {
            watch_filtered(watcher, &p);
        }
    }
}

/// Native file system watcher with 50ms debounce.
#[napi]
pub struct NativeWatcher {
    inner: Arc<Mutex<Option<RecommendedWatcher>>>,
    stop: Arc<AtomicBool>,
}

#[napi]
impl NativeWatcher {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(None)),
            stop: Arc::new(AtomicBool::new(false)),
        }
    }

    #[napi]
    pub fn get_version(&self) -> String {
        format!("rust-notify (lunx-native v{})", env!("CARGO_PKG_VERSION"))
    }

    /// Start watching the given paths.
    /// `callback` is called on every debounced file-system event.
    #[napi]
    pub fn start(
        &self,
        paths: Vec<String>,
        #[napi(ts_arg_type = "(err: null | Error, event: WatchEvent) => void")]
        callback: ThreadsafeFunction<WatchEvent>,
    ) -> Result<()> {
        self.stop.store(false, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel::<WatchEvent>();
        let stop = Arc::clone(&self.stop);

        let cb = callback;
        thread::Builder::new()
            .name("lunx-notify-debounce".into())
            .spawn(move || {
                let mut pending: HashSet<String> = HashSet::new();
                let mut last_kind = "modify".to_string();
                loop {
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    match rx.recv_timeout(Duration::from_millis(DEBOUNCE_MS)) {
                        Ok(ev) => {
                            if ev.kind != "access" {
                                last_kind = ev.kind;
                                pending.extend(ev.paths);
                            }
                        }
                        Err(RecvTimeoutError::Timeout) => {
                            if pending.is_empty() {
                                continue;
                            }
                            let watch_event = WatchEvent {
                                kind: last_kind.clone(),
                                paths: pending.drain().collect(),
                                timestamp: now_ms(),
                            };
                            let _ = cb.call(Ok(watch_event), ThreadsafeFunctionCallMode::NonBlocking);
                        }
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
            })
            .map_err(|e| Error::new(Status::GenericFailure, format!("debounce thread: {}", e)))?;

        let mut watcher = RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                match res {
                    Ok(event) => {
                        if matches!(event.kind, notify::EventKind::Access(_)) {
                            return;
                        }
                        let kind = match event.kind {
                            notify::EventKind::Create(_) => "create",
                            notify::EventKind::Modify(_) => "modify",
                            notify::EventKind::Remove(_) => "delete",
                            _ => "other",
                        };
                        let paths: Vec<String> = event
                            .paths
                            .iter()
                            .filter(|p| !should_ignore(p))
                            .filter_map(|p| p.to_str().map(|s| s.to_string()))
                            .collect();
                        if paths.is_empty() {
                            return;
                        }
                        let _ = tx.send(WatchEvent {
                            kind: kind.to_string(),
                            paths,
                            timestamp: now_ms(),
                        });
                    }
                    Err(e) => {
                        let _ = tx.send(WatchEvent {
                            kind: "error".to_string(),
                            paths: vec![e.to_string()],
                            timestamp: 0.0,
                        });
                    }
                }
            },
            Config::default(),
        )
        .map_err(|e| Error::new(Status::GenericFailure, format!("Watcher init failed: {}", e)))?;

        for path_str in &paths {
            let p = PathBuf::from(path_str);
            if !p.exists() {
                continue;
            }
            watch_filtered(&mut watcher, &p);
        }

        let mut inner = self
            .inner
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "Mutex poisoned"))?;
        *inner = Some(watcher);
        Ok(())
    }

    /// Stop watching and release all resources.
    #[napi]
    pub fn stop(&self) -> Result<()> {
        self.stop.store(true, Ordering::SeqCst);
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| Error::new(Status::GenericFailure, "Mutex poisoned"))?;
        *inner = None;
        Ok(())
    }
}

/// Convenience standalone function. The watcher is dropped at the end of this
/// call — use `new NativeWatcher()` for a persistent watcher.
#[napi(js_name = "startWatcher")]
pub fn start_watcher(
    paths: Vec<String>,
    #[napi(ts_arg_type = "(err: null | Error, event: WatchEvent) => void")]
    callback: ThreadsafeFunction<WatchEvent>,
) -> Result<()> {
    let w = NativeWatcher::new();
    w.start(paths, callback)?;
    Ok(())
}
