import sys

with open('src-tauri/src/lib.rs', 'r', encoding='utf-8') as f:
    content = f.read()

CLIPBOARD_CODE = """
#[cfg(target_os = "windows")]
fn backup_clipboard() -> Result<Vec<(u32, Vec<u8>)>, String> {
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hWnd: isize) -> i32;
        fn CloseClipboard() -> i32;
        fn EnumClipboardFormats(format: u32) -> u32;
        fn GetClipboardData(uFormat: u32) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalLock(hMem: isize) -> *const u8;
        fn GlobalUnlock(hMem: isize) -> i32;
        fn GlobalSize(hMem: isize) -> usize;
    }

    let mut backup = Vec::new();
    unsafe {
        if OpenClipboard(0) == 0 {
            return Err("Не удалось открыть буфер обмена для бэкапа".to_string());
        }
        let mut format = 0;
        loop {
            format = EnumClipboardFormats(format);
            if format == 0 {
                break;
            }
            if format == 2 || format == 8 || format == 17 {
                continue;
            }
            let h_mem = GetClipboardData(format);
            if h_mem != 0 {
                let size = GlobalSize(h_mem);
                if size > 0 && size < 1024 * 1024 * 10 {
                    let ptr = GlobalLock(h_mem);
                    if !ptr.is_null() {
                        let mut data = vec![0u8; size];
                        std::ptr::copy_nonoverlapping(ptr, data.as_mut_ptr(), size);
                        GlobalUnlock(h_mem);
                        backup.push((format, data));
                    }
                }
            }
        }
        CloseClipboard();
    }
    Ok(backup)
}

#[cfg(target_os = "windows")]
fn restore_clipboard(backup: Vec<(u32, Vec<u8>)>) -> Result<(), String> {
    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hWnd: isize) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(uFormat: u32, hMem: isize) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(uFlags: u32, dwBytes: usize) -> isize;
        fn GlobalLock(hMem: isize) -> *mut u8;
        fn GlobalUnlock(hMem: isize) -> i32;
    }
    const GMEM_MOVEABLE: u32 = 2;

    unsafe {
        if OpenClipboard(0) == 0 {
            return Err("Не удалось открыть буфер обмена для восстановления".to_string());
        }
        EmptyClipboard();

        for (format, data) in backup {
            let size = data.len();
            let h_mem = GlobalAlloc(GMEM_MOVEABLE, size);
            if h_mem != 0 {
                let ptr = GlobalLock(h_mem);
                if !ptr.is_null() {
                    std::ptr::copy_nonoverlapping(data.as_ptr(), ptr, size);
                    GlobalUnlock(h_mem);
                    SetClipboardData(format, h_mem);
                }
            }
        }
        CloseClipboard();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn simulate_ctrl_c() {
    #[repr(C)]
    struct INPUT {
        type_: u32,
        u: INPUT_UNION,
    }
    #[repr(C)]
    union INPUT_UNION {
        ki: KEYBDINPUT,
        mi: [u8; 32],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct KEYBDINPUT {
        wVk: u16,
        wScan: u16,
        dwFlags: u32,
        time: u32,
        dwExtraInfo: usize,
    }
    const INPUT_KEYBOARD: u32 = 1;
    const KEYEVENTF_KEYUP: u32 = 2;
    const VK_CONTROL: u16 = 17;
    const VK_C: u16 = 67;

    #[link(name = "user32")]
    extern "system" {
        fn SendInput(cInputs: u32, pInputs: *const INPUT, cbSize: i32) -> u32;
    }

    unsafe {
        let ctrl_down = INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION {
                ki: KEYBDINPUT { wVk: VK_CONTROL, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 },
            },
        };
        let c_down = INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION {
                ki: KEYBDINPUT { wVk: VK_C, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 },
            },
        };
        let c_up = INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION {
                ki: KEYBDINPUT { wVk: VK_C, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 },
            },
        };
        let ctrl_up = INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION {
                ki: KEYBDINPUT { wVk: VK_CONTROL, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 },
            },
        };

        let inputs = [ctrl_down, c_down, c_up, ctrl_up];
        SendInput(4, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
}

#[tauri::command]
async fn capture_clipboard_text(app_handle: tauri::AppHandle, translate: bool) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let backup = backup_clipboard().unwrap_or_default();
        let _ = set_clipboard_text("");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        simulate_ctrl_c();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        let text = get_clipboard_text_raw().unwrap_or_default();
        let _ = restore_clipboard(backup);

        if text.trim().is_empty() { return Ok("".to_string()); }

        if translate {
            let config = load_config_internal(&app_handle)?;
            let translated = crate::translator::translate_hybrid(&text, &config.api_key, &config.ai_model).await?;
            return Ok(translated);
        }
        Ok(text)
    }
    #[cfg(not(target_os = "windows"))]
    { Err("Поддерживается только Windows".to_string()) }
}

#[tauri::command]
fn set_ignore_cursor_events(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?;
    Ok(())
}
"""

if 'pub struct CursorPos' in content:
    content = content.replace(
        '#[derive(serde::Serialize)]\npub struct CursorPos',
        CLIPBOARD_CODE + '\n#[derive(serde::Serialize)]\npub struct CursorPos'
    )

old_run_block = """pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {}))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {"""

new_run_block = """pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {}))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+q", "ctrl+shift", "ctrl+alt"])
                .unwrap()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if shortcut.matches(tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyQ) {
                            if let Some(w) = app.get_webview_window("ocr") {
                                if w.is_visible().unwrap_or(false) {
                                    let _ = w.hide();
                                } else {
                                    let _ = w.show();
                                    let _ = w.set_focus();
                                }
                            }
                        } else if shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::SHIFT, tauri_plugin_global_shortcut::Code::Unidentified) || shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::SHIFT, tauri_plugin_global_shortcut::Code::ShiftLeft) || shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::SHIFT, tauri_plugin_global_shortcut::Code::ShiftRight) {
                            let _ = app.emit("tts-action-read", ());
                        } else if shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::Unidentified) || shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::AltLeft) || shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::AltRight) {
                            let _ = app.emit("tts-action-translate", ());
                        }
                    }
                })
                .build()
        )
        .setup(|app| {"""

content = content.replace(old_run_block, new_run_block)
content = content.replace('set_click_region\n        ])', 'set_click_region,\n            set_ignore_cursor_events,\n            capture_clipboard_text\n        ])')

with open('src-tauri/src/lib.rs', 'w', encoding='utf-8') as f:
    f.write(content)
