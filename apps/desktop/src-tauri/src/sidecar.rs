use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct BackendInfo {
    pub url: String,
    pub token: String,
}

/// Lifecycle of the Node service. The service binds 127.0.0.1 only and requires the token.
#[derive(Default)]
pub struct Sidecar {
    info: Arc<Mutex<Option<BackendInfo>>>,
    error: Arc<Mutex<Option<String>>>,
    child: Mutex<Option<Child>>,
    // Kept open: the service exits by itself when this pipe closes (e.g. if HERMES crashes).
    stdin: Mutex<Option<ChildStdin>>,
}

fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("générateur aléatoire indisponible : {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Parses the service ready line (`HERMES_READY port=1234 …`); the line never carries the token.
pub fn parse_ready_port(line: &str) -> Option<u16> {
    let rest = line.strip_prefix("HERMES_READY port=")?;
    rest.split_whitespace().next()?.parse().ok()
}

/// Tauri returns `\\?\C:\...` verbatim paths on Windows; Node cannot use them as a main script path.
pub fn strip_verbatim(p: &Path) -> PathBuf {
    let s = p.display().to_string();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p.to_path_buf(),
    }
}

/// Command line of the service: bundled script in release builds, TypeScript sources in development.
fn service_command(resource_dir: Option<&Path>) -> Result<(PathBuf, Vec<String>, PathBuf), String> {
    let node = std::env::var("HERMES_NODE").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("node"));
    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        let tsx = repo.join("node_modules/tsx/dist/cli.mjs");
        let main = repo.join("apps/server/src/main.ts");
        return Ok((node, vec![tsx.display().to_string(), main.display().to_string()], repo.join("workers")));
    }
    let res = strip_verbatim(resource_dir.ok_or("dossier de ressources introuvable")?);
    let script = res.join("server").join("hermes-server.mjs");
    if !script.exists() {
        return Err(format!("service introuvable : {}", script.display()));
    }
    Ok((node, vec![script.display().to_string()], res.join("workers")))
}

impl Sidecar {
    pub fn info(&self) -> Option<BackendInfo> {
        self.info.lock().ok()?.clone()
    }

    pub fn error(&self) -> Option<String> {
        self.error.lock().ok()?.clone()
    }

    pub fn start(&self, resource_dir: Option<PathBuf>) {
        if let Err(e) = self.try_start(resource_dir) {
            if let Ok(mut slot) = self.error.lock() {
                *slot = Some(e);
            }
        }
    }

    fn try_start(&self, resource_dir: Option<PathBuf>) -> Result<(), String> {
        let token = new_token()?;
        let (node, args, workers) = service_command(resource_dir.as_deref())?;
        let mut cmd = Command::new(&node);
        cmd.args(&args)
            .env("HERMES_TOKEN", &token)
            .env("HERMES_PORT", "0")
            .env("HERMES_EXIT_ON_STDIN_CLOSE", "1")
            .env("HERMES_WORKERS_DIR", &workers)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Impossible de lancer Node.js ({}) : {e}. Node.js 22.13+ doit être installé.", node.display()))?;
        let stdout = child.stdout.take().ok_or("sortie du service indisponible")?;
        *self.stdin.lock().map_err(|e| e.to_string())? = child.stdin.take();
        *self.child.lock().map_err(|e| e.to_string())? = Some(child);

        let info = Arc::clone(&self.info);
        let error = Arc::clone(&self.error);
        std::thread::spawn(move || {
            let mut ready = false;
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(port) = parse_ready_port(&line) {
                    if let Ok(mut slot) = info.lock() {
                        *slot = Some(BackendInfo { url: format!("http://127.0.0.1:{port}"), token: token.clone() });
                    }
                    ready = true;
                }
            }
            if let Ok(mut slot) = info.lock() {
                *slot = None;
            }
            if let Ok(mut e) = error.lock() {
                *e = Some(if ready {
                    "Le service local HERMES s'est arrêté".into()
                } else {
                    "Le service local HERMES n'a pas pu démarrer (voir les journaux)".into()
                });
            }
        });
        Ok(())
    }

    pub fn stop(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take(); // closing stdin asks the service to shut down cleanly
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(mut c) = child.take() {
                for _ in 0..30 {
                    if matches!(c.try_wait(), Ok(Some(_))) {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                let _ = c.kill();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ready_line() {
        assert_eq!(parse_ready_port("HERMES_READY port=51234 startupMs=120"), Some(51234));
        assert_eq!(parse_ready_port("HERMES_READY port=8080"), Some(8080));
    }

    #[test]
    fn rejects_other_lines() {
        assert_eq!(parse_ready_port("HERMES_READY port=abc"), None);
        assert_eq!(parse_ready_port("random output"), None);
        assert_eq!(parse_ready_port("HERMES_READY port=99999"), None);
    }

    #[test]
    fn strips_windows_verbatim_prefix() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\Program Files\HERMES")), PathBuf::from(r"C:\Program Files\HERMES"));
        assert_eq!(strip_verbatim(Path::new(r"C:\x")), PathBuf::from(r"C:\x"));
        assert_eq!(strip_verbatim(Path::new(r"\\?\UNC\srv\share")), PathBuf::from(r"\\?\UNC\srv\share"));
    }

    #[test]
    fn token_is_64_hex_chars_and_random() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
