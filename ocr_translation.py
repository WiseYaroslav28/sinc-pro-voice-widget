import asyncio
import os
import tempfile
import uuid
import re
import statistics
import unicodedata
from PIL import Image

def is_icon_or_noise(text: str, bbox: tuple = None) -> bool:
    """Returns True if the text represents a single icon, emoji, or non-textual unicode character."""
    if not text or not text.strip():
        return True
        
    # Разрешаем стандартные знаки препинания (включая длинное и среднее тире, подчеркивание, звездочку)
    if re.match(r'^[.,?!:\-\–\—;()\[\]"\'«»\\/<>|_*+=&^%$#@~`{}]+$', text):
        return False
        
    # Если передан bbox, проверяем геометрические пропорции для одиночных символов
    if bbox and len(text) == 1:
        x1, y1, x2, y2 = bbox
        w = x2 - x1
        h = y2 - y1
        if h > 0:
            ratio = w / h
            # Одиночные буквы обычно высокие и узкие (ratio < 0.75).
            # Квадратные или широкие одиночные символы (ratio >= 0.85) часто являются иконками,
            # распознанными как буквы (например, чекбоксы, маркеры списков, стрелки).
            # Не фильтруем цифры (они могут быть тонкими).
            if ratio >= 0.85 and not text.isdigit() and not re.match(r'^[a-zA-Zа-яА-ЯёЁ]$', text):
                return True

    # Если в слове есть буквы или цифры, это обычное слово
    if re.search(r'[\w\d]', text):
        # Но если длина 1, проверим редкие символы
        if len(text) == 1:
            char = text[0]
            cat = unicodedata.category(char)
            # Фильтруем категории Symbol (S*) или Control (C*), а также редкие символы
            if cat.startswith('S') or cat.startswith('C') or ord(char) > 0x2000:
                return True
        return False
        
    # Все остальное (стрелочки, прямоугольники, эмодзи) - это шум/иконка
    return True

def sort_blocks_robustly(blocks: list, H: float) -> list:
    """Sorts geometric blocks robustly by reading order.
    Groups blocks into rows based on vertical overlap (> 35%),
    sorts rows from top to bottom, and sorts blocks within each row from left to right.
    """
    if not blocks:
        return []
        
    # Sort blocks initially by their top Y coordinate
    sorted_by_y = sorted(blocks, key=lambda b: b["bbox"][1])
    
    rows = [] # list of rows, where each row is a list of blocks
    
    for block in sorted_by_y:
        bx1, by1, bx2, by2 = block["bbox"]
        bh = by2 - by1
        if bh <= 0:
            bh = H
            
        placed = False
        for row in rows:
            # Compare with the anchor block of the row (the first block)
            ax1, ay1, ax2, ay2 = row[0]["bbox"]
            ah = ay2 - ay1
            if ah <= 0:
                ah = H
                
            overlap_y = max(0, min(ay2, by2) - max(ay1, by1))
            min_h = min(ah, bh)
            
            # If vertical overlap is significant (e.g. > 35%)
            if min_h > 0 and (overlap_y / min_h) > 0.35:
                # Limit the vertical offset of top edges to prevent combining distant fonts
                if abs(by1 - ay1) < H * 1.5:
                    row.append(block)
                    placed = True
                    break
                    
        if not placed:
            rows.append([block])
            
    # Sort blocks in each row horizontally from left to right (by X coordinate)
    for row in rows:
        row.sort(key=lambda b: b["bbox"][0])
        
    # Sort the rows themselves vertically by their average Y coordinate
    rows.sort(key=lambda r: sum(b["bbox"][1] for b in r) / len(r))
    
    # Flatten the list of rows into a single list of blocks
    sorted_blocks = []
    for row in rows:
        sorted_blocks.extend(row)
        
    return sorted_blocks

# Импортируем translation_engine ПЕРВЫМ, чтобы избежать WinError 1114 (конфликт OpenMP/DLL между Torch и WinRT)
import translation_engine

# Windows Runtime imports
try:
    from winrt.windows.graphics.imaging import BitmapDecoder
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.storage import StorageFile, FileAccessMode
    try:
        from winrt.windows.globalization import Language
    except ImportError:
        Language = None
    winrt_available = True
except ImportError:
    winrt_available = False

async def run_ocr_on_file(file_path: str) -> list:
    """Runs Windows OCR on an image file, groups lines geometrically into logical blocks,
    and returns a list of block dictionaries with word-level data:
    {'text': str, 'bbox': (x1, y1, x2, y2), 'words': [{'text': str, 'bbox': (x1,y1,x2,y2)}, ...]}
    """
    if not winrt_available:
        raise ImportError("WinRT OCR libraries are not installed or not supported on this platform.")

    abs_path = os.path.abspath(file_path)
    file = await StorageFile.get_file_from_path_async(abs_path)
    stream = await file.open_async(FileAccessMode.READ)
    decoder = await BitmapDecoder.create_async(stream)
    software_bitmap = await decoder.get_software_bitmap_async()

    # Попробуем создать движки для русского и английского
    engine_ru = None
    engine_en = None
    
    try:
        if Language:
            # Пробуем создать английский движок
            try:
                engine_en = OcrEngine.try_create_from_language(Language("en-US"))
            except:
                pass
            # Пробуем создать русский движок
            try:
                engine_ru = OcrEngine.try_create_from_language(Language("ru-RU"))
            except:
                pass
    except Exception as e:
        print(f"Language pack API not available: {e}")
        
    # Если не удалось создать русский движок, берем язык системы по умолчанию
    if not engine_ru:
        engine_ru = OcrEngine.try_create_from_user_profile_languages()
        
    if not engine_ru:
        raise RuntimeError("Failed to create OcrEngine. Make sure language packs are installed.")

    # 1. Запуск распознавания
    result_ru = await engine_ru.recognize_async(software_bitmap)
    
    result_en = None
    if engine_en:
        try:
            result_en = await engine_en.recognize_async(software_bitmap)
        except Exception as e:
            print(f"Failed to run English OCR: {e}")

    # 2. Собираем слова из русского OCR
    words_ru = []
    for line in result_ru.lines:
        for w in line.words:
            words_ru.append({
                "text": w.text,
                "bbox": (
                    w.bounding_rect.x,
                    w.bounding_rect.y,
                    w.bounding_rect.x + w.bounding_rect.width,
                    w.bounding_rect.y + w.bounding_rect.height
                )
            })
            
    # Собираем слова из английского OCR
    words_en = []
    if result_en:
        for line in result_en.lines:
            for w in line.words:
                words_en.append({
                    "text": w.text,
                    "bbox": (
                        w.bounding_rect.x,
                        w.bounding_rect.y,
                        w.bounding_rect.x + w.bounding_rect.width,
                        w.bounding_rect.y + w.bounding_rect.height
                    )
                })

    # 3. Объединяем слова из двух движков (с защитой от пропусков mixed-слов)
    def calculate_overlap_pct(box1, box2):
        x1_1, y1_1, x2_1, y2_1 = box1
        x1_2, y1_2, x2_2, y2_2 = box2
        xi1 = max(x1_1, x1_2)
        yi1 = max(y1_1, y1_2)
        xi2 = min(x2_1, x2_2)
        yi2 = min(y2_1, y2_2)
        inter_area = max(0, xi2 - xi1) * max(0, yi2 - yi1)
        if inter_area <= 0: return 0.0
        area1 = (x2_1 - x1_1) * (y2_1 - y1_1)
        area2 = (x2_2 - x1_2) * (y2_2 - y1_2)
        return inter_area / min(area1, area2)

    merged_words = list(words_ru)
    pil_img = None
    
    for w_en in words_en:
        has_overlap = False
        for w_ru in words_ru:
            if calculate_overlap_pct(w_en["bbox"], w_ru["bbox"]) > 0.4:
                has_overlap = True
                break
                
        if not has_overlap:
            # Английское слово отсутствует в русском OCR. Проверяем, не смешанное ли оно
            text_en = w_en["text"]
            if "-" in text_en and len(text_en) > 3:
                parts = text_en.split("-")
                # Точечно кропаем и распознаем правую часть русским движком
                try:
                    if pil_img is None:
                        pil_img = Image.open(abs_path)
                    
                    x1, y1, x2, y2 = w_en["bbox"]
                    w_width = x2 - x1
                    left_len = len(parts[0])
                    total_len = len(text_en)
                    split_ratio = (left_len + 1) / total_len
                    
                    crop_x1 = max(x1, x1 + w_width * (split_ratio - 0.05))
                    crop_x2 = x2
                    
                    # Безопасные адаптивные отступы вокруг кропа для повышения качества OCR
                    img_w, img_h = pil_img.size
                    pad_x_left = 6
                    pad_x_right = 6
                    wh = y2 - y1
                    pad_y = max(4, int(wh * 0.4))
                    
                    c_x1 = max(0, int(crop_x1) - pad_x_left)
                    c_y1 = max(0, int(y1) - pad_y)
                    c_x2 = min(img_w, int(crop_x2) + pad_x_right)
                    c_y2 = min(img_h, int(y2) + pad_y)
                    
                    cropped_w = pil_img.crop((c_x1, c_y1, c_x2, c_y2))
                    cw, ch = cropped_w.size
                    if cw > 2 and ch > 2:
                        scaled_w = cropped_w.resize((cw * 3, ch * 3), Image.Resampling.LANCZOS)
                        
                        import tempfile
                        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f_temp:
                            temp_crop_path = f_temp.name
                        try:
                            scaled_w.save(temp_crop_path)
                            crop_file = await StorageFile.get_file_from_path_async(os.path.abspath(temp_crop_path))
                            crop_stream = await crop_file.open_async(FileAccessMode.READ)
                            crop_decoder = await BitmapDecoder.create_async(crop_stream)
                            crop_bitmap = await crop_decoder.get_software_bitmap_async()
                            
                            crop_res = await engine_ru.recognize_async(crop_bitmap)
                            crop_text = "".join(w_c.text for line_c in crop_res.lines for w_c in line_c.words).strip()
                            
                            if crop_text:
                                if crop_text.startswith("-"):
                                    crop_text = crop_text[1:]
                                restored_text = parts[0] + "-" + crop_text
                                print(f"Hybrid OCR Restored Mixed Word: {text_en} -> {restored_text}")
                                w_en["text"] = restored_text
                        finally:
                            if os.path.exists(temp_crop_path):
                                try: os.remove(temp_crop_path)
                                except: pass
                except Exception as ex:
                    print(f"Error in hybrid OCR fallback: {ex}")
                    
            merged_words.append(w_en)

    if pil_img:
        try: pil_img.close()
        except: pass

    if not merged_words:
        return []

    # 4. Расчет медианной высоты шрифта (DPI-awareness)
    all_word_heights = [w["bbox"][3] - w["bbox"][1] for w in merged_words]
    median_word_height = statistics.median(all_word_heights) if all_word_heights else 18
    H = median_word_height

    # 5. Группируем все слова по визуальным строкам с использованием вертикальной кластеризации
    sorted_words = sorted(merged_words, key=lambda w: w["bbox"][1])
    lines_of_words = []
    
    for w in sorted_words:
        wy = w["bbox"][1]
        wh = w["bbox"][3] - w["bbox"][1]
        if wh <= 0:
            wh = H
            
        placed = False
        for line in lines_of_words:
            anchor = line[0]
            ay = anchor["bbox"][1]
            ah = anchor["bbox"][3] - anchor["bbox"][1]
            if ah <= 0:
                ah = H
                
            overlap_y = max(0, min(ay + ah, wy + wh) - max(ay, wy))
            min_h = min(ah, wh)
            
            if min_h > 0 and (overlap_y / min_h) > 0.4:
                # Если один из символов очень низкий (например, подчеркивание) и полностью перекрывается по Y
                is_sub_line = (overlap_y / min_h) > 0.9 and min_h <= 4
                if is_sub_line or abs(wy - ay) < H * 0.8:
                    line.append(w)
                    placed = True
                    break
                    
        if not placed:
            lines_of_words.append([w])
            
    for line in lines_of_words:
        line.sort(key=lambda w: w["bbox"][0])
        
    lines_of_words.sort(key=lambda r: sum(w["bbox"][1] for w in r) / len(r))

    # 6. Формируем исходные геометрические строки и слова в них
    lines_data = []
    
    for words in lines_of_words:
        if not words:
            continue
            
        # Вычисляем адаптивный порог зазора для текущей строки на основе медианы пробелов
        gaps = []
        for idx_g in range(1, len(words)):
            g_val = words[idx_g]["bbox"][0] - words[idx_g-1]["bbox"][2]
            gaps.append(max(0, g_val))
            
        median_gap = statistics.median(gaps) if gaps else 5.0
        adaptive_threshold = min(H * 4.5, max(H * 2.8, median_gap * 4.0))

        # Группируем исходные слова по горизонтали на основе адаптивного зазора
        word_groups = []
        current_group = []
        
        for w_data in words:
            if not current_group:
                current_group.append(w_data)
            else:
                last_w = current_group[-1]
                gap = w_data["bbox"][0] - last_w["bbox"][2]
                
                if gap > adaptive_threshold:
                    word_groups.append(current_group)
                    current_group = [w_data]
                else:
                    current_group.append(w_data)
        if current_group:
            word_groups.append(current_group)
            
        # Фильтруем каждую группу и добавляем в lines_data
        for group in word_groups:
            valid_group = []
            for w_data in group:
                if is_icon_or_noise(w_data["text"], w_data["bbox"]):
                    continue
                valid_group.append(w_data)
                
            if not valid_group:
                continue
                
            # Фильтруем слова-выбросы по высоте (повышаем коэффициент до 2.8)
            if len(valid_group) > 1:
                median_h = statistics.median(w["bbox"][3] - w["bbox"][1] for w in valid_group)
                valid_group = [w for w in valid_group if (w["bbox"][3] - w["bbox"][1]) <= median_h * 2.8]
                
            if not valid_group:
                continue
                
            min_x = min(w["bbox"][0] for w in valid_group)
            min_y = min(w["bbox"][1] for w in valid_group)
            max_x = max(w["bbox"][2] for w in valid_group)
            max_y = max(w["bbox"][3] for w in valid_group)
            
            lines_data.append({
                "text": " ".join(w["text"] for w in valid_group),
                "bbox": (min_x, min_y, max_x, max_y),
                "words": valid_group
            })
            
    if not lines_data:
        return []

    # --- Детектор табличной верстки (выполняется до горизонтального слияния на исходных строках) ---
    n_orig = len(lines_data)
    has_horiz_neighbor = [False] * n_orig
    for i in range(n_orig):
        ax1, ay1, ax2, ay2 = lines_data[i]["bbox"]
        for j in range(n_orig):
            if i == j:
                continue
            bx1, by1, bx2, by2 = lines_data[j]["bbox"]
            overlap_y = max(0, min(ay2, by2) - max(ay1, by1))
            min_h = min(ay2 - ay1, by2 - by1)
            # Перекрытие по Y более чем на 30% и они не перекрываются по X
            if min_h > 0 and (overlap_y / min_h) > 0.3:
                # Находим зазор по X
                if bx2 < ax1:
                    gap_x = ax1 - bx2
                elif ax2 < bx1:
                    gap_x = bx1 - ax2
                else:
                    gap_x = 0
                # Считаем горизонтальным соседом (колонкой/ячейкой), только если есть существенный зазор
                if gap_x >= H * 2.0:
                    has_horiz_neighbor[i] = True
                    break
                    
    # 2. Строим временный вертикальный граф для оценки высоты колонок
    temp_adj = {i: [] for i in range(n_orig)}
    for i in range(n_orig):
        ax1, ay1, ax2, ay2 = lines_data[i]["bbox"]
        for j in range(i + 1, n_orig):
            bx1, by1, bx2, by2 = lines_data[j]["bbox"]
            vertical_gap = by1 - ay2
            horizontal_overlap = (bx1 < ax2 and ax1 < bx2)
            if -5 <= vertical_gap < H * 1.5 and horizontal_overlap:
                temp_adj[i].append(j)
                temp_adj[j].append(i)
                
    # Находим высоту колонок (размеры связных вертикальных компонент)
    temp_visited = set()
    col_heights = []
    for i in range(n_orig):
        if i not in temp_visited:
            comp = []
            q = [i]
            temp_visited.add(i)
            while q:
                curr = q.pop(0)
                comp.append(curr)
                for neighbor in temp_adj[curr]:
                    if neighbor not in temp_visited:
                        temp_visited.add(neighbor)
                        q.append(neighbor)
            col_heights.append(len(comp))
            
    pct_horiz = sum(has_horiz_neighbor) / n_orig if n_orig > 0 else 0
    max_col_height = max(col_heights) if col_heights else 0
    mean_col_height = statistics.mean(col_heights) if col_heights else 0
    
    # Табличный режим включается, если много горизонтальных колонок и высота колонок мала (сетка)
    is_table = (pct_horiz > 0.35 and max_col_height <= 3) or (pct_horiz > 0.5 and mean_col_height < 2.5)

    # --- Шаг 1.5: Горизонтальное слияние фрагментов строк (только если не таблица) ---
    if not is_table:
        h_adj = {i: [] for i in range(len(lines_data))}
        for i in range(len(lines_data)):
            for j in range(i + 1, len(lines_data)):
                a = lines_data[i]
                b = lines_data[j]
                ax1, ay1, ax2, ay2 = a["bbox"]
                bx1, by1, bx2, by2 = b["bbox"]
                
                # Перекрытие по Y более 30% (было 60%)
                overlap_y = max(0, min(ay2, by2) - max(ay1, by1))
                min_h = min(ay2 - ay1, by2 - by1)
                if min_h <= 0 or (overlap_y / min_h) <= 0.3:
                    continue
                    
                # Допускаем большее различие по высоте шрифта (до 1.0 * H вместо 0.4 * H)
                if abs((ay2 - ay1) - (by2 - by1)) >= H * 1.0:
                    continue
                    
                # Зазор по X (кто-то должен быть левее, либо перекрываться)
                if ax2 <= bx1:
                    gap_x = bx1 - ax2
                elif bx2 <= ax1:
                    gap_x = ax1 - bx2
                else:
                    gap_x = 0
                    
                # Максимальный зазор слияния по X увеличен до H * 2.5 (было 2.2)
                if gap_x < H * 2.5:
                    h_adj[i].append(j)
                    h_adj[j].append(i)
                    
        h_visited = set()
        merged_lines_data = []
        for i in range(len(lines_data)):
            if i not in h_visited:
                comp = []
                q = [i]
                h_visited.add(i)
                while q:
                    curr = q.pop(0)
                    comp.append(curr)
                    for neighbor in h_adj[curr]:
                        if neighbor not in h_visited:
                            h_visited.add(neighbor)
                            q.append(neighbor)
                            
                if len(comp) == 1:
                    merged_lines_data.append(lines_data[i])
                else:
                    comp_sorted = sorted(comp, key=lambda idx: lines_data[idx]["bbox"][0])
                    words_all = []
                    for idx in comp_sorted:
                        words_all.extend(lines_data[idx]["words"])
                        
                    min_x = min(lines_data[idx]["bbox"][0] for idx in comp)
                    min_y = min(lines_data[idx]["bbox"][1] for idx in comp)
                    max_x = max(lines_data[idx]["bbox"][2] for idx in comp)
                    max_y = max(lines_data[idx]["bbox"][3] for idx in comp)
                    
                    merged_lines_data.append({
                        "text": " ".join(lines_data[idx]["text"] for idx in comp_sorted),
                        "bbox": (min_x, min_y, max_x, max_y),
                        "words": words_all
                    })
        lines_data = merged_lines_data

    # 2. Алгоритм связных компонент для объединения строк в логические блоки (абзацы/колонки)
    def should_merge(a, b):
        ax1, ay1, ax2, ay2 = a["bbox"]
        bx1, by1, bx2, by2 = b["bbox"]
        a_h = ay2 - ay1
        b_h = by2 - by1
        
        # B должна быть ниже A, но не слишком далеко по Y (не больше 2.2 * H для поддержки большого line-spacing)
        vertical_gap = by1 - ay2
        if not (-5 <= vertical_gap < H * 2.2):
            return False
            
        # Близость размеров шрифта (высоты строки)
        if abs(a_h - b_h) >= H * 0.7:
            return False
            
        # Наличие горизонтального перекрытия областей
        horizontal_overlap = (bx1 < ax2 and ax1 < bx2)
        if not horizontal_overlap:
            return False
            
        # Лингвистический и синтаксический анализ стыка строк
        a_text = a["text"].strip()
        b_text = b["text"].strip()
        
        if not a_text or not b_text:
            return False
            
        # Проверяем, оканчивается ли строка A на незавершенный знак препинания
        unfinished_punc = a_text[-1] in (',', ':', ';', '-', '–', '—', '→', '(', '"', '«')
        
        # Списки предлогов/союзов/вспомогательных глаголов (английских и русских)
        connectors = {
            'and', 'or', 'the', 'a', 'of', 'to', 'in', 'on', 'with', 'for', 'at', 'by', 'is', 'are', 'if', 'then', 'but', 'that', 'from', 'an', 'as',
            'и', 'или', 'в', 'на', 'с', 'под', 'для', 'а', 'но', 'от', 'к', 'из', 'у', 'за', 'над', 'перед', 'что', 'чтобы', 'как', 'если'
        }
        last_word = re.sub(r'[^\w]', '', a_text.split()[-1]).lower() if a_text.split() else ""
        has_connector = last_word in connectors
        
        # Проверяем, начинается ли нижняя строка со строчной (маленькой) буквы
        first_word = b_text.split()[0] if b_text.split() else ""
        # Регулярное выражение для проверки первой маленькой буквы (английской или русской)
        starts_with_lowercase = bool(re.match(r'^[a-zа-яё]', first_word))
        
        # Проверяем, является ли строка началом элемента списка (маркером вроде -, *, •, 1., a))
        is_list_item = bool(re.match(r'^([-\*•+■]|\d+[\.)]|[a-zA-Z][\.)])', b_text))
        
        # Если нижняя строка является новым элементом списка, запрещаем слияние с предыдущим блоком
        if is_list_item:
            return False
            
        # Проверяем, оканчивается ли строка A на знак окончания предложения
        ends_with_sentence_end = a_text[-1] in ('.', '?', '!')
        
        # Правило 1: Если строка B начинается со строчной буквы (продолжение предложения) —
        # объединяем её с предыдущим блоком, допускаем смещение левого края до 5.0 * H (для отступов)
        if starts_with_lowercase:
            if abs(ax1 - bx1) < H * 5.0:
                return True
                
        # Правило 2: Если строка A оканчивается на запятую, двоеточие, предлог или союз
        if unfinished_punc or has_connector:
            if abs(ax1 - bx1) < H * 4.0:
                return True
                
        # Правило 3: Геометрическое правило для плотных абзацев текста (если B начинается с заглавной буквы)
        # Объединяем, если левые края выровнены строго, вертикальный зазор очень маленький
        # и предыдущая строка не закончилась точкой
        if not ends_with_sentence_end:
            if abs(ax1 - bx1) < H * 1.5 and vertical_gap < H * 0.85:
                return True
                
        return False

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
                
            # В табличном режиме разрешаем слияние только если строки очень близко (внутри одной ячейки)
            if is_table and merge:
                top_box = a["bbox"] if a["bbox"][1] <= b["bbox"][1] else b["bbox"]
                bot_box = b["bbox"] if a["bbox"][1] <= b["bbox"][1] else a["bbox"]
                v_gap = bot_box[1] - top_box[3]
                h_offset = abs(top_box[0] - bot_box[0])
                if not (v_gap < H * 1.1 and h_offset < H * 1.2):
                    merge = False
                
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
                        
            # Сортируем строки внутри абзаца с использованием робастной группировки по Y
            paragraph_lines = [lines_data[idx] for idx in component]
            sorted_lines = sort_blocks_robustly(paragraph_lines, H)
            block_words = []
            for line in sorted_lines:
                block_words.extend(line["words"])
                
            min_x = min(lines_data[idx]["bbox"][0] for idx in component)
            min_y = min(lines_data[idx]["bbox"][1] for idx in component)
            max_x = max(lines_data[idx]["bbox"][2] for idx in component)
            max_y = max(lines_data[idx]["bbox"][3] for idx in component)
            
            merged_blocks.append({
                "words": block_words,
                "bbox": (min_x, min_y, max_x, max_y)
            })

    # 3. Сортируем визуальные блоки по правилам чтения с использованием робастной вертикальной кластеризации
    sorted_blocks = sort_blocks_robustly(merged_blocks, H)

    # 4. Формируем итоговый результат: каждый блок как единый элемент с массивом слов
    blocks_data = []
    for block in sorted_blocks:
        block_words = block["words"]
        if not block_words:
            continue
            
        # Собираем полный текст блока из слов
        full_text = ""
        for i, w in enumerate(block_words):
            if i > 0:
                prev_w = block_words[i - 1]
                same_line = (abs(w["bbox"][1] - prev_w["bbox"][1]) < H * 0.5) or (w["bbox"][3] - w["bbox"][1] <= 4) or (prev_w["bbox"][3] - prev_w["bbox"][1] <= 4)
                gap = w["bbox"][0] - prev_w["bbox"][2]
                if not same_line or gap >= max(H * 0.15, 3):
                    full_text += " "
            full_text += w["text"]
            
        if full_text.strip():
            blocks_data.append({
                "text": full_text.strip(),
                "bbox": block["bbox"],
                "words": block_words
            })
                
    return blocks_data

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
    """Saves Pillow Image, runs OCR with block grouping, translates texts, 
    and returns list of blocks with original text, translated text, bbox, and words:
    {'text': translated_text, 'original_text': original_text, 'bbox': (x1,y1,x2,y2), 
     'words': [...], 'was_translated': bool}
    """
    temp_dir = tempfile.gettempdir()
    temp_filename = os.path.join(temp_dir, f"ocr_{uuid.uuid4().hex}.png")
    
    try:
        # Save image to temp file (WinRT OCR works best with file decoder)
        image.save(temp_filename, format="PNG")
        
        # Run OCR and get blocks (with words)
        ocr_blocks = await run_ocr_on_file(temp_filename)
        if not ocr_blocks:
            return []
            
        # Умная детекция языка: переводим, если есть хотя бы 3 латинских символа (любое английское слово)
        def needs_translation(text, t_lang):
            if t_lang != "ru":
                return True
            latin_alpha = sum(1 for c in text if ('A' <= c <= 'Z') or ('a' <= c <= 'z'))
            # Переводим, если в блоке есть хотя бы одно полноценное английское слово (3+ букв латиницы)
            return latin_alpha >= 3
        
        texts_to_translate = []
        translate_indices = []
        translated_texts = [None] * len(ocr_blocks)
        
        for i, block in enumerate(ocr_blocks):
            text = block["text"]
            if needs_translation(text, target_lang):
                texts_to_translate.append(text)
                translate_indices.append(i)
            else:
                translated_texts[i] = text
        
        # Переводим в фоновом пуле потоков только то, что действительно требует перевода
        if texts_to_translate:
            import functools
            loop = asyncio.get_running_loop()
            func = functools.partial(translate_batch_texts, texts_to_translate, target_lang, engine_type, **kwargs)
            batch_results = await loop.run_in_executor(None, func)
            
            for idx, trans_text in zip(translate_indices, batch_results):
                translated_texts[idx] = trans_text
        
        # Combine back
        translate_set = set(translate_indices)
        result = []
        for i, block in enumerate(ocr_blocks):
            translated = translated_texts[i] if translated_texts[i] is not None else block["text"]
            result.append({
                "text": translated,
                "original_text": block["text"],
                "bbox": block["bbox"],
                "words": block.get("words", []),
                "was_translated": i in translate_set
            })
            
        return result
        
    finally:
        # Clean up temp file
        if os.path.exists(temp_filename):
            try:
                os.remove(temp_filename)
            except:
                pass
