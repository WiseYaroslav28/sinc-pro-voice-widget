import os
import sys
import sqlite3
import re
import traceback
from deep_translator import GoogleTranslator

# Определение директории приложения
if getattr(sys, 'frozen', False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

DB_PATH = os.path.join(APP_DIR, "translation_cache.db")

class TranslationEngine:
    def translate_batch(self, texts: list, target_lang: str) -> list:
        raise NotImplementedError("Subclasses must implement translate_batch")


class GoogleCacheEngine(TranslationEngine):
    def __init__(self):
        self.db_path = DB_PATH
        self._init_db()

    def _init_db(self):
        """Инициализирует базу данных кэша переводов."""
        try:
            conn = sqlite3.connect(self.db_path)
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
        """Получает перевод из кэша, если он существует."""
        try:
            conn = sqlite3.connect(self.db_path)
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
        """Сохраняет перевод в кэш."""
        try:
            conn = sqlite3.connect(self.db_path)
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

        results = [None] * len(texts)
        missing_indices = []
        missing_texts = []

        # 1. Проверяем локальный кэш
        for i, text in enumerate(texts):
            cleaned = text.strip()
            if not cleaned:
                results[i] = ""
                continue
            
            cached = self._get_cached_translation(cleaned, target_lang)
            if cached is not None:
                results[i] = cached
            else:
                missing_indices.append(i)
                missing_texts.append(cleaned)

        if not missing_texts:
            return results

        # 2. Выполняем пакетный перевод отсутствующих фраз
        # Разделяем на чанки длиной не более 4000 символов, чтобы избежать ошибок API
        chunks = []
        current_chunk = []
        current_len = 0

        for idx, text in zip(missing_indices, missing_texts):
            # Строка разметки: "___N___ Текст\n"
            line_len = len(text) + 20
            if current_len + line_len > 4000 and current_chunk:
                chunks.append(current_chunk)
                current_chunk = []
                current_len = 0
            current_chunk.append((idx, text))
            current_len += line_len
        if current_chunk:
            chunks.append(current_chunk)

        translator = GoogleTranslator(source='auto', target=target_lang)

        for chunk in chunks:
            # Строим единый запрос
            payload_parts = []
            for i, (idx, text) in enumerate(chunk):
                payload_parts.append(f"___{i}___ {text}")
            
            payload = "\n".join(payload_parts)

            try:
                # Отправляем один HTTP-запрос к Google
                translated_payload = translator.translate(payload)
                
                # Парсим ответ с помощью регулярного выражения
                # regex ищет вхождения ___(\d+)___ и текст после него до следующего разделителя или конца
                pattern = r'(?:^|\n)\s*___(\d+)___\s*(.*?)(?=\n\s*___\d+___|$)'
                matches = re.findall(pattern, translated_payload, re.DOTALL)
                
                translated_map = {}
                for idx_str, text_val in matches:
                    try:
                        rel_idx = int(idx_str)
                        translated_map[rel_idx] = text_val.strip()
                    except ValueError:
                        pass

                # Распределяем результаты и кэшируем их
                for i, (orig_idx, orig_text) in enumerate(chunk):
                    if i in translated_map:
                        trans_text = translated_map[i]
                        # Проверяем, что перевод не пустой и не совпадает просто с маркером
                        if trans_text and not trans_text.startswith("___"):
                            results[orig_idx] = trans_text
                            self._save_to_cache(orig_text, target_lang, trans_text)
                            continue
                    
                    # Fallback для конкретной фразы, если парсинг не удался
                    try:
                        trans_text = translator.translate(orig_text)
                        results[orig_idx] = trans_text
                        self._save_to_cache(orig_text, target_lang, trans_text)
                    except Exception as e:
                        print(f"Fallback translation error for '{orig_text}': {e}")
                        results[orig_idx] = orig_text # оставляем оригинал
            except Exception as e:
                print(f"Batch translation error for chunk: {e}")
                traceback.print_exc()
                # В случае общей ошибки переводим элементы по одному с сохранением в кэш
                for orig_idx, orig_text in chunk:
                    try:
                        trans_text = translator.translate(orig_text)
                        results[orig_idx] = trans_text
                        self._save_to_cache(orig_text, target_lang, trans_text)
                    except Exception as ex:
                        print(f"Fallback translation error in loop for '{orig_text}': {ex}")
                        results[orig_idx] = orig_text

        # На всякий случай заполняем None оригинальным текстом
        for i in range(len(results)):
            if results[i] is None:
                results[i] = texts[i]

        return results


class ArgosEngine(TranslationEngine):
    def translate_batch(self, texts: list, target_lang: str) -> list:
        # Заглушка для Этапа 2
        return [f"[Argos] {t}" for t in texts]


class OllamaEngine(TranslationEngine):
    def __init__(self, model="gemma2", url="http://localhost:11434"):
        self.model = model
        self.url = url

    def translate_batch(self, texts: list, target_lang: str) -> list:
        # Заглушка для Этапа 2
        return [f"[Ollama] {t}" for t in texts]


def create_engine(engine_type: str, **kwargs) -> TranslationEngine:
    if engine_type == "argos":
        return ArgosEngine()
    elif engine_type == "ollama":
        return OllamaEngine(
            model=kwargs.get("ollama_model", "gemma2"),
            url=kwargs.get("ollama_url", "http://localhost:11434")
        )
    else:
        return GoogleCacheEngine()
