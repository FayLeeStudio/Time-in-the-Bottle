use std::fs;
use std::sync::{
  atomic::{AtomicU64, Ordering},
  Arc,
};

use rdev::{listen, EventType};
use tauri::{DeviceEventFilter, Emitter, Listener, Manager};

// Glue the menu popover to the bottle: park it just left of the main window,
// top-aligned, clamped on-screen. Called on open and whenever the bottle moves.
fn place_menu(app: &tauri::AppHandle) {
  if let (Some(main), Some(menu)) = (
    app.get_webview_window("main"),
    app.get_webview_window("menu"),
  ) {
    if let (Ok(p), Ok(ms)) = (main.outer_position(), menu.outer_size()) {
      let x = (p.x - ms.width as i32 - 8).max(0);
      let _ = menu.set_position(tauri::PhysicalPosition::new(x, p.y));
    }
  }
}

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

      // Debug builds (`npm run dev`): flip the overlay into ?debug so the menu's fill
      // tools appear with zero manual setup. Release builds (`npm run build`) stay clean.
      if cfg!(debug_assertions) {
        if let Some(main) = handle.get_webview_window("main") {
          if let Ok(url) = "https://sandtogether.indiegames.design/#overlay&debug".parse() {
            let _ = main.navigate(url);
          }
        }
      }

      // Keep the popover glued to the bottle while you drag the main window — it's a
      // child of the bottle, so it should move in lockstep (only while it's open).
      if let Some(main) = handle.get_webview_window("main") {
        let move_h = handle.clone();
        main.on_window_event(move |ev| {
          if let tauri::WindowEvent::Moved(_) = ev {
            if let Some(menu) = move_h.get_webview_window("menu") {
              if menu.is_visible().unwrap_or(false) {
                place_menu(&move_h);
              }
            }
          }
        });
      }

      // ---- menu popover window (separate frameless window; tauri.conf visible:false) ----
      // The bar's ≡ emits "menu:toggle": tap to open, tap again to close. It deliberately
      // does NOT hide on blur — so you can drag the bottle or click elsewhere while the menu
      // stays open; only another ≡ tap closes it. "app:exit" (menu's exit) quits the app.
      let open_h = handle.clone();
      handle.listen_any("menu:toggle", move |_| {
        let menu = match open_h.get_webview_window("menu") {
          Some(n) => n,
          None => return,
        };
        // tap-again-to-close: if the popover is already up, just hide it
        if menu.is_visible().unwrap_or(false) {
          let _ = menu.hide();
          return;
        }
        place_menu(&open_h);            // park it beside the bottle, then reveal
        let _ = menu.show();
        let _ = menu.set_focus();
      });
      let exit_h = handle.clone();
      handle.listen_any("app:exit", move |_| exit_h.exit(0));

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
