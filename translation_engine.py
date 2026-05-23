import os
import sys
import sqlite3
import re
import traceback
import json
import urllib.request
from deep_translator import GoogleTranslator

# Определение директории приложения
if getattr(sys, 'frozen', False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

LOCAL_TRANSLATOR_DIR = os.path.join(APP_DIR, "local_translator")
os.environ["ARGOS_PACKAGES_DIR"] = os.path.join(LOCAL_TRANSLATOR_DIR, "packages")

argos_available = False
argostranslate = None

def try_import_argos():
    global argos_available, argostranslate
    if LOCAL_TRANSLATOR_DIR not in sys.path:
        sys.path.insert(0, LOCAL_TRANSLATOR_DIR)
    try:
        import argostranslate.package
        import argostranslate.translate
        import argostranslate
        argos_available = True
        return True
    except Exception as e:
        print(f"Dynamic Argos import failed: {e}")
        argos_available = False
        return False

# Пробуем импортировать при старте
try_import_argos()

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
            self._update_translator()

    def _update_translator(self):
        try:
            self.argos_translate = argostranslate.translate.translate
        except Exception as e:
            print(f"Argos translation init error: {e}")
            self.argos_translate = None

    def is_model_installed(self, from_code='en', to_code='ru') -> bool:
        if not argos_available:
            return False
        try:
            installed_packages = argostranslate.package.get_installed_packages()
            return any(p.from_code == from_code and p.to_code == to_code for p in installed_packages)
        except Exception as e:
            print(f"Argos check installed packages error: {e}")
            return False

    def download_model(self, from_code='en', to_code='ru', progress_callback=None) -> bool:
        global argos_available
        if not argos_available:
            success = self.download_argos_framework(progress_callback)
            if not success:
                return False
            if not try_import_argos():
                if progress_callback:
                    progress_callback("Ошибка инициализации")
                return False
                
        try:
            if progress_callback:
                progress_callback("Обновление индекса...")
            argostranslate.package.update_package_index()
            
            if progress_callback:
                progress_callback("Поиск модели...")
            available_packages = argostranslate.package.get_available_packages()
            package_to_install = next(
                filter(lambda x: x.from_code == from_code and x.to_code == to_code, available_packages), None
            )
            if package_to_install:
                if progress_callback:
                    progress_callback("Загрузка модели (~150MB)...")
                downloaded_file = package_to_install.download()
                
                if progress_callback:
                    progress_callback("Установка модели...")
                argostranslate.package.install_from_path(downloaded_file)
                self._update_translator()
                
                if progress_callback:
                    progress_callback("Успешно")
                return True
            else:
                if progress_callback:
                    progress_callback("Не найдена")
                return False
        except Exception as e:
            print(f"Argos download model error: {e}")
            if progress_callback:
                progress_callback("Ошибка установки")
            return False

    def download_argos_framework(self, progress_callback=None) -> bool:
        try:
            os.makedirs(LOCAL_TRANSLATOR_DIR, exist_ok=True)
            zip_path = os.path.join(APP_DIR, "local_translator.zip")
            parent_zip_path = os.path.join(os.path.dirname(APP_DIR), "local_translator.zip")
            
            found_local = False
            if os.path.exists(zip_path):
                found_local = True
            elif os.path.exists(parent_zip_path):
                zip_path = parent_zip_path
                found_local = True
                
            if found_local:
                if progress_callback:
                    progress_callback("Распаковка локального архива...")
            else:
                url = "https://github.com/WiseYaroslav28/sinc-pro-voice-widget/releases/download/v3.1.0-WIP/local_translator.zip"
                if progress_callback:
                    progress_callback("Скачивание движка (180MB)...")
                
                import urllib.request
                req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req) as response:
                    total_size = int(response.info().get('Content-Length', 0))
                    downloaded = 0
                    block_size = 1024 * 1024 # 1MB
                    with open(zip_path, 'wb') as f:
                        while True:
                            block = response.read(block_size)
                            if not block:
                                break
                            f.write(block)
                            downloaded += len(block)
                            if total_size > 0 and progress_callback:
                                percent = int((downloaded / total_size) * 100)
                                progress_callback(f"Скачивание движка: {percent}%")
            
            if progress_callback:
                progress_callback("Распаковка движка...")
                
            import zipfile
            with zipfile.ZipFile(zip_path, 'r') as zip_ref:
                zip_ref.extractall(LOCAL_TRANSLATOR_DIR)
                
            if not found_local:
                try:
                    os.remove(zip_path)
                except:
                    pass
                
            return True
        except Exception as e:
            print(f"Error downloading argos framework: {e}")
            if progress_callback:
                progress_callback("Ошибка скачивания")
            return False

    def _translate_payload(self, payload: str, target_lang: str) -> str:
        if not self.is_model_installed('en', target_lang):
            raise RuntimeError("Локальный переводчик не установлен. Скачайте модель в настройках.")
        if not self.argos_translate:
            raise RuntimeError("Движок Argos Translate не инициализирован.")
        return self.argos_translate(payload, 'en', target_lang)
        
    def _translate_individual(self, text: str, target_lang: str) -> str:
        if not self.is_model_installed('en', target_lang):
            raise RuntimeError("Локальный переводчик не установлен. Скачайте модель в настройках.")
        if not self.argos_translate:
            raise RuntimeError("Движок Argos Translate не инициализирован.")
        return self.argos_translate(text, 'en', target_lang)


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
