use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use regex::Regex;
use std::sync::Mutex;
use std::time::Instant;

lazy_static::lazy_static! {
    static ref GOOGLE_TRANSLATE_LOCK: Mutex<Option<Instant>> = Mutex::new(None);
}

#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<Content>,
    #[serde(rename = "generationConfig")]
    generation_config: GenerationConfig,
}

#[derive(Serialize)]
struct Content {
    parts: Vec<Part>,
}

#[derive(Serialize)]
struct Part {
    text: String,
}

#[derive(Serialize)]
struct GenerationConfig {
    temperature: f32,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<Candidate>>,
}

#[derive(Deserialize)]
struct Candidate {
    content: Option<CandidateContent>,
}

#[derive(Deserialize)]
struct CandidateContent {
    parts: Option<Vec<CandidatePart>>,
}

#[derive(Deserialize)]
struct CandidatePart {
    text: Option<String>,
}

pub async fn translate_hybrid(
    text: &str,
    api_key: &str,
    model: &str,
) -> Result<String, String> {
    if text.trim().is_empty() {
        return Ok(String::new());
    }

    // Try Gemini First if key exists
    if !api_key.trim().is_empty() {
        let prompt = format!(
            "Переведи все иностранные слова и предложения на русский язык, сохранив исходную структуру и контекст. Если текст уже на русском — просто верни его. Если смешанный — переведи только иностранные вставки, чтобы получился связный русский текст. Сохраняй технические плейсхолдеры в фигурных скобках вида {{N0}}, {{F0}} без изменений на своих местах. Текст:\n\n{}",
            text
        );

        let req = GeminiRequest {
            contents: vec![Content {
                parts: vec![Part { text: prompt }],
            }],
            generation_config: GenerationConfig { temperature: 0.1 },
        };

        let client = Client::new();
        let url = format!(
            "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
            if model.is_empty() { "gemini-2.5-flash" } else { model },
            api_key
        );

        match client.post(&url).json(&req).send().await {
            Ok(res) if res.status().is_success() => {
                if let Ok(gr) = res.json::<GeminiResponse>().await {
                    if let Some(mut cands) = gr.candidates {
                        if let Some(cand) = cands.pop() {
                            if let Some(content) = cand.content {
                                if let Some(mut parts) = content.parts {
                                    if let Some(part) = parts.pop() {
                                        if let Some(translated) = part.text {
                                            return Ok(post_process_translation(text, translated));
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {} // Fallback on error
        }
    }

    // Fallback: Parse English words and use Free Google Translate Web API
    let translated = fallback_translate(text).await?;
    Ok(post_process_translation(text, translated))
}

async fn fallback_translate(text: &str) -> Result<String, String> {
    // Simple logic: Extract English sentences/words, translate them, replace them back.
    let re = Regex::new(r"[A-Za-z0-9\s.,!?'\x22\x27{} -]+").unwrap();

    let mut original_fragments = Vec::new();

    for mat in re.find_iter(text) {
        let frag = mat.as_str().trim();
        // Only translate if it actually contains english letters
        if frag.chars().any(|c| c.is_ascii_alphabetic()) && frag.len() > 1 {
            original_fragments.push(frag.to_string());
        }
    }

    if original_fragments.is_empty() {
        return Ok(text.to_string());
    }

    // Translate batch
    let batch_text = original_fragments.join(" | ");
    let translated_batch = google_translate_free(&batch_text).await?;

    let trans_parts: Vec<&str> = translated_batch.split('|').collect();
    
    let mut final_text = text.to_string();
    for (i, orig) in original_fragments.iter().enumerate() {
        if i < trans_parts.len() {
            let tr = trans_parts[i].trim();
            if !tr.is_empty() {
                final_text = final_text.replacen(orig, tr, 1);
            }
        }
    }

    Ok(final_text)
}

async fn google_translate_free(text: &str) -> Result<String, String> {
    // Rate limit protection
    let should_sleep = {
        let mut lock = GOOGLE_TRANSLATE_LOCK.lock().unwrap();
        let sleep = if let Some(last_time) = *lock {
            last_time.elapsed() < Duration::from_millis(500)
        } else {
            false
        };
        *lock = Some(Instant::now());
        sleep
    };

    if should_sleep {
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    let url = format!(
        "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q={}",
        urlencoding::encode(text)
    );

    let client = Client::new();
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    
    if !res.status().is_success() {
        return Err("Fallback translation failed".into());
    }

    let json: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    
    let mut result = String::new();
    if let Some(arr) = json.as_array() {
        if let Some(sentences) = arr.get(0).and_then(|v| v.as_array()) {
            for sentence in sentences {
                if let Some(text) = sentence.get(0).and_then(|v| v.as_str()) {
                    result.push_str(text);
                }
            }
        }
    }

    Ok(result)
}

fn post_process_translation(original: &str, mut translated: String) -> String {
    let original_lower = original.to_lowercase();
    
    // 1. Gemini -> Близнецы / близнецы / Близнец / близнец
    if original_lower.contains("gemini") {
        let re_gemini = Regex::new(r"(?i)близнец[а-я]*").unwrap();
        translated = re_gemini.replace_all(&translated, "Gemini").to_string();
    }
    
    // 2. Playwright -> Драматург / драматург / Плейрайт / плейрайт
    if original_lower.contains("playwright") {
        let re_playwright = Regex::new(r"(?i)драматург[а-я]*").unwrap();
        translated = re_playwright.replace_all(&translated, "Playwright").to_string();
    }

    // Clean up spaces in placeholders like { N0 } or { f1 }
    let re_clean = Regex::new(r"\{\s*([nNfF]\d+)\s*\}").unwrap();
    translated = re_clean.replace_all(&translated, |caps: &regex::Captures| {
        format!("{{{}}}", caps[1].to_uppercase())
    }).to_string();
    
    translated
}
