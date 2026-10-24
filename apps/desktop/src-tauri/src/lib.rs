//! Native shell of HERMES: owns the local Node service (agents, tools, SQLite), hands its
//! loopback URL and per-launch session token to the webview, and stops it on exit.

mod sidecar;

use std::sync::Arc;
use std::time::{Duration, Instant};

use sidecar::{BackendInfo, Sidecar};
use tauri::{Manager, RunEvent, State};

/// Waits (up to 30 s) for the local service to be ready, then returns its address and token.
#[tauri::command]
async fn backend_info(state: State<'_, Arc<Sidecar>>) -> Result<BackendInfo, String> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some(info) = state.info() {
            return Ok(info);
        }
        if let Some(err) = state.error() {
            return Err(err);
        }
        if Instant::now() > deadline {
            return Err("Le service local HERMES n'a pas démarré dans le délai imparti".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            let sidecar = Arc::new(Sidecar::default());
            sidecar.start(resource_dir);
            app.manage(sidecar);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![backend_info])
        .build(tauri::generate_context!())
        .expect("échec de l'initialisation de HERMES");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            handle.state::<Arc<Sidecar>>().stop();
        }
    });
}
