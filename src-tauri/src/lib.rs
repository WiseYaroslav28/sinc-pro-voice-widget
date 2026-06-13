mod translator;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

// ─── Edge TTS ────────────────────────────────────────────────────────────────
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};
use uuid::Uuid;

const EDGE_TTS_ENDPOINT: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";

static LAST_SKEW_UPDATE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
static CACHED_SKEW: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);

lazy_static::lazy_static! {
    static ref SKEW_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::new(());
}

lazy_static::lazy_static! {
    static ref EDGE_TTS_MUTEX: tokio::sync::Mutex<()> = tokio::sync::Mutex::new(());
}

async fn get_clock_skew() -> i64 {
    let now = match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => 0,
    };
    let last_update = LAST_SKEW_UPDATE.load(Ordering::Relaxed);
    
    // Быстрая проверка без блокировки: если кэш свежий, возвращаем сразу
    if last_update != 0 && (now - last_update) < 600 {
        return CACHED_SKEW.load(Ordering::Relaxed);
    }

    // Блокируем, чтобы только один поток делал сетевой запрос
    let _guard = SKEW_MUTEX.lock().await;

    // Повторно проверяем после захвата блокировки (double-checked locking)
    let last_update = LAST_SKEW_UPDATE.load(Ordering::Relaxed);
    if last_update != 0 && (now - last_update) < 600 {
        return CACHED_SKEW.load(Ordering::Relaxed);
    }

    // Создаем клиент с коротким таймаутом (1.5 секунды), чтобы не вешать озвучку
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(1500))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let url = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    let mut success = false;

    if let Ok(resp) = client.head(url).send().await {
        if let Some(date_header) = resp.headers().get("date") {
            if let Ok(date_str) = date_header.to_str() {
                if let Ok(server_time) = chrono::DateTime::parse_from_rfc2822(date_str) {
                    let server_timestamp = server_time.timestamp();
                    let local_timestamp = chrono::Utc::now().timestamp();
                    let skew = server_timestamp - local_timestamp;
                    println!("SINC PRO TTS: Clock skew adjusted by {} seconds (network update)", skew);
                    
                    CACHED_SKEW.store(skew, Ordering::Relaxed);
                    success = true;
                }
            }
        }
    }
    
    // Устанавливаем задержку до следующей попытки: 600 секунд при успехе, 60 секунд при ошибке
    let next_retry_delay = if success { 600 } else { 60 };
    LAST_SKEW_UPDATE.store(now - 600 + next_retry_delay, Ordering::Relaxed);

    CACHED_SKEW.load(Ordering::Relaxed)
}

fn generate_sec_ms_gec(skew: i64) -> String {
    use sha2::{Digest, Sha256};
    let win_epoch = 11644473600u64;
    let now_sec = (chrono::Utc::now().timestamp() + skew) as u64;
    let mut ticks = now_sec + win_epoch;
    ticks -= ticks % 300;
    ticks *= 10_000_000;

    let str_to_hash = format!("{}{}", ticks, "6A5AA1D4EAFF4E9FB37E23D68491D6F4");
    let mut hasher = Sha256::new();
    hasher.update(str_to_hash.as_bytes());
    let result = hasher.finalize();
    format!("{:X}", result)
}

fn log_tts_error(text: &str, err: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("c:\\Antigravity projects\\voice-server\\tts_errors.log")
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "[{}] TEXT: \"{}\" | ERROR: {}", timestamp, text, err);
    }
}

#[tauri::command]
fn write_js_log(log: String) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("c:\\Antigravity projects\\voice-server\\tts_errors.log")
    {
        let timestamp = chrono::Local::now().format("%Y-%m-%d %H:%M:%S");
        let _ = writeln!(file, "[JS {}] {}", timestamp, log);
    }
}

#[tauri::command]
async fn speak_edge_tts(text: String, voice: String, rate: f32) -> Result<String, String> {
    let _guard = EDGE_TTS_MUTEX.lock().await;
    let res = speak_edge_tts_internal(text.clone(), voice, rate).await;
    if let Err(ref e) = res {
        log_tts_error(&text, e);
    }
    res
}

async fn speak_edge_tts_internal(text: String, voice: String, rate: f32) -> Result<String, String> {
    let rate_pct = (((rate - 1.0) * 100.0).round() as i32).clamp(-50, 100);
    let rate_str = if rate_pct >= 0 {
        format!("+{}%", rate_pct)
    } else {
        format!("{}%", rate_pct)
    };

    let skew = get_clock_skew().await;
    let gec = generate_sec_ms_gec(skew);
    let gec_version = "1-143.0.3650.75";

    let conn_id = Uuid::new_v4().to_string().replace("-", "").to_uppercase();
    let url = format!(
        "{}&ConnectionId={}&Sec-MS-GEC={}&Sec-MS-GEC-Version={}",
        EDGE_TTS_ENDPOINT, conn_id, gec, gec_version
    );

    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    let mut request = url.into_client_request().map_err(|e| format!("WebSocket request config failed: {}", e))?;
    
    let headers = request.headers_mut();
    headers.insert("Origin", "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold".parse().unwrap());
    headers.insert("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0".parse().unwrap());
    headers.insert("Accept-Encoding", "gzip, deflate, br, zstd".parse().unwrap());
    headers.insert("Accept-Language", "en-US,en;q=0.9".parse().unwrap());
    headers.insert("Pragma", "no-cache".parse().unwrap());
    headers.insert("Cache-Control", "no-cache".parse().unwrap());

    let muid = Uuid::new_v4().to_string().replace("-", "").to_uppercase();
    headers.insert("Cookie", format!("muid={};", muid).parse().unwrap());
    
    // Задаем таймаут на все сетевое взаимодействие с Edge TTS (10 секунд)
    let net_result = tokio::time::timeout(Duration::from_secs(10), async {
        let (mut ws, _) = tokio_tungstenite::connect_async_tls_with_config(request, None, false, None)
            .await
            .map_err(|e| format!("WebSocket connect failed: {}", e))?;

        // 1. Отправляем конфигурационное сообщение
        let config_msg = format!(
            "X-Timestamp:{ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n\
             {{\"context\":{{\"synthesis\":{{\"audio\":{{\"metadataoptions\":{{\"sentenceBoundaryEnabled\":false,\
             \"wordBoundaryEnabled\":false}},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}}}}}",
            ts = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S.000Z")
        );
        ws.send(Message::Text(config_msg.into())).await
            .map_err(|e| format!("Send config failed: {}", e))?;

        // 2. SSML синтез
        let request_id = Uuid::new_v4().to_string().replace("-", "").to_uppercase();
        let ssml_text = text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;");
        let ssml_msg = format!(
            "X-RequestId:{req}\r\nContent-Type:application/ssml+xml\r\n\
             X-Timestamp:{ts}\r\nPath:ssml\r\n\r\n\
             <speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>\
             <voice name='{voice}'><prosody rate='{rate}'>{text}</prosody></voice></speak>",
            req  = request_id,
            ts   = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S.000Z"),
            voice = voice,
            rate = rate_str,
            text = ssml_text,
        );
        ws.send(Message::Text(ssml_msg.into())).await
            .map_err(|e| format!("Send SSML failed: {}", e))?;

        // 3. Собираем бинарные чанки MP3
        let mut audio_bytes: Vec<u8> = Vec::new();
        let separator = b"Path:audio\r\n";

        loop {
            match ws.next().await {
                Some(Ok(Message::Binary(data))) => {
                    if let Some(pos) = data.windows(separator.len()).position(|w| w == separator) {
                        let audio_start = pos + separator.len();
                        if audio_start < data.len() {
                            audio_bytes.extend_from_slice(&data[audio_start..]);
                        }
                    }
                }
                Some(Ok(Message::Text(t))) => {
                    if t.contains("Path:turn.end") { break; }
                }
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(e)) => return Err(format!("WebSocket error: {}", e)),
                _ => {}
            }
        }
        Ok(audio_bytes)
    }).await;

    let audio_bytes = match net_result {
        Ok(inner_res) => inner_res?,
        Err(_) => return Err("Timeout requesting Edge TTS (10s)".into()),
    };

    if audio_bytes.is_empty() {
        return Err("Edge TTS вернул пустой аудио-ответ".into());
    }

    Ok(STANDARD.encode(&audio_bytes))
}

static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
static MINIMIZED_STARTUP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static OCR_WINDOW_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static CANCEL_REQUEST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static MODEL_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static MODEL_REQUEST_LOGS: std::sync::LazyLock<Mutex<HashMap<String, Vec<i64>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static LAST_WORKING_MODEL: Mutex<Option<String>> = Mutex::new(None);

fn check_and_record_rate_limit(model: &str) -> Result<(usize, usize), String> {
    let now = chrono::Utc::now().timestamp();
    let mut logs = MODEL_REQUEST_LOGS.lock().unwrap();
    let timestamps = logs.entry(model.to_string()).or_insert_with(Vec::new);

    // Очищаем метки старше 24 часов (86400 секунд)
    timestamps.retain(|&t| now - t < 86400);

    // Считаем RPM (последние 60 секунд)
    let rpm_count = timestamps.iter().filter(|&&t| now - t < 60).count();
    // Считаем RPD (за последние 24 часа)
    let rpd_count = timestamps.len();

    // Динамические пороги в зависимости от модели
    let (max_rpm, max_rpd) = match model {
        "gemini-2.5-pro" => (4, 24),
        "gemini-2.5-flash" => (4, 19),
        "gemini-2.5-flash-lite" => (9, 19),
        "gemini-2.0-flash" => (14, 1450),
        "gemini-2.0-flash-lite" => (28, 1450),
        "gemini-1.5-flash" => (14, 1450),
        "gemini-1.5-pro" => (1, 48),
        "gemini-3.5-flash" => (4, 19),
        "gemini-3.1-flash-lite" => (14, 490),
        "gemini-3-flash" => (4, 19),
        "gemma-4-31b-it" | "gemma-4-26b-a4b-it" => (14, 1450),
        _ => {
            if model.contains("lite") {
                (28, 1450)
            } else if model.contains("pro") {
                (2, 48)
            } else {
                (14, 1450)
            }
        }
    };

    let actual_max_rpm_label = max_rpm + 1;
    let actual_max_rpd_label = max_rpd + 10;

    if rpm_count >= max_rpm {
        return Err(format!("лимит RPM ({}/{})", rpm_count, actual_max_rpm_label));
    }
    if rpd_count >= max_rpd {
        return Err(format!("лимит RPD ({}/{})", rpd_count, actual_max_rpd_label));
    }

    // Записываем текущий запрос
    timestamps.push(now);

    Ok((rpm_count + 1, rpd_count + 1))
}
static CTRL_PRESSED: AtomicBool = AtomicBool::new(false);
static WIN_PRESSED: AtomicBool = AtomicBool::new(false);
static ALT_PRESSED: AtomicBool = AtomicBool::new(false);
static SHIFT_PRESSED: AtomicBool = AtomicBool::new(false);
static SHORTCUT_ACTIVE: AtomicBool = AtomicBool::new(false);
static FORCE_SEND_ACTIVE: AtomicBool = AtomicBool::new(false);
static RECORDING_OR_PAUSED: AtomicBool = AtomicBool::new(false);
static CAPSULE_ENABLED: AtomicU8 = AtomicU8::new(2);
static WIDGET_ENABLED: AtomicU8 = AtomicU8::new(2);
static OCR_ENABLED: AtomicU8 = AtomicU8::new(0); // Выключен по умолчанию при старте


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
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
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

unsafe extern "system" fn low_level_keyboard_proc(
    code: i32,
    w_param: usize,
    l_param: isize,
) -> isize {
    if code >= 0 {
        let info = *(l_param as *const KBDLLHOOKSTRUCT);
        
        // Ignore simulated events generated by our own simulate_ctrl_c
        if info.dwExtraInfo == 0x12345678 {
            return CallNextHookEx(0, code, w_param, l_param);
        }

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
        } else if vk == VK_LSHIFT || vk == VK_RSHIFT {
            let prev = SHIFT_PRESSED.swap(is_key_down, Ordering::SeqCst);
            if prev != is_key_down {
                state_changed = true;
            }
        } else if vk == VK_ESCAPE && is_key_down {
            if CAPSULE_ENABLED.load(Ordering::SeqCst) > 0 && RECORDING_OR_PAUSED.load(Ordering::SeqCst) {
                if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                    let _ = app.emit("global-escape", ());
                }
            }
        }

        if state_changed {
            let ctrl = CTRL_PRESSED.load(Ordering::SeqCst);
            let win = WIN_PRESSED.load(Ordering::SeqCst);
            let alt = ALT_PRESSED.load(Ordering::SeqCst);
            let shift = SHIFT_PRESSED.load(Ordering::SeqCst);

            if ctrl && shift && !alt && !win {
                if WIDGET_ENABLED.load(Ordering::SeqCst) > 0 {
                    let was_active = SHORTCUT_ACTIVE.swap(true, Ordering::SeqCst);
                    println!("SINC PRO HOTKEY: Ctrl+Shift detected, was_active={}", was_active);
                    if !was_active {
                        if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                            println!("SINC PRO HOTKEY: Emitting tts-action-read");
                            let _ = app.emit("tts-action-read", ());
                        }
                        // TTS-чтение — одноразовое действие, сбрасываем флаг сразу,
                        // чтобы следующее нажатие Ctrl+Shift снова сработало
                        SHORTCUT_ACTIVE.store(false, Ordering::SeqCst);
                    }
                }
            } else if ctrl && alt && !shift && !win {
                if WIDGET_ENABLED.load(Ordering::SeqCst) > 0 {
                    if !SHORTCUT_ACTIVE.swap(true, Ordering::SeqCst) {
                        if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                            let _ = app.emit("tts-action-translate", ());
                        }
                        // TTS-перевод — одноразовое действие, аналогично
                        SHORTCUT_ACTIVE.store(false, Ordering::SeqCst);
                    }
                }
            } else if win && alt && !ctrl && !shift {
                if CAPSULE_ENABLED.load(Ordering::SeqCst) > 0 {
                    if !FORCE_SEND_ACTIVE.swap(true, Ordering::SeqCst) {
                        if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                            println!("SINC PRO HOTKEY: Win+Alt (Send) detected");
                            let _ = app.emit("global-force-send", ());
                        }
                    }
                }
            } else if ctrl && win && !alt && !shift {
                if CAPSULE_ENABLED.load(Ordering::SeqCst) > 0 {
                    if !SHORTCUT_ACTIVE.swap(true, Ordering::SeqCst) {
                        if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                            println!("SINC PRO HOTKEY: Ctrl+Win (Record) pressed");
                            let _ = app.emit("global-shortcut-pressed", ());
                        }
                    }
                }
            } else {
                if SHORTCUT_ACTIVE.swap(false, Ordering::SeqCst) {
                    if CAPSULE_ENABLED.load(Ordering::SeqCst) > 0 {
                        if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                            println!("SINC PRO HOTKEY: Ctrl+Win released");
                            let _ = app.emit("global-shortcut-released", ());
                        }
                    }
                }
                if FORCE_SEND_ACTIVE.swap(false, Ordering::SeqCst) {
                    println!("SINC PRO HOTKEY: Win+Alt released");
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

#[tauri::command]
fn set_module_mode(module: String, mode: u8) {
    println!("SINC PRO MODULE MODE: {} -> {}", module, mode);
    match module.as_str() {
        "capsule" => CAPSULE_ENABLED.store(mode, Ordering::SeqCst),
        "widget" => WIDGET_ENABLED.store(mode, Ordering::SeqCst),
        "ocr" => OCR_ENABLED.store(mode, Ordering::SeqCst),
        _ => {}
    }
}


#[tauri::command]
fn cancel_active_request() {
    CANCEL_REQUEST.store(true, std::sync::atomic::Ordering::SeqCst);
    println!("SINC PRO BACKEND: Request cancellation triggered.");
}

#[tauri::command]
fn is_minimized_startup() -> bool {
    MINIMIZED_STARTUP.load(std::sync::atomic::Ordering::SeqCst)
}

#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let current_exe = std::env::current_exe()
            .map_err(|e| format!("Не удалось получить путь к исполняемому файлу: {}", e))?;
        let exe_str = current_exe.to_string_lossy();
        
        let run_key_path = r#"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"#;
        let val_name = "SincPro";
        
        if enabled {
            let val_data = format!("\"{}\" --minimized", exe_str);
            let status = std::process::Command::new("reg")
                .args(&["add", run_key_path, "/v", val_name, "/t", "REG_SZ", "/d", &val_data, "/f"])
                .status()
                .map_err(|e| format!("Не удалось выполнить reg add: {}", e))?;
            
            if !status.success() {
                return Err("Ошибка reg add при записи автозапуска".to_string());
            }
        } else {
            let _ = std::process::Command::new("reg")
                .args(&["delete", run_key_path, "/v", val_name, "/f"])
                .status();
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Поддерживается только Windows".to_string())
    }
}

#[tauri::command]
fn is_autostart_enabled() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let run_key_path = r#"HKCU\Software\Microsoft\Windows\CurrentVersion\Run"#;
        let val_name = "SincPro";
        
        let output = std::process::Command::new("reg")
            .args(&["query", run_key_path, "/v", val_name])
            .output()
            .map_err(|e| format!("Не удалось выполнить reg query: {}", e))?;
        
        Ok(output.status.success())
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(false)
    }
}

#[tauri::command]
async fn show_capsule_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app_handle.get_webview_window("capsule") {
        w.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn hide_capsule_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app_handle.get_webview_window("capsule") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_widget_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app_handle.get_webview_window("widget") {
        w.show().map_err(|e| e.to_string())?;
        let _ = w.emit("widget-shown", ());
    }
    Ok(())
}

#[tauri::command]
async fn hide_widget_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app_handle.get_webview_window("widget") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn show_ocr_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app_handle.get_webview_window("ocr") {
        let _ = w.show();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        if let Ok(handle) = w.window_handle() {
            if let RawWindowHandle::Win32(win_handle) = handle.as_raw() {
                let hwnd = win_handle.hwnd.get() as isize;
                
                use winapi::um::winuser::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};
                let x = unsafe { GetSystemMetrics(SM_XVIRTUALSCREEN) };
                let y = unsafe { GetSystemMetrics(SM_YVIRTUALSCREEN) };
                let width = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN) };
                let height = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN) };
                
                println!("SINC PRO OCR NATIVE SHOW: hwnd=0x{:X}, x={}, y={}, w={}, h={}", hwnd, x, y, width, height);
                
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
                    fn ShowWindow(hWnd: isize, nCmdShow: i32) -> i32;
                    fn SetForegroundWindow(hWnd: isize) -> i32;
                }
                
                const HWND_TOPMOST: isize = -1;
                const SWP_NOACTIVATE: u32 = 0x0010;
                const SWP_NOCOPYBITS: u32 = 0x0100;
                const SWP_NOOWNERZORDER: u32 = 0x0200;
                const SWP_SHOWWINDOW: u32 = 0x0040;
                
                unsafe {
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        x,
                        y,
                        width,
                        height,
                        SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOCOPYBITS | SWP_SHOWWINDOW,
                    );
                    ShowWindow(hwnd, 5); // SW_SHOW
                    SetForegroundWindow(hwnd);
                }
            }
        }
        let _ = w.set_always_on_top(true);
        let _ = app_handle.emit("ocr-visibility-changed", true);
    }
    OCR_WINDOW_VISIBLE.store(true, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
async fn hide_ocr_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    println!("SINC PRO OCR: hide_ocr_window command called");
    if let Some(w) = app_handle.get_webview_window("ocr") {
        #[cfg(target_os = "windows")]
        {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            if let Ok(handle) = w.window_handle() {
                if let RawWindowHandle::Win32(win_handle) = handle.as_raw() {
                    let hwnd = win_handle.hwnd.get() as isize;
                    #[link(name = "user32")]
                    extern "system" {
                        fn ShowWindow(hWnd: isize, nCmdShow: i32) -> i32;
                    }
                    unsafe {
                        ShowWindow(hwnd, 0); // SW_HIDE
                    }
                    println!("SINC PRO OCR: Native ShowWindow SW_HIDE executed for hwnd=0x{:X}", hwnd);
                }
            }
        }
        w.hide().map_err(|e| e.to_string())?;
        let _ = app_handle.emit("ocr-visibility-changed", false);
        println!("SINC PRO OCR: ocr-visibility-changed false emitted");
    }
    OCR_WINDOW_VISIBLE.store(false, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppConfig {
    #[serde(default = "default_ui_lang")]
    pub ui_lang: String,
    #[serde(default = "default_dictation_lang")]
    pub dictation_lang: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub yandex_api_key: String,
    #[serde(default = "default_ai_model")]
    pub ai_model: String,
    #[serde(default = "default_ocr_mode")]
    pub ocr_mode: String,
}

fn default_ui_lang() -> String {
    "ru".to_string()
}
fn default_dictation_lang() -> String {
    "auto".to_string()
}
fn default_ai_model() -> String {
    "gemini-2.0-flash".to_string()
}
fn default_ocr_mode() -> String {
    "text".to_string()
}

// Один AI-результат (может быть несколько на одну запись)
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AiResult {
    pub preset: String,
    pub preset_label: String,
    pub text: String,
    pub timestamp: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct HistoryEntry {
    pub id: String,
    pub timestamp: String,
    pub duration_secs: u32,
    // Новое поле: дословная транскрипция
    #[serde(default)]
    pub raw_transcript: String,
    // Обратная совместимость со старыми записями (transcript вместо raw_transcript)
    #[serde(default)]
    pub transcript: String,
    // Пресет (для обратной совместимости)
    #[serde(default)]
    pub preset: String,
    #[serde(default)]
    pub preset_label: String,
    // Список AI-результатов
    #[serde(default)]
    pub ai_results: Vec<AiResult>,
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
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    let config_path = config_dir.join("config.json");
    if !config_path.exists() {
        return Ok(AppConfig {
            ui_lang: "ru".to_string(),
            dictation_lang: "auto".to_string(),
            api_key: "".to_string(),
            yandex_api_key: "".to_string(),
            ai_model: "gemini-2.0-flash".to_string(),
            ocr_mode: "text".to_string(),
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
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let config_path = config_dir.join("config.json");
    let json_str = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(config_path, json_str).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn fetch_gemini_models(api_key: String) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models?key={}&pageSize=100",
        api_key.trim()
    );

    let resp = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Сетевая ошибка при запросе моделей: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!("Google AI вернул ошибку {}: {}", status, err_body));
    }

    let data: serde_json::Value = resp.json()
        .await
        .map_err(|e| format!("Ошибка парсинга JSON: {}", e))?;

    Ok(data)
}


fn load_history_internal(app_handle: &tauri::AppHandle) -> Result<Vec<HistoryEntry>, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    let history_path = config_dir.join("history.json");
    if !history_path.exists() {
        return Ok(Vec::new());
    }
    let json_str = std::fs::read_to_string(history_path).map_err(|e| e.to_string())?;
    let history: Vec<HistoryEntry> = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    Ok(history)
}

fn save_history_internal(
    app_handle: &tauri::AppHandle,
    history: &Vec<HistoryEntry>,
) -> Result<(), String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let history_path = config_dir.join("history.json");
    let json_str = serde_json::to_string_pretty(history).map_err(|e| e.to_string())?;
    std::fs::write(history_path, json_str).map_err(|e| e.to_string())?;
    Ok(())
}

fn save_to_history_internal(
    app_handle: &tauri::AppHandle,
    entry: HistoryEntry,
) -> Result<(), String> {
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
async fn delete_history_entry(
    app_handle: tauri::AppHandle,
    id: String,
) -> Result<Vec<HistoryEntry>, String> {
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
            "Возьми дословный текст из поля 'transcript' и очисти его от слов-паразитов (ну, э-э, значит, как бы, короче, вот, типа, эм и т.п.), повторов слов, заиканий и запинаний. При этом сохрани исходный порядок слов, весь смысл и структуру предложений. Выдай очищенный, грамотный текст без заголовков, пояснений и форматирования.",
            "Текст"
        ),
        "email" => (
            "На основе этой аудиозаписи составь структурированное деловое письмо (email) на русском языке.",
            "Письмо"
        ),
        _ => (
            "Transform the scattered speech into a clear structured concept. Rules: 1) Remove filler, repetitions, chaos. 2) Merge all fragments into one logical concept. 3) Keep ALL important details and nuances. 4) Structure logically: main idea first, then details. 5) NO preamble, no 'In this recording...', no 'The speech is about...'. 6) Start IMMEDIATELY with the essence. Format: one-line concept title, then bullet points (bullet) for key ideas and details. Answer in Russian.",
            "Суть"
        ),
    }
}

fn parse_retry_delay(body: &str) -> Option<Duration> {
    let val: serde_json::Value = serde_json::from_str(body).ok()?;
    let details = val.get("error")?.get("details")?.as_array()?;
    for detail in details {
        if let Some(delay_str) = detail.get("retryDelay").and_then(|v| v.as_str()) {
            if let Some(seconds_str) = delay_str.strip_suffix('s') {
                if let Ok(seconds) = seconds_str.parse::<f64>() {
                    return Some(Duration::from_secs_f64(seconds));
                }
            }
        }
    }
    None
}

fn is_stub_transcript(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("предоставьте аудиозапись")
        || lower.contains("входные данные отсутствуют")
        || lower.contains("отсутствует аудиозапись")
        || lower.contains("аудиозапись не предоставлена")
        || lower.contains("пожалуйста, предоставьте аудио")
        || lower.contains("не могу распознать аудио")
        || lower.contains("аудиозапись отсутствует")
        || lower.contains("здесь будет дословная транскрипция")
        || lower.contains("очищенная от слов-паразитов")
        || lower.contains("сохранением всех мыслей")
}

static RECORDING_FILE: std::sync::LazyLock<Mutex<Option<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

#[tauri::command]
fn start_recording_session(app_handle: tauri::AppHandle) -> Result<(), String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let temp_dir = app_data_dir.join("temp");
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_file = temp_dir.join("current_recording.webm");

    if temp_file.exists() {
        let _ = std::fs::remove_file(&temp_file);
    }

    *RECORDING_FILE.lock().unwrap() = Some(temp_file.to_string_lossy().to_string());
    Ok(())
}

#[tauri::command]
fn append_audio_chunk(bytes: Vec<u8>) -> Result<(), String> {
    let lock = RECORDING_FILE.lock().unwrap();
    if let Some(path) = lock.as_ref() {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn save_audio(
    app_handle: tauri::AppHandle,
    duration_secs: u32,
    preset: String,
    custom_prompt: Option<String>,
    is_cancelled: Option<bool>,
    hard_delete: Option<bool>,
) -> Result<HistoryEntry, String> {
    CANCEL_REQUEST.store(false, std::sync::atomic::Ordering::SeqCst);
    let temp_file_path = {
        let mut lock = RECORDING_FILE.lock().unwrap();
        lock.clone()
    };

    if hard_delete.unwrap_or(false) {
        if let Some(path) = temp_file_path {
            let _ = std::fs::remove_file(&path);
        }
        return Ok(HistoryEntry {
            id: String::new(),
            timestamp: String::new(),
            duration_secs: 0,
            raw_transcript: String::new(),
            transcript: String::new(),
            preset: "hard_delete".to_string(),
            preset_label: String::new(),
            ai_results: vec![],
            audio_path: String::new(),
        });
    }

    let bytes = if let Some(path) = temp_file_path {
        std::fs::read(&path).unwrap_or_default()
    } else {
        Vec::new()
    };

    if bytes.len() < 100 {
        return Err("Запись отменена: аудиофайл пуст или слишком мал (нет звука)".to_string());
    }

    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let records_dir = app_data_dir.join("records");
    std::fs::create_dir_all(&records_dir).map_err(|e| e.to_string())?;

    let now_millis = Local::now().timestamp_millis();
    let id = format!("rec_{}", now_millis);
    let file_name = format!("{}.webm", id);
    let file_path = records_dir.join(&file_name);
    std::fs::write(&file_path, &bytes).map_err(|e| e.to_string())?;

    let timestamp = Local::now().format("%d.%m.%Y • %H:%M").to_string();

    // Если запись отменена пользователем — сохраняем в историю без Gemini (для Escape отмен)
    if is_cancelled.unwrap_or(false) {
        let entry = HistoryEntry {
            id: id.clone(),
            timestamp,
            duration_secs,
            raw_transcript: "[Запись отменена пользователем]".to_string(),
            transcript: String::new(),
            preset: "cancelled".to_string(),
            preset_label: "Отменено".to_string(),
            ai_results: vec![],
            audio_path: file_path.to_string_lossy().to_string(),
        };
        save_to_history_internal(&app_handle, entry.clone())?;
        let _ = app_handle.emit("history-updated", entry.clone());
        return Ok(entry);
    }

    // Проверяем наличие API-ключа
    let config = load_config_internal(&app_handle)?;
    if config.api_key.trim().is_empty() {
        let ts_clone = timestamp.clone();
        let entry = HistoryEntry {
            id: id.clone(),
            timestamp,
            duration_secs,
            raw_transcript: "[Ошибка: API-ключ Gemini не настроен]".to_string(),
            transcript: String::new(),
            preset: "error".to_string(),
            preset_label: "Ошибка API".to_string(),
            ai_results: vec![AiResult {
                preset: "error".to_string(),
                preset_label: "Ошибка API".to_string(),
                text: "Укажите API-ключ в Настройках и переотправьте запись.".to_string(),
                timestamp: ts_clone,
            }],
            audio_path: file_path.to_string_lossy().to_string(),
        };
        save_to_history_internal(&app_handle, entry.clone())?;
        let _ = app_handle.emit("history-updated", entry.clone());
        return Ok(entry);
    }

    let base64_audio = STANDARD.encode(&bytes);

    // Определяем пользовательский пресет
    let (user_preset_prompt, preset_label_str) = if let Some(ref cp) = custom_prompt {
        if !cp.trim().is_empty() {
            // Берём первые 60 символов промпта как заголовок
            let short = if cp.len() > 60 {
                format!("{}...", &cp[..60])
            } else {
                cp.clone()
            };
            (cp.clone(), format!("Свой: {}", short))
        } else {
            let (p, l) = get_preset_prompt_and_label(&preset);
            (p.to_string(), l.to_string())
        }
    } else {
        let (p, l) = get_preset_prompt_and_label(&preset);
        (p.to_string(), l.to_string())
    };

    // Единый JSON-промпт: транскрипция + AI-результат в одном запросе
    let combined_prompt = format!(
        r#"Ответь СТРОГО в формате JSON без markdown, без пояснений, без ```json, только чистый JSON:
{{"transcript":"...","ai_result":"..."}}

Правила:
- "transcript": абсолютная дословная транскрипция аудио (включая все слова-паразиты, заикания, повторы, оговорки и т.д.). Запиши речь точно так, как она звучит, без художественной обработки и без удаления слов.
- "ai_result": {}

В JSON-строках экранируй кавычки через \" и переносы строк через \n."#,
        user_preset_prompt
    );

    let request_payload = serde_json::json!({
        "contents": [{
            "parts": [
                {"inlineData": {"mimeType": "audio/webm", "data": base64_audio}},
                {"text": combined_prompt}
            ]
        }],
        "generationConfig": {
            "temperature": 0.2,
            "responseMimeType": "application/json"
        }
    });

    // Fallback цепочка моделей: расширяем до максимальной отказоустойчивости на бесплатном тарифе
    let mut primary_model = if config.ai_model.is_empty() {
        "gemini-2.5-flash-lite".to_string()
    } else {
        config.ai_model.clone()
    };
    if primary_model.contains("tts-preview") {
        primary_model = "gemini-2.0-flash".to_string();
    }
    let fallback_models = vec![
        primary_model.clone(),
        "gemini-3.1-flash-lite".to_string(),
        "gemini-2.5-flash".to_string(),
        "gemini-3.5-flash".to_string(),
        "gemini-2.5-flash-lite".to_string(),
        "gemini-2.0-flash".to_string(),
        "gemini-2.0-flash-lite".to_string(),
        "gemini-2.5-pro".to_string(),
    ];
    // Убираем дубли, сохраняем порядок
    let mut seen = std::collections::HashSet::new();
    let fallback_models: Vec<String> = fallback_models
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let api_key = config.api_key.trim().to_string();

    // Пробуем модели по очереди
    let mut last_err = String::new();
    let mut gemini_text: Option<String> = None;
    for model in &fallback_models {
        if CANCEL_REQUEST.load(std::sync::atomic::Ordering::SeqCst) {
            last_err = "Запрос отменен пользователем".to_string();
            break;
        }
        // Проверяем блокировку модели по времени разблокировки
        {
            let locks = MODEL_LOCKS.lock().unwrap();
            if let Some(unlock_time) = locks.get(model) {
                if Instant::now() < *unlock_time {
                    last_err = format!("Модель {} временно заблокирована из-за 429", model);
                    continue;
                }
            }
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );
        match client.post(&url).json(&request_payload).send().await {
            Err(e) => {
                last_err = format!("Сетевая ошибка ({}): {}", model, e);
                log_tts_error("Gemini network error", &last_err);
                continue;
            }
            Ok(res) => {
                let status = res.status();
                if status.as_u16() == 429 {
                    let err_text = res.text().await.unwrap_or_default();
                    let delay = parse_retry_delay(&err_text).unwrap_or(Duration::from_secs(60));
                    let unlock_time = Instant::now() + delay;
                    {
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    last_err = format!("Модель {} заблокирована (429) на {:?}", model, delay);
                    log_tts_error("Gemini rate limit 429", &last_err);
                    continue;
                }
                if status.as_u16() == 503 {
                    last_err = format!("Сервис недоступен (503) для {}", model);
                    log_tts_error("Gemini service unavailable 503", &last_err);
                    continue;
                }
                if !status.is_success() {
                    let err_text = res.text().await.unwrap_or_default();
                    last_err = format!("Ошибка {} ({}): {}", status, model, err_text);
                    log_tts_error("Gemini API error status", &last_err);
                    if err_text.contains("RESOURCE_EXHAUSTED") || err_text.contains("quota") {
                        let unlock_time = Instant::now() + Duration::from_secs(3600);
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    continue;
                }
                match res.json::<GeminiResponse>().await {
                    Err(e) => {
                        last_err = format!("Парсинг ответа ({}): {}", model, e);
                        log_tts_error("Gemini JSON deserialize error", &last_err);
                        continue;
                    }
                    Ok(gr) => {
                        if let Some(text) = gr
                            .candidates
                            .and_then(|c| c.into_iter().next())
                            .and_then(|c| c.content)
                            .and_then(|c| c.parts)
                            .and_then(|p| p.into_iter().next())
                            .and_then(|p| p.text)
                        {
                            // Проверяем, не является ли транскрипция заглушкой
                            let transcript = match serde_json::from_str::<serde_json::Value>(&text)
                            {
                                Ok(v) => v["transcript"].as_str().unwrap_or("").to_string(),
                                Err(_) => text.clone(),
                            };

                            if is_stub_transcript(&transcript) {
                                last_err =
                                    format!("Модель {} вернула заглушку: {}", model, transcript);
                                log_tts_error("Gemini stub returned", &last_err);
                                continue;
                            }

                            gemini_text = Some(text);
                            break;
                        } else {
                            last_err = format!("Пустой ответ от {}", model);
                            log_tts_error("Gemini empty candidates", &last_err);
                        }
                    }
                }
            }
        }
    }

    // Парсим JSON-ответ от Gemini
    let (raw_transcript, ai_result_text, is_error) = match gemini_text {
        None => {
            if last_err == "Запрос отменен пользователем" {
                ("[Запрос отменен пользователем]".to_string(), String::new(), true)
            } else {
                let err_msg = format!("[Ошибка: все модели недоступны. {}]", last_err);
                log_tts_error("Gemini call failed entirely", &err_msg);
                (err_msg, String::new(), true)
            }
        }
        Some(raw_json) => {
            // Очищаем от Markdown и мусора
            let mut cleaned = raw_json.trim().to_string();
            if cleaned.starts_with("```json") {
                cleaned = cleaned.trim_start_matches("```json").to_string();
            } else if cleaned.starts_with("```") {
                cleaned = cleaned.trim_start_matches("```").to_string();
            }
            if cleaned.ends_with("```") {
                cleaned = cleaned.trim_end_matches("```").to_string();
            }
            cleaned = cleaned.trim().to_string();

            // Извлекаем от первой { до последней }
            if let (Some(start), Some(end)) = (cleaned.find('{'), cleaned.rfind('}')) {
                if start <= end {
                    cleaned = cleaned[start..=end].to_string();
                }
            }

            // Пытаемся распарсить JSON
            match serde_json::from_str::<serde_json::Value>(&cleaned) {
                Ok(v) => {
                    let tr = v["transcript"].as_str().unwrap_or("").to_string();
                    let ai = v["ai_result"].as_str().unwrap_or("").to_string();
                    (tr, ai, false)
                }
                Err(e) => {
                    // Логируем ошибку парсинга в файл
                    println!("SINC PRO ERROR: Ошибка парсинга JSON от Gemini: {}. Пробуем регулярные выражения.", e);
                    log_tts_error("Gemini JSON parse failed", &format!("Error: {}, Raw input: {}", e, cleaned));
                    
                    // Пытаемся вытащить значения полей регулярными выражениями
                    let re_tr = regex::Regex::new(r#""transcript"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap();
                    let re_ai = regex::Regex::new(r#""ai_result"\s*:\s*"((?:[^"\\]|\\.)*)""#).unwrap();
                    
                    let tr = if let Some(cap) = re_tr.captures(&cleaned) {
                        cap.get(1).map(|m| m.as_str().replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")).unwrap_or_default()
                    } else {
                        String::new()
                    };
                    
                    let ai = if let Some(cap) = re_ai.captures(&cleaned) {
                        cap.get(1).map(|m| m.as_str().replace("\\n", "\n").replace("\\\"", "\"").replace("\\\\", "\\")).unwrap_or_default()
                    } else {
                        String::new()
                    };

                    if !tr.is_empty() || !ai.is_empty() {
                        (tr, ai, false)
                    } else {
                        // Если регулярки тоже не сработали, возвращаем raw_json как транскрипцию
                        (raw_json, String::new(), false)
                    }
                }
            }
        }
    };

    let preset_key = if is_error {
        "error".to_string()
    } else if custom_prompt
        .as_ref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false)
    {
        "custom".to_string()
    } else {
        preset.clone()
    };

    let ts = timestamp.clone(); // клон для ai_results
    let ai_results = if is_error {
        vec![AiResult {
            preset: "error".to_string(),
            preset_label: "Ошибка API".to_string(),
            text: raw_transcript.clone(),
            timestamp: ts,
        }]
    } else if !ai_result_text.is_empty() {
        vec![AiResult {
            preset: preset_key.clone(),
            preset_label: preset_label_str.clone(),
            text: ai_result_text,
            timestamp: ts,
        }]
    } else {
        vec![]
    };

    let entry = HistoryEntry {
        id: id.clone(),
        timestamp,
        duration_secs,
        raw_transcript: raw_transcript.clone(),
        transcript: if is_error { String::new() } else { raw_transcript },
        preset: if is_error { "error".to_string() } else { preset_key },
        preset_label: if is_error { "Ошибка".to_string() } else { preset_label_str },
        ai_results,
        audio_path: file_path.to_string_lossy().to_string(),
    };

    save_to_history_internal(&app_handle, entry.clone())?;
    let _ = app_handle.emit("history-updated", entry.clone());

    Ok(entry)
}

#[tauri::command]
async fn process_ai_request(
    app_handle: tauri::AppHandle,
    entry_id: String,
    source_type: String,     // "audio", "text"
    source_text: String,     // Исходный текст для обработки (если source_type != "audio")
    preset: String,          // "tasks", "transcript", "email", "essence", "custom"
    custom_prompt: Option<String>,
    result_label: String,    // Название для результата ИИ, например "Суть (Транскрипция)"
) -> Result<Vec<HistoryEntry>, String> {
    CANCEL_REQUEST.store(false, std::sync::atomic::Ordering::SeqCst);

    // 1. Загружаем историю
    let mut history = load_history_internal(&app_handle)?;
    let entry_idx = history.iter().position(|e| e.id == entry_id)
        .ok_or_else(|| "Запись не найдена в истории".to_string())?;

    // 2. Получаем конфиг
    let config = load_config_internal(&app_handle)?;
    if config.api_key.trim().is_empty() {
        return Err("API ключ Gemini не настроен. Укажите его в Настройках.".to_string());
    }

    // 3. Формируем промпт
    let prompt_essence = if preset == "custom" {
        custom_prompt.clone().unwrap_or_default()
    } else {
        get_preset_prompt_and_label(&preset).0.to_string()
    };

    if prompt_essence.trim().is_empty() {
        return Err("Промпт не может быть пустым".to_string());
    }

    let request_payload = if source_type == "audio" {
        // Читаем аудиофайл
        let audio_path = &history[entry_idx].audio_path;
        if audio_path.is_empty() {
            return Err("Аудиофайл не найден для этой записи".to_string());
        }
        let bytes = std::fs::read(audio_path)
            .map_err(|e| format!("Не удалось прочитать аудиофайл: {}", e))?;
        let base64_audio = STANDARD.encode(&bytes);

        let combined_prompt = format!(
            r#"Прослушай аудиозапись и выполни следующую задачу:
            {}
            Ответь на русском языке."#,
            prompt_essence
        );

        serde_json::json!({
            "contents": [{
                "parts": [
                    {"inlineData": {"mimeType": "audio/webm", "data": base64_audio}},
                    {"text": combined_prompt}
                ]
            }],
            "generationConfig": {
                "temperature": 0.3
            }
        })
    } else {
        let combined_prompt = format!(
            r#"Вот исходный текст:
            ---
            {}
            ---
            Выполни следующую задачу с этим текстом:
            {}
            Ответь на русском языке."#,
            source_text,
            prompt_essence
        );

        serde_json::json!({
            "contents": [{
                "parts": [
                    {"text": combined_prompt}
                ]
            }],
            "generationConfig": {
                "temperature": 0.3
            }
        })
    };

    // 4. Подготавливаем цепочку моделей
    let mut primary_model = if config.ai_model.is_empty() {
        "gemini-2.5-flash-lite".to_string()
    } else {
        config.ai_model.clone()
    };
    if primary_model.contains("tts-preview") {
        primary_model = "gemini-2.0-flash".to_string();
    }
    let fallback_models = vec![
        primary_model.clone(),
        "gemini-3.1-flash-lite".to_string(),
        "gemini-2.5-flash".to_string(),
        "gemini-3.5-flash".to_string(),
        "gemini-2.5-flash-lite".to_string(),
        "gemini-2.0-flash".to_string(),
        "gemini-2.0-flash-lite".to_string(),
        "gemini-2.5-pro".to_string(),
    ];
    let mut seen = std::collections::HashSet::new();
    let fallback_models: Vec<String> = fallback_models
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let api_key = config.api_key.trim().to_string();

    let mut last_err = String::new();
    let mut gemini_text: Option<String> = None;

    for model in &fallback_models {
        if CANCEL_REQUEST.load(std::sync::atomic::Ordering::SeqCst) {
            last_err = "Запрос отменен пользователем".to_string();
            break;
        }

        // Проверяем блокировку модели
        {
            let locks = MODEL_LOCKS.lock().unwrap();
            if let Some(unlock_time) = locks.get(model) {
                if Instant::now() < *unlock_time {
                    last_err = format!("Модель {} временно заблокирована из-за 429", model);
                    continue;
                }
            }
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );

        match client.post(&url).json(&request_payload).send().await {
            Err(e) => {
                last_err = format!("Сетевая ошибка ({}): {}", model, e);
                log_tts_error("Gemini network error", &last_err);
                continue;
            }
            Ok(res) => {
                let status = res.status();
                if status.as_u16() == 429 {
                    let err_text = res.text().await.unwrap_or_default();
                    let delay = parse_retry_delay(&err_text).unwrap_or(Duration::from_secs(60));
                    let unlock_time = Instant::now() + delay;
                    {
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    last_err = format!("Модель {} заблокирована (429) на {:?}", model, delay);
                    log_tts_error("Gemini rate limit 429", &last_err);
                    continue;
                }
                if status.as_u16() == 503 {
                    last_err = format!("Сервис недоступен (503) для {}", model);
                    log_tts_error("Gemini service unavailable 503", &last_err);
                    continue;
                }
                if !status.is_success() {
                    let err_text = res.text().await.unwrap_or_default();
                    last_err = format!("Ошибка {} ({}): {}", status, model, err_text);
                    log_tts_error("Gemini API error status", &last_err);
                    if err_text.contains("RESOURCE_EXHAUSTED") || err_text.contains("quota") {
                        let unlock_time = Instant::now() + Duration::from_secs(3600);
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    continue;
                }

                match res.json::<GeminiResponse>().await {
                    Err(e) => {
                        last_err = format!("Парсинг ответа ({}): {}", model, e);
                        log_tts_error("Gemini JSON deserialize error", &last_err);
                        continue;
                    }
                    Ok(gr) => {
                        if let Some(text) = gr
                            .candidates
                            .and_then(|c| c.into_iter().next())
                            .and_then(|c| c.content)
                            .and_then(|c| c.parts)
                            .and_then(|p| p.into_iter().next())
                            .and_then(|p| p.text)
                        {
                            gemini_text = Some(text);
                            break;
                        } else {
                            last_err = format!("Пустой ответ от {}", model);
                            log_tts_error("Gemini empty candidates", &last_err);
                        }
                    }
                }
            }
        }
    }

    let ai_result_text = match gemini_text {
        None => {
            return Err(format!("Ошибка обработки Gemini: {}", last_err));
        }
        Some(t) => {
            // Если ответ содержит JSON разметку ```json ... ```, очистим его
            let mut cleaned = t.trim();
            if cleaned.starts_with("```json") && cleaned.ends_with("```") {
                cleaned = &cleaned[7..cleaned.len() - 3].trim();
            } else if cleaned.starts_with("```") && cleaned.ends_with("```") {
                cleaned = &cleaned[3..cleaned.len() - 3].trim();
            }
            cleaned.to_string()
        }
    };

    // 5. Создаем новый AiResult и сохраняем
    let new_result = AiResult {
        preset: preset.clone(),
        preset_label: result_label.clone(),
        text: ai_result_text,
        timestamp: Local::now().format("%d.%m.%Y • %H:%M").to_string(),
    };

    history[entry_idx].ai_results.push(new_result);
    save_history_internal(&app_handle, &history)?;

    let _ = app_handle.emit("history-updated", ());
    Ok(history)
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

    let wide: Vec<u16> = OsStr::new(text)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
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
fn get_clipboard_text_raw() -> Result<String, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;

    #[link(name = "user32")]
    extern "system" {
        fn OpenClipboard(hWndNewOwner: isize) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(uFormat: u32) -> isize;
        fn IsClipboardFormatAvailable(format: u32) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalLock(hMem: isize) -> *mut u16;
        fn GlobalUnlock(hMem: isize) -> i32;
    }

    const CF_UNICODETEXT: u32 = 13;

    unsafe {
        if OpenClipboard(0) == 0 {
            return Err("Не удалось открыть буфер обмена".to_string());
        }
        if IsClipboardFormatAvailable(CF_UNICODETEXT) == 0 {
            CloseClipboard();
            return Ok(String::new());
        }
        let h_mem = GetClipboardData(CF_UNICODETEXT);
        if h_mem == 0 {
            CloseClipboard();
            return Err("Не удалось получить данные из буфера обмена".to_string());
        }
        let ptr = GlobalLock(h_mem);
        if ptr.is_null() {
            CloseClipboard();
            return Err("Ошибка блокировки памяти буфера".to_string());
        }

        let mut len = 0;
        while *ptr.add(len) != 0 {
            len += 1;
        }

        let slice = std::slice::from_raw_parts(ptr, len);
        let os_str = OsString::from_wide(slice);
        GlobalUnlock(h_mem);
        CloseClipboard();

        os_str
            .into_string()
            .map_err(|_| "Не удалось конвертировать текст из буфера обмена в UTF-8".to_string())
    }
}

#[tauri::command]
async fn read_clipboard_text() -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        get_clipboard_text_raw()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Поддерживается только Windows".to_string())
    }
}

#[tauri::command]
async fn write_clipboard_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        set_clipboard_text(&text)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Поддерживается только Windows".to_string())
    }
}


#[cfg(target_os = "windows")]
fn log_to_file(msg: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("debug_clipboard.log")
    {
        use std::io::Write;
        let _ = writeln!(file, "[{}] {}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), msg);
    }
}

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

    log_to_file("backup_clipboard: Start backing up");
    let mut backup = Vec::new();
    unsafe {
        let mut opened = false;
        for i in 0..15 {
            if OpenClipboard(0) != 0 {
                opened = true;
                break;
            }
            log_to_file(&format!("backup_clipboard: OpenClipboard failed, retry {}/15...", i + 1));
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        if !opened {
            log_to_file("backup_clipboard: Failed to open clipboard after 15 retries");
            return Err("Не удалось открыть буфер обмена для бэкапа".to_string());
        }
        let mut format = 0;
        loop {
            format = EnumClipboardFormats(format);
            if format == 0 {
                break;
            }
            // Skip GDI handle-based formats that cannot be backed up as raw byte arrays
            if format == 2 || format == 3 || format == 9 || format == 14 {
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
    log_to_file(&format!("backup_clipboard: Backup successful. Saved {} formats", backup.len()));
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

    log_to_file(&format!("restore_clipboard: Start restoring {} formats", backup.len()));
    if backup.is_empty() {
        log_to_file("restore_clipboard: Backup is empty, skipping restore to avoid clearing clipboard");
        return Ok(());
    }

    unsafe {
        let mut opened = false;
        for i in 0..15 {
            if OpenClipboard(0) != 0 {
                opened = true;
                break;
            }
            log_to_file(&format!("restore_clipboard: OpenClipboard failed, retry {}/15...", i + 1));
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        if !opened {
            log_to_file("restore_clipboard: Failed to open clipboard after 15 retries");
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
    log_to_file("restore_clipboard: Restore successful");
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
        let mut inputs: Vec<INPUT> = Vec::new();
        // Принудительно отпускаем все модификаторы
        let release_keys = [
            0x10, 0xA0, 0xA1, // Shift
            0x11, 0xA2, 0xA3, // Ctrl
            0x12, 0xA4, 0xA5, // Alt
            0x5B, 0x5C,       // Win
        ];
        for k in release_keys.iter() {
            inputs.push(INPUT {
                type_: INPUT_KEYBOARD,
                u: INPUT_UNION { ki: KEYBDINPUT { wVk: *k, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0x12345678 } },
            });
        }

        // Зажимаем логический Ctrl
        inputs.push(INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION { ki: KEYBDINPUT { wVk: VK_CONTROL, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0x12345678 } },
        });
        // Зажимаем C
        inputs.push(INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION { ki: KEYBDINPUT { wVk: VK_C, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0x12345678 } },
        });
        // Отпускаем C
        inputs.push(INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION { ki: KEYBDINPUT { wVk: VK_C, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0x12345678 } },
        });
        // Отпускаем логический Ctrl
        inputs.push(INPUT {
            type_: INPUT_KEYBOARD,
            u: INPUT_UNION { ki: KEYBDINPUT { wVk: VK_CONTROL, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0x12345678 } },
        });

        SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
}

static TRANSLATION_CACHE: std::sync::LazyLock<Mutex<Option<HashMap<String, String>>>> =
    std::sync::LazyLock::new(|| Mutex::new(None));

fn get_translation_cache_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let config_dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?;
    Ok(config_dir.join("translation_cache.json"))
}

fn load_translation_cache(app_handle: &tauri::AppHandle) -> HashMap<String, String> {
    let mut cache_lock = TRANSLATION_CACHE.lock().unwrap();
    if let Some(ref cache) = *cache_lock {
        return cache.clone();
    }
    let mut cache = HashMap::new();
    if let Ok(path) = get_translation_cache_path(app_handle) {
        if path.exists() {
            if let Ok(json_str) = std::fs::read_to_string(&path) {
                if let Ok(parsed) = serde_json::from_str::<HashMap<String, String>>(&json_str) {
                    let has_legacy = parsed.keys().any(|k| k.contains("__NUM") || k.contains("__FILE"))
                        || parsed.values().any(|v| v.contains("__NUM") || v.contains("__") || v.contains("НОМЕР") || v.contains("ЧИСЛО") || v.contains("ФАЙЛ"));
                    if has_legacy {
                        println!("[Translation Cache] Legacy or corrupted cache detected. Clearing: {:?}", path);
                        let _ = std::fs::remove_file(&path);
                    } else {
                        cache = parsed;
                    }
                }
            }
        }
    }
    *cache_lock = Some(cache.clone());
    cache
}

fn save_translation_cache_item(app_handle: &tauri::AppHandle, key: String, val: String) {
    let mut cache_lock = TRANSLATION_CACHE.lock().unwrap();
    let cache_ref = cache_lock.get_or_insert_with(HashMap::new);
    cache_ref.insert(key, val);
    let cache_clone = cache_ref.clone();
    drop(cache_lock);
    
    if let Ok(path) = get_translation_cache_path(app_handle) {
        if let Ok(parent) = path.parent().ok_or("No parent") {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json_str) = serde_json::to_string_pretty(&cache_clone) {
            let _ = std::fs::write(path, json_str);
        }
    }
}

fn normalize_and_extract_variables(text: &str) -> (String, Vec<(String, String)>) {
    let re_file = regex::Regex::new(r"[a-zA-Z0-9_-]+\.(?i)(md|json|rs|html|js|css|py|png|jpg|txt|toml|yml|yaml)").unwrap();
    let re_num = regex::Regex::new(r"\d+").unwrap();

    let mut template = text.to_string();
    let mut variables = Vec::new();

    // 1. Находим файлы
    let file_matches: Vec<(usize, usize, String)> = re_file.find_iter(text)
        .map(|mat| (mat.start(), mat.end(), mat.as_str().to_string()))
        .collect();

    // 2. Находим числа
    let num_matches: Vec<(usize, usize, String)> = re_num.find_iter(text)
        .map(|mat| (mat.start(), mat.end(), mat.as_str().to_string()))
        .collect();

    // 3. Отсекаем числа, которые лежат внутри диапазонов файлов
    let filtered_nums: Vec<(usize, usize, String)> = num_matches.into_iter()
        .filter(|&(n_start, n_end, _)| {
            !file_matches.iter().any(|&(f_start, f_end, _)| {
                n_start >= f_start && n_end <= f_end
            })
        })
        .collect();

    #[derive(Clone)]
    enum VarType {
        File,
        Num,
    }
    struct MatchItem {
        start: usize,
        end: usize,
        var_type: VarType,
        val: String,
    }

    let mut all_matches = Vec::new();
    for (start, end, val) in file_matches {
        all_matches.push(MatchItem { start, end, var_type: VarType::File, val });
    }
    for (start, end, val) in filtered_nums {
        all_matches.push(MatchItem { start, end, var_type: VarType::Num, val });
    }

    // 5. Сортируем по убыванию начального индекса (с конца к началу)
    all_matches.sort_by_key(|m| std::cmp::Reverse(m.start));

    // 6. Выполняем замену
    let mut file_idx = 0;
    let mut num_idx = 0;
    for item in all_matches {
        match item.var_type {
            VarType::File => {
                let placeholder = format!("{{F{}}}", file_idx);
                variables.push((placeholder.clone(), item.val));
                template.replace_range(item.start..item.end, &placeholder);
                file_idx += 1;
            }
            VarType::Num => {
                let placeholder = format!("{{N{}}}", num_idx);
                variables.push((placeholder.clone(), item.val));
                template.replace_range(item.start..item.end, &placeholder);
                num_idx += 1;
            }
        }
    }

    (template, variables)
}

fn restore_variables(template: &str, variables: &[(String, String)]) -> String {
    let mut result = template.to_string();
    for (placeholder, val) in variables {
        result = result.replace(placeholder, val);
    }
    result
}

async fn translate_with_cache(
    app_handle: &tauri::AppHandle,
    text: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }

    let (template_orig, variables) = normalize_and_extract_variables(trimmed);

    let cache = load_translation_cache(app_handle);
    if let Some(cached_val) = cache.get(&template_orig) {
        println!("[Translation Cache] Hit: '{}' -> '{}'", template_orig, cached_val);
        return Ok(restore_variables(cached_val, &variables));
    }

    println!("[Translation Cache] Miss, calling Gemini with template: '{}'", template_orig);
    let translated = crate::translator::translate_hybrid(&template_orig, api_key, model).await?;

    save_translation_cache_item(app_handle, template_orig.clone(), translated.clone());

    Ok(restore_variables(&translated, &variables))
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
        
        CTRL_PRESSED.store(false, Ordering::SeqCst);
        SHIFT_PRESSED.store(false, Ordering::SeqCst);
        ALT_PRESSED.store(false, Ordering::SeqCst);
        
        let text = get_clipboard_text_raw().unwrap_or_default();
        let _ = restore_clipboard(backup);

        if text.trim().is_empty() { return Ok("".to_string()); }

        if translate {
            let config = load_config_internal(&app_handle)?;
            let translated = translate_with_cache(&app_handle, &text, &config.api_key, &config.ai_model).await?;
            return Ok(translated);
        }
        Ok(text)
    }
    #[cfg(not(target_os = "windows"))]
    { Err("Поддерживается только Windows".to_string()) }
}

#[tauri::command]
async fn translate_hybrid(
    app_handle: tauri::AppHandle,
    text: String,
    target_lang: Option<String>,
) -> Result<String, String> {
    let config = load_config_internal(&app_handle)?;
    let translated = translate_with_cache(&app_handle, &text, &config.api_key, &config.ai_model).await?;
    Ok(translated)
}


#[tauri::command]
async fn process_ocr_vision(
    app_handle: tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<serde_json::Value, String> {
    // 1. Поиск монитора
    let center_x = x + (width as i32) / 2;
    let center_y = y + (height as i32) / 2;
    
    // Скрываем окно оверлея на время скриншота, чтобы его рамка и элементы (лоадер, тулбар) не попадали на снимок
    if let Some(w) = app_handle.get_webview_window("ocr") {
        let _ = w.hide();
        // Даем Windows время перерисовать рабочий стол под окном (асинхронно, чтобы не блокировать поток)
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    
    let capture_res = (|| -> Result<(image::RgbaImage, f32, i32, i32), String> {
        let monitor = xcap::Monitor::from_point(center_x, center_y)
            .map_err(|e| format!("Не удалось найти монитор в точке ({}, {}): {}", center_x, center_y, e))?;
            
        let screenshot = monitor.capture_image()
            .map_err(|e| format!("Ошибка захвата экрана: {}", e))?;
            
        let scale = monitor.scale_factor().map_err(|e| e.to_string())?;
        let monitor_x = monitor.x().map_err(|e| e.to_string())?;
        let monitor_y = monitor.y().map_err(|e| e.to_string())?;
        
        Ok((screenshot, scale, monitor_x, monitor_y))
    })();

    // Показываем окно оверлея обратно
    if let Some(w) = app_handle.get_webview_window("ocr") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
    }

    let (screenshot, scale, monitor_x, monitor_y) = capture_res?;
    
    let local_x = x - monitor_x;
    let local_y = y - monitor_y;
    
    let phys_x = local_x.max(0) as u32;
    let phys_y = local_y.max(0) as u32;
    let phys_w = width;
    let phys_h = height;
    
    let img_w = screenshot.width();
    let img_h = screenshot.height();
    
    let crop_x = phys_x.min(img_w);
    let crop_y = phys_y.min(img_h);
    let crop_w = phys_w.min(img_w - crop_x);
    let crop_h = phys_h.min(img_h - crop_y);
    
    if crop_w == 0 || crop_h == 0 {
        return Err("Размер области захвата равен нулю".to_string());
    }
    
    // 4. Обрезка
    let cropped = image::imageops::crop_imm(&screenshot, crop_x, crop_y, crop_w, crop_h).to_image();
    
    // 5. Кодирование в PNG -> Base64
    let mut png_bytes = Vec::new();
    cropped.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("Ошибка сжатия PNG: {}", e))?;
        
    let base64_image = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    
    // 6. Gemini Vision API запрос
    let config = load_config_internal(&app_handle)?;
    let api_key = config.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("API ключ Gemini пуст в конфигурации".to_string());
    }
    
    let ocr_prompt = r#"Распознай весь текст на изображении (OCR) и верни его СТРОГО в формате JSON без markdown, без пояснений, без ```json, только чистый JSON.
Раздели текст на логические предложения. Каждое слово в предложении должно иметь точные координаты bounding box в виде нормализованных координат от 0 до 1000 относительно ширины и высоты изображения в формате: [ymin, xmin, ymax, xmax].

Формат ответа:
{
  "sentences": [
    {
      "text": "Полный текст предложения",
      "words": [
        {
          "text": "слово",
          "box": [ymin, xmin, ymax, xmax]
        }
      ]
    }
  ]
}

Правила:
- Координаты "box": [ymin, xmin, ymax, xmax] должны быть целыми числами от 0 до 1000.
- Не пропускай слова и не склеивай их. Каждое отдельное слово должно быть в массиве words.
- Ответ должен содержать ТОЛЬКО валидный JSON-объект."#;

    let request_payload = serde_json::json!({
        "contents": [{
            "parts": [
                {"inlineData": {"mimeType": "image/png", "data": base64_image}},
                {"text": ocr_prompt}
            ]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json"
        }
    });

    let mut primary_model = if config.ai_model.is_empty() {
        "gemini-2.5-flash-lite".to_string()
    } else {
        config.ai_model.clone()
    };
    if primary_model.contains("tts-preview") {
        primary_model = "gemini-2.0-flash".to_string();
    }
    
    let fallback_models = vec![
        primary_model.clone(),
        "gemini-3.1-flash-lite".to_string(),
        "gemini-2.5-flash".to_string(),
        "gemini-3.5-flash".to_string(),
        "gemini-2.5-flash-lite".to_string(),
        "gemini-2.0-flash".to_string(),
        "gemini-2.0-flash-lite".to_string(),
        "gemini-2.5-pro".to_string(),
    ];
    
    let mut seen = std::collections::HashSet::new();
    let fallback_models: Vec<String> = fallback_models
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut last_err = String::new();
    let mut gemini_text: Option<String> = None;
    
    for model in &fallback_models {
        // Проверяем блокировку модели по времени разблокировки
        {
            let locks = MODEL_LOCKS.lock().unwrap();
            if let Some(unlock_time) = locks.get(model) {
                if std::time::Instant::now() < *unlock_time {
                    last_err = format!("Модель {} временно заблокирована из-за 429", model);
                    continue;
                }
            }
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );

        match client.post(&url).json(&request_payload).send().await {
            Err(e) => {
                last_err = format!("Сетевая ошибка для {}: {}", model, e);
                continue;
            }
            Ok(res) => {
                let status = res.status();
                if status.as_u16() == 429 {
                    let delay = std::time::Duration::from_secs(60);
                    let unlock_time = std::time::Instant::now() + delay;
                    {
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    last_err = format!("Модель {} заблокирована (429)", model);
                    continue;
                }
                if !status.is_success() {
                    let err_text = res.text().await.unwrap_or_default();
                    last_err = format!("Ошибка {} для {}: {}", status, model, err_text);
                    if err_text.contains("RESOURCE_EXHAUSTED") || err_text.contains("quota") {
                        let unlock_time = std::time::Instant::now() + std::time::Duration::from_secs(3600);
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    continue;
                }
                match res.json::<GeminiResponse>().await {
                    Err(e) => {
                        last_err = format!("Парсинг ответа для {}: {}", model, e);
                        continue;
                    }
                    Ok(gr) => {
                        let mut found = false;
                        if let Some(cands) = gr.candidates {
                            for cand in cands {
                                if let Some(content) = cand.content {
                                    if let Some(parts) = content.parts {
                                        for part in parts {
                                            if let Some(text) = part.text {
                                                if !text.trim().is_empty() {
                                                    gemini_text = Some(text);
                                                    found = true;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                                if found { break; }
                            }
                        }
                        if !found {
                            last_err = format!("Пустой ответ кандидатов от {}", model);
                        } else {
                            break;
                        }
                    }
                }
            }
        }
    }
    
    let raw_json = match gemini_text {
        None => return Err(format!("Все модели ИИ недоступны. Последняя ошибка: {}", last_err)),
        Some(txt) => txt,
    };
    
    // Очищаем от markdown разметки типа ```json ... ```
    let mut cleaned = raw_json.trim().to_string();
    if cleaned.starts_with("```") {
        if let Some(first_newline) = cleaned.find('\n') {
            cleaned = cleaned[first_newline..].to_string();
        }
        if cleaned.ends_with("```") {
            cleaned.truncate(cleaned.len() - 3);
        }
        cleaned = cleaned.trim().to_string();
    }
    
    // Парсим ответ в JSON
    let parsed: serde_json::Value = serde_json::from_str(&cleaned)
        .map_err(|e| format!("Ошибка парсинга JSON от Gemini: {}. Исходный текст: {}", e, cleaned))?;
        
    // Пересчитываем нормализованные координаты в локальные пиксели оверлея
    let mut sentences_out = Vec::new();
    
    if let Some(sentences) = parsed["sentences"].as_array() {
        for sentence in sentences {
            let sentence_text = sentence["text"].as_str().unwrap_or("").to_string();
            let mut words_out = Vec::new();
            
            if let Some(words) = sentence["words"].as_array() {
                for word in words {
                    let word_text = word["text"].as_str().unwrap_or("").to_string();
                    if let Some(box_arr) = word["box"].as_array() {
                        if box_arr.len() == 4 {
                            let ymin = box_arr[0].as_f64().unwrap_or(0.0);
                            let xmin = box_arr[1].as_f64().unwrap_or(0.0);
                            let ymax = box_arr[2].as_f64().unwrap_or(0.0);
                            let xmax = box_arr[3].as_f64().unwrap_or(0.0);
                            
                            // Пересчет координат [0, 1000] в абсолютные физические на экране
                            let phys_crop_x = monitor_x + crop_x as i32;
                            let phys_crop_y = monitor_y + crop_y as i32;

                            let wx_rel = (xmin / 1000.0) * (crop_w as f64);
                            let wy_rel = (ymin / 1000.0) * (crop_h as f64);
                            let ww_rel = ((xmax - xmin) / 1000.0) * (crop_w as f64);
                            let wh_rel = ((ymax - ymin) / 1000.0) * (crop_h as f64);

                            let wx_abs = phys_crop_x as f64 + wx_rel;
                            let wy_abs = phys_crop_y as f64 + wy_rel;
                            
                            words_out.push(serde_json::json!({
                                "text": word_text,
                                "x": wx_abs.round() as i32,
                                "y": wy_abs.round() as i32,
                                "w": ww_rel.round() as i32,
                                "h": wh_rel.round() as i32
                            }));
                        }
                    }
                }
            }
            
            sentences_out.push(serde_json::json!({
                "text": sentence_text,
                "words": words_out
            }));
        }
    }
    
    Ok(serde_json::json!({
        "sentences": sentences_out
    }))
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct OcrWordInfo {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
}

#[cfg(target_os = "windows")]
fn recognize_bitmap(
    ocr_engine: &windows::Media::Ocr::OcrEngine,
    software_bitmap: &windows::Graphics::Imaging::SoftwareBitmap,
) -> Result<Vec<OcrWordInfo>, String> {
    let ocr_result = ocr_engine.RecognizeAsync(software_bitmap).map_err(|e| e.to_string())?.get()
        .map_err(|e| format!("Ошибка распознавания Windows OCR: {}", e))?;
        
    let mut words = Vec::new();
    let lines = ocr_result.Lines().map_err(|e| e.to_string())?;
    for line in lines {
        let line_words = line.Words().map_err(|e| e.to_string())?;
        for word in line_words {
            let text = word.Text().map_err(|e| e.to_string())?.to_string();
            let rect = word.BoundingRect().map_err(|e| e.to_string())?;
            words.push(OcrWordInfo {
                text,
                x: rect.X,
                y: rect.Y,
                width: rect.Width,
                height: rect.Height,
            });
        }
    }
    Ok(words)
}

fn has_extended_chars(s: &str) -> bool {
    s.chars().any(|c| {
        ('\u{0400}'..='\u{04FF}').contains(&c) || // Кириллица
        ('\u{0600}'..='\u{06FF}').contains(&c) || // Арабское письмо
        ('\u{4E00}'..='\u{9FFF}').contains(&c) || // CJK иероглифы
        ('\u{00C0}'..='\u{00FF}').contains(&c) || // Latin-1 Supplement (умлауты, акценты)
        ('\u{0100}'..='\u{017F}').contains(&c)    // Latin Extended-A
    })
}

fn select_best_word(w1: &OcrWordInfo, lang1: &str, w2: &OcrWordInfo, lang2: &str) -> OcrWordInfo {
    let ext1 = has_extended_chars(&w1.text);
    let ext2 = has_extended_chars(&w2.text);

    // 1. Если один вариант содержит национальные спецсимволы (кириллицу, арабский, умлауты, иероглифы), а второй нет
    if ext1 && !ext2 {
        return w1.clone();
    }
    if ext2 && !ext1 {
        return w2.clone();
    }

    // 2. Если оба содержат или оба не содержат (чистый ASCII):
    // Отдаем приоритет английскому движку
    let is_en1 = lang1.to_lowercase().contains("en");
    let is_en2 = lang2.to_lowercase().contains("en");
    if is_en1 && !is_en2 {
        return w1.clone();
    }
    if is_en2 && !is_en1 {
        return w2.clone();
    }

    // 3. Выбираем слово, которое длиннее
    if w1.text.len() >= w2.text.len() {
        w1.clone()
    } else {
        w2.clone()
    }
}

fn merge_two_ocr_results(
    words_a: Vec<OcrWordInfo>,
    lang_a: &str,
    words_b: Vec<OcrWordInfo>,
    lang_b: &str,
) -> Vec<OcrWordInfo> {
    let mut merged = Vec::new();
    let mut b_used = vec![false; words_b.len()];

    for w_a in words_a {
        let mut found_match_idx = None;
        for (idx, w_b) in words_b.iter().enumerate() {
            if b_used[idx] {
                continue;
            }
            // Вычисляем пересечение BoundingRect
            let ax1 = w_a.x;
            let ay1 = w_a.y;
            let ax2 = w_a.x + w_a.width;
            let ay2 = w_a.y + w_a.height;

            let bx1 = w_b.x;
            let by1 = w_b.y;
            let bx2 = w_b.x + w_b.width;
            let by2 = w_b.y + w_b.height;

            let overlap_x1 = ax1.max(bx1);
            let overlap_y1 = ay1.max(by1);
            let overlap_x2 = ax2.min(bx2);
            let overlap_y2 = ay2.min(by2);

            let overlap_w = overlap_x2 - overlap_x1;
            let overlap_h = overlap_y2 - overlap_y1;

            if overlap_w > 0.0 && overlap_h > 0.0 {
                let overlap_area = overlap_w * overlap_h;
                let area_a = w_a.width * w_a.height;
                let area_b = w_b.width * w_b.height;
                let min_area = area_a.min(area_b);
                
                if overlap_area > 0.4 * min_area {
                    found_match_idx = Some(idx);
                    break;
                }
            }
        }

        if let Some(idx) = found_match_idx {
            b_used[idx] = true;
            let w_b = &words_b[idx];
            merged.push(select_best_word(&w_a, lang_a, w_b, lang_b));
        } else {
            merged.push(w_a);
        }
    }

    for (idx, w_b) in words_b.into_iter().enumerate() {
        if !b_used[idx] {
            merged.push(w_b);
        }
    }

    merged
}

fn sort_ocr_words(mut words: Vec<OcrWordInfo>) -> Vec<OcrWordInfo> {
    if words.is_empty() {
        return words;
    }
    // 1. Сортируем по Y центра
    words.sort_by(|a, b| {
        let ay = a.y + a.height / 2.0;
        let by = b.y + b.height / 2.0;
        ay.partial_cmp(&by).unwrap_or(std::cmp::Ordering::Equal)
    });

    // 2. Группируем в строки
    let mut lines: Vec<Vec<OcrWordInfo>> = Vec::new();
    for w in words {
        let cy = w.y + w.height / 2.0;
        let mut added = false;
        for line in &mut lines {
            let line_cy = line.iter().map(|word| word.y + word.height / 2.0).sum::<f32>() / line.len() as f32;
            let line_h = line.iter().map(|word| word.height).sum::<f32>() / line.len() as f32;
            if (cy - line_cy).abs() < line_h * 0.8 {
                line.push(w.clone());
                added = true;
                break;
            }
        }
        if !added {
            lines.push(vec![w]);
        }
    }

    // 3. Сортируем слова внутри каждой строки по X
    for line in &mut lines {
        line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal));
    }

    // 4. Сортируем строки по Y
    lines.sort_by(|a, b| {
        let ay = a.iter().map(|w| w.y + w.height / 2.0).sum::<f32>() / a.len() as f32;
        let by = b.iter().map(|w| w.y + w.height / 2.0).sum::<f32>() / b.len() as f32;
        ay.partial_cmp(&by).unwrap_or(std::cmp::Ordering::Equal)
    });

    // 5. Собираем в плоский список
    lines.into_iter().flatten().collect()
}

#[cfg(target_os = "windows")]
async fn run_windows_ocr(png_bytes: &[u8]) -> Result<Vec<OcrWordInfo>, String> {
    use windows::Storage::Streams::InMemoryRandomAccessStream;
    use windows::Storage::Streams::DataWriter;
    use windows::Graphics::Imaging::BitmapDecoder;
    use windows::Media::Ocr::OcrEngine;

    let stream = InMemoryRandomAccessStream::new()
        .map_err(|e| format!("Ошибка создания WinRT Stream: {}", e))?;
    
    let writer = DataWriter::CreateDataWriter(&stream)
        .map_err(|e| format!("Ошибка создания DataWriter: {}", e))?;
    
    writer.WriteBytes(png_bytes)
        .map_err(|e| format!("Ошибка записи байт: {}", e))?;
        
    writer.StoreAsync().map_err(|e| e.to_string())?.get()
        .map_err(|e| format!("Ошибка сохранения потока DataWriter: {}", e))?;
        
    writer.FlushAsync().map_err(|e| e.to_string())?.get()
        .map_err(|e| format!("Ошибка сброса буфера DataWriter: {}", e))?;
        
    stream.Seek(0)
        .map_err(|e| format!("Ошибка перемотки потока: {}", e))?;
        
    let decoder = BitmapDecoder::CreateAsync(&stream).map_err(|e| e.to_string())?.get()
        .map_err(|e| format!("Ошибка создания BitmapDecoder: {}", e))?;
        
    let software_bitmap = decoder.GetSoftwareBitmapAsync().map_err(|e| e.to_string())?.get()
        .map_err(|e| format!("Ошибка декодирования SoftwareBitmap: {}", e))?;
        
    // Опрашиваем все доступные языки OCR в системе
    let mut lang_tags = Vec::new();
    if let Ok(langs) = OcrEngine::AvailableRecognizerLanguages() {
        if let Ok(size) = langs.Size() {
            for i in 0..size {
                if let Ok(lang) = langs.GetAt(i) {
                    if let Ok(tag) = lang.LanguageTag() {
                        lang_tags.push(tag.to_string());
                    }
                }
            }
        }
    }

    let mut all_words_by_lang = Vec::new();

    if lang_tags.is_empty() {
        if let Ok(default_engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
            if let Ok(w) = recognize_bitmap(&default_engine, &software_bitmap) {
                all_words_by_lang.push(("default".to_string(), w));
            }
        }
    } else {
        // Ограничиваем первыми 3 языками для скорости
        for tag in lang_tags.into_iter().take(3) {
            use windows::Globalization::Language;
            if let Ok(lang) = Language::CreateLanguage(&tag.clone().into()) {
                if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&lang) {
                    if let Ok(w) = recognize_bitmap(&engine, &software_bitmap) {
                        all_words_by_lang.push((tag, w));
                    }
                }
            }
        }
    }

    let mut merged_words = Vec::new();
    if !all_words_by_lang.is_empty() {
        let (first_lang, first_words) = all_words_by_lang.remove(0);
        merged_words = first_words;
        let mut current_lang = first_lang;

        for (next_lang, next_words) in all_words_by_lang {
            merged_words = merge_two_ocr_results(merged_words, &current_lang, next_words, &next_lang);
            if next_lang.to_lowercase().contains("en") {
                current_lang = next_lang;
            }
        }
    }

    Ok(sort_ocr_words(merged_words))
}

#[cfg(not(target_os = "windows"))]
async fn run_windows_ocr(_png_bytes: &[u8]) -> Result<Vec<OcrWordInfo>, String> {
    Err("Windows OCR поддерживается только на ОС Windows".to_string())
}

#[tauri::command]
async fn process_ocr_hybrid(
    app_handle: tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<serde_json::Value, String> {
    // 1. Поиск монитора и захват скриншота
    let center_x = x + (width as i32) / 2;
    let center_y = y + (height as i32) / 2;
    
    // Скрываем окно оверлея
    if let Some(w) = app_handle.get_webview_window("ocr") {
        let _ = w.hide();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    
    let capture_res = (|| -> Result<(image::RgbaImage, f32, i32, i32), String> {
        let monitor = xcap::Monitor::from_point(center_x, center_y)
            .map_err(|e| format!("Не удалось найти монитор в точке ({}, {}): {}", center_x, center_y, e))?;
            
        let screenshot = monitor.capture_image()
            .map_err(|e| format!("Ошибка захвата экрана: {}", e))?;
            
        let scale = monitor.scale_factor().map_err(|e| e.to_string())?;
        let monitor_x = monitor.x().map_err(|e| e.to_string())?;
        let monitor_y = monitor.y().map_err(|e| e.to_string())?;
        
        Ok((screenshot, scale, monitor_x, monitor_y))
    })();

    // Показываем окно оверлея обратно
    if let Some(w) = app_handle.get_webview_window("ocr") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
    }

    let (screenshot, _scale, monitor_x, monitor_y) = capture_res?;
    
    let local_x = x - monitor_x;
    let local_y = y - monitor_y;
    
    let phys_x = local_x.max(0) as u32;
    let phys_y = local_y.max(0) as u32;
    let phys_w = width;
    let phys_h = height;
    
    let img_w = screenshot.width();
    let img_h = screenshot.height();
    
    let crop_x = phys_x.min(img_w);
    let crop_y = phys_y.min(img_h);
    let crop_w = phys_w.min(img_w - crop_x);
    let crop_h = phys_h.min(img_h - crop_y);
    
    if crop_w == 0 || crop_h == 0 {
        return Err("Размер области захвата равен нулю".to_string());
    }
    
    // Обрезка
    let cropped = image::imageops::crop_imm(&screenshot, crop_x, crop_y, crop_w, crop_h).to_image();
    
    // Кодирование в PNG
    let mut png_bytes = Vec::new();
    cropped.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("Ошибка сжатия PNG: {}", e))?;
        
    // Запускаем локальный Windows OCR
    let words = run_windows_ocr(&png_bytes).await?;
    
    if words.is_empty() {
        return Ok(serde_json::json!({ "sentences": [] }));
    }
    
    // Формируем плоский текст для Gemini (просто склеиваем слова через пробел)
    let mut ocr_flat_text = String::new();
    for w in &words {
        ocr_flat_text.push_str(&w.text);
        ocr_flat_text.push(' ');
    }
    
    // Запрос к Gemini (текстовый) для разбивки на предложения
    let config = load_config_internal(&app_handle)?;
    let api_key = config.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("API ключ Gemini пуст в конфигурации".to_string());
    }
    
    let prompt = r#"Ты — помощник по сегментации текста.
Тебе дан сырой текст, полученный в результате распознавания экрана (OCR). Раздели этот текст на правильные, грамматически и логически связные предложения.
Игнорируй случайный мусор (например, битые символы распознавания), но объединяй слова, которые логически составляют одну фразу или предложение.

Формат ответа — СТРОГО JSON без markdown (без ```json, без пояснений):
{
  "sentences": [
    "Первое предложение",
    "Второе предложение"
  ]
}

Правила:
1. Не придумывай новые слова, не изменяй окончания слов, используй только те, что даны в тексте.
2. Каждое предложение должно быть грамматически полным и правильным.
3. Сохраняй исходную пунктуацию в конце предложений (точки, знаки восклицания, вопросы).
4. СТРОГО ЗАПРЕЩЕНО объединять в одно предложение строки, разделенные переносом строки (\n), если они не являются непосредственным грамматическим продолжением друг друга.
5. Технические логи (например, "Worked for 38s", "Worked for 46s"), служебные сообщения, заголовки и пункты списков ДОЛЖНЫ быть выделены в отдельные предложения. Никогда не склеивай их с основным текстом.
6. Если в тексте встречается точка (.), восклицательный (!) или вопросительный (?) знак, за которым следует новое предложение с заглавной буквы (даже на той же строке), СТРОГО разделяй их на разные предложения.
7. Никогда не выделяй текст в скобках в конце предложения в отдельное предложение, если завершающий знак препинания (точка/вопрос/восклицание) стоит после закрывающей скобки. Текст в скобках должен оставаться частью основного предложения."#;

    let request_payload = serde_json::json!({
        "contents": [{
            "parts": [
                {"text": format!("{}\n\nТекст для разделения:\n{}", prompt, ocr_flat_text)}
            ]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json"
        }
    });

    let mut primary_model = if config.ai_model.is_empty() {
        "gemini-2.5-flash-lite".to_string()
    } else {
        config.ai_model.clone()
    };
    if primary_model.contains("tts-preview") {
        primary_model = "gemini-2.0-flash".to_string();
    }
    
    let fallback_models = vec![
        primary_model.clone(),
        "gemini-3.1-flash-lite".to_string(),
        "gemini-2.5-flash".to_string(),
        "gemini-3.5-flash".to_string(),
        "gemini-2.5-flash-lite".to_string(),
        "gemini-2.0-flash".to_string(),
        "gemini-2.0-flash-lite".to_string(),
        "gemini-2.5-pro".to_string(),
    ];
    
    let mut seen = std::collections::HashSet::new();
    let fallback_models: Vec<String> = fallback_models
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());
    let mut last_err = String::new();
    let mut gemini_response_text: Option<String> = None;
    
    for model in &fallback_models {
        {
            let locks = MODEL_LOCKS.lock().unwrap();
            if let Some(unlock_time) = locks.get(model) {
                if std::time::Instant::now() < *unlock_time {
                    last_err = format!("Модель {} заблокирована", model);
                    continue;
                }
            }
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );

        match client.post(&url).json(&request_payload).send().await {
            Err(e) => {
                last_err = format!("Ошибка сети для {}: {}", model, e);
                continue;
            }
            Ok(res) => {
                let status = res.status();
                if status.as_u16() == 429 {
                    let unlock_time = std::time::Instant::now() + std::time::Duration::from_secs(60);
                    let mut locks = MODEL_LOCKS.lock().unwrap();
                    locks.insert(model.clone(), unlock_time);
                    last_err = format!("Модель {} 429", model);
                    continue;
                }
                if !status.is_success() {
                    let err_text = res.text().await.unwrap_or_default();
                    last_err = format!("Код {} от {}: {}", status, model, err_text);
                    continue;
                }
                match res.json::<GeminiResponse>().await {
                    Err(e) => {
                        last_err = format!("Ошибка парсинга JSON для {}: {}", model, e);
                        continue;
                    }
                    Ok(gr) => {
                        let mut found = false;
                        if let Some(cands) = gr.candidates {
                            for cand in cands {
                                if let Some(content) = cand.content {
                                    if let Some(parts) = content.parts {
                                        for part in parts {
                                            if let Some(text) = part.text {
                                                if !text.trim().is_empty() {
                                                    gemini_response_text = Some(text);
                                                    found = true;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                                if found { break; }
                            }
                        }
                        if found { break; }
                    }
                }
            }
        }
    }

    let raw_json = match gemini_response_text {
        None => return Err(format!("Все модели ИИ недоступны. Последняя ошибка: {}", last_err)),
        Some(txt) => txt,
    };

    let mut cleaned = raw_json.trim().to_string();
    if cleaned.starts_with("```") {
        if let Some(first_newline) = cleaned.find('\n') {
            cleaned = cleaned[first_newline..].to_string();
        }
        if cleaned.ends_with("```") {
            cleaned.truncate(cleaned.len() - 3);
        }
        cleaned = cleaned.trim().to_string();
    }

    // Парсим результат от Gemini
    let parsed: serde_json::Value = serde_json::from_str(&cleaned)
        .map_err(|e| format!("Ошибка парсинга JSON от Gemini: {}. Ответ: {}", e, cleaned))?;

    // Получаем список предложений из ответа Gemini
    let mut sentences_vec = Vec::new();
    if let Some(arr) = parsed["sentences"].as_array() {
        for val in arr {
            if let Some(s) = val.as_str() {
                sentences_vec.push(s.to_string());
            }
        }
    }

    if sentences_vec.is_empty() {
        return Ok(serde_json::json!({ "sentences": [] }));
    }

    let phys_crop_x = monitor_x + crop_x as i32;
    let phys_crop_y = monitor_y + crop_y as i32;

    let sentences_out = format_sentences_with_words(&sentences_vec, &words, phys_crop_x, phys_crop_y);

    Ok(serde_json::json!({
        "sentences": sentences_out
    }))
}

// ─── Asynchronous Three-Phase OCR Scan (start_ocr_scan_async) ────────────────

async fn call_gemini_text_api(
    app_handle: &tauri::AppHandle,
    api_key: &str,
    primary_model: &str,
    prompt: &str,
    text: &str,
) -> Result<(Vec<String>, String), String> {
    let mut fallback_models = Vec::new();
    if let Ok(last_model_lock) = LAST_WORKING_MODEL.lock() {
        if let Some(ref last_model) = *last_model_lock {
            fallback_models.push(last_model.clone());
        }
    }
    fallback_models.push(primary_model.to_string());
    fallback_models.push("gemini-3.1-flash-lite".to_string());
    fallback_models.push("gemini-3.5-flash".to_string());
    fallback_models.push("gemini-3-flash".to_string());
    fallback_models.push("gemini-2.5-flash-lite".to_string());
    fallback_models.push("gemini-2.5-flash".to_string());
    fallback_models.push("gemini-2.0-flash-lite".to_string());
    fallback_models.push("gemini-2.0-flash".to_string());
    fallback_models.push("gemma-4-31b-it".to_string());
    fallback_models.push("gemma-4-26b-a4b-it".to_string());
    
    let mut seen = std::collections::HashSet::new();
    let fallback_models: Vec<String> = fallback_models
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let request_payload = serde_json::json!({
        "contents": [{
            "parts": [
                {"text": format!("{}\n\nТекст для разделения:\n{}", prompt, text)}
            ]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json"
        }
    });

    let mut last_err = String::new();
    let mut gemini_response_text = None;
    let mut used_model_info = String::new();

    for model in &fallback_models {
        {
            let locks = MODEL_LOCKS.lock().unwrap();
            if let Some(unlock_time) = locks.get(model) {
                if std::time::Instant::now() < *unlock_time {
                    last_err = format!("Модель {} заблокирована", model);
                    continue;
                }
            }
        }

        // Проверяем локальные лимиты RPM/RPD перед запросом
        let (rpm, rpd) = match check_and_record_rate_limit(model) {
            Ok((rpm, rpd)) => (rpm, rpd),
            Err(err_msg) => {
                last_err = format!("Модель {} пропущена ({})", model, err_msg);
                let _ = app_handle.emit("ocr-status-update", format!("⚠️ Пропущена {}: {}. Переключаю...", model, err_msg));
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
        };

        let (max_rpm_label, max_rpd_label) = match model.as_str() {
            "gemini-2.5-pro" => (5, 34),
            "gemini-2.5-flash" => (5, 20),
            "gemini-2.5-flash-lite" => (10, 20),
            "gemini-2.0-flash" => (15, 1500),
            "gemini-2.0-flash-lite" => (30, 1500),
            "gemini-1.5-flash" => (15, 1500),
            "gemini-1.5-pro" => (2, 58),
            "gemini-3.5-flash" => (5, 20),
            "gemini-3.1-flash-lite" => (15, 500),
            "gemini-3-flash" => (5, 20),
            "gemma-4-31b-it" | "gemma-4-26b-a4b-it" => (15, 1500),
            _ => {
                if model.contains("lite") { (30, 1500) }
                else if model.contains("pro") { (3, 58) }
                else { (15, 1500) }
            }
        };

        let _ = app_handle.emit(
            "ocr-status-update",
            format!("⏳ Попытка ИИ: {} (минута {}/{}, день {}/{})...", model, rpm, max_rpm_label, rpd, max_rpd_label)
        );

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );

        match client.post(&url).json(&request_payload).send().await {
            Err(e) => {
                last_err = format!("Ошибка сети для {}: {}", model, e);
                let _ = app_handle.emit("ocr-status-update", format!("⚠️ Ошибка сети {}. Ожидание 1с...", model));
                let unlock_time = std::time::Instant::now() + std::time::Duration::from_secs(60);
                {
                    let mut locks = MODEL_LOCKS.lock().unwrap();
                    locks.insert(model.clone(), unlock_time);
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                continue;
            }
            Ok(res) => {
                let status = res.status();
                if status.as_u16() == 429 {
                    let unlock_time = std::time::Instant::now() + std::time::Duration::from_secs(60);
                    {
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    last_err = format!("Модель {} 429", model);
                    let _ = app_handle.emit("ocr-status-update", format!("⚠️ Сбой {} (429). Ожидание 1с перед следующей попыткой...", model));
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
                if !status.is_success() {
                    let err_text = res.text().await.unwrap_or_default();
                    last_err = format!("Код {} от {}: {}", status, model, err_text);
                    let _ = app_handle.emit("ocr-status-update", format!("⚠️ Сбой {} ({}). Ожидание 1с...", model, status));
                    let unlock_time = std::time::Instant::now() + std::time::Duration::from_secs(60);
                    {
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    continue;
                }
                match res.json::<GeminiResponse>().await {
                    Err(e) => {
                        last_err = format!("Ошибка парсинга JSON для {}: {}", model, e);
                        continue;
                    }
                    Ok(gr) => {
                        let mut found = false;
                        if let Some(cands) = gr.candidates {
                            for cand in cands {
                                if let Some(content) = cand.content {
                                    if let Some(parts) = content.parts {
                                        for part in parts {
                                            if let Some(txt) = part.text {
                                                if !txt.trim().is_empty() {
                                                    gemini_response_text = Some(txt);
                                                    used_model_info = format!("{} (RPM: {}/15)", model, rpm);
                                                    found = true;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                                if found { break; }
                            }
                        }
                        if found {
                            if let Ok(mut last_model_lock) = LAST_WORKING_MODEL.lock() {
                                *last_model_lock = Some(model.clone());
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    let raw_json = gemini_response_text.ok_or_else(|| format!("Все модели недоступны. Последняя ошибка: {}", last_err))?;
    let mut cleaned = raw_json.trim().to_string();
    if cleaned.starts_with("```") {
        if let Some(first_newline) = cleaned.find('\n') {
            cleaned = cleaned[first_newline..].to_string();
        }
        if cleaned.ends_with("```") {
            cleaned.truncate(cleaned.len() - 3);
        }
        cleaned = cleaned.trim().to_string();
    }

    let parsed: serde_json::Value = serde_json::from_str(&cleaned)
        .map_err(|e| format!("Ошибка парсинга JSON от Gemini: {}. Ответ: {}", e, cleaned))?;

    let mut sentences_vec = Vec::new();
    if let Some(arr) = parsed["sentences"].as_array() {
        for val in arr {
            if let Some(s) = val.as_str() {
                sentences_vec.push(s.to_string());
            }
        }
    }

    Ok((sentences_vec, used_model_info))
}

async fn call_gemini_vision_api(
    api_key: &str,
    primary_model: &str,
    prompt: &str,
    base64_image: &str,
) -> Result<serde_json::Value, String> {
    let mut fallback_models = Vec::new();
    if let Ok(last_model_lock) = LAST_WORKING_MODEL.lock() {
        if let Some(ref last_model) = *last_model_lock {
            fallback_models.push(last_model.clone());
        }
    }
    fallback_models.push(primary_model.to_string());
    fallback_models.push("gemini-3.1-flash-lite".to_string());
    fallback_models.push("gemini-3.5-flash".to_string());
    fallback_models.push("gemini-3-flash".to_string());
    fallback_models.push("gemini-2.5-flash".to_string());
    fallback_models.push("gemini-2.0-flash".to_string());
    fallback_models.push("gemini-1.5-flash".to_string());
    fallback_models.push("gemini-2.5-pro".to_string());
    
    let mut seen = std::collections::HashSet::new();
    let fallback_models: Vec<String> = fallback_models
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let request_payload = serde_json::json!({
        "contents": [{
            "parts": [
                {"text": prompt.to_string()},
                {
                    "inlineData": {
                        "mimeType": "image/png",
                        "data": base64_image.to_string()
                    }
                }
            ]
        }],
        "generationConfig": {
            "temperature": 0.1,
            "responseMimeType": "application/json"
        }
    });

    let mut last_err = String::new();
    let mut gemini_response_text = None;

    for model in &fallback_models {
        {
            let locks = MODEL_LOCKS.lock().unwrap();
            if let Some(unlock_time) = locks.get(model) {
                if std::time::Instant::now() < *unlock_time {
                    last_err = format!("Модель {} заблокирована", model);
                    continue;
                }
            }
        }

        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            model, api_key
        );

        match client.post(&url).json(&request_payload).send().await {
            Err(e) => {
                last_err = format!("Ошибка сети для {}: {}", model, e);
                let unlock_time = std::time::Instant::now() + std::time::Duration::from_secs(60);
                {
                    let mut locks = MODEL_LOCKS.lock().unwrap();
                    locks.insert(model.clone(), unlock_time);
                }
                continue;
            }
            Ok(res) => {
                let status = res.status();
                if status.as_u16() == 429 {
                    let unlock_time = std::time::Instant::now() + std::time::Duration::from_secs(60);
                    {
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    last_err = format!("Модель {} 429", model);
                    continue;
                }
                if !status.is_success() {
                    let err_text = res.text().await.unwrap_or_default();
                    last_err = format!("Код {} от {}: {}", status, model, err_text);
                    let unlock_time = std::time::Instant::now() + std::time::Duration::from_secs(60);
                    {
                        let mut locks = MODEL_LOCKS.lock().unwrap();
                        locks.insert(model.clone(), unlock_time);
                    }
                    continue;
                }
                match res.json::<GeminiResponse>().await {
                    Err(e) => {
                        last_err = format!("Ошибка парсинга JSON для {}: {}", model, e);
                        continue;
                    }
                    Ok(gr) => {
                        let mut found = false;
                        if let Some(cands) = gr.candidates {
                            for cand in cands {
                                if let Some(content) = cand.content {
                                    if let Some(parts) = content.parts {
                                        for part in parts {
                                            if let Some(txt) = part.text {
                                                if !txt.trim().is_empty() {
                                                    gemini_response_text = Some(txt);
                                                    found = true;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                }
                                if found { break; }
                            }
                        }
                        if found {
                            if let Ok(mut last_model_lock) = LAST_WORKING_MODEL.lock() {
                                *last_model_lock = Some(model.clone());
                            }
                            break;
                        }
                    }
                }
            }
        }
    }

    let raw_json = gemini_response_text.ok_or_else(|| format!("Все модели недоступны. Последняя ошибка: {}", last_err))?;
    let mut cleaned = raw_json.trim().to_string();
    if cleaned.starts_with("```") {
        if let Some(first_newline) = cleaned.find('\n') {
            cleaned = cleaned[first_newline..].to_string();
        }
        if cleaned.ends_with("```") {
            cleaned.truncate(cleaned.len() - 3);
        }
        cleaned = cleaned.trim().to_string();
    }

    let parsed: serde_json::Value = serde_json::from_str(&cleaned)
        .map_err(|e| format!("Ошибка парсинга JSON от Gemini Vision: {}. Ответ: {}", e, cleaned))?;

    Ok(parsed)
}

struct OcrLineInfo {
    text: String,
    x: f32,
    y: f32,
    width: f32,
    height: f32,
    avg_word_height: f32,
    text_start_x: f32,
}

fn split_text_into_sentences(text: &str) -> Vec<String> {
    if text.trim().is_empty() {
        return Vec::new();
    }
    let mut sentences = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    
    while i < chars.len() {
        let c = chars[i];
        current.push(c);
        
        let is_terminal = c == '.' || c == '!' || c == '?';
        let mut should_split = false;
        
        if is_terminal {
            // Проверяем, не является ли это сокращением (например, "сокр.", "т.д.", "lib.rs")
            let is_abbreviation = {
                let prev_words: Vec<&str> = current.split_whitespace().collect();
                if let Some(&last_word) = prev_words.last() {
                    let clean = last_word.to_lowercase().trim_matches(|ch: char| !ch.is_alphabetic()).to_string();
                    clean == "vs" || clean == "rs" || clean == "mr" || clean == "ms" || clean == "dr" || clean == "eg" || clean == "ie" || clean == "lib"
                } else {
                    false
                }
            };
            
            if !is_abbreviation {
                // За точкой может следовать закрывающая скобка или кавычка
                let mut next_idx = i + 1;
                while next_idx < chars.len() && (chars[next_idx] == ')' || chars[next_idx] == ']' || chars[next_idx] == '"' || chars[next_idx] == '\'' || chars[next_idx] == '»') {
                    current.push(chars[next_idx]);
                    next_idx += 1;
                }
                i = next_idx - 1; // сдвигаем указатель
                
                // Теперь ищем следующий непробельный символ
                let mut check_idx = next_idx;
                while check_idx < chars.len() && chars[check_idx].is_whitespace() {
                    check_idx += 1;
                }
                
                if check_idx < chars.len() {
                    let next_char = chars[check_idx];
                    // Если следующий символ — заглавная буква, начинаем новое предложение
                    if next_char.is_uppercase() || next_char.is_ascii_digit() || next_char == '-' || next_char == '*' || next_char == '•' {
                        should_split = true;
                    }
                } else {
                    // Конец текста
                    should_split = true;
                }
            }
        }
        
        if should_split {
            let trimmed = current.trim().to_string();
            if !trimmed.is_empty() {
                sentences.push(trimmed);
            }
            current.clear();
        }
        
        i += 1;
    }
    
    let trimmed = current.trim().to_string();
    if !trimmed.is_empty() {
        sentences.push(trimmed);
    }
    
    sentences
}

fn is_list_marker(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }
    if trimmed == "-" || trimmed == "*" || trimmed == "•" || trimmed == "+" || trimmed == "—" {
        return true;
    }
    if trimmed.ends_with('.') || trimmed.ends_with(')') {
        let core = &trimmed[..trimmed.len() - 1];
        if !core.is_empty() && core.chars().all(|c| c.is_ascii_digit()) {
            return true;
        }
        if core.len() == 1 && core.chars().next().unwrap().is_alphabetic() {
            return true;
        }
    }
    false
}

fn starts_with_list_item_marker(text: &str) -> bool {
    let trimmed = text.trim_start();
    let Some(first_char) = trimmed.chars().next() else {
        return false;
    };

    if matches!(first_char, '*' | '-' | '+' | '•' | '—') {
        let rest = &trimmed[first_char.len_utf8()..];
        return rest.is_empty()
            || rest
                .chars()
                .next()
                .map(|c| c.is_whitespace())
                .unwrap_or(false);
    }

    if !first_char.is_ascii_digit() {
        return false;
    }

    let digit_count = trimmed
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .count();

    let after_digits = &trimmed[digit_count..];
    after_digits.starts_with('.') || after_digits.starts_with(')')
}

fn is_technical_log_line(text: &str) -> bool {
    const LOG_PREFIXES: &[&str] = &[
        "[TRACE]",
        "[DEBUG]",
        "[INFO]",
        "[WARN]",
        "[WARNING]",
        "[ERROR]",
        "[FATAL]",
        "TRACE:",
        "DEBUG:",
        "INFO:",
        "WARN:",
        "WARNING:",
        "ERROR:",
        "FATAL:",
    ];

    let uppercase = text.trim_start().to_ascii_uppercase();
    LOG_PREFIXES
        .iter()
        .any(|prefix| uppercase.starts_with(prefix))
}

fn ends_with_connector(text: &str) -> bool {
    const CONNECTORS: &[&str] = &[
        "и", "или", "а", "но", "да", "хотя", "что", "чтобы", "если", "как", "в", "на", "с",
        "у", "к", "под", "над", "за", "из", "от", "до", "без", "для", "о", "об", "обо", "при",
        "про", "and", "or", "but", "yet", "so", "for", "in", "on", "at", "with", "to", "of",
        "by", "about", "under", "over", "from", "into", "through", "after", "before", "between",
        "against", "during", "without", "because", "the", "a", "an", "is", "are", "was", "were",
        "be", "been", "has", "have", "had",
    ];

    let Some(last_word) = text.split_whitespace().last() else {
        return false;
    };

    let lowercase = last_word.to_lowercase();
    let clean_last = lowercase.trim_matches(|c: char| !c.is_alphabetic());
    CONNECTORS.contains(&clean_last)
}

fn clean_ends_with_terminal(text: &str) -> bool {
    let cleaned = text.trim_end_matches(|c: char| c.is_whitespace() || c.is_control() || c == '\u{200b}');
    cleaned.ends_with('.') 
        || cleaned.ends_with('?') 
        || cleaned.ends_with('!')
        || cleaned.ends_with(':')
        || cleaned.ends_with(';')
        || cleaned.ends_with('>')
}

fn is_valid_single_word_start(text: &str) -> bool {
    let lower = text.to_lowercase();
    matches!(lower.as_str(), "я" | "в" | "с" | "у" | "к" | "о" | "а" | "и" | "i" | "a")
}

fn build_fallback_sentences_from_words(words: &[OcrWordInfo]) -> Vec<String> {
    if words.is_empty() {
        return Vec::new();
    }
    let sorted = sort_ocr_words(words.to_vec());
    
    // 1. Группируем слова в строки по Y и горизонтальным зазорам
    let mut lines: Vec<Vec<OcrWordInfo>> = Vec::new();
    let mut current_line: Vec<OcrWordInfo> = Vec::new();
    
    if !sorted.is_empty() {
        let mut last_x = sorted[0].x;
        let mut last_w = sorted[0].width;
        
        for w in sorted {
            let mut is_new_line = false;
            
            if !current_line.is_empty() {
                let ref_h = current_line.iter()
                    .map(|word| word.height)
                    .fold(w.height, |a, b| a.max(b));
                
                let line_cy = current_line.iter()
                    .map(|word| word.y + word.height / 2.0)
                    .sum::<f32>() / current_line.len() as f32;
                
                let cy = w.y + w.height / 2.0;
                
                is_new_line = (cy - line_cy).abs() > ref_h * 0.8;
                
                if !is_new_line {
                    let gap_x = w.x - (last_x + last_w);
                    if gap_x > ref_h * 4.0 {
                        is_new_line = true;
                    }
                }
            }
            
            if is_new_line && !current_line.is_empty() {
                lines.push(current_line);
                current_line = Vec::new();
            }
            
            last_x = w.x;
            last_w = w.width;
            current_line.push(w);
        }
        if !current_line.is_empty() {
            lines.push(current_line);
        }
    }
    
    // Переводим строки в структурный вид с геометрией
    let mut text_lines: Vec<OcrLineInfo> = Vec::new();
    for line in lines {
        if line.is_empty() { continue; }
        
        let min_x = line.iter().map(|w| w.x).fold(f32::INFINITY, f32::min);
        let max_x = line.iter().map(|w| w.x + w.width).fold(f32::NEG_INFINITY, f32::max);
        let min_y = line.iter().map(|w| w.y).fold(f32::INFINITY, f32::min);
        let max_y = line.iter().map(|w| w.y + w.height).fold(f32::NEG_INFINITY, f32::max);
        
        let avg_word_height = line.iter().map(|w| w.height).sum::<f32>() / line.len() as f32;
        
        let mut text_start_x = min_x;
        if line.len() > 1 {
            if is_list_marker(&line[0].text) {
                text_start_x = line[1].x;
            }
        }
        
        let line_str = line.iter().map(|w| w.text.as_str()).collect::<Vec<&str>>().join(" ");
        let trimmed = line_str.trim().to_string();
        
        if !trimmed.is_empty() {
            text_lines.push(OcrLineInfo {
                text: trimmed,
                x: min_x,
                y: min_y,
                width: max_x - min_x,
                height: max_y - min_y,
                avg_word_height,
                text_start_x,
            });
        }
    }
    
    if text_lines.is_empty() {
        return Vec::new();
    }
    
    // 2. Объединяем строки в абзацы по геометрическим и грамматическим признакам
    let max_line_width = text_lines.iter().map(|l| l.width).fold(0.0_f32, f32::max);
    let mut paragraphs = Vec::new();
    let mut current_paragraph = text_lines[0].text.clone();
    let mut prev_line = &text_lines[0];
    
    for i in 1..text_lines.len() {
        let curr_line = &text_lines[i];
        
        let prev_trimmed = current_paragraph.trim();
        let curr_trimmed = curr_line.text.trim();
        
        if curr_trimmed.is_empty() {
            continue;
        }
        
        let last_char = prev_trimmed.chars().last().unwrap_or(' ');
        
        // Используем максимальную высоту пары для всех геометрических порогов.
        let pair_h = prev_line
            .avg_word_height
            .max(curr_line.avg_word_height)
            .max(1.0);
            
        let gap_y = curr_line.y - (prev_line.y + prev_line.height);
        
        let overlap_x = (prev_line.x + prev_line.width)
            .min(curr_line.x + curr_line.width)
            - prev_line.x.max(curr_line.x);
            
        let font_ratio = if curr_line.avg_word_height > f32::EPSILON {
            prev_line.avg_word_height / curr_line.avg_word_height
        } else {
            f32::INFINITY
        };
        
        let x_shift = (curr_line.text_start_x - prev_line.text_start_x).abs();
        
        // Жесткие причины разделения
        let vertical_hard_split = gap_y > pair_h * 2.2;
        let column_hard_split = overlap_x <= 0.0;
        let list_item_hard_split = starts_with_list_item_marker(curr_trimmed);
        let tech_log_hard_split = is_technical_log_line(curr_trimmed);
        
        let hard_split = vertical_hard_split
            || column_hard_split
            || list_item_hard_split
            || tech_log_hard_split;
            
        // Мягкие геометрические признаки
        let font_changed = font_ratio < 0.70 || font_ratio > 1.40;
        let x_shift_split = x_shift > pair_h * 3.0;
        let soft_geometry_split = font_changed || x_shift_split;
        
        // Грамматическое продолжение
        let words_curr: Vec<&str> = curr_trimmed.split_whitespace().collect();
        let mut is_lowercase_start = false;
        let mut starts_with_bracket = false;
        
        if !words_curr.is_empty() {
            let mut target_word = words_curr[0];
            
            // Если первое слово состоит из одного символа, и оно НЕ является валидным предлогом/местоимением,
            // и есть второе слово, то мы считаем первое слово иконкой/мусором и анализируем второе.
            if target_word.chars().count() == 1 
                && !is_valid_single_word_start(target_word) 
                && words_curr.len() > 1 
            {
                target_word = words_curr[1];
            }
            
            let first_alphabetic_char = target_word.chars().find(|c| c.is_alphabetic());
            is_lowercase_start = first_alphabetic_char
                .map(|c| c.is_lowercase())
                .unwrap_or(false);
                
            starts_with_bracket = target_word.starts_with('(')
                || target_word.starts_with('[')
                || target_word.starts_with('{')
                || target_word.starts_with('«')
                || target_word.starts_with('"')
                || target_word.starts_with('\'');
        }
        
        let prev_ends_with_terminal = clean_ends_with_terminal(prev_trimmed);
            
        let is_prev_line_long = prev_line.width >= max_line_width * 0.75
            && prev_line.width >= prev_line.avg_word_height * 12.0;
            
        // Если предыдущая строка длинная (заполнена по ширине) и не заканчивается точкой,
        // то даже начало с заглавной буквы при идеальной геометрии считается продолжением.
        let is_continuation_by_flow = !prev_ends_with_terminal 
            && is_prev_line_long 
            && !soft_geometry_split;
            
        let is_continuation = is_lowercase_start || starts_with_bracket || is_continuation_by_flow;
        let connector_continuation = ends_with_connector(prev_trimmed);
        let punctuation_continuation = matches!(
            last_char,
            ',' | '-' | '—' | '–' | '(' | '[' | '{'
        );
        let merge_by_grammar = connector_continuation || punctuation_continuation;
        
        let (merge, reason) = if hard_split {
            (false, "hard_split")
        } else if is_continuation {
            // Грамматическое продолжение отменяет все мягкие признаки.
            (true, "grammatical_continuation")
        } else if soft_geometry_split {
            (false, "soft_geometry_without_continuation")
        } else if merge_by_grammar {
            (true, "connector_or_punctuation")
        } else {
            (false, "no_merge_rule")
        };
        
        eprintln!(
            "[ocr-line-merge] merge={} reason={} prev={:?} curr={:?} gap_y={:.2} pair_h={:.2} overlap_x={:.2} font_ratio={:.2} x_shift={:.2} hard=[v:{} c:{} l:{} t:{}] soft=[f:{} x:{}] grammar=[l:{} b:{} conn:{} p:{}]",
            merge,
            reason,
            prev_trimmed,
            curr_trimmed,
            gap_y,
            pair_h,
            overlap_x,
            font_ratio,
            x_shift,
            vertical_hard_split,
            column_hard_split,
            list_item_hard_split,
            tech_log_hard_split,
            font_changed,
            x_shift_split,
            is_lowercase_start,
            starts_with_bracket,
            connector_continuation,
            punctuation_continuation,
        );
        
        if merge {
            if !current_paragraph.ends_with(' ') {
                current_paragraph.push(' ');
            }
            current_paragraph.push_str(curr_trimmed);
        } else {
            paragraphs.push(current_paragraph.trim().to_string());
            current_paragraph = curr_line.text.clone();
        }
        prev_line = curr_line;
    }
    
    if !current_paragraph.is_empty() {
        paragraphs.push(current_paragraph.trim().to_string());
    }
    
    // 3. Каждую склеенную область разбиваем по точкам на предложения
    let mut sentences = Vec::new();
    for p in paragraphs {
        let p_sentences = split_text_into_sentences(&p);
        sentences.extend(p_sentences);
    }
    
    sentences
}

fn build_multiline_text_from_words(words: &[OcrWordInfo]) -> String {
    if words.is_empty() {
        return String::new();
    }
    let sorted = sort_ocr_words(words.to_vec());
    let mut multiline_text = String::new();
    
    let mut current_line_words: Vec<&OcrWordInfo> = Vec::new();
    let mut last_x = sorted[0].x;
    let mut last_w = sorted[0].width;
    
    for w in &sorted {
        let mut is_new_line = false;
        if !current_line_words.is_empty() {
            let ref_h = current_line_words.iter()
                .map(|word| word.height)
                .fold(w.height, |a, b| a.max(b));
                
            let line_cy = current_line_words.iter()
                .map(|word| word.y + word.height / 2.0)
                .sum::<f32>() / current_line_words.len() as f32;
                
            let cy = w.y + w.height / 2.0;
            
            is_new_line = (cy - line_cy).abs() > ref_h * 0.8;
            if !is_new_line {
                let gap_x = w.x - (last_x + last_w);
                if gap_x > ref_h * 4.0 {
                    is_new_line = true;
                }
            }
        }
        
        if is_new_line && !multiline_text.is_empty() {
            if multiline_text.ends_with(' ') {
                multiline_text.pop();
            }
            multiline_text.push('\n');
            current_line_words.clear();
        }
        
        multiline_text.push_str(&w.text);
        multiline_text.push(' ');
        
        last_x = w.x;
        last_w = w.width;
        current_line_words.push(w);
    }
    
    multiline_text.trim().to_string()
}

fn clean_word(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn levenshtein_distance(s1: &str, s2: &str) -> usize {
    let v1: Vec<char> = s1.chars().collect();
    let v2: Vec<char> = s2.chars().collect();
    let len1 = v1.len();
    let len2 = v2.len();
    
    let mut dp = vec![vec![0; len2 + 1]; len1 + 1];
    for i in 0..=len1 { dp[i][0] = i; }
    for j in 0..=len2 { dp[0][j] = j; }
    
    for i in 1..=len1 {
        for j in 1..=len2 {
            if v1[i-1] == v2[j-1] {
                dp[i][j] = dp[i-1][j-1];
            } else {
                dp[i][j] = 1 + dp[i-1][j-1].min(dp[i-1][j].min(dp[i][j-1]));
            }
        }
    }
    dp[len1][len2]
}

fn is_fuzzy_match(w1: &str, w2: &str) -> bool {
    let clean_w1 = clean_word(w1);
    let clean_w2 = clean_word(w2);
    if clean_w1.is_empty() || clean_w2.is_empty() {
        return false;
    }
    if clean_w1 == clean_w2 {
        return true;
    }
    if clean_w1.contains(&clean_w2) || clean_w2.contains(&clean_w1) {
        return true;
    }
    let dist = levenshtein_distance(&clean_w1, &clean_w2);
    let max_len = clean_w1.len().max(clean_w2.len());
    if max_len > 4 {
        dist <= 2
    } else {
        dist <= 1
    }
}

fn format_sentences_with_words(
    sentences_vec: &[String],
    words: &[OcrWordInfo],
    phys_crop_x: i32,
    phys_crop_y: i32,
) -> Vec<serde_json::Value> {
    let sorted_words = sort_ocr_words(words.to_vec());
    let clean_words: Vec<String> = sorted_words.iter().map(|w| clean_word(&w.text)).collect();
    
    // Фаза 1: Точное и нечеткое сопоставление слов ИИ с исходными словами OCR (помечаем индексы предложений)
    let mut word_to_sentence = vec![None; sorted_words.len()];
    let mut w_idx = 0;

    for (s_idx, sentence_text) in sentences_vec.iter().enumerate() {
        let query_words: Vec<&str> = sentence_text.split_whitespace().collect();
        for qw in query_words {
            let clean_qw = clean_word(qw);
            if clean_qw.is_empty() {
                continue;
            }

            let search_limit = (w_idx + 12).min(sorted_words.len());
            let mut found_idx = None;

            for i in w_idx..search_limit {
                if clean_words[i] == clean_qw {
                    found_idx = Some(i);
                    break;
                }
            }

            if found_idx.is_none() {
                for i in w_idx..search_limit {
                    if is_fuzzy_match(&clean_words[i], &clean_qw) {
                        found_idx = Some(i);
                        break;
                    }
                }
            }

            if let Some(match_idx) = found_idx {
                word_to_sentence[match_idx] = Some(s_idx);
                w_idx = match_idx + 1;
            }
        }
    }

    // Фаза 2: Распределение несопоставленных слов по ближайшим соседям
    for i in 0..sorted_words.len() {
        if word_to_sentence[i].is_none() {
            // Ищем ближайшего левого сопоставленного соседа
            let mut left_neighbor = None;
            for l in (0..i).rev() {
                if let Some(s_idx) = word_to_sentence[l] {
                    left_neighbor = Some((l, s_idx));
                    break;
                }
            }

            // Ищем ближайшего правого сопоставленного соседа
            let mut right_neighbor = None;
            for r in (i + 1)..sorted_words.len() {
                if let Some(s_idx) = word_to_sentence[r] {
                    right_neighbor = Some((r, s_idx));
                    break;
                }
            }

            // Определяем, к какому соседу привязать слово
            let assigned_s_idx = match (left_neighbor, right_neighbor) {
                (Some((l, s_idx_l)), Some((r, s_idx_r))) => {
                    if s_idx_l == s_idx_r {
                        s_idx_l
                    } else {
                        // Оба соседа есть и они из разных предложений.
                        // Проверяем, на одной ли строке слово с левым или правым соседом.
                        let cy_i = sorted_words[i].y + sorted_words[i].height / 2.0;
                        let cy_l = sorted_words[l].y + sorted_words[l].height / 2.0;
                        let cy_r = sorted_words[r].y + sorted_words[r].height / 2.0;

                        let diff_l = (cy_i - cy_l).abs();
                        let diff_r = (cy_i - cy_r).abs();
                        let threshold_l = sorted_words[i].height.max(sorted_words[l].height) * 0.8;
                        let threshold_r = sorted_words[i].height.max(sorted_words[r].height) * 0.8;

                        if diff_l < threshold_l && diff_r >= threshold_r {
                            s_idx_l
                        } else if diff_r < threshold_r && diff_l >= threshold_l {
                            s_idx_r
                        } else {
                            // Если оба на одной строке или оба на разных — привязываем к левому (предыдущему)
                            s_idx_l
                        }
                    }
                }
                (Some((_, s_idx_l)), None) => s_idx_l,
                (None, Some((_, s_idx_r))) => s_idx_r,
                (None, None) => 0, // По умолчанию первое предложение
            };

            word_to_sentence[i] = Some(assigned_s_idx);
        }
    }

    // Собираем результаты
    let mut sentence_word_indices = vec![Vec::new(); sentences_vec.len()];
    for (w_idx, s_idx_opt) in word_to_sentence.iter().enumerate() {
        if let Some(s_idx) = s_idx_opt {
            if *s_idx < sentence_word_indices.len() {
                sentence_word_indices[*s_idx].push(w_idx);
            }
        }
    }

    let mut sentences_out = Vec::new();
    for (s_idx, sentence_text) in sentences_vec.iter().enumerate() {
        let mut indices = sentence_word_indices[s_idx].clone();
        if indices.is_empty() {
            continue;
        }
        indices.sort_unstable();

        let mut words_out = Vec::new();
        for &idx in &indices {
            let w = &sorted_words[idx];
            let wx_abs = phys_crop_x as f32 + w.x;
            let wy_abs = phys_crop_y as f32 + w.y;

            words_out.push(serde_json::json!({
                "text": w.text.clone(),
                "x": wx_abs.round() as i32,
                "y": wy_abs.round() as i32,
                "w": w.width.round() as i32,
                "h": w.height.round() as i32
            }));
        }

        if !words_out.is_empty() {
            sentences_out.push(serde_json::json!({
                "text": sentence_text.clone(),
                "words": words_out
            }));
        }
    }
    sentences_out
}

fn align_and_format_vision_data(
    vision_data: &serde_json::Value,
    local_words: &[OcrWordInfo],
    phys_crop_x: i32,
    phys_crop_y: i32,
    crop_w: u32,
    crop_h: u32,
) -> Option<Vec<serde_json::Value>> {
    let sentences = vision_data["sentences"].as_array()?;
    if sentences.is_empty() {
        return None;
    }

    let mut sentences_out = Vec::new();
    let mut has_new_words = false;

    for s in sentences {
        let text = match s["text"].as_str() {
            Some(t) => t.to_string(),
            None => continue,
        };
        let words = match s["words"].as_array() {
            Some(w) => w,
            None => continue,
        };
        let mut words_out = Vec::new();

        for w in words {
            let w_text = match w["text"].as_str() {
                Some(t) => t.to_string(),
                None => continue,
            };
            let box_arr = match w["box"].as_array() {
                Some(b) => b,
                None => continue,
            };
            if box_arr.len() < 4 {
                continue;
            }

            let ymin = match box_arr[0].as_f64() { Some(val) => val as f32, None => continue };
            let xmin = match box_arr[1].as_f64() { Some(val) => val as f32, None => continue };
            let ymax = match box_arr[2].as_f64() { Some(val) => val as f32, None => continue };
            let xmax = match box_arr[3].as_f64() { Some(val) => val as f32, None => continue };

            let w_x_rel = (xmin / 1000.0) * crop_w as f32;
            let w_y_rel = (ymin / 1000.0) * crop_h as f32;
            let w_w = ((xmax - xmin) / 1000.0) * crop_w as f32;
            let w_h = ((ymax - ymin) / 1000.0) * crop_h as f32;

            let mut final_x = phys_crop_x as f32 + w_x_rel;
            let mut final_y = phys_crop_y as f32 + w_y_rel;
            let mut final_w = w_w;
            let mut final_h = w_h;

            let mut matched_local = false;

            for local_w in local_words {
                let ax1 = final_x;
                let ay1 = final_y;
                let ax2 = final_x + final_w;
                let ay2 = final_y + final_h;

                let bx1 = phys_crop_x as f32 + local_w.x;
                let by1 = phys_crop_y as f32 + local_w.y;
                let bx2 = bx1 + local_w.width;
                let by2 = by1 + local_w.height;

                let overlap_x1 = ax1.max(bx1);
                let overlap_y1 = ay1.max(by1);
                let overlap_x2 = ax2.min(bx2);
                let overlap_y2 = ay2.min(by2);

                let overlap_w = overlap_x2 - overlap_x1;
                let overlap_h = overlap_y2 - overlap_y1;

                if overlap_w > 0.0 && overlap_h > 0.0 {
                    let overlap_area = overlap_w * overlap_h;
                    let area_a = final_w * final_h;
                    let area_b = local_w.width * local_w.height;
                    let min_area = area_a.min(area_b);

                    if overlap_area > 0.4 * min_area {
                        final_x = bx1;
                        final_y = by1;
                        final_w = local_w.width;
                        final_h = local_w.height;
                        matched_local = true;
                        break;
                    }
                }
            }

            if !matched_local {
                has_new_words = true;
            }

            words_out.push(serde_json::json!({
                "text": w_text,
                "x": final_x.round() as i32,
                "y": final_y.round() as i32,
                "w": final_w.round() as i32,
                "h": final_h.round() as i32
            }));
        }

        if !words_out.is_empty() {
            sentences_out.push(serde_json::json!({
                "text": text,
                "words": words_out
            }));
        }
    }

    if has_new_words {
        Some(sentences_out)
    } else {
        None
    }
}

#[tauri::command]
async fn start_ocr_scan_async(
    app_handle: tauri::AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let center_x = x + (width as i32) / 2;
    let center_y = y + (height as i32) / 2;
    
    if let Some(w) = app_handle.get_webview_window("ocr") {
        let _ = w.hide();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    }
    
    let capture_res = (|| -> Result<(image::RgbaImage, f32, i32, i32), String> {
        let monitor = xcap::Monitor::from_point(center_x, center_y)
            .map_err(|e| format!("Не удалось найти монитор в точке ({}, {}): {}", center_x, center_y, e))?;
            
        let screenshot = monitor.capture_image()
            .map_err(|e| format!("Ошибка захвата экрана: {}", e))?;
            
        let scale = monitor.scale_factor().map_err(|e| e.to_string())?;
        let monitor_x = monitor.x().map_err(|e| e.to_string())?;
        let monitor_y = monitor.y().map_err(|e| e.to_string())?;
        
        Ok((screenshot, scale, monitor_x, monitor_y))
    })();

    if let Some(w) = app_handle.get_webview_window("ocr") {
        let _ = w.show();
        let _ = w.set_always_on_top(true);
    }

    let (screenshot, _scale, monitor_x, monitor_y) = capture_res?;
    
    let local_x = x - monitor_x;
    let local_y = y - monitor_y;
    
    let phys_x = local_x.max(0) as u32;
    let phys_y = local_y.max(0) as u32;
    let phys_w = width;
    let phys_h = height;
    
    let img_w = screenshot.width();
    let img_h = screenshot.height();
    
    let crop_x = phys_x.min(img_w);
    let crop_y = phys_y.min(img_h);
    let crop_w = phys_w.min(img_w - crop_x);
    let crop_h = phys_h.min(img_h - crop_y);
    
    if crop_w == 0 || crop_h == 0 {
        return Err("Размер области захвата равен нулю".to_string());
    }
    
    let cropped = image::imageops::crop_imm(&screenshot, crop_x, crop_y, crop_w, crop_h).to_image();
    
    let mut png_bytes = Vec::new();
    cropped.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| format!("Ошибка сжатия PNG: {}", e))?;
        
    let local_words = run_windows_ocr(&png_bytes).await?;
    let base64_image = STANDARD.encode(&png_bytes);
    
    let phys_crop_x = monitor_x + crop_x as i32;
    let phys_crop_y = monitor_y + crop_y as i32;

    let words_out: Vec<serde_json::Value> = local_words.iter().map(|w| {
        serde_json::json!({
            "text": w.text.clone(),
            "x": (phys_crop_x as f32 + w.x).round() as i32,
            "y": (phys_crop_y as f32 + w.y).round() as i32,
            "w": w.width.round() as i32,
            "h": w.height.round() as i32
        })
    }).collect();

    let _ = app_handle.emit("ocr-words-ready", &words_out);

    let config = load_config_internal(&app_handle)?;
    let api_key = config.api_key.trim().to_string();
    if api_key.is_empty() {
        return Err("API ключ Gemini пуст в конфигурации".to_string());
    }

    let mut primary_model = if config.ai_model.is_empty() {
        "gemini-2.5-flash-lite".to_string()
    } else {
        config.ai_model.clone()
    };
    if primary_model.contains("tts-preview") {
        primary_model = "gemini-2.0-flash".to_string();
    }

    // Собираем структурированный многострочный текст с переносами строк
    let multiline_text = build_multiline_text_from_words(&local_words);

    let app_handle_clone = app_handle.clone();
    let api_key_clone = api_key.clone();
    let model_clone = primary_model.clone();
    let local_words_clone = local_words.clone();
    let base64_image_clone = base64_image.clone();
    let ocr_mode_clone = config.ocr_mode.clone();

    tokio::spawn(async move {
        let mut vision_success = false;

        if ocr_mode_clone == "vision" {
            let ocr_prompt = r#"Распознай весь текст на изображении (OCR) и верни его СТРОГО в формате JSON без markdown, без пояснений, без ```json, только чистый JSON.
Раздели текст на логические предложения. Каждое слово в предложении должно иметь точные координаты bounding box в виде нормализованных координат от 0 до 1000 относительно ширины и высоты изображения в формате: [ymin, xmin, ymax, xmax].

Формат ответа:
{
  "sentences": [
    {
      "text": "Полный текст предложения",
      "words": [
        {
          "text": "слово",
          "box": [ymin, xmin, ymax, xmax]
        }
      ]
    }
  ]
}

Правила:
- Координаты "box": [ymin, xmin, ymax, xmax] должны быть целыми числами от 0 до 1000.
- Не пропускай слова и не склеивай их. Каждое отдельное слово должно быть в массиве words.
- Ответ должен содержать ТОЛЬКО валидный JSON-объект."#;

            let res = call_gemini_vision_api(&api_key_clone, &model_clone, ocr_prompt, &base64_image_clone).await;
            match res {
                Ok(parsed) => {
                    let mut sentences_out = Vec::new();
                    if let Some(sentences) = parsed["sentences"].as_array() {
                        for sentence in sentences {
                            let sentence_text = sentence["text"].as_str().unwrap_or("").to_string();
                            let mut words_out = Vec::new();
                            if let Some(words) = sentence["words"].as_array() {
                                for word in words {
                                    let word_text = word["text"].as_str().unwrap_or("").to_string();
                                    if let Some(box_arr) = word["box"].as_array() {
                                        if box_arr.len() == 4 {
                                            let ymin = box_arr[0].as_f64().unwrap_or(0.0);
                                            let xmin = box_arr[1].as_f64().unwrap_or(0.0);
                                            let ymax = box_arr[2].as_f64().unwrap_or(0.0);
                                            let xmax = box_arr[3].as_f64().unwrap_or(0.0);

                                            let wx_rel = (xmin / 1000.0) * (crop_w as f64);
                                            let wy_rel = (ymin / 1000.0) * (crop_h as f64);
                                            let ww_rel = ((xmax - xmin) / 1000.0) * (crop_w as f64);
                                            let wh_rel = ((ymax - ymin) / 1000.0) * (crop_h as f64);

                                            let wx_abs = phys_crop_x as f64 + wx_rel;
                                            let wy_abs = phys_crop_y as f64 + wy_rel;

                                            words_out.push(serde_json::json!({
                                                "text": word_text,
                                                "x": wx_abs.round() as i32,
                                                "y": wy_abs.round() as i32,
                                                "w": ww_rel.round() as i32,
                                                "h": wh_rel.round() as i32
                                            }));
                                        }
                                    }
                                }
                            }
                            sentences_out.push(serde_json::json!({
                                "text": sentence_text,
                                "words": words_out
                            }));
                        }
                    }
                    
                    let _ = app_handle_clone.emit("ocr-sentences-ready", serde_json::json!({
                        "sentences": sentences_out,
                        "model": format!("ИИ Vision: {}", model_clone)
                    }));
                    vision_success = true;
                }
                Err(err) => {
                    eprintln!("[OCR] Gemini Vision API task failed, falling back to text mode: {}", err);
                    let _ = app_handle_clone.emit("ocr-status-update", format!("⚠️ Сбой Vision. Переход в текстовый режим..."));
                }
            }
        }

        if !vision_success {
            let prompt = r#"Ты — помощник по сегментации текста.
Тебе дан сырой текст, полученный в результате распознавания экрана (OCR). Раздели этот текст на правильные, грамматически и логически связные предложения.
Игнорируй случайный мусор (например, битые символы распознавания), но объединяй слова, которые логически составляют одну фразу или предложение.

Формат ответа — СТРОГО JSON без markdown (без ```json, без пояснений):
{
  "sentences": [
    "Первое предложение",
    "Второе предложение"
  ]
}

Правила:
1. Не придумывай новые слова, не изменяй окончания слов, используй только те, что даны в тексте.
2. Каждое предложение должно быть грамматически полным и правильным.
3. Сохраняй исходную пунктуацию в конце предложений (точки, знаки восклицания, вопросы).
4. СТРОГО ЗАПРЕЩЕНО объединять в одно предложение строки, разделенные переносом строки (\n), если они не являются непосредственным грамматическим продолжением друг друга.
5. Технические логи (например, "Worked for 38s", "Worked for 46s"), служебные сообщения, заголовки и пункты списков ДОЛЖНЫ быть выделены в отдельные предложения. Никогда не склеивай их с основным текстом.
6. Если в тексте встречается точка (.), восклицательный (!) или вопросительный (?) знак, за которым следует новое предложение с заглавной буквы (даже на той же строке), СТРОГО разделяй их на разные предложения.
7. Никогда не выделяй текст в скобках в конце предложения в отдельное предложение, если завершающий знак препинания (точка/вопрос/восклицание) стоит после закрывающей скобки. Текст в скобках должен оставаться частью основного предложения."#;

            if ocr_mode_clone == "local" {
                let sentences_vec = build_fallback_sentences_from_words(&local_words_clone);
                let formatted = format_sentences_with_words(&sentences_vec, &local_words_clone, phys_crop_x, phys_crop_y);
                let _ = app_handle_clone.emit("ocr-sentences-ready", serde_json::json!({
                    "sentences": formatted,
                    "model": "Локальный (Принудительно)"
                }));
            } else {
                match call_gemini_text_api(&app_handle_clone, &api_key_clone, &model_clone, prompt, &multiline_text).await {
                    Ok((sentences_vec, used_model)) => {
                        let formatted = format_sentences_with_words(&sentences_vec, &local_words_clone, phys_crop_x, phys_crop_y);
                        let _ = app_handle_clone.emit("ocr-sentences-ready", serde_json::json!({
                            "sentences": formatted,
                            "model": format!("ИИ Text: {}", used_model)
                        }));
                    }
                    Err(e) => {
                        eprintln!("[OCR] Gemini Text API task failed, using local fallback: {}", e);
                        let sentences_vec = build_fallback_sentences_from_words(&local_words_clone);
                        let formatted = format_sentences_with_words(&sentences_vec, &local_words_clone, phys_crop_x, phys_crop_y);
                        let _ = app_handle_clone.emit("ocr-sentences-ready", serde_json::json!({
                            "sentences": formatted,
                            "model": "Локальный fallback",
                            "error": format!("ИИ недоступен: {}", e)
                        }));
                    }
                }
            }
        }
        
        let _ = app_handle_clone.emit("ocr-scan-finished", serde_json::json!({}));
    });

    Ok(())
}

#[tauri::command]
fn set_ignore_cursor_events(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
}

#[tauri::command]
async fn get_cursor_pos() -> Result<CursorPos, String> {
    #[cfg(target_os = "windows")]
    {
        #[repr(C)]
        struct POINT {
            x: i32,
            y: i32,
        }
        #[link(name = "user32")]
        extern "system" {
            fn GetCursorPos(lpPoint: *mut POINT) -> i32;
        }
        let mut pt = POINT { x: 0, y: 0 };
        unsafe {
            GetCursorPos(&mut pt);
        }
        Ok(CursorPos { x: pt.x, y: pt.y })
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(CursorPos { x: 0, y: 0 })
    }
}

#[derive(serde::Deserialize)]
pub struct RegionRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[tauri::command]
async fn set_click_region(
    window: tauri::Window,
    rects: Vec<RegionRect>,
    scale_factor: f64,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Manager;
        use winapi::shared::windef::HWND;
        use winapi::um::wingdi::{CombineRgn, CreateRectRgn, RGN_OR};
        use winapi::um::winuser::SetWindowRgn;

        let tauri_hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = unsafe { std::mem::transmute::<_, HWND>(tauri_hwnd) };

        if rects.is_empty() {
            unsafe {
                SetWindowRgn(hwnd, std::ptr::null_mut(), 1);
            }
            return Ok(());
        }

        unsafe {
            let r0 = &rects[0];
            let mut final_rgn = CreateRectRgn(
                (r0.x * scale_factor).round() as i32,
                (r0.y * scale_factor).round() as i32,
                ((r0.x + r0.width) * scale_factor).round() as i32,
                ((r0.y + r0.height) * scale_factor).round() as i32,
            );

            for r in rects.iter().skip(1) {
                let temp_rgn = CreateRectRgn(
                    (r.x * scale_factor).round() as i32,
                    (r.y * scale_factor).round() as i32,
                    ((r.x + r.width) * scale_factor).round() as i32,
                    ((r.y + r.height) * scale_factor).round() as i32,
                );
                CombineRgn(final_rgn, final_rgn, temp_rgn, RGN_OR);
                winapi::um::wingdi::DeleteObject(temp_rgn as *mut _);
            }

            SetWindowRgn(hwnd, final_rgn, 1);
        }
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
        if class_lower.contains("progman")
            || class_lower.contains("workerw")
            || class_lower.contains("shell_traywnd")
        {
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
                },
            },
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
                },
            },
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
                },
            },
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
                },
            },
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
        log_to_file(&format!("paste_text: Started. Text length = {}, insertion possible = {}", text.len(), possible));
        if possible {
            let backup = match backup_clipboard() {
                Ok(b) => b,
                Err(e) => {
                    log_to_file(&format!("paste_text: backup_clipboard failed: {}", e));
                    Vec::new()
                }
            };
            
            log_to_file("paste_text: Setting new clipboard text");
            let _ = set_clipboard_text(&text);
            
            log_to_file("paste_text: Sleeping 150ms before Ctrl+V");
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            
            log_to_file("paste_text: Simulating Ctrl+V");
            simulate_ctrl_v();
            
            log_to_file("paste_text: Sleeping 300ms before restoring clipboard");
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            
            log_to_file("paste_text: Restoring clipboard");
            let _ = restore_clipboard(backup);
            
            log_to_file("paste_text: Finished successfully");
            Ok(true)
        } else {
            show_result_window(&app_handle, text);
            log_to_file("paste_text: Finished (showing result window)");
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
fn resize_window(window: tauri::Window, width: i32, height: i32) -> Result<(), String> {
    if width <= 0 || height <= 0 {
        return Err("Ширина и высота должны быть положительными".into());
    }
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let hwnd = match window.window_handle().map_err(|e| e.to_string())?.as_raw() {
        RawWindowHandle::Win32(handle) => handle.hwnd.get() as isize,
        _ => return Err("Текущее окно не является Win32 HWND".into()),
    };
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(hWnd: isize, hWndInsertAfter: isize, X: i32, Y: i32, cx: i32, cy: i32, uFlags: u32) -> i32;
    }
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    unsafe {
        let res = SetWindowPos(hwnd, 0, 0, 0, width, height, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER);
        if res == 0 { return Err("Ошибка SetWindowPos".into()); }
    }
    Ok(())
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

    println!("SINC PRO OCR: resize_bottom_up_phys -> hwnd=0x{:X}, x={}, y={}, width={}, height={}", hwnd, x, y, width, height);

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
        fn ShowWindow(hWnd: isize, nCmdShow: i32) -> i32;
        fn SetForegroundWindow(hWnd: isize) -> i32;
    }

    const HWND_TOPMOST: isize = -1;
    const SWP_NOACTIVATE: u32 = 0x0010;
    const SWP_NOCOPYBITS: u32 = 0x0100;
    const SWP_NOOWNERZORDER: u32 = 0x0200;
    const SWP_SHOWWINDOW: u32 = 0x0040;

    unsafe {
        let res = SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOCOPYBITS | SWP_SHOWWINDOW,
        );
        if res == 0 {
            println!("SINC PRO OCR: SetWindowPos FAILED!");
            return Err("Ошибка при вызове SetWindowPos".into());
        }
        
        let label = window.label();
        if label == "ocr" {
            ShowWindow(hwnd, 5); // SW_SHOW
            SetForegroundWindow(hwnd);
        }
    }
    
    // ПРИНУДИТЕЛЬНО восстанавливаем флаг TOPMOST, так как SetWindowPos может его сбить
    let _ = window.set_always_on_top(true);

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

#[link(name = "shcore")]
extern "system" {
    fn GetDpiForMonitor(hmonitor: isize, dpi_type: u32, dpi_x: *mut u32, dpi_y: *mut u32) -> i32;
}

#[derive(Serialize, Clone, Debug)]
pub struct CursorMonitorInfo {
    pub work_left: i32,
    pub work_top: i32,
    pub work_right: i32,
    pub work_bottom: i32,
    pub scale_factor: f64,
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn get_cursor_monitor() -> Result<CursorMonitorInfo, String> {
    #[repr(C)]
    #[derive(Default)]
    struct POINTL {
        x: i32,
        y: i32,
    }

    #[repr(C)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    impl Default for RECT {
        fn default() -> Self {
            RECT {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0,
            }
        }
    }

    #[repr(C)]
    struct MONITORINFO {
        cb_size: u32,
        rc_monitor: RECT,
        rc_work: RECT,
        dw_flags: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(lp_point: *mut POINTL) -> i32;
        fn MonitorFromPoint(pt: POINTL, dw_flags: u32) -> isize;
        fn GetMonitorInfoW(h_monitor: isize, lp_mi: *mut MONITORINFO) -> i32;
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;

    unsafe {
        let mut pt = POINTL::default();
        GetCursorPos(&mut pt);
        let hmon = MonitorFromPoint(pt, MONITOR_DEFAULTTONEAREST);
        let mut mi = MONITORINFO {
            cb_size: std::mem::size_of::<MONITORINFO>() as u32,
            rc_monitor: RECT::default(),
            rc_work: RECT::default(),
            dw_flags: 0,
        };
        GetMonitorInfoW(hmon, &mut mi);

        let mut dpi_x = 0;
        let mut dpi_y = 0;
        let _ = GetDpiForMonitor(hmon, 0, &mut dpi_x, &mut dpi_y);
        let scale_factor = dpi_x as f64 / 96.0;

        Ok(CursorMonitorInfo {
            work_left: mi.rc_work.left,
            work_top: mi.rc_work.top,
            work_right: mi.rc_work.right,
            work_bottom: mi.rc_work.bottom,
            scale_factor,
        })
    }
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
fn get_cursor_monitor() -> Result<CursorMonitorInfo, String> {
    Err("get_cursor_monitor реализован только для Windows".into())
}

#[tauri::command]
#[cfg(target_os = "windows")]
fn get_virtual_desktop_rect() -> Result<serde_json::Value, String> {
    use winapi::um::winuser::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        
        println!("SINC PRO OCR: get_virtual_desktop_rect -> x={}, y={}, width={}, height={}", x, y, width, height);
        
        if width == 0 || height == 0 {
            use winapi::um::winuser::{SM_CXSCREEN, SM_CYSCREEN};
            let w = GetSystemMetrics(SM_CXSCREEN);
            let h = GetSystemMetrics(SM_CYSCREEN);
            return Ok(serde_json::json!({ "x": 0, "y": 0, "width": w, "height": h }));
        }
        
        Ok(serde_json::json!({
            "x": x,
            "y": y,
            "width": width,
            "height": height
        }))
    }
}

#[tauri::command]
#[cfg(not(target_os = "windows"))]
fn get_virtual_desktop_rect() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "x": 0, "y": 0, "width": 1920, "height": 1080 }))
}

pub fn run() {
    let minimize_startup = std::env::args().any(|arg| arg == "--minimized");
    MINIMIZED_STARTUP.store(minimize_startup, std::sync::atomic::Ordering::SeqCst);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {}))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+q"])
                .unwrap()
                .with_handler(|app, shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if shortcut.matches(tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyQ) {
                            if OCR_ENABLED.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                                println!("SINC PRO OCR: OCR mode is disabled, skipping shortcut Alt+Q");
                                return;
                            }
                            println!("SINC PRO OCR: Global Shortcut Alt+Q triggered.");
                            if let Some(w) = app.get_webview_window("ocr") {
                                use tauri::Emitter;
                                let visible = OCR_WINDOW_VISIBLE.load(std::sync::atomic::Ordering::SeqCst);
                                println!("SINC PRO OCR: OCR_WINDOW_VISIBLE load is={}", visible);
                                if visible {
                                    println!("SINC PRO OCR: Global Shortcut Alt+Q calling hide_ocr_window...");
                                    let app_clone = app.clone();
                                    tauri::async_runtime::spawn(async move {
                                        if let Err(e) = hide_ocr_window(app_clone).await {
                                            println!("SINC PRO OCR: Global Shortcut hide_ocr_window failed: {}", e);
                                        }
                                    });
                                } else {
                                    println!("SINC PRO OCR: Global Shortcut Alt+Q calling show_ocr_window...");
                                    let app_clone = app.clone();
                                    tauri::async_runtime::spawn(async move {
                                        if let Err(e) = show_ocr_window(app_clone).await {
                                            println!("SINC PRO OCR: Global Shortcut show_ocr_window failed: {}", e);
                                        }
                                    });
                                }
                            } else {
                                println!("SINC PRO OCR: WebviewWindow 'ocr' NOT FOUND when Shortcut triggered!");
                            }
                        }
                    }
                })
                .build()
        )
        .setup(|app| {
            // Сохраняем handle для отправки событий
            *APP_HANDLE.lock().unwrap() = Some(app.handle().clone());

            let minimize = MINIMIZED_STARTUP.load(std::sync::atomic::Ordering::SeqCst);
            if !minimize {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }

            // Инициализация системного трея
            use tauri::menu::{MenuBuilder, MenuItem};
            use tauri::tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState};

            let quit_i = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let show_main_i = MenuItem::with_id(app, "show_main", "Показать главное окно", true, None::<&str>)?;
            let show_widget_i = MenuItem::with_id(app, "show_widget", "Показать виджет озвучки", true, None::<&str>)?;
            let show_ocr_i = MenuItem::with_id(app, "show_ocr", "Показать оверлей переводчика", true, None::<&str>)?;

            let menu = MenuBuilder::new(app)
                .item(&show_main_i)
                .item(&show_widget_i)
                .item(&show_ocr_i)
                .separator()
                .item(&quit_i)
                .build()?;

            let tray_icon = app.default_window_icon().cloned();
            let mut tray_builder = TrayIconBuilder::new()
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "quit" => {
                            app.exit(0);
                        }
                        "show_main" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                                use tauri::Emitter;
                                let _ = w.emit("main-shown", ());
                            }
                        }
                        "show_widget" => {
                            if let Some(w) = app.get_webview_window("widget") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        "show_ocr" => {
                            if let Some(w) = app.get_webview_window("ocr") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                            use tauri::Emitter;
                            let _ = w.emit("main-shown", ());
                        }
                    }
                });

            if let Some(icon) = tray_icon {
                tray_builder = tray_builder.icon(icon);
            }

            let _tray = tray_builder.build(app)?;

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

                std::thread::spawn(|| {
                    use winapi::um::winuser::{GetAsyncKeyState, VK_MENU};
                    let mut alt_pressed = false;
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(50));
                        let state = unsafe { GetAsyncKeyState(VK_MENU) };
                        let is_down = (state as u16 & 0x8000) != 0;
                        if is_down != alt_pressed {
                            alt_pressed = is_down;
                            if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                                use tauri::Emitter;
                                if is_down {
                                    let _ = app.emit("alt-pressed", ());
                                } else {
                                    let _ = app.emit("alt-released", ());
                                }
                            }
                        }
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            write_js_log,
            load_config,
            save_config,
            fetch_gemini_models,
            set_module_mode,
            load_history,
            delete_history_entry,
            open_audio_folder,
            start_recording_session,
            append_audio_chunk,
            save_audio,
            cancel_active_request,
            is_minimized_startup,
            set_autostart_enabled,
            is_autostart_enabled,
            paste_text,
            set_capsule_active,
            show_capsule_window,
            hide_capsule_window,
            show_widget_window,
            hide_widget_window,
            show_ocr_window,
            hide_ocr_window,
            resize_window,
            resize_bottom_up_phys,
            get_cursor_monitor,
            speak_edge_tts,
            read_clipboard_text,
            write_clipboard_text,
            get_cursor_pos,
            set_click_region,
            set_ignore_cursor_events,
            capture_clipboard_text,
            translate_hybrid,
            process_ocr_vision,
            process_ocr_hybrid,
            start_ocr_scan_async,
            get_virtual_desktop_rect,
            process_ai_request
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
