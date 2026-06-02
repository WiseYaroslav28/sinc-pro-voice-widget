use tauri::{Emitter, Manager};
use serde::{Serialize, Deserialize};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chrono::Local;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
static CTRL_PRESSED: AtomicBool = AtomicBool::new(false);
static WIN_PRESSED: AtomicBool = AtomicBool::new(false);
static ALT_PRESSED: AtomicBool = AtomicBool::new(false);
static SHORTCUT_ACTIVE: AtomicBool = AtomicBool::new(false);
static FORCE_SEND_ACTIVE: AtomicBool = AtomicBool::new(false);
static RECORDING_OR_PAUSED: AtomicBool = AtomicBool::new(false);

#[repr(C)]
struct POINT {
    x: i32,
    y: i32,
}

#[repr(C)]
struct MSG {
    hwnd: isize,
    message: u32,
    wParam: usize,
    lParam: isize,
    time: u32,
    pt: POINT,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct KBDLLHOOKSTRUCT {
    vkCode: u32,
    scanCode: u32,
    flags: u32,
    time: u32,
    dwExtraInfo: usize,
}

const WH_KEYBOARD_LL: i32 = 13;
const WM_KEYDOWN: usize = 0x0100;
const WM_KEYUP: usize = 0x0101;
const WM_SYSKEYDOWN: usize = 0x0104;
const WM_SYSKEYUP: usize = 0x0105;

const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_ESCAPE: u32 = 0x1B;

#[link(name = "user32")]
extern "system" {
    fn SetWindowsHookExW(
        idHook: i32,
        lpfn: Option<unsafe extern "system" fn(code: i32, w_param: usize, l_param: isize) -> isize>,
        hmod: isize,
        dwThreadId: u32,
    ) -> isize;
    fn UnhookWindowsHookEx(hhk: isize) -> i32;
    fn CallNextHookEx(hhk: isize, nCode: i32, wParam: usize, lParam: isize) -> isize;
    fn GetMessageW(lpMsg: *mut MSG, hWnd: isize, wMsgFilterMin: u32, wMsgFilterMax: u32) -> i32;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(lpModuleName: *const u16) -> isize;
}

unsafe extern "system" fn low_level_keyboard_proc(code: i32, w_param: usize, l_param: isize) -> isize {
    if code >= 0 {
        let info = *(l_param as *const KBDLLHOOKSTRUCT);
        let vk = info.vkCode;
        let is_key_down = w_param == WM_KEYDOWN || w_param == WM_SYSKEYDOWN;

        let mut state_changed = false;

        if vk == VK_LCONTROL || vk == VK_RCONTROL {
            let prev = CTRL_PRESSED.swap(is_key_down, Ordering::SeqCst);
            if prev != is_key_down {
                state_changed = true;
            }
        } else if vk == VK_LWIN || vk == VK_RWIN {
            let prev = WIN_PRESSED.swap(is_key_down, Ordering::SeqCst);
            if prev != is_key_down {
                state_changed = true;
            }
        } else if vk == VK_LMENU || vk == VK_RMENU {
            let prev = ALT_PRESSED.swap(is_key_down, Ordering::SeqCst);
            if prev != is_key_down {
                state_changed = true;
            }
        } else if vk == VK_ESCAPE && is_key_down {
            if RECORDING_OR_PAUSED.load(Ordering::SeqCst) {
                if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                    let _ = app.emit("global-escape", ());
                }
            }
        }

        if state_changed {
            let ctrl = CTRL_PRESSED.load(Ordering::SeqCst);
            let win = WIN_PRESSED.load(Ordering::SeqCst);
            let alt = ALT_PRESSED.load(Ordering::SeqCst);

            if ctrl && win {
                if alt {
                    if !FORCE_SEND_ACTIVE.swap(true, Ordering::SeqCst) {
                        if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                            let _ = app.emit("global-force-send", ());
                        }
                    }
                } else {
                    if !SHORTCUT_ACTIVE.swap(true, Ordering::SeqCst) {
                        if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                            let _ = app.emit("global-shortcut-pressed", ());
                        }
                    }
                }
            } else {
                if SHORTCUT_ACTIVE.load(Ordering::SeqCst) && (!ctrl || !win) {
                    SHORTCUT_ACTIVE.store(false, Ordering::SeqCst);
                    if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                        let _ = app.emit("global-shortcut-released", ());
                    }
                }
                if FORCE_SEND_ACTIVE.load(Ordering::SeqCst) && (!ctrl || !win || !alt) {
                    FORCE_SEND_ACTIVE.store(false, Ordering::SeqCst);
                }
            }
        }
    }
    CallNextHookEx(0, code, w_param, l_param)
}

#[tauri::command]
fn set_capsule_active(active: bool) {
    RECORDING_OR_PAUSED.store(active, Ordering::SeqCst);
}


#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    #[serde(default = "default_ui_lang")]
    pub ui_lang: String,
    #[serde(default = "default_dictation_lang")]
    pub dictation_lang: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
}

fn default_ui_lang() -> String { "ru".to_string() }
fn default_dictation_lang() -> String { "auto".to_string() }
fn default_ai_model() -> String { "gemini-2.0-pro-exp".to_string() }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HistoryEntry {
    pub id: String,
    pub timestamp: String,
    pub duration_secs: u32,
    pub preset: String,
    pub preset_label: String,
    pub transcript: String,
    pub audio_path: String,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiContent>,
}

#[derive(Deserialize)]
struct GeminiContent {
    parts: Option<Vec<GeminiPart>>,
}

#[derive(Deserialize)]
struct GeminiPart {
    text: Option<String>,
}

fn load_config_internal(app_handle: &tauri::AppHandle) -> Result<AppConfig, String> {
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let config_path = config_dir.join("config.json");
    if !config_path.exists() {
        return Ok(AppConfig {
            ui_lang: "ru".to_string(),
            dictation_lang: "auto".to_string(),
            api_key: "".to_string(),
            ai_model: "gemini-2.0-pro-exp".to_string(),
        });
    }
    let json_str = std::fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let config: AppConfig = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    Ok(config)
}

#[tauri::command]
async fn load_config(app_handle: tauri::AppHandle) -> Result<AppConfig, String> {
    load_config_internal(&app_handle)
}

#[tauri::command]
async fn save_config(app_handle: tauri::AppHandle, config: AppConfig) -> Result<(), String> {
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("config.json");
    let json_str = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path, json_str).map_err(|e| e.to_string())?;
    Ok(())
}

fn load_history_internal(app_handle: &tauri::AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    let history_path = config_dir.join("history.json");
    if !history_path.exists() {
        return Ok(Vec::new());
    }
    let json_str = std::fs::read_to_string(history_path).map_err(|e| e.to_string())?;
    let history: Vec<HistoryEntry> = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    Ok(history)
}

fn save_history_internal(app_handle: &tauri::AppHandle, history: &Vec<HistoryEntry>) -> Result<(), String> {
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let history_path = config_dir.join("history.json");
    let json_str = serde_json::to_string_pretty(history).map_err(|e| e.to_string())?;
    std::fs::write(history_path, json_str).map_err(|e| e.to_string())?;
    Ok(())
}

fn save_to_history_internal(app_handle: &tauri::AppHandle, entry: HistoryEntry) -> Result<(), String> {
    let mut history = load_history_internal(app_handle)?;
    history.insert(0, entry);
    if history.len() > 50 {
        history.truncate(50);
    }
    save_history_internal(app_handle, &history)
}

#[tauri::command]
async fn load_history(app_handle: tauri::AppHandle) -> Result<Vec<HistoryEntry>, String> {
    load_history_internal(&app_handle)
}

#[tauri::command]
async fn delete_history_entry(app_handle: tauri::AppHandle, id: String) -> Result<Vec<HistoryEntry>, String> {
    let mut history = load_history_internal(&app_handle)?;
    if let Some(entry) = history.iter().find(|e| e.id == id) {
        let path = std::path::Path::new(&entry.audio_path);
        if path.exists() {
            let _ = std::fs::remove_file(path);
        }
    }
    history.retain(|e| e.id != id);
    save_history_internal(&app_handle, &history)?;
    let _ = app_handle.emit("history-updated", ());
    Ok(history)
}

#[tauri::command]
async fn open_audio_folder(path: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    if path.exists() {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    } else {
        return Err("Файл не существует".to_string());
    }
    Ok(())
}

fn get_preset_prompt_and_label(preset: &str) -> (&'static str, &'static str) {
    match preset {
        "tasks" => (
            "Прослушай запись и выдели все поручения, задачи, действия и сроки, которые упоминаются. Сделай структурированный список задач TODO на русском языке.",
            "Задачи"
        ),
        "transcript" => (
            "Сделай полную дословную транскрипцию (стенограмму) аудиозаписи на языке оригинала без лишних комментариев.",
            "Дословно"
        ),
        "email" => (
            "На основе этой аудиозаписи составь структурированное деловое письмо (email) на русском языке.",
            "Письмо"
        ),
        _ => (
            "Сделай краткое содержание этой аудиозаписи на русском языке. Выдели основные тезисы, ключевые моменты и выводы.",
            "Собрать суть"
        ),
    }
}

#[tauri::command]
async fn save_audio(
    app_handle: tauri::AppHandle,
    bytes: Vec<u8>,
    duration_secs: u32,
    preset: String,
    custom_prompt: Option<String>,
    is_cancelled: Option<bool>,
) -> Result<HistoryEntry, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let records_dir = app_data_dir.join("records");
    std::fs::create_dir_all(&records_dir).map_err(|e| e.to_string())?;

    let now_millis = Local::now().timestamp_millis();
    let id = format!("rec_{}", now_millis);
    let file_name = format!("{}.webm", id);
    let file_path = records_dir.join(&file_name);
    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;

    let timestamp = Local::now().format("%d.%m.%Y • %H:%M").to_string();

    // Если запись отменена пользователем — сохраняем в историю без Gemini
    if is_cancelled.unwrap_or(false) {
        let entry = HistoryEntry {
            id: id.clone(),
            timestamp,
            duration_secs,
            preset: "cancelled".to_string(),
            preset_label: "Отменено".to_string(),
            transcript: "[Запись отменена пользователем]".to_string(),
            audio_path: file_path.to_string_lossy().to_string(),
        };
        save_to_history_internal(&app_handle, entry.clone())?;
        let _ = app_handle.emit("history-updated", entry.clone());
        return Ok(entry);
    }

    // Проверяем наличие API-ключа
    let config = load_config_internal(&app_handle)?;
    if config.api_key.trim().is_empty() {
        // Нет API-ключа — сохраняем аудио в историю с пометкой
        let error_msg = "[Ошибка: API-ключ Gemini не настроен. Укажите его в Настройках дашборда и переотправьте запись]";
        let entry = HistoryEntry {
            id: id.clone(),
            timestamp,
            duration_secs,
            preset: "error".to_string(),
            preset_label: "Ошибка API".to_string(),
            transcript: error_msg.to_string(),
            audio_path: file_path.to_string_lossy().to_string(),
        };
        save_to_history_internal(&app_handle, entry.clone())?;
        let _ = app_handle.emit("history-updated", entry.clone());
        return Ok(entry);
    }

    let base64_audio = STANDARD.encode(&bytes);

    let (prompt_text, preset_label) = if let Some(ref cp) = custom_prompt {
        if !cp.trim().is_empty() {
            (cp.as_str(), "Свой промпт")
        } else {
            get_preset_prompt_and_label(&preset)
        }
    } else {
        get_preset_prompt_and_label(&preset)
    };

    let client = reqwest::Client::new();
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        config.ai_model, config.api_key
    );

    let request_payload = serde_json::json!({
        "contents": [
            {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": "audio/webm",
                            "data": base64_audio
                        }
                    },
                    {
                        "text": prompt_text
                    }
                ]
            }
        ]
    });

    // Выполняем запрос к Gemini и при любой ошибке всё равно сохраняем в историю
    let gemini_result = async {
        let res = client.post(&url)
            .json(&request_payload)
            .send()
            .await
            .map_err(|e| format!("Ошибка отправки запроса в Gemini: {}", e))?;

        let status = res.status();
        if !status.is_success() {
            let err_text = res.text().await.unwrap_or_default();
            return Err(format!("Gemini API вернул ошибку (код {}): {}", status, err_text));
        }

        let gemini_res: GeminiResponse = res.json()
            .await
            .map_err(|e| format!("Ошибка парсинга ответа Gemini: {}", e))?;

        gemini_res.candidates
            .and_then(|c| c.into_iter().next())
            .and_then(|c| c.content)
            .and_then(|c| c.parts)
            .and_then(|p| p.into_iter().next())
            .and_then(|p| p.text)
            .ok_or_else(|| "Gemini вернул пустой ответ или не смог распознать аудио.".to_string())
    }.await;

    // В любом случае сохраняем запись в историю
    let (final_preset, final_label, final_transcript) = match gemini_result {
        Ok(text) => {
            let lbl = if preset_label == "Свой промпт" { "custom".to_string() } else { preset.clone() };
            (lbl, preset_label.to_string(), text)
        },
        Err(err_msg) => {
            // Ошибка API — сохраняем с пометкой
            (
                "error".to_string(),
                "Ошибка API".to_string(),
                format!("[Ошибка Gemini API: {}]", err_msg),
            )
        }
    };

    let entry = HistoryEntry {
        id: id.clone(),
        timestamp,
        duration_secs,
        preset: final_preset,
        preset_label: final_label,
        transcript: final_transcript,
        audio_path: file_path.to_string_lossy().to_string(),
    };

    save_to_history_internal(&app_handle, entry.clone())?;
    let _ = app_handle.emit("history-updated", entry.clone());

    Ok(entry)
}

#[cfg(target_os = "windows")]
fn set_clipboard_text(text: &str) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hWndNewOwner: isize) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(uFormat: u32, hMem: isize) -> isize;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalAlloc(uFlags: u32, dwBytes: usize) -> isize;
        fn GlobalLock(hMem: isize) -> *mut u16;
        fn GlobalUnlock(hMem: isize) -> i32;
    }

    const CF_UNICODETEXT: u32 = 13;
    const GMEM_MOVEABLE: u32 = 2;

    let wide: Vec<u16> = OsStr::new(text).encode_wide().chain(std::iter::once(0)).collect();
    let size = wide.len() * 2;

    unsafe {
        if OpenClipboard(0) == 0 {
            return Err("Не удалось открыть буфер обмена".to_string());
        }
        EmptyClipboard();
        let h_mem = GlobalAlloc(GMEM_MOVEABLE, size);
        if h_mem == 0 {
            CloseClipboard();
            return Err("Ошибка выделения памяти для буфера".to_string());
        }
        let ptr = GlobalLock(h_mem);
        if ptr.is_null() {
            CloseClipboard();
            return Err("Ошибка блокировки памяти".to_string());
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
        GlobalUnlock(h_mem);
        if SetClipboardData(CF_UNICODETEXT, h_mem) == 0 {
            CloseClipboard();
            return Err("Ошибка записи данных".to_string());
        }
        CloseClipboard();
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn is_insertion_possible() -> bool {
    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> isize;
        fn GetClassNameW(hWnd: isize, lpClassName: *mut u16, nMaxCount: i32) -> i32;
    }

    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd == 0 {
        return false;
    }

    let mut class_name = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, class_name.as_mut_ptr(), 256) };
    if len > 0 {
        let class_str = String::from_utf16_lossy(&class_name[..len as usize]);
        let class_lower = class_str.to_lowercase();
        // Классы окон рабочего стола и панели задач
        if class_lower.contains("progman") || class_lower.contains("workerw") || class_lower.contains("shell_traywnd") {
            return false;
        }
    }
    true
}

#[cfg(target_os = "windows")]
fn simulate_ctrl_v() {
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
    const VK_V: u16 = 86;

    #[link(name = "user32")]
    extern "system" {
        fn SendInput(cInputs: u32, pInputs: *const INPUT, cbSize: i32) -> u32;
    }

    unsafe {
        let ctrl_down = INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                }
            }
        };
        let v_down = INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION {
                ki: KEYBDINPUT {
                    wVk: VK_V,
                    wScan: 0,
                    dwFlags: 0,
                    time: 0,
                    dwExtraInfo: 0,
                }
            }
        };
        let v_up = INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION {
                ki: KEYBDINPUT {
                    wVk: VK_V,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                }
            }
        };
        let ctrl_up = INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION {
                ki: KEYBDINPUT {
                    wVk: VK_CONTROL,
                    wScan: 0,
                    dwFlags: KEYEVENTF_KEYUP,
                    time: 0,
                    dwExtraInfo: 0,
                }
            }
        };

        let inputs = [ctrl_down, v_down, v_up, ctrl_up];
        SendInput(4, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
}

fn show_result_window(app_handle: &tauri::AppHandle, text: String) {
    if let Some(win) = app_handle.get_webview_window("result") {
        let _ = win.emit("set-result-text", text);
        let _ = win.show();
        let _ = win.set_focus();
    }
}

#[tauri::command]
async fn paste_text(app_handle: tauri::AppHandle, text: String) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let possible = is_insertion_possible();
        let _ = set_clipboard_text(&text);
        if possible {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            simulate_ctrl_v();
            Ok(true)
        } else {
            show_result_window(&app_handle, text);
            Ok(false)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        show_result_window(&app_handle, text);
        Ok(false)
    }
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn resize_bottom_up_phys(
    window: tauri::Window,
    width: i32,
    height: i32,
    x: i32,
    y: i32,
) -> Result<(), String> {
    if width <= 0 || height <= 0 {
        return Err("Ширина и высота должны быть положительными числами".into());
    }

    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let hwnd = match window.window_handle().map_err(|e| e.to_string())?.as_raw() {
        RawWindowHandle::Win32(handle) => handle.hwnd.get() as isize,
        _ => return Err("Текущее окно не является Win32 HWND".into()),
    };

    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hWnd: isize,
            hWndInsertAfter: isize,
            X: i32,
            Y: i32,
            cx: i32,
            cy: i32,
            uFlags: u32,
        ) -> i32;
    }

    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOOWNERZORDER: u32 = 0x0200;

    unsafe {
        let res = SetWindowPos(
            hwnd,
            0,
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        );
        if res == 0 {
            return Err("Ошибка при вызове SetWindowPos".into());
        }
    }

    Ok(())
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
fn resize_bottom_up_phys(
    _window: tauri::Window,
    _width: i32,
    _height: i32,
    _x: i32,
    _y: i32,
) -> Result<(), String> {
    Err("resize_bottom_up_phys реализован только для Windows".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Сохраняем handle для отправки событий
            *APP_HANDLE.lock().unwrap() = Some(app.handle().clone());

            // Запускаем глобальный низкоуровневый хук клавиатуры на Windows
            #[cfg(target_os = "windows")]
            {
                std::thread::spawn(|| {
                    unsafe {
                        let h_instance = GetModuleHandleW(std::ptr::null());
                        let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(low_level_keyboard_proc), h_instance, 0);
                        if hook == 0 {
                            println!("SINC PRO: Ошибка установки глобального хука клавиатуры");
                            return;
                        }
                        println!("SINC PRO: Глобальный низкоуровневый хук клавиатуры (Ctrl+Win, Ctrl+Win+Alt, Escape) успешно зарегистрирован");
                        
                        let mut msg = std::mem::zeroed();
                        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
                            // Цикл сообщений потока
                        }
                        
                        UnhookWindowsHookEx(hook);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_config,
            save_config,
            load_history,
            delete_history_entry,
            open_audio_folder,
            save_audio,
            paste_text,
            set_capsule_active,
            resize_bottom_up_phys
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
