use std::fs;
use std::sync::{
  atomic::{AtomicU64, Ordering},
  Arc,
};

use rdev::{listen, EventType};
use tauri::{DeviceEventFilter, Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Shared running total of inputs (keystrokes + mouse clicks).
  // Privacy red line: we ONLY ever increment a counter — never which key or
  // button was pressed, never any content.
  let counter = Arc::new(AtomicU64::new(0));
  let counter_page = counter.clone();

  tauri::Builder::default()
    // Mitigates rdev dropping key events when our own window holds focus
    // (Tauri issue #14770). A desktop pet rarely holds focus, but be safe.
    .device_event_filter(DeviceEventFilter::Never)
    // Re-deliver the current count whenever the (remote) page (re)loads, so a
    // restored count shows up — we can't otherwise time the remote webview.
    .on_page_load(move |webview, _payload| {
      let _ = webview.emit("keycount", counter_page.load(Ordering::Relaxed));
    })
    .setup(move |app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let handle = app.handle().clone();

      // Persist the count next to the app's data dir; restore it on launch.
      let dir = handle.path().app_data_dir().unwrap();
      fs::create_dir_all(&dir).ok();
      let file = dir.join("keycount.txt");

      let start: u64 = fs::read_to_string(&file)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
      counter.store(start, Ordering::Relaxed);
      let _ = handle.emit("keycount", start);

      // Global input listener on its own OS thread — rdev::listen blocks.
      let (c, h, f) = (counter.clone(), handle.clone(), file.clone());
      std::thread::spawn(move || {
        let _ = listen(move |event| {
          // Count key presses and mouse clicks; ignore moves/wheel/releases.
          let counted = matches!(
            event.event_type,
            EventType::KeyPress(_) | EventType::ButtonPress(_)
          );
          if counted {
            let n = c.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = h.emit("keycount", n);
            if n % 25 == 0 {
              let _ = fs::write(&f, n.to_string());
            }
          }
        });
      });

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
