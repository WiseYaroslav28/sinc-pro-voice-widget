import tkinter as tk
import customtkinter as ctk
import asyncio
import threading
import ctypes
import sys
import time
from PIL import ImageGrab, ImageEnhance, ImageTk, Image, ImageDraw, ImageFont

try:
    import cv2
    import numpy as np
    opencv_available = True
except ImportError:
    opencv_available = False


# Принудительная установка DPI-awareness для сопоставления координат Tkinter и скриншотов 1:1
if sys.platform.startswith("win"):
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2) # PROCESS_PER_MONITOR_DPI_AWARE
    except:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except:
            pass

from ctypes import wintypes

def get_virtual_screen_origin():
    try:
        user32 = ctypes.windll.user32
        vx = user32.GetSystemMetrics(76) # SM_XVIRTUALSCREEN
        vy = user32.GetSystemMetrics(77) # SM_YVIRTUALSCREEN
        return vx, vy
    except Exception as e:
        print(f"Error in get_virtual_screen_origin: {e}")
        return 0, 0

def wrap_text(text, font, max_width):
    words = text.split(' ')
    lines = []
    current_line = []
    
    for word in words:
        test_line = ' '.join(current_line + [word])
        try:
            # Pillow 10+
            draw_temp = ImageDraw.Draw(Image.new("RGB", (1,1)))
            left, top, right, bottom = draw_temp.textbbox((0, 0), test_line, font=font)
            w = right - left
        except:
            try:
                w, _ = font.getsize(test_line)
            except:
                w = len(test_line) * (font.size * 0.55)
                
        if w <= max_width:
            current_line.append(word)
        else:
            if current_line:
                lines.append(' '.join(current_line))
                current_line = [word]
            else:
                lines.append(word)
                current_line = []
                
    if current_line:
        lines.append(' '.join(current_line))
    return lines

def get_canvas_physical_pos(canvas):
    try:
        hwnd = canvas.winfo_id()
        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
        pt = POINT(0, 0)
        ctypes.windll.user32.ClientToScreen(hwnd, ctypes.byref(pt))
        return pt.x, pt.y
    except Exception as e:
        # Так как log_debug определен ниже, выведем в консоль
        print(f"Error in get_canvas_physical_pos: {e}")
        return canvas.winfo_rootx(), canvas.winfo_rooty()

import ocr_translation

def log_debug(message):
    try:
        import os
        log_path = r"c:\Antigravity projects\voice-server\debug.log"
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}\n")
    except Exception as e:
        print(f"Log error: {e}")

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
        # Проверяем, является ли master корректным виджетом tkinter, иначе передаем None
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
        
        self.show_translation = True
        self.show_highlight = False
        self.canvas_images = []
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
        
        # Запуск калибровки положения окна
        self.after(50, self.align_canvas)

    def align_canvas(self):
        if getattr(self, "target_x", None) is None or getattr(self, "target_y", None) is None:
            return
        
        self.update_idletasks()
        self.update()
        
        # Получаем реальные физические координаты Canvas на экране
        real_x, real_y = get_canvas_physical_pos(self.canvas)
        
        # Вычисляем разницу в физических пикселях
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
            
            # Так как процесс DPI-aware, geometry() принимает физические пиксели напрямую.
            dx = dx_phys
            dy = dy_phys
            
            self.geometry(f"+{int(cur_x + dx)}+{int(cur_y + dy)}")
            self.update()
            log_debug(f"align_canvas: aligned by dx={dx}, dy={dy}. Target: {self.target_x},{self.target_y}. Real was: {real_x},{real_y}")

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
        
        self.btn_highlight = ctk.CTkButton(self.toolbar, text="✨", width=24, height=22, corner_radius=4,
                                           fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                           command=self.toggle_highlight)
        self.btn_highlight.pack(side="right", padx=3, pady=3)

    def toggle_highlight(self):
        self.show_highlight = not self.show_highlight
        if self.show_highlight:
            self.btn_highlight.configure(fg_color="#007AFF", text_color="#ffffff")
        else:
            self.btn_highlight.configure(fg_color="transparent", text_color="#aaa")
        self.draw_translations()

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
                # Обрабатываем все события перемещения окна, чтобы получить свежие координаты
                self.update()
                canvas_x, canvas_y = get_canvas_physical_pos(self.canvas)
                canvas_w = self.canvas.winfo_width()
                canvas_h = self.canvas.winfo_height()
                
                if canvas_w > 10 and canvas_h > 10:
                    # Обходим баг Pillow с отрицательными координатами:
                    # Делаем полноэкранный снимок виртуального экрана и вырезаем Canvas по координатам
                    vx, vy = get_virtual_screen_origin()
                    full_screenshot = ImageGrab.grab(all_screens=True)
                    
                    crop_x1 = canvas_x - vx
                    crop_y1 = canvas_y - vy
                    crop_x2 = crop_x1 + canvas_w
                    crop_y2 = crop_y1 + canvas_h
                    
                    current_img = full_screenshot.crop((crop_x1, crop_y1, crop_x2, crop_y2))
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

    # --- Процесс перевода (Потокобезопасная реализация) ---
    def translate_precropped(self, cropped_image):
        if self.is_translating:
            return
        self.is_translating = True
        self.btn_translate.configure(text="⌛")
        self.canvas.delete("all")
        
        # Принудительно обновляем геометрию окна, чтобы winfo_width() вернул реальные размеры
        self.update_idletasks()
        self.update()
        
        canvas_w = max(self.canvas.winfo_width(), self.winfo_width() - 2 * self.border_width)
        canvas_h = max(self.canvas.winfo_height(), self.winfo_height() - 2 * self.border_width - 28)
        self.canvas.create_text(
            canvas_w / 2, 
            canvas_h / 2, 
            text="⏳ Перевод...", 
            font=("Segoe UI", 24, "bold"), 
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
            print(f"Error during translation process: {e}")
            self.after(0, lambda: self.finish_translation(None))
        finally:
            loop.close()

    def translate_area(self):
        if self.is_translating:
            return
        
        self.is_translating = True
        self.btn_translate.configure(text="⌛")
        
        # Делаем холст прозрачным и очищаем
        self.canvas.delete("all")
        self.canvas_images.clear()
        
        # Получаем координаты и размеры холста Canvas ДО скрытия окна!
        # Сначала принудительно обновляем события Tkinter, чтобы применить перемещение
        self.update()
        canvas_x, canvas_y = get_canvas_physical_pos(self.canvas)
        canvas_w = self.canvas.winfo_width()
        canvas_h = self.canvas.winfo_height()
        
        log_debug(f"translate_area: physical pos = ({canvas_x}, {canvas_y}), size = {canvas_w}x{canvas_h}")
        
        # Скрываем окно переводчика гарантированным способом
        self.withdraw()
        self.update()
        time.sleep(0.18) # Даем DWM время скрыть окно перед скриншотом
        
        screenshot = None
        try:
            if canvas_w > 10 and canvas_h > 10:
                # Обходим баг Pillow с отрицательными координатами:
                # Делаем полноэкранный снимок виртуального экрана и вырезаем Canvas по координатам
                vx, vy = get_virtual_screen_origin()
                full_screenshot = ImageGrab.grab(all_screens=True)
                
                crop_x1 = canvas_x - vx
                crop_y1 = canvas_y - vy
                crop_x2 = crop_x1 + canvas_w
                crop_y2 = crop_y1 + canvas_h
                
                screenshot = full_screenshot.crop((crop_x1, crop_y1, crop_x2, crop_y2))
        except Exception as e:
            log_debug(f"Error capturing screen in translate_area: {e}")
            print(f"Error capturing screen in translate_area: {e}")
            
        # Восстанавливаем видимость окна переводчика на экране
        self.deiconify()
        self.attributes("-topmost", True)
        self.focus_force()
        self.update()
        
        if screenshot is None:
            self.is_translating = False
            self.btn_translate.configure(text="🔄")
            return
            
        self.current_screenshot = screenshot
        
        # Рисуем индикатор загрузки после снятия скриншота
        canvas_w = max(self.canvas.winfo_width(), self.winfo_width() - 2 * self.border_width)
        canvas_h = max(self.canvas.winfo_height(), self.winfo_height() - 2 * self.border_width - 28)
        self.canvas.create_text(
            canvas_w / 2, 
            canvas_h / 2, 
            text="⏳ Перевод...", 
            font=("Segoe UI", 24, "bold"), 
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
            print(f"Error during translation process: {e}")
            # Извлекаем более дружелюбный текст ошибки, если это возможно
            raw_err = str(e)
            if "Локальный переводчик не установлен" in raw_err:
                error_msg = "Локальный переводчик не установлен.\nСкачайте модель в настройках."
            elif "Argos Translate" in raw_err:
                error_msg = "Ошибка движка Argos.\nПожалуйста, установите модель в настройках."
            else:
                error_msg = f"Ошибка перевода: {raw_err[:60]}"
            data = None
        finally:
            loop.close()
        self.after(0, lambda: self.finish_translation(data, error_msg))

    def finish_translation(self, data, error_msg=None):
        log_debug(f"finish_translation: received data: {data}, error: {error_msg}")
        self.is_translating = False
        self.btn_translate.configure(text="🔄")
        self.canvas.delete("loading")
        
        if data is not None:
            self.last_translated_data = data
            self.show_translation = True
            self.draw_translations()
        else:
            self.canvas.delete("all")
            canvas_w = max(self.canvas.winfo_width(), self.winfo_width() - 2 * self.border_width)
            canvas_h = max(self.canvas.winfo_height(), self.winfo_height() - 2 * self.border_width - 28)
            msg = error_msg if error_msg else "Ошибка распознавания или перевода"
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

    def draw_translations(self):
        log_debug(f"draw_translations: show_translation={self.show_translation}, data size={len(self.last_translated_data) if self.last_translated_data else 0}")
        self.canvas.delete("all")
        self.canvas_images.clear()
        
        if not self.show_translation or not self.last_translated_data:
            self.last_screen_hash = None
            log_debug("draw_translations: show_translation is False or data is empty. Exiting.")
            return
            
        # Так как процесс полностью DPI-aware, координаты Canvas 1:1 соответствуют физическим пикселям
        scale = 1.0
        canvas_h_phys = self.canvas.winfo_height()
        canvas_w = self.canvas.winfo_width()
        
        for i, item in enumerate(self.last_translated_data):
            text = item["text"]
            original_text = item.get("original_text", "")
            log_debug(f"Block {i}: original='{original_text}', translated='{text}'")
            
            if not text or text.strip().lower() == original_text.strip().lower():
                log_debug(f"Block {i}: text matches original (or empty). Skipping.")
                continue
                
            x1, y1, x2, y2 = item["bbox"]
            x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)
            w = x2 - x1
            h = y2 - y1
            orig_line_h = item.get("line_height", h)
            log_debug(f"Block {i} coordinates: bbox={item['bbox']}, w={w}, h={h}, orig_line_h={orig_line_h}")
            
            if w <= 0 or h <= 0:
                log_debug(f"Block {i}: invalid width/height. Skipping.")
                continue
                
            # --- Умный расчет свободного пространства (Smart Padding) ---
            min_dist_right = max(0, canvas_w - x2) # до правого края Canvas
            
            for idx, other_item in enumerate(self.last_translated_data):
                if idx == i:
                    continue
                ox1, oy1, ox2, oy2 = other_item["bbox"]
                ox1, oy1, ox2, oy2 = int(ox1), int(oy1), int(ox2), int(oy2)
                
                # Проверяем пересечение по вертикали (на той же высоте)
                y_overlap = not (oy2 + 2 <= y1 or oy1 - 2 >= y2)
                if y_overlap:
                    if ox1 >= x2:
                        dist = ox1 - x2
                        if dist < min_dist_right:
                            min_dist_right = dist
                            
            # Безопасный зазор справа 4 пикселя
            extra_w_right = max(0, min_dist_right - 4)
            
            # Ограничиваем расширение вправо: до 45% от ширины, но не менее 40px
            max_ext_r = max(40, int(w * 0.45))
            extra_w_right = min(extra_w_right, max_ext_r)
            
            draw_x1 = x1
            draw_x2 = x2 + extra_w_right
            draw_w = draw_x2 - draw_x1
            
            # Ищем свободное пространство снизу в новых границах draw_x1..draw_x2
            min_dist_to_next = max(0, canvas_h_phys - y2)
            for idx, other_item in enumerate(self.last_translated_data):
                if idx == i:
                    continue
                ox1, oy1, ox2, oy2 = other_item["bbox"]
                ox1, oy1, ox2, oy2 = int(ox1), int(oy1), int(ox2), int(oy2)
                
                if oy1 >= y2:
                    # Проверяем пересечение по горизонтали в расширенных границах
                    x_overlap = not (ox2 <= draw_x1 or ox1 >= draw_x2)
                    if x_overlap:
                        dist = oy1 - y2
                        if dist < min_dist_to_next:
                            min_dist_to_next = dist
                            
            # Безопасный зазор снизу 6 пикселей
            extra_h_down = max(0, min_dist_to_next - 6)
            
            # Ограничиваем вертикальное расширение
            if h > 40:
                max_ext_d = int(h * 1.5)
            else:
                max_ext_d = max(30, h)
            extra_h_down = min(extra_h_down, max_ext_d)
            
            draw_h = h + extra_h_down
            log_debug(f"Block {i}: draw_x1={draw_x1}, draw_x2={draw_x2}, draw_w={draw_w}, extra_h_down={extra_h_down}, draw_h={draw_h}")
            
            bg_color = "#FFFFFF"
            fg_color = "#000000"
            if hasattr(self, "current_screenshot") and self.current_screenshot:
                bg_color, fg_color = analyze_colors(self.current_screenshot, (x1, y1, x2, y2))
                log_debug(f"Block {i} colors: bg={bg_color}, fg={fg_color}")
            else:
                log_debug(f"Block {i}: current_screenshot missing!")
            
            block_img = None
            text_box_coords = None
            if hasattr(self, "current_screenshot") and self.current_screenshot:
                try:
                    sc_w, sc_h = self.current_screenshot.size
                    crop_x2 = max(0, min(sc_w, draw_x2))
                    crop_y2 = max(0, min(sc_h, y2 + extra_h_down))
                    
                    if crop_x2 > x1 and crop_y2 > y1:
                        # Вырезаем область плашки
                        block = self.current_screenshot.crop((x1, y1, crop_x2, crop_y2))
                        log_debug(f"Block {i}: cropped successfully. size={block.size}")
                        
                        if opencv_available:
                            block_cv = cv2.cvtColor(np.array(block), cv2.COLOR_RGB2BGR)
                            bg_rgb = tuple(int(bg_color[i:i+2], 16) for i in (1, 3, 5))
                            bg_b, bg_g, bg_r = bg_rgb[2], bg_rgb[1], bg_rgb[0]
                            
                            # Маска только для оригинальной области текста (от 0 до w)
                            mask = np.zeros(block_cv.shape[:2], dtype=np.uint8)
                            diff = np.abs(block_cv[:h, :w].astype(np.int32) - [bg_b, bg_g, bg_r])
                            mask_text = np.any(diff > 35, axis=-1).astype(np.uint8) * 255
                            mask[:h, :w] = mask_text
                            
                            kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
                            mask = cv2.dilate(mask, kernel, iterations=1)
                            
                            inpainted = cv2.inpaint(block_cv, mask, 3, cv2.INPAINT_TELEA)
                            block_clean = Image.fromarray(cv2.cvtColor(inpainted, cv2.COLOR_BGR2RGB))
                        else:
                            block_clean = Image.new("RGB", (crop_x2 - x1, draw_h), bg_color)
                            
                        draw = ImageDraw.Draw(block_clean)
                        
                        # Динамически подбираем шрифт, чтобы текст влез с учетом переносов
                        font_size = max(10, int(orig_line_h * 1.15))
                        wrapped_lines = []
                        line_height = 0
                        total_text_h = 0
                        line_spacing = 0
                        y_pos_start = 0
                        
                        while font_size > 8:
                            try:
                                font = ImageFont.truetype("segoeui.ttf", font_size)
                            except IOError:
                                try:
                                    font = ImageFont.truetype("arial.ttf", font_size)
                                except IOError:
                                    font = ImageFont.load_default()
                                    break
                                    
                            wrapped_lines = wrap_text(text, font, draw_w - 6)
                            
                            try:
                                left_t, top_t, right_t, bottom_t = draw.textbbox((0, 0), "Abc", font=font)
                                single_line_h = bottom_t - top_t
                            except:
                                try:
                                    _, single_line_h = font.getsize("Abc")
                                except:
                                    single_line_h = font_size
                                    
                            line_spacing = int(single_line_h * 0.15)
                            line_height = single_line_h + line_spacing
                            total_text_h = len(wrapped_lines) * line_height - line_spacing
                            
                            # Вычисляем Y-координату начала первой строки перевода
                            # Первая строка перевода выравнивается по центру оригинальной строки
                            y_pos_start = max(0, (orig_line_h - single_line_h) // 2)
                            
                            # Если по высоте текст помещается в draw_h, выходим из цикла
                            if y_pos_start + total_text_h <= draw_h - 2:
                                break
                            font_size -= 1
                            
                        y_pos = y_pos_start
                        left_min = draw_w
                        right_max = 0
                        
                        for line in wrapped_lines:
                            # Рисуем с отступом в 3 пикселя слева
                            draw.text((3, y_pos), line, fill=fg_color, font=font)
                            try:
                                l_b, t_b, r_b, b_b = draw.textbbox((3, y_pos), line, font=font)
                                if l_b < left_min: left_min = l_b
                                if r_b > right_max: right_max = r_b
                            except:
                                pass
                            y_pos += line_height
                            
                        text_box_coords = (left_min, y_pos_start, right_max, y_pos - line_spacing)
                        block_img = block_clean
                        log_debug(f"Block {i}: PIL rendering completed. font_size={font_size}, lines={len(wrapped_lines)}")
                except Exception as e:
                    log_debug(f"Block {i}: Error rendering block: {e}")
                    print(f"Error rendering block: {e}")
                    
            if block_img is not None:
                log_debug(f"Block {i}: block_img is valid, drawing Image on Canvas")
                if self.show_highlight and text_box_coords is not None:
                    block_rgba = block_img.convert("RGBA")
                    glow = Image.new("RGBA", block_rgba.size, (0, 0, 0, 0))
                    draw_glow = ImageDraw.Draw(glow)
                    
                    try:
                        left, top, right, bottom = text_box_coords
                        # Мягкое градиентное неоновое свечение (4 слоя)
                        for r_offset, alpha in [(4, 8), (3, 16), (2, 32), (1, 64)]:
                            draw_glow.rounded_rectangle(
                                [left - r_offset, top - r_offset, right + r_offset, bottom + r_offset],
                                radius=4 + r_offset,
                                fill=(0, 122, 255, alpha // 4),
                                outline=(0, 122, 255, alpha),
                                width=1
                            )
                    except AttributeError:
                        for r_offset, alpha in [(4, 8), (3, 16), (2, 32), (1, 64)]:
                            draw_glow.rounded_rectangle(
                                [0 - r_offset, 0 - r_offset, glow.width - 1 + r_offset, glow.height - 1 + r_offset],
                                radius=4 + r_offset,
                                fill=(0, 122, 255, alpha // 4),
                                outline=(0, 122, 255, alpha),
                                width=1
                            )
                        
                    block_img = Image.alpha_composite(block_rgba, glow).convert("RGB")
                    
                img_tk = ImageTk.PhotoImage(block_img)
                self.canvas_images.append(img_tk)
                log_x1 = draw_x1 / scale
                log_y1 = y1 / scale
                self.canvas.create_image(log_x1, log_y1, image=img_tk, anchor="nw")
            else:
                # Fallback: стандартный Tkinter текст
                log_debug(f"Block {i}: block_img is None! Using Tkinter fallback.")
                log_x1 = x1 / scale
                log_y1 = y1 / scale
                log_x2 = draw_x2 / scale
                log_y2 = (y1 + draw_h) / scale
                log_draw_w = draw_w / scale
                
                self.canvas.create_rectangle(
                    log_x1, log_y1, log_x2, log_y2,
                    fill=bg_color,
                    outline="",
                    width=0
                )
                
                font_size_px = max(10, int(orig_line_h * 1.15))
                log_font_size_px = int(font_size_px / scale)
                
                self.canvas.create_text(
                    log_x1 + 3,
                    log_y1 + (orig_line_h / 2) / scale,
                    text=text,
                    fill=fg_color,
                    font=("Segoe UI", -log_font_size_px, "bold"),
                    width=log_draw_w - 6,
                    anchor="w"
                )
                if self.show_highlight:
                    self.canvas.create_rectangle(
                        log_x1 - 2, log_y1 - 2, log_x2 + 2, log_y2 + 2,
                        outline="#007AFF",
                        width=1.5
                    )
                
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
