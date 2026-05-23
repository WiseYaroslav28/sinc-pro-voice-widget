import tkinter as tk
import customtkinter as ctk
import asyncio
import threading
import ctypes
import sys
import time
from PIL import ImageGrab, ImageEnhance, ImageTk

# Принудительная установка DPI-awareness для сопоставления координат Tkinter и скриншотов 1:1
if sys.platform.startswith("win"):
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2) # PROCESS_PER_MONITOR_DPI_AWARE
    except:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except:
            pass

import ocr_translation

def analyze_colors(image, bbox):
    try:
        w, h = image.size
        x1, y1, x2, y2 = bbox
        
        # Расширяем bbox для поиска чистого фона вокруг букв
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
        
        # Анализируем пиксели по краям рамки для определения фона
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
            
        # Определяем цвет текста из исходной области (не расширенной)
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
        
        # Обходим прозрачный цвет окна (tk transparentcolor)
        if bg_hex == "#000001":
            bg_hex = "#000002"
            
        return bg_hex, fg_hex
    except Exception as e:
        print(f"Error in analyze_colors: {e}")
        return "#FFFFFF", "#000000"


class AreaSelector(tk.Toplevel):
    def __init__(self, master, on_selected):
        # Проверяем, является ли master корректным виджетом tkinter, иначе передаем None
        tcl_master = master if isinstance(master, (tk.Misc, ctk.CTk, ctk.CTkToplevel)) else None
        super().__init__(tcl_master)
        self.master = master
        self.on_selected = on_selected
        
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(bg="#000000")
        
        # Получаем метрики виртуального экрана
        try:
            user32 = ctypes.windll.user32
            self.vx = user32.GetSystemMetrics(76) # SM_XVIRTUALSCREEN
            self.vy = user32.GetSystemMetrics(77) # SM_YVIRTUALSCREEN
            self.vw = user32.GetSystemMetrics(78) # SM_CXVIRTUALSCREEN
            self.vh = user32.GetSystemMetrics(79) # SM_CYVIRTUALSCREEN
            if self.vw <= 0 or self.vh <= 0:
                raise Exception()
        except:
            self.vx = 0
            self.vy = 0
            self.vw = self.winfo_screenwidth()
            self.vh = self.winfo_screenheight()
            
        # Устанавливаем абсолютную геометрию под виртуальный экран
        self.geometry(f"{self.vw}x{self.vh}+{self.vx}+{self.vy}")
        
        # Снимок экрана
        self.original_screenshot = ImageGrab.grab(all_screens=True)
        
        # Затемненная версия для фона
        enhancer = ImageEnhance.Brightness(self.original_screenshot)
        self.dark_screenshot = enhancer.enhance(0.4)
        
        self.photo_dark = ImageTk.PhotoImage(self.dark_screenshot)
        
        # Холст выбора области
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


class ScreenTranslatorFrame(tk.Toplevel):
    def __init__(self, master, translate_to="ru"):
        # Проверяем, является ли master корректным виджетом tkinter, иначе передаем None
        tcl_master = master if isinstance(master, (tk.Misc, ctk.CTk, ctk.CTkToplevel)) else None
        super().__init__(tcl_master)
        self.master = master
        self.translate_to = translate_to
        
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.attributes("-transparentcolor", "#000001")
        self.configure(bg="#000001")
        
        self.min_width = 150
        self.min_height = 100
        self.border_width = 5
        
        self.show_translation = True
        self.last_translated_data = []
        self.is_translating = False
        self.need_update_translation = False
        
        # Параметры автоматического отслеживания изменений экрана
        self.auto_scan = False
        self.last_screen_hash = None
        self.stabilize_counter = 0
        self.screen_changed = False
        
        # 4 Границы изменения размера с правильными курсорами
        self.left_border = tk.Frame(self, bg="#007AFF", cursor="size_we")
        self.left_border.place(x=0, y=self.border_width, width=self.border_width, relheight=1.0, height=-2*self.border_width)
        
        self.right_border = tk.Frame(self, bg="#007AFF", cursor="size_we")
        self.right_border.place(relx=1.0, x=-self.border_width, y=self.border_width, width=self.border_width, relheight=1.0, height=-2*self.border_width)
        
        self.top_border = tk.Frame(self, bg="#007AFF", cursor="size_ns")
        self.top_border.place(x=self.border_width, y=0, relwidth=1.0, width=-2*self.border_width, height=self.border_width)
        
        self.bottom_border = tk.Frame(self, bg="#007AFF", cursor="size_ns")
        self.bottom_border.place(x=self.border_width, rely=1.0, y=-self.border_width, relwidth=1.0, width=-2*self.border_width, height=self.border_width)
        
        # 4 Угла изменения размера с диагональными курсорами
        self.top_left_corner = tk.Frame(self, bg="#007AFF", cursor="size_nw_se")
        self.top_left_corner.place(x=0, y=0, width=self.border_width, height=self.border_width)
        
        self.top_right_corner = tk.Frame(self, bg="#007AFF", cursor="size_ne_sw")
        self.top_right_corner.place(relx=1.0, x=-self.border_width, y=0, width=self.border_width, height=self.border_width)
        
        self.bottom_left_corner = tk.Frame(self, bg="#007AFF", cursor="size_ne_sw")
        self.bottom_left_corner.place(x=0, rely=1.0, y=-self.border_width, width=self.border_width, height=self.border_width)
        
        self.bottom_right_corner = tk.Frame(self, bg="#007AFF", cursor="size_nw_se")
        self.bottom_right_corner.place(relx=1.0, x=-self.border_width, rely=1.0, y=-self.border_width, width=self.border_width, height=self.border_width)
        
        # Внутренний контейнер для контента
        self.center_container = tk.Frame(self, bg="#000001")
        self.center_container.place(x=self.border_width, y=self.border_width, relwidth=1.0, relheight=1.0, width=-2*self.border_width, height=-2*self.border_width)
        
        # Панель инструментов
        self.toolbar = ctk.CTkFrame(self.center_container, height=28, fg_color="#181818", corner_radius=0)
        self.toolbar.pack(side="top", fill="x")
        self.toolbar.pack_propagate(False)
        
        # Прозрачный холст перевода
        self.canvas = tk.Canvas(self.center_container, bg="#000001", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        
        self.setup_toolbar()
        self.setup_drag_and_resize()
        
        self.bind("<Escape>", lambda e: self.destroy())
        self.bind("<ButtonRelease-1>", self.on_global_release)
        self.canvas.bind("<ButtonRelease-1>", self.on_global_release)
        
        # Запуск фонового отслеживания изменений экрана
        self.after(800, self.check_screen_changes)

    def setup_toolbar(self):
        self.lbl_title = ctk.CTkLabel(self.toolbar, text=" ⛶ SINC TRANSLATE", font=ctk.CTkFont(size=10, weight="bold"), text_color="#007AFF")
        self.lbl_title.pack(side="left", padx=5)
        
        # Перетаскивание за тулбар
        self.toolbar.bind("<ButtonPress-1>", self.start_drag)
        self.toolbar.bind("<B1-Motion>", self.do_drag)
        self.toolbar.bind("<ButtonRelease-1>", self.on_global_release)
        
        self.lbl_title.bind("<ButtonPress-1>", self.start_drag)
        self.lbl_title.bind("<B1-Motion>", self.do_drag)
        self.lbl_title.bind("<ButtonRelease-1>", self.on_global_release)
        
        # Кнопки
        self.btn_close = ctk.CTkButton(self.toolbar, text="✕", width=24, height=22, corner_radius=4,
                                       fg_color="transparent", hover_color="#c0392b", text_color="#aaa", font=ctk.CTkFont(size=12, weight="bold"),
                                       command=self.destroy)
        self.btn_close.pack(side="right", padx=3, pady=3)
        
        self.btn_speak = ctk.CTkButton(self.toolbar, text="🔊", width=24, height=22, corner_radius=4,
                                       fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                       command=self.speak_translated_text)
        self.btn_speak.pack(side="right", padx=3, pady=3)
        
        self.btn_visibility = ctk.CTkButton(self.toolbar, text="👁", width=24, height=22, corner_radius=4,
                                            fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                            command=self.toggle_visibility)
        self.btn_visibility.pack(side="right", padx=3, pady=3)
        
        self.btn_auto = ctk.CTkButton(self.toolbar, text="⚡", width=24, height=22, corner_radius=4,
                                      fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                      command=self.toggle_auto_scan)
        self.btn_auto.pack(side="right", padx=3, pady=3)
        
        self.btn_translate = ctk.CTkButton(self.toolbar, text="🔄", width=24, height=22, corner_radius=4,
                                           fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                           command=self.translate_area)
        self.btn_translate.pack(side="right", padx=3, pady=3)

    def setup_drag_and_resize(self):
        # Настройка 4 границ
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
        
        # Настройка 4 углов
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

    # --- Фоновый мониторинг изменений экрана ---
    def check_screen_changes(self):
        if not self.winfo_exists():
            return
            
        if self.auto_scan and not self.is_translating and not getattr(self, "need_update_translation", False):
            try:
                canvas_x = self.canvas.winfo_rootx()
                canvas_y = self.canvas.winfo_rooty()
                canvas_w = self.canvas.winfo_width()
                canvas_h = self.canvas.winfo_height()
                
                if canvas_w > 10 and canvas_h > 10:
                    current_img = ImageGrab.grab(bbox=(canvas_x, canvas_y, canvas_x + canvas_w, canvas_y + canvas_h))
                    # Даунсэмплинг для быстрой обработки и исключения шумов
                    small_img = current_img.resize((32, 32)).convert("L")
                    pixels = list(small_img.getdata())
                    
                    if self.last_screen_hash is not None:
                        diff = sum(abs(p1 - p2) for p1, p2 in zip(pixels, self.last_screen_hash)) / len(pixels)
                        
                        if diff > 3.0:
                            # Экран изменился
                            self.screen_changed = True
                            self.stabilize_counter = 0
                            self.last_screen_hash = pixels
                        else:
                            # Экран стабилен
                            if getattr(self, "screen_changed", False):
                                self.stabilize_counter += 1
                                # Если стабилен более 800 мс (1 цикла) после изменений, переводим
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

    # --- Перевод при отпускании мыши ---
    def on_global_release(self, event):
        if getattr(self, "need_update_translation", False):
            self.need_update_translation = False
            self.translate_area()

    # --- Перетаскивание за тулбар ---
    def start_drag(self, event):
        self.drag_start_x = event.x_root
        self.drag_start_y = event.y_root
        self.win_start_x = self.winfo_rootx()
        self.win_start_y = self.winfo_rooty()

    def do_drag(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.drag_start_x
        dy = event.y_root - self.drag_start_y
        self.geometry(f"+{self.win_start_x + dx}+{self.win_start_y + dy}")

    # --- Классический ресайз (Фиксированные стартовые переменные) ---
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
        new_h = max(self.min_height, self.resize_start_h - dy)
        if new_h > self.min_height:
            new_y = self.resize_win_y + dy
        else:
            new_y = self.resize_win_y + (self.resize_start_h - self.min_height)
        self.geometry(f"{self.resize_start_w}x{new_h}+{self.resize_win_x}+{new_y}")

    def do_resize_top_left(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.resize_start_x
        dy = event.y_root - self.resize_start_y
        new_w = max(self.min_width, self.resize_start_w - dx)
        new_h = max(self.min_height, self.resize_start_h - dy)
        if new_w > self.min_width:
            new_x = self.resize_win_x + dx
        else:
            new_x = self.resize_win_x + (self.resize_start_w - self.min_width)
        if new_h > self.min_height:
            new_y = self.resize_win_y + dy
        else:
            new_y = self.resize_win_y + (self.resize_start_h - self.min_height)
        self.geometry(f"{new_w}x{new_h}+{new_x}+{new_y}")

    def do_resize_top_right(self, event):
        self.need_update_translation = True
        dx = event.x_root - self.resize_start_x
        dy = event.y_root - self.resize_start_y
        new_w = max(self.min_width, self.resize_start_w + dx)
        new_h = max(self.min_height, self.resize_start_h - dy)
        if new_h > self.min_height:
            new_y = self.resize_win_y + dy
        else:
            new_y = self.resize_win_y + (self.resize_start_h - self.min_height)
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

    # --- Процесс перевода ---
    def translate_precropped(self, cropped_image):
        if self.is_translating:
            return
        self.is_translating = True
        self.btn_translate.configure(text="⌛")
        self.canvas.delete("all")
        self.current_screenshot = cropped_image
        
        threading.Thread(target=self._run_precropped_translation_thread, args=(cropped_image,), daemon=True).start()

    def _run_precropped_translation_thread(self, cropped_image):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            data = loop.run_until_complete(
                ocr_translation.perform_ocr_and_translation(cropped_image, self.translate_to)
            )
            self.last_translated_data = data
            self.show_translation = True
            self.after(0, self.draw_translations)
        except Exception as e:
            print(f"Error during translation process: {e}")
        finally:
            loop.close()
            self.is_translating = False
            self.after(0, lambda: self.btn_translate.configure(text="🔄"))

    def translate_area(self):
        if self.is_translating:
            return
        
        self.is_translating = True
        self.btn_translate.configure(text="⌛")
        self.canvas.delete("all")
        
        threading.Thread(target=self._run_translation_thread, daemon=True).start()

    def _run_translation_thread(self):
        self.update_idletasks()
        
        # Скрываем рамку для чистого захвата экрана под ней
        self.attributes("-alpha", 0.0)
        time.sleep(0.08)
        
        try:
            canvas_x = self.canvas.winfo_rootx()
            canvas_y = self.canvas.winfo_rooty()
            canvas_w = self.canvas.winfo_width()
            canvas_h = self.canvas.winfo_height()
            
            screenshot = ImageGrab.grab(bbox=(canvas_x, canvas_y, canvas_x + canvas_w, canvas_y + canvas_h))
        except Exception as e:
            screenshot = None
            print(f"Error capturing screen: {e}")
            
        self.attributes("-alpha", 1.0)
        
        if screenshot is None:
            self.is_translating = False
            self.after(0, lambda: self.btn_translate.configure(text="🔄"))
            return
            
        self.current_screenshot = screenshot
        
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            data = loop.run_until_complete(
                ocr_translation.perform_ocr_and_translation(screenshot, self.translate_to)
            )
            self.last_translated_data = data
            self.show_translation = True
            self.after(0, self.draw_translations)
        except Exception as e:
            print(f"Error during translation process: {e}")
        finally:
            loop.close()
            self.is_translating = False
            self.after(0, lambda: self.btn_translate.configure(text="🔄"))

    def draw_translations(self):
        self.canvas.delete("all")
        if not self.show_translation or not self.last_translated_data:
            self.last_screen_hash = None
            return
            
        for item in self.last_translated_data:
            text = item["text"]
            x1, y1, x2, y2 = item["bbox"]
            w = x2 - x1
            h = y2 - y1
            
            # Анализируем цвет фона и текста
            bg_color = "#FFFFFF"
            fg_color = "#000000"
            if hasattr(self, "current_screenshot") and self.current_screenshot:
                bg_color, fg_color = analyze_colors(self.current_screenshot, (x1, y1, x2, y2))
            
            # Рисуем подложку точного цвета фона без каёмок (эффект «закрашивания»)
            self.canvas.create_rectangle(
                x1 - 1, y1 - 1, x2 + 1, y2 + 1,
                fill=bg_color,
                outline="",
                width=0
            )
            
            # Динамически вычисляем размер шрифта под высоту строки (Google Lens style)
            font_size = max(6, int(h * 0.65))
            
            # Отрисовываем перевод оригинальным цветом текста
            self.canvas.create_text(
                (x1 + x2) / 2,
                (y1 + y2) / 2,
                text=text,
                fill=fg_color,
                font=("Segoe UI", font_size, "bold"),
                width=w + 10,
                anchor="center"
            )
            
        # Сбрасываем хэш, чтобы избежать ложных детекций изменений от только что нарисованного перевода
        self.last_screen_hash = None

    def toggle_visibility(self):
        self.show_translation = not self.show_translation
        if self.show_translation:
            self.btn_visibility.configure(text="👁", fg_color="transparent")
            self.draw_translations()
        else:
            self.btn_visibility.configure(text="👁‍🗨", fg_color="#007AFF")
            self.canvas.delete("all")

    def speak_translated_text(self):
        if not self.last_translated_data:
            return
        combined_text = "\n".join([item["text"] for item in self.last_translated_data])
        if hasattr(self.master, "update_text_and_play"):
            self.master.update_text_and_play(combined_text)
        elif hasattr(self.master, "master") and hasattr(self.master.master, "update_text_and_play"):
            self.master.master.update_text_and_play(combined_text)
