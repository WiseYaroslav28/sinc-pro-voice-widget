import tkinter as tk
import customtkinter as ctk
import asyncio
import threading
import ctypes
import sys
import time
from PIL import ImageGrab, ImageEnhance, ImageTk, Image, ImageDraw, ImageFont

# Принудительная установка DPI-awareness
if sys.platform.startswith("win"):
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2) # PROCESS_PER_MONITOR_DPI_AWARE
    except:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except:
            pass

def get_virtual_screen_origin():
    try:
        user32 = ctypes.windll.user32
        vx = user32.GetSystemMetrics(76) # SM_XVIRTUALSCREEN
        vy = user32.GetSystemMetrics(77) # SM_YVIRTUALSCREEN
        return vx, vy
    except Exception as e:
        print(f"Error in get_virtual_screen_origin: {e}")
        return 0, 0

def get_canvas_physical_pos(canvas):
    try:
        hwnd = canvas.winfo_id()
        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
        pt = POINT(0, 0)
        ctypes.windll.user32.ClientToScreen(hwnd, ctypes.byref(pt))
        return pt.x, pt.y
    except Exception as e:
        print(f"Error in get_canvas_physical_pos: {e}")
        return canvas.winfo_rootx(), canvas.winfo_rooty()

import ocr_translation

def log_debug(message):
    try:
        log_path = r"c:\Antigravity projects\voice-server\debug.log"
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
    except Exception as e:
        print(f"Log error: {e}")

def analyze_colors(image, bbox):
    """Simple color analysis: calculates average background color around the bbox
    and text color (furthest from background) inside the bbox.
    """
    try:
        w, h = image.size
        x1, y1, x2, y2 = bbox
        
        pad = 4
        bg_x1 = max(0, min(w - 1, int(x1 - pad)))
        bg_y1 = max(0, min(h - 1, int(y1 - pad)))
        bg_x2 = max(0, min(w - 1, int(x2 + pad)))
        bg_y2 = max(0, min(h - 1, int(y2 + pad)))
        
        tx1 = max(0, min(w - 1, int(x1)))
        ty1 = max(0, min(h - 1, int(y1)))
        tx2 = max(0, min(w - 1, int(x2)))
        ty2 = max(0, min(h - 1, int(y2)))
        
        if bg_x2 <= bg_x1 or bg_y2 <= bg_y1:
            return "#FFFFFF", "#000000"
            
        cropped_bg = image.crop((bg_x1, bg_y1, bg_x2, bg_y2))
        cw, ch = cropped_bg.size
        
        edge_pixels = []
        for x in range(cw):
            edge_pixels.append(cropped_bg.getpixel((x, 0)))
            edge_pixels.append(cropped_bg.getpixel((x, ch - 1)))
        for y in range(1, ch - 1):
            edge_pixels.append(cropped_bg.getpixel((0, y)))
            edge_pixels.append(cropped_bg.getpixel((cw - 1, y)))
            
        if edge_pixels:
            r_avg = int(sum(p[0] for p in edge_pixels) / len(edge_pixels))
            g_avg = int(sum(p[1] for p in edge_pixels) / len(edge_pixels))
            b_avg = int(sum(p[2] for p in edge_pixels) / len(edge_pixels))
            bg_rgb = (r_avg, g_avg, b_avg)
        else:
            bg_rgb = (255, 255, 255)
            
        if tx2 > tx1 and ty2 > ty1:
            cropped_txt = image.crop((tx1, ty1, tx2, ty2))
            pixels = list(cropped_txt.getdata())
        else:
            pixels = []
            
        max_dist = -1
        fg_rgb = (0, 0, 0)
        for p in pixels:
            dist = (p[0] - bg_rgb[0])**2 + (p[1] - bg_rgb[1])**2 + (p[2] - bg_rgb[2])**2
            if dist > max_dist:
                max_dist = dist
                fg_rgb = p[:3]
                
        if max_dist < 400:
            brightness = (bg_rgb[0] * 299 + bg_rgb[1] * 587 + bg_rgb[2] * 114) / 1000
            if brightness < 128:
                fg_rgb = (255, 255, 255)
            else:
                fg_rgb = (0, 0, 0)
                
        bg_hex = f"#{bg_rgb[0]:02x}{bg_rgb[1]:02x}{bg_rgb[2]:02x}"
        fg_hex = f"#{fg_rgb[0]:02x}{fg_rgb[1]:02x}{fg_rgb[2]:02x}"
        
        if bg_hex == "#000001":
            bg_hex = "#000002"
            
        return bg_hex, fg_hex
    except Exception as e:
        print(f"Error in analyze_colors: {e}")
        return "#FFFFFF", "#000000"


# --- Glow Underline Palettes ---
# Каждый слой: (dy — смещение вниз, width — толщина линии, color — цвет, stipple — паттерн прозрачности)
PALETTE_EN_DARK = [   # 🔵 Английские слова — тёмный фон
    (1, 3.0, "#004C80", ""),   # Мягкое темное свечение-подложка
    (0, 1.5, "#00B2FF", ""),   # Четкое ядро приглушенного голубого цвета
]
PALETTE_EN_LIGHT = [  # 🔵 Английские слова — светлый фон
    (1, 3.0, "#8CEBFF", ""),
    (0, 1.5, "#0077D6", ""),
]
PALETTE_RU_DARK = [   # 🟣 Русские слова — тёмный фон
    (1, 3.0, "#3C2080", ""),   # Мягкое темно-фиолетовое свечение
    (0, 1.5, "#8E52FF", ""),   # Четкое ядро приглушенного фиолетового цвета
]
PALETTE_RU_LIGHT = [  # 🟣 Русские слова — светлый фон
    (1, 3.0, "#E0D8FF", ""),
    (0, 1.5, "#6A3ED6", ""),
]
# Hover — усиленные палитры (ярче и толще, без stipple)
PALETTE_EN_HOVER_DARK = [
    (2, 7.0, "#0059B3", ""),   # Широкая подложка глубокого синего цвета
    (1, 4.0, "#00D9FF", ""),   # Яркий голубой переход
    (0, 2.0, "#FFFFFF", ""),   # Белое ядро фокуса
]
PALETTE_EN_HOVER_LIGHT = [
    (2, 6.0, "#8CEBFF", ""),
    (1, 4.0, "#0088C8", ""),
    (0, 2.0, "#002B80", ""),
]
PALETTE_RU_HOVER_DARK = [
    (2, 7.0, "#5027A3", ""),   # Широкая подложка глубокого фиолетового цвета
    (1, 4.0, "#B880FF", ""),   # Яркий фиолетовый переход
    (0, 2.0, "#FFFFFF", ""),   # Белое ядро фокуса
]
PALETTE_RU_HOVER_LIGHT = [
    (2, 6.0, "#C7B5FF", ""),
    (1, 4.0, "#7D55E8", ""),
    (0, 2.0, "#2E1575", ""),
]

def _is_latin_word(text):
    """Возвращает True если слово содержит латинские буквы (вероятно, английское)."""
    import re
    latin = sum(1 for c in text if ('A' <= c <= 'Z') or ('a' <= c <= 'z'))
    total_alpha = latin + sum(1 for c in text if ('А' <= c <= 'я') or c in 'ёЁ')
    if total_alpha == 0:
        return False
    return latin / total_alpha > 0.5

def _get_bg_brightness(screenshot, bbox):
    """Определяем яркость фона под bbox."""
    if screenshot:
        bg_color, _ = analyze_colors(screenshot, bbox)
        try:
            bg_rgb = tuple(int(bg_color[i:i+2], 16) for i in (1, 3, 5))
            return (bg_rgb[0] * 299 + bg_rgb[1] * 587 + bg_rgb[2] * 114) / 1000
        except:
            pass
    return 128  # default: средняя яркость


class TranslationTooltip(tk.Toplevel):
    """A beautiful, dark-themed popup that displays translation of a sentence 
    right next to the cursor, automatically destroying itself on focus loss/leave,
    with custom translation editing capabilities.
    """
    def __init__(self, master, item, x, y):
        super().__init__(master)
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg="#181818")
        
        self.item = item
        text = item["text"]
        
        self.border_frame = ctk.CTkFrame(
            self, 
            fg_color="#181818", 
            border_width=1, 
            border_color="#007AFF", 
            corner_radius=6
        )
        self.border_frame.pack(fill="both", expand=True, padx=1, pady=1)
        
        # Заголовок-подсказка
        self.lbl_title = ctk.CTkLabel(
            self.border_frame,
            text="✍️ РЕДАКТИРОВАНИЕ ПЕРЕВОДА",
            font=ctk.CTkFont(family="Segoe UI", size=9, weight="bold"),
            text_color="#007AFF"
        )
        self.lbl_title.pack(anchor="w", padx=12, pady=(6, 2))
        
        # Текстовое поле для редактирования
        self.textbox = ctk.CTkTextbox(
            self.border_frame,
            font=ctk.CTkFont(family="Segoe UI", size=12),
            fg_color="#222222",
            text_color="#FFFFFF",
            border_width=1,
            border_color="#333333",
            corner_radius=4,
            height=70
        )
        self.textbox.pack(fill="x", padx=12, pady=(0, 4))
        self.textbox.insert("0.0", text)
        
        # Горизонтальный фрейм для кнопок
        self.btn_frame = ctk.CTkFrame(self.border_frame, fg_color="transparent")
        self.btn_frame.pack(fill="x", padx=12, pady=(4, 8))
        
        # Кнопка Сохранить
        self.btn_save = ctk.CTkButton(
            self.btn_frame,
            text="Сохранить 💾",
            font=ctk.CTkFont(family="Segoe UI", size=10, weight="bold"),
            height=20,
            width=90,
            fg_color="#34C759",
            hover_color="#28A745",
            text_color="#FFFFFF",
            command=self.save_translation
        )
        self.btn_save.pack(side="left", padx=(0, 4))
        
        # Кнопка Сбросить
        self.btn_reset = ctk.CTkButton(
            self.btn_frame,
            text="Сбросить ↩",
            font=ctk.CTkFont(family="Segoe UI", size=10),
            height=20,
            width=90,
            fg_color="#FF9500",
            hover_color="#E08500",
            text_color="#FFFFFF",
            command=self.reset_translation
        )
        self.btn_reset.pack(side="left", padx=4)

        # Кнопка Обновить
        self.btn_refresh = ctk.CTkButton(
            self.btn_frame,
            text="Обновить 🔄",
            font=ctk.CTkFont(family="Segoe UI", size=10),
            height=20,
            width=90,
            fg_color="#007AFF",
            hover_color="#0056B3",
            text_color="#FFFFFF",
            command=self.refresh_translation
        )
        self.btn_refresh.pack(side="left", padx=4)

        # Кнопка Закрыть
        self.btn_close = ctk.CTkButton(
            self.btn_frame,
            text="Закрыть ✕",
            font=ctk.CTkFont(family="Segoe UI", size=10),
            height=20,
            width=80,
            fg_color="#555555",
            hover_color="#333333",
            text_color="#FFFFFF",
            command=self.safe_destroy
        )
        self.btn_close.pack(side="right", padx=(4, 0))
        
        # Вычисляем размеры тултипа
        self.update_idletasks()
        w = 430  # Чуть увеличим ширину для свободного размещения кнопок в ряд
        h = max(170, self.border_frame.winfo_reqheight() + 12)  # Адаптивная высота с учетом DPI
        
        # Positioning
        self.geometry(f"{w}x{h}+{x + 15}+{y + 10}")
        
        self.bind("<Escape>", lambda e: self.safe_destroy())
        self.textbox.bind("<FocusIn>", self.on_text_focus_in)
        
        # Биндим автоматическое закрытие при потере фокуса всем окном.
        # Событие Leave (уход мыши) больше не биндится во избежание закрытия при наведении на кнопки.
        self.bind("<FocusOut>", self.on_focus_out)
        
        # Таймер автоматического закрытия (на случай, если пользователь забыл закрыть тултип)
        self._auto_close_id = self.after(15000, self.safe_destroy)
        
        # Фокусируемся на окне при старте
        self.focus_force()

    def on_focus_out(self, event):
        # Небольшая задержка, чтобы Tkinter успел обновить сфокусированный виджет
        self.after(100, self._check_focus_and_destroy)

    def _check_focus_and_destroy(self):
        try:
            if not self.winfo_exists():
                return
            focused = self.focus_get()
            if focused is not None:
                # Если фокус перешел на дочерний элемент этого же окна, не уничтожаем
                if str(focused).startswith(str(self)):
                    return
            self.safe_destroy()
        except:
            pass

    def on_text_focus_in(self, event):
        # Отключаем автозакрытие по таймеру, так как пользователь начал редактирование
        if hasattr(self, "_auto_close_id"):
            try:
                self.after_cancel(self._auto_close_id)
            except:
                pass

    def save_translation(self):
        custom_text = self.textbox.get("1.0", "end-1c").strip()
        orig_text = self.item["original_text"]
        if hasattr(self.master, "save_custom_sentence_translation"):
            self.master.save_custom_sentence_translation(orig_text, custom_text)
        self.safe_destroy()
        
    def reset_translation(self):
        orig_text = self.item["original_text"]
        if hasattr(self.master, "reset_custom_sentence_translation"):
            self.master.reset_custom_sentence_translation(orig_text)
        self.safe_destroy()

    def refresh_translation(self):
        orig_text = self.item["original_text"]
        if hasattr(self.master, "force_refresh_sentence"):
            self.master.force_refresh_sentence(orig_text)
        self.safe_destroy()

    def safe_destroy(self):
        try:
            self.destroy()
        except:
            pass


class AreaSelector(tk.Toplevel):
    def __init__(self, master, on_selected):
        tcl_master = master if isinstance(master, (tk.Misc, ctk.CTk, ctk.CTkToplevel)) else None
        super().__init__(tcl_master)
        self.master = master
        self.on_selected = on_selected
        
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg="#000000")
        
        try:
            user32 = ctypes.windll.user32
            self.vx = user32.GetSystemMetrics(76)
            self.vy = user32.GetSystemMetrics(77)
            self.vw = user32.GetSystemMetrics(78)
            self.vh = user32.GetSystemMetrics(79)
            if self.vw <= 0 or self.vh <= 0:
                raise Exception()
        except:
            self.vx = 0
            self.vy = 0
            self.vw = self.winfo_screenwidth()
            self.vh = self.winfo_screenheight()
            
        self.geometry(f"{self.vw}x{self.vh}+{self.vx}+{self.vy}")
        
        self.original_screenshot = ImageGrab.grab(all_screens=True)
        
        enhancer = ImageEnhance.Brightness(self.original_screenshot)
        self.dark_screenshot = enhancer.enhance(0.4)
        
        self.photo_dark = ImageTk.PhotoImage(self.dark_screenshot)
        
        self.canvas = tk.Canvas(self, cursor="cross", highlightthickness=0, bg="#000000")
        self.canvas.pack(fill="both", expand=True)
        self.canvas.create_image(0, 0, anchor="nw", image=self.photo_dark)
        
        self.start_x = None
        self.start_y = None
        self.rect_border_id = None
        self.rect_image_id = None
        self.active_photo_image = None
        
        self.canvas.bind("<ButtonPress-1>", self.on_press)
        self.canvas.bind("<B1-Motion>", self.on_drag)
        self.canvas.bind("<ButtonRelease-1>", self.on_release)
        self.bind("<Escape>", lambda e: self.cancel())
        
        self.lift()
        self.focus_force()

    def on_press(self, event):
        self.start_x = event.x
        self.start_y = event.y
        self.rect_border_id = self.canvas.create_rectangle(
            self.start_x, self.start_y, self.start_x, self.start_y,
            outline="#007AFF", width=2
        )
        self.rect_image_id = self.canvas.create_image(
            self.start_x, self.start_y, anchor="nw"
        )

    def on_drag(self, event):
        if self.start_x is None or self.start_y is None:
            return
        cur_x, cur_y = event.x, event.y
        x1 = min(self.start_x, cur_x)
        y1 = min(self.start_y, cur_y)
        x2 = max(self.start_x, cur_x)
        y2 = max(self.start_y, cur_y)
        
        if x2 - x1 < 2 or y2 - y1 < 2:
            return
            
        self.canvas.coords(self.rect_border_id, x1, y1, x2, y2)
        
        cropped = self.original_screenshot.crop((x1, y1, x2, y2))
        self.active_photo_image = ImageTk.PhotoImage(cropped)
        
        self.canvas.coords(self.rect_image_id, x1, y1)
        self.canvas.itemconfig(self.rect_image_id, image=self.active_photo_image)

    def on_release(self, event):
        if self.start_x is None or self.start_y is None:
            self.destroy()
            self.on_selected(None, None, None, None, None)
            return
        cur_x, cur_y = event.x, event.y
        x1 = min(self.start_x, cur_x)
        y1 = min(self.start_y, cur_y)
        x2 = max(self.start_x, cur_x)
        y2 = max(self.start_y, cur_y)
        
        w = x2 - x1
        h = y2 - y1
        
        self.destroy()
        
        if w > 10 and h > 10:
            abs_x = x1 + self.vx
            abs_y = y1 + self.vy
            cropped_image = self.original_screenshot.crop((x1, y1, x2, y2))
            self.on_selected(abs_x, abs_y, w, h, cropped_image)
        else:
            self.on_selected(None, None, None, None, None)

    def cancel(self):
        self.destroy()
        self.on_selected(None, None, None, None, None)


class WordTooltip(tk.Toplevel):
    """Компактный тултип для перевода одного слова (двойной клик)."""
    def __init__(self, master, word_text, x, y):
        super().__init__(master)
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg="#1a1a2e")
        
        self.word_text = word_text
        self.master_ref = master
        
        self.border_frame = ctk.CTkFrame(
            self,
            fg_color="#1a1a2e",
            border_width=1,
            border_color="#00D7FF",
            corner_radius=8
        )
        self.border_frame.pack(fill="both", expand=True, padx=1, pady=1)
        
        # Оригинальное слово
        self.lbl_word = ctk.CTkLabel(
            self.border_frame,
            text=f"📖  {word_text}",
            font=ctk.CTkFont(family="Segoe UI", size=13, weight="bold"),
            text_color="#00D7FF"
        )
        self.lbl_word.pack(anchor="w", padx=12, pady=(8, 2))
        
        # Перевод (сначала «загрузка...»)
        self.lbl_translation = ctk.CTkLabel(
            self.border_frame,
            text="⏳ ...",
            font=ctk.CTkFont(family="Segoe UI", size=12),
            text_color="#FFFFFF",
            wraplength=250
        )
        self.lbl_translation.pack(anchor="w", padx=12, pady=(0, 4))
        
        # Кнопки
        self.btn_frame = ctk.CTkFrame(self.border_frame, fg_color="transparent")
        self.btn_frame.pack(fill="x", padx=12, pady=(2, 8))
        
        self.btn_speak = ctk.CTkButton(
            self.btn_frame,
            text="🔊",
            font=ctk.CTkFont(size=12),
            width=32, height=22,
            fg_color="#007AFF",
            hover_color="#0056b3",
            command=self._speak_word
        )
        self.btn_speak.pack(side="left", padx=(0, 4))
        
        self.btn_close = ctk.CTkButton(
            self.btn_frame,
            text="✕",
            font=ctk.CTkFont(size=11, weight="bold"),
            width=32, height=22,
            fg_color="transparent",
            hover_color="#c0392b",
            text_color="#888",
            command=self.destroy
        )
        self.btn_close.pack(side="right")
        
        # Позиционирование
        self.update_idletasks()
        w = max(self.winfo_reqwidth(), 200)
        h = self.winfo_reqheight()
        screen_w = self.winfo_screenwidth()
        screen_h = self.winfo_screenheight()
        
        pos_x = min(x + 10, screen_w - w - 10)
        pos_y = min(y + 10, screen_h - h - 10)
        self.geometry(f"{w}x{h}+{pos_x}+{pos_y}")
        
        # Закрытие по клику вне тултипа
        self.bind("<FocusOut>", lambda e: self.destroy())
        self.after(100, lambda: self.focus_force())
        
        # Запускаем перевод в фоне
        self.after(10, self._translate_word)
    
    def _translate_word(self):
        """Переводит слово через translation_engine."""
        import threading
        def do_translate():
            try:
                import translation_engine
                engine_type = getattr(self.master_ref.master, "translation_engine", "google_cache")
                engine = translation_engine.get_engine(engine_type)
                result = engine.translate_batch([self.word_text], "ru")
                translated = result[0] if result else self.word_text
                # Обновляем UI из главного потока
                self.after(0, lambda: self._set_translation(translated))
            except Exception as e:
                self.after(0, lambda: self._set_translation(f"⚠ {e}"))
        
        threading.Thread(target=do_translate, daemon=True).start()
    
    def _set_translation(self, text):
        """Устанавливает перевод в лейбл."""
        if self.winfo_exists():
            self.lbl_translation.configure(text=f"→  {text}")
            self.update_idletasks()
            # Обновляем размер
            w = max(self.winfo_reqwidth(), 200)
            h = self.winfo_reqheight()
            self.geometry(f"{w}x{h}")
    
    def _speak_word(self):
        """Озвучивает слово через TTS."""
        try:
            master = self.master_ref  # ScreenTranslatorFrame
            if hasattr(master, 'master') and hasattr(master.master, 'update_text_and_play'):
                master.master.update_text_and_play(self.word_text)
            elif hasattr(master, 'update_text_and_play'):
                master.update_text_and_play(self.word_text)
        except Exception as e:
            print(f"WordTooltip TTS error: {e}")


class ScreenTranslatorFrame(tk.Toplevel):
    def get_scale_factor(self):
        try:
            dpi = self.winfo_fpixels('1i')
            scale = dpi / 96.0
            if 0.5 <= scale <= 4.0:
                return scale
        except Exception as e:
            print(f"Error getting scale factor: {e}")
        return 1.0

    def __init__(self, master, translate_to="ru", target_x=None, target_y=None):
        tcl_master = master if isinstance(master, (tk.Misc, ctk.CTk, ctk.CTkToplevel)) else None
        super().__init__(tcl_master)
        self.master = master
        self.translate_to = translate_to
        self.target_x = target_x
        self.target_y = target_y
        
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.attributes("-transparentcolor", "#000001")
        self.configure(bg="#000001")
        
        self.min_width = 150
        self.min_height = 100
        self.border_width = 5
        
        # State
        self.click_lock_active = False # Режим интерактива/блокировки кликов
        self.show_highlight = True # Показывать ли подсветку вообще
        self.show_word_lines = True
        self.show_flow_threads = True
        self.hovered_sentence = None
        self.last_translated_data = []
        self.is_translating = False
        self.need_update_translation = False
        self.active_tooltip = None
        self.last_hovered_idx = None
        self.last_hovered_word = None  # (block_idx, word_idx)
        self.canvas_word_items = {}    # (block_idx, word_idx) → [canvas item IDs]
        self._click_after_id = None    # debounce для одинарного клика
        
        # Auto scan (left for backwards compatibility)
        self.auto_scan = False
        self.last_screen_hash = None
        self.stabilize_counter = 0
        self.screen_changed = False
        
        # 4 Borders for resizing
        self.left_border = tk.Frame(self, bg="#007AFF", cursor="size_we")
        self.left_border.place(x=0, y=self.border_width, width=self.border_width, relheight=1.0, height=-2*self.border_width)
        
        self.right_border = tk.Frame(self, bg="#007AFF", cursor="size_we")
        self.right_border.place(relx=1.0, x=-self.border_width, y=self.border_width, width=self.border_width, relheight=1.0, height=-2*self.border_width)
        
        self.top_border = tk.Frame(self, bg="#007AFF", cursor="size_ns")
        self.top_border.place(x=self.border_width, y=0, relwidth=1.0, width=-2*self.border_width, height=self.border_width)
        
        self.bottom_border = tk.Frame(self, bg="#007AFF", cursor="size_ns")
        self.bottom_border.place(x=self.border_width, rely=1.0, y=-self.border_width, relwidth=1.0, width=-2*self.border_width, height=self.border_width)
        
        # 4 Corners
        self.top_left_corner = tk.Frame(self, bg="#007AFF", cursor="size_nw_se")
        self.top_left_corner.place(x=0, y=0, width=self.border_width, height=self.border_width)
        
        self.top_right_corner = tk.Frame(self, bg="#007AFF", cursor="size_ne_sw")
        self.top_right_corner.place(relx=1.0, x=-self.border_width, y=0, width=self.border_width, height=self.border_width)
        
        self.bottom_left_corner = tk.Frame(self, bg="#007AFF", cursor="size_ne_sw")
        self.bottom_left_corner.place(x=0, rely=1.0, y=-self.border_width, width=self.border_width, height=self.border_width)
        
        self.bottom_right_corner = tk.Frame(self, bg="#007AFF", cursor="size_nw_se")
        self.bottom_right_corner.place(relx=1.0, x=-self.border_width, rely=1.0, y=-self.border_width, width=self.border_width, height=self.border_width)
        
        # Container
        self.center_container = tk.Frame(self, bg="#000001")
        self.center_container.place(x=self.border_width, y=self.border_width, relwidth=1.0, relheight=1.0, width=-2*self.border_width, height=-2*self.border_width)
        
        # Toolbar
        self.toolbar = ctk.CTkFrame(self.center_container, height=28, fg_color="#181818", corner_radius=0)
        self.toolbar.pack(side="top", fill="x")
        self.toolbar.pack_propagate(False)
        
        # Canvas
        self.canvas = tk.Canvas(self.center_container, bg="#000001", highlightthickness=0, borderwidth=0)
        self.canvas.pack(fill="both", expand=True)
        
        self.setup_toolbar()
        self.setup_drag_and_resize()
        
        # Shortcuts
        self.bind("<Escape>", lambda e: self.destroy())
        self.bind("<space>", lambda e: self.toggle_click_lock())
        
        self.bind("<ButtonRelease-1>", self.on_global_release)
        self.canvas.bind("<ButtonRelease-1>", self.on_global_release)
        
        # Canvas mouse event bindings
        self.canvas.bind("<Button-1>", self.on_canvas_click)
        self.canvas.bind("<Double-Button-1>", self.on_canvas_double_click)
        self.canvas.bind("<Button-3>", self.on_canvas_right_click)
        self.canvas.bind("<Motion>", self.on_canvas_motion)
        
        self.after(800, self.check_screen_changes)
        self.after(50, self.align_canvas)

    def align_canvas(self):
        if getattr(self, "target_x", None) is None or getattr(self, "target_y", None) is None:
            return
        
        self.update_idletasks()
        self.update()
        
        real_x, real_y = get_canvas_physical_pos(self.canvas)
        dx_phys = self.target_x - real_x
        dy_phys = self.target_y - real_y
        
        if abs(dx_phys) > 1 or abs(dy_phys) > 1:
            geom = self.geometry().split('+')
            try:
                cur_x = int(geom[1])
                cur_y = int(geom[2])
            except:
                cur_x = self.winfo_x()
                cur_y = self.winfo_y()
            
            dx = dx_phys
            dy = dy_phys
            
            self.geometry(f"+{int(cur_x + dx)}+{int(cur_y + dy)}")
            self.update()
            log_debug(f"align_canvas: aligned by dx={dx}, dy={dy}. Target: {self.target_x},{self.target_y}.")

    def setup_toolbar(self):
        self.lbl_title = ctk.CTkLabel(self.toolbar, text=" ⛶ SINC READ & TRANSLATE", font=ctk.CTkFont(size=10, weight="bold"), text_color="#007AFF")
        self.lbl_title.pack(side="left", padx=5)
        
        self.toolbar.bind("<ButtonPress-1>", self.start_drag)
        self.toolbar.bind("<B1-Motion>", self.do_drag)
        self.toolbar.bind("<ButtonRelease-1>", self.on_global_release)
        self.lbl_title.bind("<ButtonPress-1>", self.start_drag)
        self.lbl_title.bind("<B1-Motion>", self.do_drag)
        self.lbl_title.bind("<ButtonRelease-1>", self.on_global_release)
        
        self.btn_close = ctk.CTkButton(self.toolbar, text="✕", width=24, height=22, corner_radius=4,
                                       fg_color="transparent", hover_color="#c0392b", text_color="#aaa", font=ctk.CTkFont(size=12, weight="bold"),
                                       command=self.destroy)
        self.btn_close.pack(side="right", padx=3, pady=3)
        
        self.btn_speak = ctk.CTkButton(self.toolbar, text="🔊", width=24, height=22, corner_radius=4,
                                       fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                       command=self.speak_translated_text)
        self.btn_speak.pack(side="right", padx=3, pady=3)
        self.btn_speak.bind("<Enter>", lambda e: self.lbl_title.configure(text="Озвучить весь перевод (🔊)"))
        self.btn_speak.bind("<Leave>", lambda e: self.lbl_title.configure(text=" ⛶ SINC READ & TRANSLATE"))

        # Click lock toggle button (Lock / Interactive Mode)
        self.btn_lock = ctk.CTkButton(self.toolbar, text="🔊/A", width=42, height=22, corner_radius=4,
                                      fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=11, weight="bold"),
                                      command=self.toggle_click_lock)
        self.btn_lock.pack(side="right", padx=3, pady=3)
        self.btn_lock.bind("<Enter>", lambda e: self.lbl_title.configure(text="Режим чтения: клик по фразам (Пробел)"))
        self.btn_lock.bind("<Leave>", lambda e: self.lbl_title.configure(text=" ⛶ SINC READ & TRANSLATE"))
        
        self.btn_highlight = ctk.CTkButton(self.toolbar, text="✨", width=24, height=22, corner_radius=4,
                                           fg_color="#007AFF", text_color="#ffffff", font=ctk.CTkFont(size=12),
                                           command=self.toggle_highlight)
        self.btn_highlight.pack(side="right", padx=3, pady=3)
        self.btn_highlight.bind("<Enter>", lambda e: self.lbl_title.configure(text="Показать/скрыть рамки распознавания (✨)"))
        self.btn_highlight.bind("<Leave>", lambda e: self.lbl_title.configure(text=" ⛶ SINC READ & TRANSLATE"))

        self.btn_words = ctk.CTkButton(self.toolbar, text="Aa", width=24, height=22, corner_radius=4,
                                       fg_color="#007AFF", text_color="#ffffff", font=ctk.CTkFont(size=11, weight="bold"),
                                       command=self.toggle_word_lines)
        self.btn_words.pack(side="right", padx=3, pady=3)
        self.btn_words.bind("<Enter>", lambda e: self.lbl_title.configure(text="Показать/скрыть подчеркивание слов (Aa)"))
        self.btn_words.bind("<Leave>", lambda e: self.lbl_title.configure(text=" ⛶ SINC READ & TRANSLATE"))

        self.btn_flow = ctk.CTkButton(self.toolbar, text="〰", width=24, height=22, corner_radius=4,
                                      fg_color="#007AFF", text_color="#ffffff", font=ctk.CTkFont(size=12),
                                      command=self.toggle_flow_threads)
        self.btn_flow.pack(side="right", padx=3, pady=3)
        self.btn_flow.bind("<Enter>", lambda e: self.lbl_title.configure(text="Показать/скрыть ниточки предложений (〰)"))
        self.btn_flow.bind("<Leave>", lambda e: self.lbl_title.configure(text=" ⛶ SINC READ & TRANSLATE"))
        
        self.btn_auto = ctk.CTkButton(self.toolbar, text="⚡", width=24, height=22, corner_radius=4,
                                      fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                      command=self.toggle_auto_scan)
        self.btn_auto.pack(side="right", padx=3, pady=3)
        self.btn_auto.bind("<Enter>", lambda e: self.lbl_title.configure(text="Автосканирование изменений (⚡)"))
        self.btn_auto.bind("<Leave>", lambda e: self.lbl_title.configure(text=" ⛶ SINC READ & TRANSLATE"))

        self.btn_help = ctk.CTkButton(self.toolbar, text="❓", width=24, height=22, corner_radius=4,
                                      fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                      command=self.show_help_overlay)
        self.btn_help.pack(side="right", padx=3, pady=3)
        self.btn_help.bind("<Enter>", lambda e: self.lbl_title.configure(text="Инструкция и легенда переводчика (❓)"))
        self.btn_help.bind("<Leave>", lambda e: self.lbl_title.configure(text=" ⛶ SINC READ & TRANSLATE"))

    def toggle_click_lock(self):
        self.click_lock_active = not self.click_lock_active
        if self.click_lock_active:
            self.attributes("-transparentcolor", "")
            self.attributes("-alpha", 0.35)
            self.canvas.configure(bg="#0c0c0c")
            self.btn_lock.configure(fg_color="#007AFF", text_color="#ffffff")
            self.lbl_title.configure(text=" 🔒 РЕЖИМ ЧТЕНИЯ АКТИВЕН", text_color="#34C759")
        else:
            self.attributes("-alpha", 1.0)
            self.canvas.configure(bg="#000001")
            self.attributes("-transparentcolor", "#000001")
            self.btn_lock.configure(fg_color="transparent", text_color="#aaa")
            self.lbl_title.configure(text=" ⛶ SINC READ & TRANSLATE", text_color="#007AFF")
            
            # Reset hover states
            self.last_hovered_word = None
            self.last_hovered_idx = None
            self.hovered_sentence = None
            self.canvas.configure(cursor="")
            
        self.draw_translations()

    def toggle_highlight(self):
        self.show_highlight = not self.show_highlight
        if self.show_highlight:
            self.btn_highlight.configure(fg_color="#007AFF", text_color="#ffffff")
        else:
            self.btn_highlight.configure(fg_color="transparent", text_color="#aaa")
        self.draw_translations()

    def toggle_word_lines(self):
        self.show_word_lines = not self.show_word_lines
        if self.show_word_lines:
            self.btn_words.configure(fg_color="#007AFF", text_color="#ffffff")
        else:
            self.btn_words.configure(fg_color="transparent", text_color="#aaa")
        self.draw_translations()

    def toggle_flow_threads(self):
        self.show_flow_threads = not self.show_flow_threads
        if self.show_flow_threads:
            self.btn_flow.configure(fg_color="#007AFF", text_color="#ffffff")
        else:
            self.btn_flow.configure(fg_color="transparent", text_color="#aaa")
        self.draw_translations()

    def setup_drag_and_resize(self):
        self.left_border.bind("<ButtonPress-1>", self.start_resize)
        self.left_border.bind("<B1-Motion>", self.do_resize_left)
        self.left_border.bind("<ButtonRelease-1>", self.on_global_release)
        
        self.right_border.bind("<ButtonPress-1>", self.start_resize)
        self.right_border.bind("<B1-Motion>", self.do_resize_right)
        self.right_border.bind("<ButtonRelease-1>", self.on_global_release)
        
        self.top_border.bind("<ButtonPress-1>", self.start_resize)
        self.top_border.bind("<B1-Motion>", self.do_resize_top)
        self.top_border.bind("<ButtonRelease-1>", self.on_global_release)
        
        self.bottom_border.bind("<ButtonPress-1>", self.start_resize)
        self.bottom_border.bind("<B1-Motion>", self.do_resize_bottom)
        self.bottom_border.bind("<ButtonRelease-1>", self.on_global_release)
        
        # Corners
        self.top_left_corner.bind("<ButtonPress-1>", self.start_resize)
        self.top_left_corner.bind("<B1-Motion>", self.do_resize_top_left)
        self.top_left_corner.bind("<ButtonRelease-1>", self.on_global_release)
        
        self.top_right_corner.bind("<ButtonPress-1>", self.start_resize)
        self.top_right_corner.bind("<B1-Motion>", self.do_resize_top_right)
        self.top_right_corner.bind("<ButtonRelease-1>", self.on_global_release)
        
        self.bottom_left_corner.bind("<ButtonPress-1>", self.start_resize)
        self.bottom_left_corner.bind("<B1-Motion>", self.do_resize_bottom_left)
        self.bottom_left_corner.bind("<ButtonRelease-1>", self.on_global_release)
        
        self.bottom_right_corner.bind("<ButtonPress-1>", self.start_resize)
        self.bottom_right_corner.bind("<B1-Motion>", self.do_resize_bottom_right)
        self.bottom_right_corner.bind("<ButtonRelease-1>", self.on_global_release)

    def toggle_auto_scan(self):
        self.auto_scan = not self.auto_scan
        if self.auto_scan:
            self.btn_auto.configure(fg_color="#007AFF", text_color="#ffffff")
            self.translate_area()
        else:
            self.btn_auto.configure(fg_color="transparent", text_color="#aaa")

    def check_screen_changes(self):
        if not self.winfo_exists():
            return
            
        if self.auto_scan and not self.is_translating and not getattr(self, "need_update_translation", False):
            try:
                self.update()
                canvas_x, canvas_y = get_canvas_physical_pos(self.canvas)
                canvas_w = self.canvas.winfo_width()
                canvas_h = self.canvas.winfo_height()
                
                if canvas_w > 10 and canvas_h > 10:
                    vx, vy = get_virtual_screen_origin()
                    full_screenshot = ImageGrab.grab(all_screens=True)
                    
                    crop_x1 = canvas_x - vx
                    crop_y1 = canvas_y - vy
                    crop_x2 = crop_x1 + canvas_w
                    crop_y2 = crop_y1 + canvas_h
                    
                    current_img = full_screenshot.crop((crop_x1, crop_y1, crop_x2, crop_y2))
                    small_img = current_img.resize((32, 32)).convert("L")
                    pixels = list(small_img.getdata())
                    
                    if self.last_screen_hash is not None:
                        diff = sum(abs(p1 - p2) for p1, p2 in zip(pixels, self.last_screen_hash)) / len(pixels)
                        if diff > 3.0:
                            self.screen_changed = True
                            self.stabilize_counter = 0
                            self.last_screen_hash = pixels
                        else:
                            if getattr(self, "screen_changed", False):
                                self.stabilize_counter += 1
                                if self.stabilize_counter >= 1:
                                    self.screen_changed = False
                                    self.stabilize_counter = 0
                                    self.translate_area()
                    else:
                        self.last_screen_hash = pixels
                        self.screen_changed = False
                        self.stabilize_counter = 0
            except Exception as e:
                print(f"Error checking screen changes: {e}")
                
        self.after(800, self.check_screen_changes)

    def on_global_release(self, event):
        if getattr(self, "need_update_translation", False):
            self.need_update_translation = False
            self.translate_area()

    def start_drag(self, event):
        self.drag_start_x = event.x_root
        self.drag_start_y = event.y_root
        self.win_start_x = self.winfo_rootx()
        self.win_start_y = self.winfo_rooty()

    def do_drag(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.drag_start_x
        dy = event.y_root - self.drag_start_y
        new_x = self.win_start_x + dx
        new_y = max(0, self.win_start_y + dy)
        self.geometry(f"+{new_x}+{new_y}")

    def start_resize(self, event):
        self.resize_start_x = event.x_root
        self.resize_start_y = event.y_root
        self.resize_start_w = self.winfo_width()
        self.resize_start_h = self.winfo_height()
        self.resize_win_x = self.winfo_rootx()
        self.resize_win_y = self.winfo_rooty()

    def do_resize_right(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.resize_start_x
        new_w = max(self.min_width, self.resize_start_w + dx)
        self.geometry(f"{new_w}x{self.resize_start_h}+{self.resize_win_x}+{self.resize_win_y}")

    def do_resize_bottom(self, event):
        self.need_update_translation = True
        dy = event.y_root - self.resize_start_y
        new_h = max(self.min_height, self.resize_start_h + dy)
        self.geometry(f"{self.resize_start_w}x{new_h}+{self.resize_win_x}+{self.resize_win_y}")

    def do_resize_left(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.resize_start_x
        new_w = max(self.min_width, self.resize_start_w - dx)
        if new_w > self.min_width:
            new_x = self.resize_win_x + dx
        else:
            new_x = self.resize_win_x + (self.resize_start_w - self.min_width)
        self.geometry(f"{new_w}x{self.resize_start_h}+{new_x}+{self.resize_win_y}")

    def do_resize_top(self, event):
        self.need_update_translation = True
        dy = event.y_root - self.resize_start_y
        new_y = max(0, self.resize_win_y + dy)
        actual_dy = new_y - self.resize_win_y
        new_h = max(self.min_height, self.resize_start_h - actual_dy)
        self.geometry(f"{self.resize_start_w}x{new_h}+{self.resize_win_x}+{new_y}")

    def do_resize_top_left(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.resize_start_x
        dy = event.y_root - self.resize_start_y
        new_w = max(self.min_width, self.resize_start_w - dx)
        if new_w > self.min_width:
            new_x = self.resize_win_x + dx
        else:
            new_x = self.resize_win_x + (self.resize_start_w - self.min_width)
            
        requested_y = self.resize_win_y + dy
        new_y = max(0, requested_y)
        actual_dy = new_y - self.resize_win_y
        new_h = max(self.min_height, self.resize_start_h - actual_dy)
        self.geometry(f"{new_w}x{new_h}+{new_x}+{new_y}")

    def do_resize_top_right(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.resize_start_x
        dy = event.y_root - self.resize_start_y
        new_w = max(self.min_width, self.resize_start_w + dx)
        
        requested_y = self.resize_win_y + dy
        new_y = max(0, requested_y)
        actual_dy = new_y - self.resize_win_y
        new_h = max(self.min_height, self.resize_start_h - actual_dy)
        self.geometry(f"{new_w}x{new_h}+{self.resize_win_x}+{new_y}")

    def do_resize_bottom_left(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.resize_start_x
        dy = event.y_root - self.resize_start_y
        new_w = max(self.min_width, self.resize_start_w - dx)
        new_h = max(self.min_height, self.resize_start_h + dy)
        if new_w > self.min_width:
            new_x = self.resize_win_x + dx
        else:
            new_x = self.resize_win_x + (self.resize_start_w - self.min_width)
        self.geometry(f"{new_w}x{new_h}+{new_x}+{self.resize_win_y}")

    def do_resize_bottom_right(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.resize_start_x
        dy = event.y_root - self.resize_start_y
        new_w = max(self.min_width, self.resize_start_w + dx)
        new_h = max(self.min_height, self.resize_start_h + dy)
        self.geometry(f"{new_w}x{new_h}+{self.resize_win_x}+{self.resize_win_y}")

    def translate_precropped(self, cropped_image):
        if self.is_translating:
            return
        self.is_translating = True
        self.btn_speak.configure(text="⌛")
        self.canvas.delete("all")
        
        self.update_idletasks()
        self.update()
        
        canvas_w = max(self.canvas.winfo_width(), self.winfo_width() - 2 * self.border_width)
        canvas_h = max(self.canvas.winfo_height(), self.winfo_height() - 2 * self.border_width - 28)
        self.canvas.create_text(
            canvas_w / 2, 
            canvas_h / 2, 
            text="⏳ Распознавание...", 
            font=("Segoe UI", 16, "bold"), 
            fill="#007AFF", 
            justify="center",
            tags="loading"
        )
        self.current_screenshot = cropped_image
        
        log_debug(f"translate_precropped: starting thread, image size={cropped_image.size}")
        threading.Thread(target=self._run_precropped_translation_thread, args=(cropped_image,), daemon=True).start()

    def _run_precropped_translation_thread(self, cropped_image):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            engine_type = getattr(self.master, "translation_engine", "google_cache")
            ollama_model = getattr(self.master, "ollama_model", "gemma2")
            ollama_url = getattr(self.master, "ollama_url", "http://localhost:11434")
            msty_model = getattr(self.master, "msty_model", "local-model")
            msty_url = getattr(self.master, "msty_url", "http://localhost:8080")
            
            data = loop.run_until_complete(
                ocr_translation.perform_ocr_and_translation(
                    cropped_image, 
                    self.translate_to,
                    engine_type=engine_type,
                    ollama_model=ollama_model,
                    ollama_url=ollama_url,
                    msty_model=msty_model,
                    msty_url=msty_url
                )
            )
            self.after(0, lambda: self.finish_translation(data))
        except Exception as e:
            print(f"Error during OCR process: {e}")
            self.after(0, lambda: self.finish_translation(None))
        finally:
            loop.close()

    def translate_area(self):
        if self.is_translating:
            return
        
        self.is_translating = True
        self.btn_speak.configure(text="⌛")
        
        self.canvas.delete("all")
        self.canvas_word_items.clear()
        
        self.update()
        canvas_x, canvas_y = get_canvas_physical_pos(self.canvas)
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        
        log_debug(f"translate_area: physical pos = ({canvas_x}, {canvas_y}), size = {canvas_w}x{canvas_h}")
        
        self.withdraw()
        self.update()
        time.sleep(0.18)
        
        screenshot = None
        try:
            if canvas_w > 10 and canvas_h > 10:
                vx, vy = get_virtual_screen_origin()
                full_screenshot = ImageGrab.grab(all_screens=True)
                
                crop_x1 = canvas_x - vx
                crop_y1 = canvas_y - vy
                crop_x2 = crop_x1 + canvas_w
                crop_y2 = crop_y1 + canvas_h
                
                screenshot = full_screenshot.crop((crop_x1, crop_y1, crop_x2, crop_y2))
        except Exception as e:
            log_debug(f"Error capturing screen in translate_area: {e}")
            
        self.deiconify()
        self.attributes("-topmost", True)
        self.focus_force()
        self.update()
        
        if screenshot is None:
            self.is_translating = False
            self.btn_speak.configure(text="🔊")
            return
            
        self.current_screenshot = screenshot
        
        canvas_w = max(self.canvas.winfo_width(), self.winfo_width() - 2 * self.border_width)
        canvas_h = max(self.canvas.winfo_height(), self.winfo_height() - 2 * self.border_width - 28)
        self.canvas.create_text(
            canvas_w / 2, 
            canvas_h / 2, 
            text="⏳ Распознавание...", 
            font=("Segoe UI", 16, "bold"), 
            fill="#007AFF", 
            justify="center",
            tags="loading"
        )
        self.update()
        
        threading.Thread(target=self._run_translation_thread, args=(screenshot,), daemon=True).start()

    def _run_translation_thread(self, screenshot):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        error_msg = None
        data = None
        try:
            engine_type = getattr(self.master, "translation_engine", "google_cache")
            ollama_model = getattr(self.master, "ollama_model", "gemma2")
            ollama_url = getattr(self.master, "ollama_url", "http://localhost:11434")
            msty_model = getattr(self.master, "msty_model", "local-model")
            msty_url = getattr(self.master, "msty_url", "http://localhost:8080")
            
            data = loop.run_until_complete(
                ocr_translation.perform_ocr_and_translation(
                    screenshot, 
                    self.translate_to,
                    engine_type=engine_type,
                    ollama_model=ollama_model,
                    ollama_url=ollama_url,
                    msty_model=msty_model,
                    msty_url=msty_url
                )
            )
        except Exception as e:
            print(f"Error during OCR process: {e}")
            raw_err = str(e)
            if "Локальный переводчик не установлен" in raw_err:
                error_msg = "Локальный переводчик не установлен.\nСкачайте модель в настройках."
            elif "Argos Translate" in raw_err:
                error_msg = "Ошибка движка Argos.\nПожалуйста, установите модель в настройках."
            else:
                error_msg = f"Ошибка: {raw_err[:60]}"
            data = None
        finally:
            loop.close()
        self.after(0, lambda: self.finish_translation(data, error_msg))

    def finish_translation(self, data, error_msg=None):
        log_debug(f"finish_translation: received data: {len(data) if data else 0} items, error: {error_msg}")
        self.is_translating = False
        self.btn_speak.configure(text="🔊")
        self.canvas.delete("loading")
        
        if data is not None:
            self.last_translated_data = data
            self.draw_translations()
        else:
            self.canvas.delete("all")
            canvas_w = max(self.canvas.winfo_width(), self.winfo_width() - 2 * self.border_width)
            canvas_h = max(self.canvas.winfo_height(), self.winfo_height() - 2 * self.border_width - 28)
            msg = error_msg if error_msg else "Ошибка распознавания"
            self.canvas.create_text(
                canvas_w / 2, 
                canvas_h / 2, 
                text=f"❌ {msg}", 
                font=("Segoe UI", 12, "bold"), 
                fill="#FF3B30", 
                justify="center",
                width=canvas_w - 40,
                tags="error"
            )

    def prepare_sentence_data(self):
        if not self.last_translated_data:
            return
        for block_idx, item in enumerate(self.last_translated_data):
            words = item.get("words", [])
            if not words:
                continue
            
            # 1. Объединяем слова в единый текст с сохранением границ слов
            full_text = ""
            word_spans = []
            for w in words:
                start = len(full_text)
                full_text += w["text"]
                end = len(full_text)
                word_spans.append((start, end))
                full_text += " " # пробел между словами
            
            # 2. Сегментируем текст на предложения
            sentence_ranges = []
            try:
                import pysbd
                # Определяем язык
                latin_chars = sum(1 for c in full_text if ('a' <= c.lower() <= 'z'))
                cyrillic_chars = sum(1 for c in full_text if ('а' <= c.lower() <= 'я' or c.lower() == 'ё'))
                lang = "ru" if cyrillic_chars > latin_chars else "en"
                
                segmenter = pysbd.Segmenter(language=lang, clean=False, char_span=True)
                spans = segmenter.segment(full_text)
                sentence_ranges = [(span.start, span.end) for span in spans]
            except Exception as e:
                print(f"Error using pysbd in screen_translator: {e}")
                import re
                for m in re.finditer(r'[^.!?]+[.!?]*', full_text):
                    sentence_ranges.append((m.start(), m.end()))
            
            if not sentence_ranges:
                sentence_ranges = [(0, len(full_text))]
                
            # 3. Распределяем слова по предложениям
            sentences = [[] for _ in range(len(sentence_ranges))]
            for w_idx, (w_start, w_end) in enumerate(word_spans):
                w_mid = (w_start + w_end) / 2.0
                matched = False
                for s_idx, (s_start, s_end) in enumerate(sentence_ranges):
                    if s_start <= w_mid <= s_end:
                        sentences[s_idx].append(w_idx)
                        matched = True
                        break
                if not matched:
                    sentences[-1].append(w_idx)
            
            # Убираем пустые списки
            sentences = [s for s in sentences if s]
            
            # 4. Записываем индексы предложений
            for sent_idx, sent_words in enumerate(sentences):
                for w_idx in sent_words:
                    words[w_idx]["sentence_idx"] = sent_idx
                    words[w_idx]["sentence_words"] = sent_words
            item["sentences"] = sentences

    def draw_translations(self):
        self.canvas.delete("all")
        self.canvas_word_items.clear()
        self.last_hovered_word = None
        
        if not self.show_highlight or not self.last_translated_data:
            return
            
        self.prepare_sentence_data()
        
        screenshot = getattr(self, "current_screenshot", None)
        
        SENTENCE_COLORS = [
            "#FF2D55",  # Neon pink
            "#007AFF",  # Neon blue
            "#34C759",  # Neon green
            "#FF9500",  # Neon orange
            "#AF52DE",  # Neon purple
            "#00C7BE"   # Neon teal
        ]
        
        for block_idx, item in enumerate(self.last_translated_data):
            words = item.get("words", [])
            was_translated = item.get("was_translated", False)
            
            if not words:
                # Fallback: если нет слов, рисуем одну линию под весь блок
                x1, y1, x2, y2 = [int(v) for v in item["bbox"]]
                if x2 - x1 <= 0 or y2 - y1 <= 0:
                    continue
                brightness = _get_bg_brightness(screenshot, (x1, y1, x2, y2))
                palette = PALETTE_EN_DARK if brightness < 128 else PALETTE_EN_LIGHT
                y_base = y2 + max(1, int((y2 - y1) * 0.06))
                tag = f"block_{block_idx}"
                items = []
                for dy, width, color, stipple in palette:
                    opts = {"fill": color, "width": width, "capstyle": tk.ROUND, "tags": tag}
                    if stipple:
                        opts["stipple"] = stipple
                    item_id = self.canvas.create_line(x1 - 2, y_base + dy, x2 + 2, y_base + dy, **opts)
                    items.append(item_id)
                self.canvas_word_items[(block_idx, 0)] = items
                continue
            
            # --- 1. Группировка слов блока по визуальным строкам ---
            block_lines = []
            for w in words:
                wx1, wy1, wx2, wy2 = [int(v) for v in w["bbox"]]
                w_h = wy2 - wy1
                w_mid = (wy1 + wy2) / 2.0
                
                placed = False
                for line in block_lines:
                    ref_w = line[0]
                    rx1, ry1, rx2, ry2 = [int(v) for v in ref_w["bbox"]]
                    r_h = ry2 - ry1
                    r_mid = (ry1 + ry2) / 2.0
                    h_ref = max(w_h, r_h)
                    
                    if abs(w_mid - r_mid) < h_ref * 0.45:
                        line.append(w)
                        placed = True
                        break
                if not placed:
                    block_lines.append([w])
            
            for line in block_lines:
                line.sort(key=lambda w: w["bbox"][0])
                max_wy2 = max(int(w["bbox"][3]) for w in line)
                min_wy1 = min(int(w["bbox"][1]) for w in line)
                mean_h = sum(int(w["bbox"][3]) - int(w["bbox"][1]) for w in line) / len(line)
                line_y_base = max_wy2 + max(1, int(mean_h * 0.06))
                line_y_top = min_wy1 - max(2, int(mean_h * 0.12))
                line_y_mid = (min_wy1 + max_wy2) / 2.0
                for w in line:
                    w["y_base"] = line_y_base
                    w["y_top"] = line_y_top
                    w["y_mid"] = line_y_mid
            
            # --- 2. Отрисовка подчеркиваний слов ---
            if self.show_word_lines:
                for word_idx, word in enumerate(words):
                    wx1, wy1, wx2, wy2 = [int(v) for v in word["bbox"]]
                    w = wx2 - wx1
                    h = wy2 - wy1
                    if w <= 0 or h <= 0:
                        continue
                    
                    is_latin = _is_latin_word(word["text"])
                    brightness = _get_bg_brightness(screenshot, (wx1, wy1, wx2, wy2))
                    
                    if is_latin:
                        palette = PALETTE_EN_DARK if brightness < 128 else PALETTE_EN_LIGHT
                    else:
                        palette = PALETTE_RU_DARK if brightness < 128 else PALETTE_RU_LIGHT
                    
                    y_base = word["y_base"]
                    word_key = (block_idx, word_idx)
                    tag = f"w_{block_idx}_{word_idx}"
                    items = []
                    
                    for dy, width, color, stipple in palette:
                        opts = {"fill": color, "width": width, "capstyle": tk.ROUND, "tags": tag}
                        if stipple:
                            opts["stipple"] = stipple
                        item_id = self.canvas.create_line(
                            wx1 - 2, y_base + dy,
                            wx2 + 2, y_base + dy,
                            **opts
                        )
                        items.append(item_id)
                    
                    self.canvas_word_items[word_key] = items
            
            # --- 3. Отрисовка штрихпунктирных нитей предложений ---
            if self.show_flow_threads and "sentences" in item:
                bx1, by1, bx2, by2 = [int(v) for v in item["bbox"]]
                
                for sent_idx, sent_words_indices in enumerate(item["sentences"]):
                    words_in_sent = [words[w_idx] for w_idx in sent_words_indices]
                    if not words_in_sent:
                        continue
                        
                    color = SENTENCE_COLORS[sent_idx % len(SENTENCE_COLORS)]
                    tag_line = f"flow_line_{block_idx}_{sent_idx}"
                    tag_marker = f"flow_marker_{block_idx}_{sent_idx}"
                    
                    # Рисуем стартовый кружок
                    first_word = words_in_sent[0]
                    fx1 = int(first_word["bbox"][0]) - 2
                    fy = first_word["y_mid"]
                    self.canvas.create_oval(
                        fx1 - 3, fy - 3,
                        fx1 + 3, fy + 3,
                        fill=color, outline=color, width=1,
                        tags=(tag_marker, "flow_marker")
                    )
                    
                    # Рисуем сегменты между последовательными словами
                    for i in range(1, len(words_in_sent)):
                        w_prev = words_in_sent[i-1]
                        w_curr = words_in_sent[i]
                        
                        if w_prev["y_base"] == w_curr["y_base"]:
                            # Слова на одной строке -> рисуем горизонтальный сегмент в пробеле
                            x1 = int(w_prev["bbox"][2]) + 2
                            x2 = int(w_curr["bbox"][0]) - 2
                            y = w_curr["y_mid"]
                            
                            if x2 > x1:
                                self.canvas.create_line(
                                    x1, y, x2, y,
                                    fill=color, width=2.0, dash=(4, 3),
                                    capstyle=tk.ROUND, joinstyle=tk.ROUND,
                                    tags=(tag_line, "flow_line")
                                )
                        else:
                            # Переход на следующую строку
                            x_end = int(w_prev["bbox"][2]) + 2
                            y_end = w_prev["y_mid"]
                            x_start = int(w_curr["bbox"][0]) - 2
                            y_start = w_curr["y_mid"]
                            
                            y_top_next = w_curr.get("y_top", w_curr["y_base"] - 15)
                            y_mid_gap = (w_prev["y_base"] + y_top_next) / 2.0
                            
                            x_right = bx2 + 10
                            x_left = bx1 - 10
                            
                            coords = [
                                x_end, y_end,
                                x_right, y_end,
                                x_right, y_mid_gap,
                                x_left, y_mid_gap,
                                x_left, y_start,
                                x_start, y_start
                            ]
                            self.canvas.create_line(
                                *coords,
                                fill=color, width=2.0, dash=(4, 3),
                                capstyle=tk.ROUND, joinstyle=tk.ROUND,
                                tags=(tag_line, "flow_line")
                            )
                    
                    # Рисуем конечный маркер-квадратик
                    last_word = words_in_sent[-1]
                    lx2 = int(last_word["bbox"][2]) + 2
                    ly = last_word["y_mid"]
                    self.canvas.create_rectangle(
                        lx2 - 3, ly - 3,
                        lx2 + 3, ly + 3,
                        fill=color, outline=color, width=1,
                        tags=(tag_marker, "flow_marker")
                    )

        # Поднимаем все нити на самый верхний слой Z-order
        self.canvas.tag_raise("flow_line")
        self.canvas.tag_raise("flow_marker")

        # Подсказка внизу canvas
        if self.last_translated_data:
            canvas_w = max(self.canvas.winfo_width(), self.winfo_width() - 2 * self.border_width)
            canvas_h = max(self.canvas.winfo_height(), self.winfo_height() - 2 * self.border_width - 28)
            
            if not self.click_lock_active:
                hint_text = "💡 Нажмите [Space] или 🔊/A для кликов по словам"
                hint_color = "#888888"
            else:
                hint_text = "🖱️ ЛКМ: озвучка | 2xЛКМ: перевод слова | ПКМ: редактор | ❓: справка"
                hint_color = "#34C759"
                
            self.canvas.create_text(
                canvas_w / 2, 
                canvas_h - 26, 
                text=hint_text, 
                font=("Segoe UI", 9, "bold"), 
                fill=hint_color, 
                justify="center",
                tags="hint"
            )

    # --- Helper: поиск слова по координатам ---
    def _find_word_at(self, x, y):
        """Возвращает (block_idx, word_idx) или None."""
        if not self.last_translated_data:
            return None
        for block_idx, item in enumerate(self.last_translated_data):
            words = item.get("words", [])
            for word_idx, word in enumerate(words):
                wx1, wy1, wx2, wy2 = word["bbox"]
                # Расширяем зону попадания на 4px во все стороны
                if (wx1 - 4 <= x <= wx2 + 4) and (wy1 - 4 <= y <= wy2 + 8):
                    return (block_idx, word_idx)
        return None
    
    def _find_block_at(self, x, y):
        """Возвращает block_idx или None."""
        if not self.last_translated_data:
            return None
        for block_idx, item in enumerate(self.last_translated_data):
            x1, y1, x2, y2 = item["bbox"]
            if (x1 - 5 <= x <= x2 + 5) and (y1 - 5 <= y <= y2 + 10):
                return block_idx
        return None

    # --- Interactive Hover & Click Events ---
    def on_canvas_motion(self, event):
        if not self.click_lock_active or not self.last_translated_data or not self.show_highlight:
            return
            
        x, y = event.x, event.y
        word_hit = self._find_word_at(x, y)
        
        if word_hit != self.last_hovered_word:
            # Сброс предыдущего hover
            if self.last_hovered_word is not None:
                self._reset_word_hover(self.last_hovered_word)
            
            # Сброс подсветки ниточки предложения
            if getattr(self, "hovered_sentence", None) is not None:
                old_block, old_sent = self.hovered_sentence
                self.canvas.itemconfigure(f"flow_line_{old_block}_{old_sent}", width=2.0, dash=(4, 3))
                self.canvas.itemconfigure(f"flow_marker_{old_block}_{old_sent}", width=1)
                self.hovered_sentence = None
            
            # Установка нового hover
            if word_hit is not None:
                self._set_word_hover(word_hit)
                self.canvas.configure(cursor="hand2")
                
                # Подсветка ниточки предложения
                block_idx, word_idx = word_hit
                item = self.last_translated_data[block_idx]
                words = item.get("words", [])
                if word_idx < len(words):
                    sent_idx = words[word_idx].get("sentence_idx")
                    if sent_idx is not None:
                        self.canvas.itemconfigure(f"flow_line_{block_idx}_{sent_idx}", width=3.5, dash=())
                        self.canvas.itemconfigure(f"flow_marker_{block_idx}_{sent_idx}", width=2)
                        self.canvas.tag_raise(f"flow_line_{block_idx}_{sent_idx}")
                        self.canvas.tag_raise(f"flow_marker_{block_idx}_{sent_idx}")
                        self.hovered_sentence = (block_idx, sent_idx)
            else:
                self.canvas.configure(cursor="")
            
            self.last_hovered_word = word_hit
            # Обновляем last_hovered_idx для совместимости
            self.last_hovered_idx = word_hit[0] if word_hit else None
    
    def _set_word_hover(self, word_key):
        """Усиливает glow подчёркивание конкретного слова."""
        block_idx, word_idx = word_key
        if block_idx >= len(self.last_translated_data):
            return
            
        item = self.last_translated_data[block_idx]
        words = item.get("words", [])
        if word_idx >= len(words):
            return
        
        word = words[word_idx]
        wx1, wy1, wx2, wy2 = [int(v) for v in word["bbox"]]
        h = max(10, wy2 - wy1)
        y_base = word.get("y_base", wy2 + max(1, int(h * 0.06)))
        
        is_latin = _is_latin_word(word["text"])
        screenshot = getattr(self, "current_screenshot", None)
        brightness = _get_bg_brightness(screenshot, (wx1, wy1, wx2, wy2))
        
        if is_latin:
            palette = PALETTE_EN_HOVER_DARK if brightness < 128 else PALETTE_EN_HOVER_LIGHT
        else:
            palette = PALETTE_RU_HOVER_DARK if brightness < 128 else PALETTE_RU_HOVER_LIGHT
        
        # Удаляем старые элементы и рисуем hover-версию
        if word_key in self.canvas_word_items:
            for cid in self.canvas_word_items[word_key]:
                self.canvas.delete(cid)
        
        tag = f"w_{block_idx}_{word_idx}"
        items = []
        for dy, width, color, stipple in palette:
            opts = {"fill": color, "width": width, "capstyle": tk.ROUND, "tags": tag}
            if stipple:
                opts["stipple"] = stipple
            item_id = self.canvas.create_line(wx1 - 2, y_base + dy, wx2 + 2, y_base + dy, **opts)
            items.append(item_id)
        self.canvas_word_items[word_key] = items
        # Гарантируем, что нити предложений лежат поверх подсветки слов
        self.canvas.tag_raise("flow_line")
        self.canvas.tag_raise("flow_marker")
    
    def _reset_word_hover(self, word_key):
        """Возвращает слово к обычному glow подчёркиванию или удаляет, если линии скрыты."""
        block_idx, word_idx = word_key
        if block_idx >= len(self.last_translated_data):
            return
        
        item = self.last_translated_data[block_idx]
        words = item.get("words", [])
        if word_idx >= len(words):
            return
        
        # Если постоянные линии скрыты, при уходе мыши просто удаляем временную ховер-линию
        if not self.show_word_lines:
            if word_key in self.canvas_word_items:
                for cid in self.canvas_word_items[word_key]:
                    self.canvas.delete(cid)
                del self.canvas_word_items[word_key]
            # Даже если удалили ховер-линию, гарантируем Z-order нитей
            self.canvas.tag_raise("flow_line")
            self.canvas.tag_raise("flow_marker")
            return
            
        word = words[word_idx]
        wx1, wy1, wx2, wy2 = [int(v) for v in word["bbox"]]
        h = max(10, wy2 - wy1)
        y_base = word.get("y_base", wy2 + max(1, int(h * 0.06)))
        
        is_latin = _is_latin_word(word["text"])
        screenshot = getattr(self, "current_screenshot", None)
        brightness = _get_bg_brightness(screenshot, (wx1, wy1, wx2, wy2))
        
        if is_latin:
            palette = PALETTE_EN_DARK if brightness < 128 else PALETTE_EN_LIGHT
        else:
            palette = PALETTE_RU_DARK if brightness < 128 else PALETTE_RU_LIGHT
        
        # Удаляем hover-элементы и рисуем обычную версию
        if word_key in self.canvas_word_items:
            for cid in self.canvas_word_items[word_key]:
                self.canvas.delete(cid)
        
        tag = f"w_{block_idx}_{word_idx}"
        items = []
        for dy, width, color, stipple in palette:
            opts = {"fill": color, "width": width, "capstyle": tk.ROUND, "tags": tag}
            if stipple:
                opts["stipple"] = stipple
            item_id = self.canvas.create_line(wx1 - 2, y_base + dy, wx2 + 2, y_base + dy, **opts)
            items.append(item_id)
        self.canvas_word_items[word_key] = items
        # Гарантируем, что нити предложений лежат поверх подсветки слов
        self.canvas.tag_raise("flow_line")
        self.canvas.tag_raise("flow_marker")

    # Legacy compatibility shims
    def set_hover_effect(self, idx):
        pass
    def reset_hover_effect(self, idx):
        pass

    def on_canvas_click(self, event):
        # Закрываем активный тултип при клике в любом месте
        if self.active_tooltip and self.active_tooltip.winfo_exists():
            self.active_tooltip.destroy()
            self.active_tooltip = None
            
        if not self.click_lock_active or not self.last_translated_data:
            return
        
        # Debounce: откладываем одинарный клик на 250мс (чтобы двойной клик мог отменить)
        if self._click_after_id:
            self.after_cancel(self._click_after_id)
        self._click_after_id = self.after(250, lambda: self._do_single_click(event))
    
    def _do_single_click(self, event):
        """Обработчик одинарного клика с debounce — озвучка блока."""
        self._click_after_id = None
        x, y = event.x, event.y
        block_idx = self._find_block_at(x, y)
        if block_idx is not None:
            speak_orig = bool(event.state & 0x0004)  # Ctrl
            self.speak_sentence(block_idx, speak_original=speak_orig)
    
    def on_canvas_double_click(self, event):
        """Двойной клик — перевод отдельного слова в тултипе."""
        # Отменяем одинарный клик (debounce)
        if self._click_after_id:
            self.after_cancel(self._click_after_id)
            self._click_after_id = None
        
        if not self.click_lock_active or not self.last_translated_data:
            return
        
        word_hit = self._find_word_at(event.x, event.y)
        if word_hit is None:
            return
        
        block_idx, word_idx = word_hit
        item = self.last_translated_data[block_idx]
        words = item.get("words", [])
        if word_idx >= len(words):
            return
        
        word = words[word_idx]
        word_text = word["text"]
        
        # Показываем WordTooltip
        self._show_word_tooltip(word_text, event.x_root, event.y_root)
    
    def _show_word_tooltip(self, word_text, x_root, y_root):
        """Показывает компактный тултип с переводом одного слова."""
        if self.active_tooltip and self.active_tooltip.winfo_exists():
            try:
                self.active_tooltip.destroy()
            except:
                pass
        self.active_tooltip = WordTooltip(self, word_text, x_root, y_root)

    def on_canvas_right_click(self, event):
        if not self.click_lock_active or not self.last_translated_data:
            return
            
        x, y = event.x, event.y
        block_idx = self._find_block_at(x, y)
        if block_idx is not None:
            item = self.last_translated_data[block_idx]
            self.show_tooltip(item, event.x_root, event.y_root)

    def show_tooltip(self, item, x_root, y_root):
        if self.active_tooltip and self.active_tooltip.winfo_exists():
            try:
                self.active_tooltip.destroy()
            except:
                pass
        self.active_tooltip = TranslationTooltip(self, item, x_root, y_root)

    def force_refresh_sentence(self, original_text: str):
        # Запускаем фоновую задачу принудительного перевода
        import asyncio
        asyncio.create_task(self._async_force_refresh(original_text))
        
    async def _async_force_refresh(self, original_text: str):
        try:
            engine_type = getattr(self.master, "translation_engine", "google_cache")
            ollama_model = getattr(self.master, "ollama_model", "gemma2")
            ollama_url = getattr(self.master, "ollama_url", "http://localhost:11434")
            msty_model = getattr(self.master, "msty_model", "local-model")
            msty_url = getattr(self.master, "msty_url", "http://localhost:8080")
            
            import functools
            import sqlite3
            loop = asyncio.get_running_loop()
            
            def do_trans():
                import translation_engine
                # Удаляем старую автозапись из кэша перед переводом
                try:
                    conn = sqlite3.connect(translation_engine.DB_PATH)
                    cursor = conn.cursor()
                    cursor.execute("DELETE FROM translations WHERE LOWER(source_text) = LOWER(?)", (original_text.strip(),))
                    conn.commit()
                    conn.close()
                except:
                    pass
                    
                engine = translation_engine.get_engine(engine_type, 
                                                       ollama_model=ollama_model, 
                                                       ollama_url=ollama_url,
                                                       msty_model=msty_model,
                                                       msty_url=msty_url)
                res = engine.translate_batch([original_text], self.translate_to)
                return res[0] if res else original_text
                
            new_text = await loop.run_in_executor(None, do_trans)
            
            # Обновляем текст предложения в last_translated_data
            updated = False
            for item in self.last_translated_data:
                if item["original_text"].strip().lower() == original_text.strip().lower():
                    item["text"] = new_text
                    updated = True
                    
            if updated:
                # Перерисовываем канвас
                self.draw_translations()
                # Озвучиваем обновленный перевод
                for i, item in enumerate(self.last_translated_data):
                    if item["original_text"].strip().lower() == original_text.strip().lower():
                        self.speak_sentence(i)
                        break
        except Exception as e:
            print(f"Force refresh failed for '{original_text}': {e}")

    def save_custom_sentence_translation(self, original_text: str, custom_text: str):
        import translation_engine
        engine_type = getattr(self.master, "translation_engine", "google_cache")
        engine = translation_engine.get_engine(engine_type)
        engine.save_custom_translation(original_text, self.translate_to, custom_text)
        
        updated = False
        for item in self.last_translated_data:
            if item["original_text"].strip().lower() == original_text.strip().lower():
                item["text"] = custom_text
                updated = True
                
        if updated:
            self.draw_translations()
            for i, item in enumerate(self.last_translated_data):
                if item["original_text"].strip().lower() == original_text.strip().lower():
                    self.speak_sentence(i)
                    break

    def reset_custom_sentence_translation(self, original_text: str):
        import translation_engine
        engine_type = getattr(self.master, "translation_engine", "google_cache")
        engine = translation_engine.get_engine(engine_type)
        engine.save_custom_translation(original_text, self.translate_to, "")
        self.force_refresh_sentence(original_text)

    def speak_sentence(self, idx, speak_original=False):
        if not self.last_translated_data or idx >= len(self.last_translated_data):
            return
        item = self.last_translated_data[idx]
        text_to_speak = item["original_text"] if speak_original else item["text"]
        
        if text_to_speak and text_to_speak.strip():
            if hasattr(self.master, "update_text_and_play"):
                self.master.update_text_and_play(text_to_speak)
            elif hasattr(self.master, "master") and hasattr(self.master.master, "update_text_and_play"):
                self.master.master.update_text_and_play(text_to_speak)

    def speak_translated_text(self):
        if not self.last_translated_data:
            return
        # Объединяем перевод предложений для гладкой озвучки на русском
        combined_text = " ".join([item["text"] for item in self.last_translated_data])
        if combined_text.strip():
            if hasattr(self.master, "update_text_and_play"):
                self.master.update_text_and_play(combined_text)
            elif hasattr(self.master, "master") and hasattr(self.master.master, "update_text_and_play"):
                self.master.master.update_text_and_play(combined_text)

    def show_help_overlay(self):
        if hasattr(self, "help_frame"):
            try:
                self.help_frame.place_forget()
                self.help_frame.destroy()
            except:
                pass
            del self.help_frame
            
            if hasattr(self, "btn_help"):
                self.btn_help.configure(fg_color="transparent")
                
            if getattr(self, "help_overlay_active", False):
                self.help_overlay_active = False
                return
                
        self.help_overlay_active = True
        if hasattr(self, "btn_help"):
            self.btn_help.configure(fg_color="#34C759")
            
        self.help_frame = ctk.CTkScrollableFrame(self.center_container, fg_color="#111111", corner_radius=8, border_width=1, border_color="#007AFF")
        self.help_frame.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.9, relheight=0.8)
        
        ctk.CTkLabel(self.help_frame, text="📖 ЛЕГЕНДА И ИНСТРУКЦИЯ ОВЕРЛЕЯ", font=ctk.CTkFont(size=12, weight="bold"), text_color="#007AFF").pack(pady=(10, 5))
        
        def add_item(title, desc):
            ctk.CTkLabel(self.help_frame, text=title, font=ctk.CTkFont(size=11, weight="bold"), text_color="#34C759", anchor="w").pack(fill="x", padx=10, pady=(5, 1))
            lbl = ctk.CTkLabel(self.help_frame, text=desc, font=ctk.CTkFont(size=10), justify="left", anchor="w", wraplength=300)
            lbl.pack(fill="x", padx=15, pady=(0, 4))
            
        add_item("🔊/A / [Space] (Пробел)", "Переключает режим кликабельности экрана. При включении оверлей темнеет, блокируя сквозные клики, чтобы вы могли взаимодействовать с текстом.")
        add_item("ЛКМ (Левый клик)", "Нажмите на предложение в режиме блокировки кликов для озвучки перевода на русский язык.")
        add_item("Ctrl + ЛКМ", "Озвучивает выделенное предложение на языке оригинала (английском).")
        add_item("ПКМ (Правый клик)", "Показывает всплывающее окошко (Tooltip) с текстом перевода предложения у курсора.")
        add_item("✨ (Рамки)", "Включает/выключает отображение постоянных неоновых рамок вокруг распознанных предложений.")
        add_item("⚡ (Авто)", "Включает автосканирование: при изменении содержимого под окном переводчика текст автоматически перераспознается.")
        add_item("🔊 (В тулбаре)", "Озвучить весь распознанный текст (сначала оригинал, затем перевод).")
        add_item("[Esc] / ✕", "Закрыть оверлей переводчика.")
        
        ctk.CTkButton(self.help_frame, text="ПОНЯТНО", height=24, corner_radius=5, fg_color="#007AFF", hover_color="#005BBB", command=self.show_help_overlay).pack(pady=(10, 10))

    def destroy(self):
        if hasattr(self.master, "on_screen_translator_closed"):
            try:
                self.master.on_screen_translator_closed()
            except:
                pass
        super().destroy()
