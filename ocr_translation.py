import asyncio
import os
import tempfile
import uuid
from PIL import Image
from deep_translator import GoogleTranslator

# Импортируем translation_engine ПЕРВЫМ, чтобы избежать WinError 1114 (конфликт OpenMP/DLL между Torch и WinRT)
import translation_engine

# Windows Runtime imports (will be resolved at runtime after pip install)
try:
    from winrt.windows.graphics.imaging import BitmapDecoder
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.storage import StorageFile, FileAccessMode
    winrt_available = True
except ImportError:
    winrt_available = False

async def run_ocr_on_file(file_path: str) -> list:
    """Runs Windows OCR on an image file and returns a list of dictionaries:
    {'text': str, 'bbox': (x1, y1, x2, y2)}
    """
    if not winrt_available:
        raise ImportError("WinRT OCR libraries are not installed or not supported on this platform.")

    abs_path = os.path.abspath(file_path)
    file = await StorageFile.get_file_from_path_async(abs_path)
    stream = await file.open_async(FileAccessMode.READ)
    decoder = await BitmapDecoder.create_async(stream)
    software_bitmap = await decoder.get_software_bitmap_async()

    # Create engine based on user profile languages
    engine = OcrEngine.try_create_from_user_profile_languages()
    if not engine:
        raise RuntimeError("Failed to create OcrEngine. Make sure language packs are installed.")

    result = await engine.recognize_async(software_bitmap)
    
    lines_data = []
    for line in result.lines:
        words = list(line.words)
        if not words:
            continue
        
        # Filter out words that don't contain any alphanumeric characters (likely icons/noise)
        import re
        # Сначала фильтруем слова, в которых вообще нет букв/цифр
        valid_words = [w for w in words if re.search(r'\w', w.text)]
        target_words = valid_words if valid_words else words
        
        # Затем фильтруем слова-выбросы по высоте (например, иконка, распознанная как буква 'E')
        # Если слово в 1.8+ раз выше медианной высоты текста, это скорее всего иконка
        import statistics
        if len(target_words) > 1:
            median_h = statistics.median(w.bounding_rect.height for w in target_words)
            height_filtered = [w for w in target_words if w.bounding_rect.height <= median_h * 1.8]
            if height_filtered:
                target_words = height_filtered
        
        # Группируем слова на основе расстояния по горизонтали
        groups = []
        current_group = []
        
        # Сортируем слова по координате X
        sorted_words = sorted(target_words, key=lambda w: w.bounding_rect.x)
        
        for w in sorted_words:
            if not current_group:
                current_group.append(w)
            else:
                prev_w = current_group[-1]
                # Вычисляем расстояние по горизонтали между концом предыдущего слова и началом текущего
                dist = w.bounding_rect.x - (prev_w.bounding_rect.x + prev_w.bounding_rect.width)
                # Порог: 1.2 * высота предыдущего слова, но не менее 20 пикселей
                threshold = max(prev_w.bounding_rect.height * 1.2, 20)
                
                # Проверяем также вертикальный сдвиг на случай, если OCR объединил слова из разных строк
                y_diff = abs(w.bounding_rect.y - prev_w.bounding_rect.y)
                y_threshold = max(prev_w.bounding_rect.height * 0.5, 10)
                
                if dist > threshold or y_diff > y_threshold:
                    groups.append(current_group)
                    current_group = [w]
                else:
                    current_group.append(w)
        if current_group:
            groups.append(current_group)
            
        for group in groups:
            group_text = " ".join(w.text for w in group)
            if not group_text.strip():
                continue
                
            # Очищаем текст от мусорных одиночных символов (иконок, распознанных как буквы)
            import re
            cleaned_text = group_text.strip()
            cleaned_text = re.sub(r'^[b-hj-np-zB-HJ-NP-Z0-9]\s+', '', cleaned_text)
            cleaned_text = re.sub(r'\s+[b-hj-np-zB-HJ-NP-Z0-9]$', '', cleaned_text)
            
            if not cleaned_text.strip():
                continue
                
            min_x = min(w.bounding_rect.x for w in group)
            min_y = min(w.bounding_rect.y for w in group)
            max_x = max(w.bounding_rect.x + w.bounding_rect.width for w in group)
            max_y = max(w.bounding_rect.y + w.bounding_rect.height for w in group)
            
            lines_data.append({
                "text": cleaned_text,
                "bbox": (min_x, min_y, max_x, max_y),
                "line_height": max_y - min_y
            })
            
    if not lines_data:
        return []
        
    # Алгоритм связных компонент для объединения строк в абзацы (поддержка многоколоночного текста)
    def should_merge(a, b):
        ax1, ay1, ax2, ay2 = a["bbox"]
        bx1, by1, bx2, by2 = b["bbox"]
        a_h = ay2 - ay1
        b_h = by2 - by1
        
        # B должна быть ниже A, но не слишком далеко по Y (не больше 1.35 * высота строки A)
        vertical_gap = by1 - ay2
        if not (-5 <= vertical_gap < a_h * 1.35):
            return False
            
        # Выравнивание по левому краю (разница X не больше высоты строки или 25px)
        if abs(ax1 - bx1) >= max(a_h, 25):
            return False
            
        # Близость размеров шрифта (высоты строки)
        if abs(a_h - b_h) >= 6:
            return False
            
        # Наличие горизонтального перекрытия областей
        horizontal_overlap = (bx1 < ax2 and ax1 < bx2)
        if not horizontal_overlap:
            return False
            
        return True

    n = len(lines_data)
    adj = {i: [] for i in range(n)}
    for i in range(n):
        for j in range(i + 1, n):
            a = lines_data[i]
            b = lines_data[j]
            if a["bbox"][1] <= b["bbox"][1]:
                merge = should_merge(a, b)
            else:
                merge = should_merge(b, a)
                
            if merge:
                adj[i].append(j)
                adj[j].append(i)

    visited = set()
    merged_blocks = []
    for i in range(n):
        if i not in visited:
            component = []
            queue = [i]
            visited.add(i)
            while queue:
                curr = queue.pop(0)
                component.append(curr)
                for neighbor in adj[curr]:
                    if neighbor not in visited:
                        visited.add(neighbor)
                        queue.append(neighbor)
                        
            # Сортируем строки внутри абзаца по Y
            sorted_indices = sorted(component, key=lambda idx: lines_data[idx]["bbox"][1])
            merged_text = " ".join(lines_data[idx]["text"] for idx in sorted_indices)
            
            min_x = min(lines_data[idx]["bbox"][0] for idx in component)
            min_y = min(lines_data[idx]["bbox"][1] for idx in component)
            max_x = max(lines_data[idx]["bbox"][2] for idx in component)
            max_y = max(lines_data[idx]["bbox"][3] for idx in component)
            
            avg_lh = sum(lines_data[idx]["line_height"] for idx in component) / len(component)
            
            merged_blocks.append({
                "text": merged_text,
                "bbox": (min_x, min_y, max_x, max_y),
                "line_height": int(avg_lh)
            })
            
    # Сортируем готовые абзацы по Y, затем по X для логичного порядка
    return sorted(merged_blocks, key=lambda b: (b["bbox"][1], b["bbox"][0]))


def translate_batch_texts(texts: list, target_lang: str, engine_type: str = "google_cache", **kwargs) -> list:
    """Translates a list of texts using our TranslationEngine (with cache and batching)."""
    if not texts:
        return []
    try:
        engine = translation_engine.get_engine(engine_type, **kwargs)
        return engine.translate_batch(texts, target_lang)
    except Exception as e:
        print(f"Error in translate_batch_texts: {e}")
        return texts

async def perform_ocr_and_translation(image: Image.Image, target_lang: str, engine_type: str = "google_cache", **kwargs) -> list:
    """Saves Pillow Image, runs OCR, translates texts, and returns list of:
    {'text': str, 'bbox': (x1, y1, x2, y2), 'original_text': str}
    """
    temp_dir = tempfile.gettempdir()
    temp_filename = os.path.join(temp_dir, f"ocr_{uuid.uuid4().hex}.png")
    
    try:
        # Save image to temp file (WinRT OCR works best with file decoder)
        # Using PNG format to preserve text clarity
        image.save(temp_filename, format="PNG")
        
        # Run OCR
        ocr_lines = await run_ocr_on_file(temp_filename)
        if not ocr_lines:
            return []
            
        # Extract texts for batch translation
        original_texts = [line["text"] for line in ocr_lines]
        
        # Run translation in a thread pool to avoid blocking the asyncio loop
        import functools
        loop = asyncio.get_running_loop()
        func = functools.partial(translate_batch_texts, original_texts, target_lang, engine_type, **kwargs)
        translated_texts = await loop.run_in_executor(None, func)
        
        # Combine back
        result = []
        for i, line in enumerate(ocr_lines):
            translated = translated_texts[i] if i < len(translated_texts) else line["text"]
            result.append({
                "text": translated,
                "original_text": line["text"],
                "bbox": line["bbox"],
                "line_height": line.get("line_height", line["bbox"][3] - line["bbox"][1])
            })
            
        return result

        
    finally:
        # Clean up temp file
        if os.path.exists(temp_filename):
            try:
                os.remove(temp_filename)
            except:
                pass
