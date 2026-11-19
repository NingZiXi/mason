//! The Win32 window region also clips the child WebView and the native hit area.
use std::cell::Cell;
use tauri::{Manager, WindowEvent};
use windows::Win32::{
    Foundation::{HWND, RECT},
    Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn},
    UI::{
        HiDpi::GetDpiForWindow,
        WindowsAndMessaging::{GetWindowRect, IsIconic, IsZoomed},
    },
};

const WINDOW_RADIUS_DIP: u32 = 16;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Frame {
    Square,
    Rounded {
        width: i32,
        height: i32,
        diameter: i32,
    },
}

impl Frame {
    fn rounded(width: i32, height: i32, dpi: u32) -> Self {
        let diameter = ((2 * WINDOW_RADIUS_DIP * dpi + 48) / 96) as i32;
        Self::Rounded {
            width,
            height,
            diameter,
        }
    }

    fn apply(self, hwnd: HWND) -> bool {
        unsafe {
            let region = match self {
                Self::Square => None,
                Self::Rounded {
                    width,
                    height,
                    diameter,
                } => {
                    // This GDI primitive excludes the last scanline at right and bottom.
                    let r = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
                    if r.0.is_null() {
                        return false;
                    }
                    Some(r)
                }
            };
            if SetWindowRgn(hwnd, region, true) != 0 {
                return true;
            }
            // Windows takes ownership only when SetWindowRgn succeeds.
            if let Some(r) = region {
                let _ = DeleteObject(r.into());
            }
            false
        }
    }
}

/// An undecorated Tao window with a system shadow has non-client insets on three
/// sides. A Win32 region exposes those insets as an opaque gray band. Disable the
/// shadow *before* creating the HWND/WebView so content and native resize hit tests
/// both extend to the same silhouette, starting with the first frame.
pub fn configure(mut context: tauri::Context<tauri::Wry>) -> tauri::Context<tauri::Wry> {
    if let Some(main) = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|w| w.label == "main")
    {
        main.shadow = false;
    }
    context
}

pub fn install(app: &tauri::App) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let Ok(handle) = main.hwnd() else { return };
    // This callback is scoped to the owning window; retain neither it nor its WebView.
    let raw = handle.0 as usize;
    let last = Cell::new(None);
    let sync = move || {
        let hwnd = HWND(raw as _);
        let frame = unsafe {
            if IsIconic(hwnd).as_bool() {
                return;
            }
            if IsZoomed(hwnd).as_bool() {
                Frame::Square
            } else {
                let mut rect = RECT::default();
                if GetWindowRect(hwnd, &mut rect).is_err() {
                    return;
                }
                let (w, h) = (rect.right - rect.left, rect.bottom - rect.top);
                let dpi = GetDpiForWindow(hwnd);
                if w <= 0 || h <= 0 || dpi == 0 {
                    return;
                }
                Frame::rounded(w, h, dpi)
            }
        };
        if last.replace(Some(frame)) != Some(frame) && !frame.apply(hwnd) {
            last.set(None);
        }
    };
    sync();
    main.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            sync();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{
        core::w,
        Win32::{
            Graphics::Gdi::{CreateRectRgn, GetWindowRgn, PtInRegion},
            UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_POPUP},
        },
    };

    #[test]
    fn actual_window_region_tracks_dpi_and_releases_all_edges_when_square() {
        unsafe {
            // A hidden top-level window exercises the same GDI path without touching the desktop.
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                None,
                WS_POPUP,
                0,
                0,
                500,
                300,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let probe = CreateRectRgn(0, 0, 0, 0);
            for dpi in [96, 192] {
                assert!(Frame::rounded(500, 300, dpi).apply(hwnd));
                assert_ne!(GetWindowRgn(hwnd, probe).0, 0);
                for (x, y) in [(0, 0), (499, 0), (0, 299), (499, 299)] {
                    assert!(!PtInRegion(probe, x, y).as_bool());
                }
                for (x, y) in [(250, 0), (499, 150), (250, 299), (0, 150)] {
                    assert!(PtInRegion(probe, x, y).as_bool());
                }
                assert_eq!(PtInRegion(probe, 7, 7).as_bool(), dpi == 96);
            }
            assert!(Frame::Square.apply(hwnd));
            assert_eq!(GetWindowRgn(hwnd, probe).0, 0);
            let _ = DeleteObject(probe.into());
            DestroyWindow(hwnd).unwrap();
        }
    }
}
