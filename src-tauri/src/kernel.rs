//! Native Python kernel: runs the user's own python3 as a child process.
//!
//! The kernel script speaks JSON lines: requests go to its stdin, protocol replies come back on
//! stdout (`kernel://msg`), and anything written straight to its file descriptors — C
//! extensions, `os.system`, subprocesses — arrives on stderr (`kernel://raw`). Every event
//! carries the generation number the frontend chose, so output from a killed kernel is ignored.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

const KERNEL_PY: &str = include_str!("../../src/kernel/native.py");
const PRELUDE_PY: &str = include_str!("../../src/kernel/prelude.py");

struct Proc {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct KernelState(Mutex<Option<Proc>>);

#[derive(Clone, Serialize)]
struct Line {
    gen: u32,
    line: String,
}

#[derive(Serialize)]
pub struct Started {
    python: String,
}

#[tauri::command]
pub fn kernel_start(
    app: AppHandle,
    state: State<KernelState>,
    gen: u32,
    python: Option<String>,
) -> Result<Started, String> {
    kill(&state);

    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("kernel");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join("calx_kernel.py");
    std::fs::write(&script, KERNEL_PY).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("calx_prelude.py"), PRELUDE_PY).map_err(|e| e.to_string())?;

    let path_env = login_path();
    let exe = resolve_python(python.as_deref(), &path_env).ok_or_else(|| {
        "python3 not found — install Python (e.g. `brew install python`) or point calx at one with :python /path/to/python3".to_string()
    })?;

    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_else(|| dir.clone());
    let mut child = Command::new(&exe)
        .arg("-u")
        .arg(&script)
        .current_dir(home)
        .env("PATH", &path_env)
        .env("MPLBACKEND", "Agg")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", exe.display()))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    forward(app.clone(), stdout, gen, "kernel://msg", Some("kernel://exit"));
    forward(app, stderr, gen, "kernel://raw", None);

    *state.0.lock().unwrap() = Some(Proc { child, stdin });
    Ok(Started { python: exe.display().to_string() })
}

#[tauri::command]
pub fn kernel_send(state: State<KernelState>, line: String) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let proc = guard.as_mut().ok_or("kernel is not running")?;
    writeln!(proc.stdin, "{line}")
        .and_then(|_| proc.stdin.flush())
        .map_err(|e| e.to_string())
}

/// Raise KeyboardInterrupt in the running code without losing the session.
#[tauri::command]
pub fn kernel_interrupt(state: State<KernelState>) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let proc = guard.as_ref().ok_or("kernel is not running")?;
    #[cfg(unix)]
    {
        // SAFETY: plain signal delivery to a child we own.
        if unsafe { libc::kill(proc.child.id() as libc::pid_t, libc::SIGINT) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = proc;
        Err("interrupt is not supported on this platform".into())
    }
}

#[tauri::command]
pub fn kernel_stop(state: State<KernelState>) {
    kill(&state);
}

pub fn kill(state: &KernelState) {
    if let Some(mut proc) = state.0.lock().unwrap().take() {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
}

fn forward<R: Read + Send + 'static>(
    app: AppHandle,
    stream: R,
    gen: u32,
    event: &'static str,
    on_close: Option<&'static str>,
) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buf).trim_end_matches(['\n', '\r']).to_string();
                    let _ = app.emit(event, Line { gen, line });
                }
            }
        }
        if let Some(close) = on_close {
            let _ = app.emit(close, Line { gen, line: String::new() });
        }
    });
}

/// Apps launched from Finder get a minimal PATH, so ask the login shell for the real one
/// (that's where Homebrew, pyenv and conda put python3).
fn login_path() -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Ok(shell) = std::env::var("SHELL") {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let out = Command::new(shell)
                .args(["-ilc", "printf '__CALX__%s__CALX__' \"$PATH\""])
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output();
            let _ = tx.send(out);
        });
        if let Ok(Ok(out)) = rx.recv_timeout(Duration::from_secs(5)) {
            let text = String::from_utf8_lossy(&out.stdout);
            if let Some(path) = text.split("__CALX__").nth(1) {
                parts.extend(path.split(':').map(String::from));
            }
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        parts.extend(path.split(':').map(String::from));
    }
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        parts.push(extra.to_string());
    }
    let mut seen = std::collections::HashSet::new();
    parts.retain(|p| !p.is_empty() && seen.insert(p.clone()));
    parts.join(":")
}

fn resolve_python(explicit: Option<&str>, path_env: &str) -> Option<PathBuf> {
    if let Some(p) = explicit.map(str::trim).filter(|p| !p.is_empty()) {
        let p = match (p.strip_prefix("~/"), std::env::var_os("HOME")) {
            (Some(rest), Some(home)) => Path::new(&home).join(rest),
            _ => PathBuf::from(p),
        };
        return p.is_file().then_some(p);
    }
    path_env
        .split(':')
        .flat_map(|dir| ["python3", "python"].map(|name| Path::new(dir).join(name)))
        .find(|p| p.is_file())
}
