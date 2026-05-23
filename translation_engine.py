import os
import sys
import sqlite3
import re
import traceback
import json
import urllib.request
from deep_translator import GoogleTranslator

# Импортируем argostranslate глобально в главном потоке, чтобы избежать DLL конфликтов (WinError 1114) с winrt
try:
    import argostranslate.package
    import argostranslate.translate
    argos_available = True
except Exception as e:
    print(f"Global Argos import failed: {e}")
    argos_available = False

# Определение директории приложения
if getattr(sys, 'frozen', False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

DB_PATH = os.path.join(APP_DIR, "translation_cache.db")

class TranslationEngine:
    def translate_batch(self, texts: list, target_lang: str) -> list:
        raise NotImplementedError("Subclasses must implement translate_batch")


    def __init__(self):
        self._init_db()

    def _init_db(self):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS translations (
                    source_text TEXT,
                    target_lang TEXT,
                    translated_text TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    PRIMARY KEY (source_text, target_lang)
                )
            """)
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"Error initializing translation database: {e}")

    def _get_cached_translation(self, text: str, target_lang: str) -> str:
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute(
                "SELECT translated_text FROM translations WHERE LOWER(source_text) = LOWER(?) AND target_lang = ?",
                (text.strip(), target_lang)
            )
            row = cursor.fetchone()
            conn.close()
            if row:
                return row[0]
        except Exception as e:
            print(f"Cache read error: {e}")
        return None

    def _save_to_cache(self, text: str, target_lang: str, translated_text: str):
        try:
            conn = sqlite3.connect(DB_PATH)
            cursor = conn.cursor()
            cursor.execute(
                "INSERT OR REPLACE INTO translations (source_text, target_lang, translated_text) VALUES (?, ?, ?)",
                (text.strip(), target_lang, translated_text.strip())
            )
            conn.commit()
            conn.close()
        except Exception as e:
            print(f"Cache write error: {e}")

    def translate_batch(self, texts: list, target_lang: str) -> list:
        if not texts:
            return []

        def abstract_digits(t):
            c = [0]
            def repl(m):
                val = str(99990 + c[0])
                c[0] += 1
                return val
            return re.sub(r'\d+', repl, t), re.findall(r'\d+', t)
            
        def restore_digits(t, d):
            return re.sub(r'9999\d+', lambda m: d[int(m.group(0))-99990] if 0<=int(m.group(0))-99990<len(d) else m.group(0), t)

        results = [None] * len(texts)
        missing_map = {} 
        abstracted_data = {}

        for i, text in enumerate(texts):
            cleaned = text.strip()
            if not cleaned:
                results[i] = ""
                continue
            
            cached = self._get_cached_translation(cleaned, target_lang)
            if cached is not None:
                results[i] = cached
            else:
                abs_text, digits = abstract_digits(cleaned)
                abstracted_data[i] = (abs_text, digits)
                if abs_text not in missing_map:
                    missing_map[abs_text] = []
                missing_map[abs_text].append(i)

        unique_abs_texts = list(missing_map.keys())
        if not unique_abs_texts:
            return results

        chunks = []
        current_chunk = []
        current_len = 0

        for idx, text in enumerate(unique_abs_texts):
            line_len = len(text) + 20
            if current_len + line_len > 4000 and current_chunk:
                chunks.append(current_chunk)
                current_chunk = []
                current_len = 0
            current_chunk.append((idx, text))
            current_len += line_len
        if current_chunk:
            chunks.append(current_chunk)

        for chunk in chunks:
            payload_parts = []
            for i, (idx, text) in enumerate(chunk):
                payload_parts.append(f"[TR{i}] {text}")
            
            payload = "\n".join(payload_parts)
            translated_payload = None
            try:
                translated_payload = self._translate_payload(payload, target_lang)
            except Exception as e:
                print(f"Batch translation API error: {e}. Falling back to individual.")

            translated_map = {}
            if translated_payload:
                try:
                    pattern = r'(?:^|\n)\s*\[\s*tr\s*(\d+)\s*\]\s*(.*?)(?=\n\s*\[\s*tr\s*\d+\s*\]|$)'
                    matches = re.findall(pattern, translated_payload, re.DOTALL | re.IGNORECASE)
                    for idx_str, text_val in matches:
                        try:
                            translated_map[int(idx_str)] = text_val.strip()
                        except ValueError:
                            pass
                except Exception as e:
                    print(f"Batch parsing error: {e}")

            for i, (idx, abs_text) in enumerate(chunk):
                trans_abs_text = None
                if i in translated_map and translated_map[i] and not translated_map[i].startswith("["):
                    trans_abs_text = translated_map[i]
                else:
                    try:
                        trans_abs_text = self._translate_individual(abs_text, target_lang)
                    except Exception as e:
                        print(f"Individual translation error for {abs_text}: {e}")
                        trans_abs_text = abs_text
                
                for orig_idx in missing_map[abs_text]:
                    orig_text = texts[orig_idx].strip()
                    _, digits = abstracted_data[orig_idx]
                    final_trans_text = restore_digits(trans_abs_text, digits)
                    
                    results[orig_idx] = final_trans_text
                    if final_trans_text.strip().lower() != orig_text.lower():
                        self._save_to_cache(orig_text, target_lang, final_trans_text)

        for i in range(len(results)):
            if results[i] is None:
                results[i] = texts[i]

        return results

    def _translate_payload(self, payload: str, target_lang: str) -> str:
        raise NotImplementedError

    def _translate_individual(self, text: str, target_lang: str) -> str:
        raise NotImplementedError


class GoogleCacheEngine(TranslationEngine):
    def _translate_payload(self, payload: str, target_lang: str) -> str:
        translator = GoogleTranslator(source='auto', target=target_lang)
        return translator.translate(payload)

    def _translate_individual(self, text: str, target_lang: str) -> str:
        translator = GoogleTranslator(source='auto', target=target_lang)
        return translator.translate(text)


class ArgosEngine(TranslationEngine):
    def __init__(self):
        super().__init__()
        self.argos_translate = None
        if argos_available:
            self.argos_translate = argostranslate.translate.translate
            try:
                # Обновляем индекс только если нет нужного пакета
                installed_packages = argostranslate.package.get_installed_packages()
                en_ru_installed = any(p.from_code == 'en' and p.to_code == 'ru' for p in installed_packages)
                
                if not en_ru_installed:
                    print("Argos: Installing EN-RU package for the first time... this may take a minute.")
                    argostranslate.package.update_package_index()
                    available_packages = argostranslate.package.get_available_packages()
                    package_to_install = next(
                        filter(lambda x: x.from_code == 'en' and x.to_code == 'ru', available_packages), None
                    )
                    if package_to_install:
                        argostranslate.package.install_from_path(package_to_install.download())
                    else:
                        print("Argos: EN-RU package not found in index.")
            except Exception as e:
                print(f"Argos package init error: {e}")
        else:
            print("Argos engine is disabled because global import failed.")

    def _translate_payload(self, payload: str, target_lang: str) -> str:
        if not self.argos_translate:
            raise RuntimeError("Argos Translate engine is not initialized due to DLL/library loading errors.")
        return self.argos_translate(payload, 'en', 'ru')
        
    def _translate_individual(self, text: str, target_lang: str) -> str:
        if not self.argos_translate:
            raise RuntimeError("Argos Translate engine is not initialized due to DLL/library loading errors.")
        return self.argos_translate(text, 'en', 'ru')


class OllamaEngine(TranslationEngine):
    def __init__(self, model="gemma2", url="http://localhost:11434"):
        super().__init__()
        self.model = model
        self.url = url

    def _call_ollama(self, prompt: str) -> str:
        data = {
            "model": self.model,
            "prompt": prompt,
            "stream": False
        }
        req = urllib.request.Request(
            f"{self.url.rstrip('/')}/api/generate",
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req) as response:
            result = json.loads(response.read().decode("utf-8"))
            return result.get("response", "").strip()

    def _translate_payload(self, payload: str, target_lang: str) -> str:
        prompt = f"You are a professional translator. Translate the following list of phrases to {target_lang}. Keep the exact same layout and formatting, including the [TRn] markers. Do not add any conversational text or markdown formatting.\n\n{payload}"
        return self._call_ollama(prompt)

    def _translate_individual(self, text: str, target_lang: str) -> str:
        prompt = f"Translate the following text to {target_lang}. Return only the translated text, with no conversational text or quotes.\n\n{text}"
        return self._call_ollama(prompt)


class MstyEngine(TranslationEngine):
    def __init__(self, model="Gemma 4", url="http://localhost:8080"):
        super().__init__()
        self.model = model
        self.url = url

    def _call_msty(self, prompt: str, retry_without_model=False) -> str:
        data = {
            "messages": [{"role": "user", "content": prompt}],
            "temperature": 0.3
        }
        if not retry_without_model:
            data["model"] = self.model

        req = urllib.request.Request(
            f"{self.url.rstrip('/')}/v1/chat/completions",
            data=json.dumps(data).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        try:
            with urllib.request.urlopen(req) as response:
                result = json.loads(response.read().decode("utf-8"))
                return result.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
        except urllib.error.HTTPError as e:
            if not retry_without_model and e.code == 400:
                print("Msty API error 400. Retrying without model parameter...")
                return self._call_msty(prompt, retry_without_model=True)
            print(f"Msty API error: {e}")
            try:
                print(f"Msty Error body: {e.read().decode('utf-8')}")
            except:
                pass
            return ""
        except Exception as e:
            print(f"Msty API error: {e}")
            return ""

    def _translate_payload(self, payload: str, target_lang: str) -> str:
        prompt = f"You are a professional translator. Translate the following list of phrases to {target_lang}. Keep the exact same layout and formatting, including the [TRn] markers. Do not add any conversational text or markdown formatting.\n\n{payload}"
        return self._call_msty(prompt)

    def _translate_individual(self, text: str, target_lang: str) -> str:
        prompt = f"Translate the following text to {target_lang}. Return only the translated text, with no conversational text or quotes.\n\n{text}"
        return self._call_msty(prompt)


_cached_engines = {}

def get_engine(engine_type: str, **kwargs) -> TranslationEngine:
    global _cached_engines
    kwargs_key = tuple(sorted(kwargs.items()))
    key = (engine_type, kwargs_key)
    if key not in _cached_engines:
        if engine_type == "argos":
            _cached_engines[key] = ArgosEngine()
        elif engine_type == "ollama":
            _cached_engines[key] = OllamaEngine(
                model=kwargs.get("ollama_model", "gemma2"),
                url=kwargs.get("ollama_url", "http://localhost:11434")
            )
        elif engine_type == "msty":
            _cached_engines[key] = MstyEngine(
                model=kwargs.get("msty_model", "Gemma 4"),
                url=kwargs.get("msty_url", "http://localhost:10000") # Msty default can vary, often 10000 or custom
            )
        else:
            _cached_engines[key] = GoogleCacheEngine()
    return _cached_engines[key]
