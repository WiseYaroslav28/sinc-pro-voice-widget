mod translator;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

// ─── Edge TTS ────────────────────────────────────────────────────────────────
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::{connect_async_tls_with_config, tungstenite::Message};
use uuid::Uuid;

const EDGE_TTS_ENDPOINT: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";

async fn get_clock_skew() -> i64 {
    let client = reqwest::Client::new();
    let url = "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";
    if let Ok(resp) = client.head(url).send().await {
        if let Some(date_header) = resp.headers().get("date") {
            if let Ok(date_str) = date_header.to_str() {
                if let Ok(server_time) = chrono::DateTime::parse_from_rfc2822(date_str) {
                    let server_timestamp = server_time.timestamp();
                    let local_timestamp = chrono::Utc::now().timestamp();
                    let skew = server_timestamp - local_timestamp;
                    println!("SINC PRO TTS: Clock skew adjusted by {} seconds", skew);
                    return skew;
                }
            }
        }
    }
    0
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

#[tauri::command]
async fn speak_edge_tts(text: String, voice: String, rate: f32) -> Result<String, String> {
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

    if audio_bytes.is_empty() {
        return Err("Edge TTS вернул пустой аудио-ответ".into());
    }

    Ok(STANDARD.encode(&audio_bytes))
}

static APP_HANDLE: Mutex<Option<tauri::AppHandle>> = Mutex::new(None);
static MODEL_LOCKS: std::sync::LazyLock<Mutex<HashMap<String, Instant>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static CTRL_PRESSED: AtomicBool = AtomicBool::new(false);
static WIN_PRESSED: AtomicBool = AtomicBool::new(false);
static ALT_PRESSED: AtomicBool = AtomicBool::new(false);
static SHIFT_PRESSED: AtomicBool = AtomicBool::new(false);
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
            let shift = SHIFT_PRESSED.load(Ordering::SeqCst);

            if ctrl && shift && !alt && !win {
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
            } else if ctrl && alt && !shift && !win {
                if !SHORTCUT_ACTIVE.swap(true, Ordering::SeqCst) {
                    if let Some(app) = APP_HANDLE.lock().unwrap().as_ref() {
                        let _ = app.emit("tts-action-translate", ());
                    }
                    // TTS-перевод — одноразовое действие, аналогично
                    SHORTCUT_ACTIVE.store(false, Ordering::SeqCst);
                }
            } else if ctrl && win {
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
                if SHORTCUT_ACTIVE.swap(false, Ordering::SeqCst) {
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
            "Транскрибируй эту аудиозапись дословно, сохраняя точный смысл и порядок слов. Убери только слова-паразиты (эм, ну, вот, короче, как бы, типа и т.п.) и очевидные оговорки. НЕ перефразируй, НЕ добавляй ничего от себя. Выдай чистый текст без заголовков и форматирования.",
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

    // Если запись отменена пользователем — сохраняем в историю без Gemini
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
- "transcript": дословная транскрипция аудио, очищенная от слов-паразитов (ну, э-э, значит, как бы, короче, вот). Сохрани ВСЕ мысли и порядок изложения говорящего. Не сокращай.
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

    // Fallback цепочка моделей: основная → резерв 1 → резерв 2
    let primary_model = if config.ai_model.is_empty() {
        "gemini-2.0-flash".to_string()
    } else {
        config.ai_model.clone()
    };
    let fallback_models = vec![
        primary_model.clone(),
        "gemini-3.5-flash".to_string(),
        "gemini-2.5-flash".to_string(),
        "gemini-3.1-flash-lite".to_string(),
        "gemini-2.0-flash".to_string(),
    ];
    // Убираем дубли, сохраняем порядок
    let mut seen = std::collections::HashSet::new();
    let fallback_models: Vec<String> = fallback_models
        .into_iter()
        .filter(|m| seen.insert(m.clone()))
        .collect();

    let client = reqwest::Client::new();
    let api_key = config.api_key.trim().to_string();

    // Пробуем модели по очереди
    let mut last_err = String::new();
    let mut gemini_text: Option<String> = None;
    for model in &fallback_models {
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
                    continue;
                }
                if status.as_u16() == 503 {
                    last_err = format!("Сервис недоступен (503) для {}", model);
                    continue;
                }
                if !status.is_success() {
                    let err_text = res.text().await.unwrap_or_default();
                    last_err = format!("Ошибка {} ({}): {}", status, model, err_text);
                    continue;
                }
                match res.json::<GeminiResponse>().await {
                    Err(e) => {
                        last_err = format!("Парсинг ответа ({}): {}", model, e);
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
                                continue;
                            }

                            gemini_text = Some(text);
                            break;
                        } else {
                            last_err = format!("Пустой ответ от {}", model);
                        }
                    }
                }
            }
        }
    }

    // Парсим JSON-ответ от Gemini
    let (raw_transcript, ai_result_text, is_error) = match gemini_text {
        None => (
            format!("[Ошибка: все модели недоступны. {}]", last_err),
            String::new(),
            true,
        ),
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
                Err(_) => {
                    // Gemini не вернул JSON — весь текст кладём как транскрипцию
                    (raw_json, String::new(), false)
                }
            }
        }
    };

    let preset_key = if custom_prompt
        .as_deref()
        .map(|s| !s.is_empty())
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
            text: ai_result_text,
            timestamp: ts,
        }]
    } else if !ai_result_text.is_empty() {
        vec![AiResult {
            preset: preset_key,
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
        raw_transcript,
        transcript: String::new(),
        preset: String::new(),
        preset_label: String::new(),
        ai_results,
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

#[tauri::command]
async fn capture_clipboard_text(app_handle: tauri::AppHandle, translate: bool) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let backup = backup_clipboard().unwrap_or_default();
        let _ = set_clipboard_text("");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        simulate_ctrl_c();
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        
        // После simulate_ctrl_c ОС считает модификаторы отжатыми (мы послали key-up через SendInput).
        // Когда пользователь физически отпустит клавиши, ОС может не сгенерировать повторный key-up,
        // и наши атомарные флаги залипнут в true. Сбрасываем их принудительно.
        CTRL_PRESSED.store(false, Ordering::SeqCst);
        SHIFT_PRESSED.store(false, Ordering::SeqCst);
        ALT_PRESSED.store(false, Ordering::SeqCst);
        
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
    const SWP_NOCOPYBITS: u32 = 0x0100;
    const SWP_NOOWNERZORDER: u32 = 0x0200;

    unsafe {
        let res = SetWindowPos(
            hwnd,
            0,
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOCOPYBITS,
        );
        if res == 0 {
            return Err("Ошибка при вызове SetWindowPos".into());
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {}))
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts(["alt+q"])
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
                        }
                    }
                })
                .build()
        )
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
            start_recording_session,
            append_audio_chunk,
            save_audio,
            paste_text,
            set_capsule_active,
            show_capsule_window,
            hide_capsule_window,
            show_widget_window,
            hide_widget_window,
            resize_window,
            resize_bottom_up_phys,
            get_cursor_monitor,
            speak_edge_tts,
            read_clipboard_text,
            write_clipboard_text,
            get_cursor_pos,
            set_click_region,
            set_ignore_cursor_events,
            capture_clipboard_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
