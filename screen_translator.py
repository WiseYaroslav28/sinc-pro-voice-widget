import tkinter as tk
import customtkinter as ctk
import asyncio
import threading
import ctypes
from PIL import ImageGrab, ImageEnhance, ImageTk
import ocr_translation

def analyze_colors(image, bbox):
    try:
        w, h = image.size
        x1, y1, x2, y2 = bbox
        
        # Ограничиваем координаты
        x1 = max(0, min(w - 1, int(x1)))
        y1 = max(0, min(h - 1, int(y1)))
        x2 = max(0, min(w - 1, int(x2)))
        y2 = max(0, min(h - 1, int(y2)))
        
        if x2 <= x1 or y2 <= y1:
            return "#FFFFFF", "#000000"
            
        cropped = image.crop((x1, y1, x2, y2))
        cw, ch = cropped.size
        
        # Анализируем пиксели по периметру для поиска цвета фона
        edge_pixels = []
        # Верхняя и нижняя строки
        for x in range(cw):
            edge_pixels.append(cropped.getpixel((x, 0)))
            edge_pixels.append(cropped.getpixel((x, ch - 1)))
        # Левая и правая колонки (без углов)
        for y in range(1, ch - 1):
            edge_pixels.append(cropped.getpixel((0, y)))
            edge_pixels.append(cropped.getpixel((cw - 1, y)))
            
        # Среднее значение цвета по периметру
        if edge_pixels:
            r_avg = int(sum(p[0] for p in edge_pixels) / len(edge_pixels))
            g_avg = int(sum(p[1] for p in edge_pixels) / len(edge_pixels))
            b_avg = int(sum(p[2] for p in edge_pixels) / len(edge_pixels))
            bg_rgb = (r_avg, g_avg, b_avg)
        else:
            bg_rgb = (255, 255, 255)
            
        # Находим самый контрастный пиксель внутри для цвета текста
        pixels = list(cropped.getdata())
        max_dist = -1
        fg_rgb = (0, 0, 0)
        
        for p in pixels:
            # Считаем евклидово расстояние
            dist = (p[0] - bg_rgb[0])**2 + (p[1] - bg_rgb[1])**2 + (p[2] - bg_rgb[2])**2
            if dist > max_dist:
                max_dist = dist
                fg_rgb = p[:3]
                
        # Если контраст очень маленький, принудительно делаем черный/белый
        if max_dist < 400: # порог контрастности
            brightness = (bg_rgb[0] * 299 + bg_rgb[1] * 587 + bg_rgb[2] * 114) / 1000
            if brightness < 128:
                fg_rgb = (255, 255, 255)
            else:
                fg_rgb = (0, 0, 0)
                
        bg_hex = f"#{bg_rgb[0]:02x}{bg_rgb[1]:02x}{bg_rgb[2]:02x}"
        fg_hex = f"#{fg_rgb[0]:02x}{fg_rgb[1]:02x}{fg_rgb[2]:02x}"
        
        # Защита от прозрачного цвета tkinter
        if bg_hex == "#000001":
            bg_hex = "#000002"
            
        return bg_hex, fg_hex
    except Exception as e:
        print(f"Error in analyze_colors: {e}")
        return "#FFFFFF", "#000000"

class AreaSelector(ctk.CTkToplevel):
    def __init__(self, master, on_selected):
        super().__init__(master)
        self.on_selected = on_selected
        
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        
        # Get virtual screen metrics for multi-monitor support
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
            
        # Manually set geometry to cover the entire virtual screen
        self.geometry(f"{self.vw}x{self.vh}+{self.vx}+{self.vy}")
        
        # Grab screenshot of all screens
        self.original_screenshot = ImageGrab.grab(all_screens=True)
        
        # Create dark version for backdrop
        enhancer = ImageEnhance.Brightness(self.original_screenshot)
        self.dark_screenshot = enhancer.enhance(0.4)
        
        self.photo_dark = ImageTk.PhotoImage(self.dark_screenshot)
        
        # Canvas fills the window
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
        
        # Lift and focus
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
            # Map back to virtual screen coordinates
            abs_x = x1 + self.vx
            abs_y = y1 + self.vy
            
            # Crop the target image from the original screenshot
            cropped_image = self.original_screenshot.crop((x1, y1, x2, y2))
            
            self.on_selected(abs_x, abs_y, w, h, cropped_image)
        else:
            self.on_selected(None, None, None, None, None)

    def cancel(self):
        self.destroy()
        self.on_selected(None, None, None, None, None)


class ScreenTranslatorFrame(ctk.CTkToplevel):
    def __init__(self, master, translate_to="ru"):
        super().__init__(master)
        self.master = master
        self.translate_to = translate_to
        
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.attributes("-transparentcolor", "#000001")
        self.configure(fg_color="#000001")
        
        self.min_width = 150
        self.min_height = 100
        self.border_width = 4
        
        self.show_translation = True
        self.last_translated_data = []
        self.is_translating = False
        
        # Borders: left/top are decorative, right/bottom are for resizing
        self.left_border = ctk.CTkFrame(self, width=self.border_width, fg_color="#007AFF")
        self.left_border.pack(side="left", fill="y")
        
        self.right_border = ctk.CTkFrame(self, width=self.border_width, fg_color="#007AFF", cursor="size_we")
        self.right_border.pack(side="right", fill="y")
        
        self.center_container = ctk.CTkFrame(self, fg_color="transparent")
        self.center_container.pack(side="top", fill="both", expand=True)
        
        # Top border is used for window dragging
        self.top_border = ctk.CTkFrame(self.center_container, height=self.border_width, fg_color="#007AFF", cursor="fleur")
        self.top_border.pack(side="top", fill="x")
        
        self.bottom_border = ctk.CTkFrame(self.center_container, height=self.border_width, fg_color="#007AFF", cursor="size_ns")
        self.bottom_border.pack(side="bottom", fill="x")
        
        # Toolbar
        self.toolbar = ctk.CTkFrame(self.center_container, height=28, fg_color="#181818", corner_radius=0)
        self.toolbar.pack(side="top", fill="x")
        self.toolbar.pack_propagate(False)
        
        # Transparent Canvas
        self.canvas = tk.Canvas(self.center_container, bg="#000001", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        
        self.setup_toolbar()
        self.setup_drag_and_resize()
        
        self.bind("<Escape>", lambda e: self.destroy())

    def setup_toolbar(self):
        self.lbl_title = ctk.CTkLabel(self.toolbar, text=" ⛶ SINC TRANSLATE", font=ctk.CTkFont(size=10, weight="bold"), text_color="#007AFF")
        self.lbl_title.pack(side="left", padx=5)
        
        # Drag binds
        self.toolbar.bind("<ButtonPress-1>", self.start_drag)
        self.toolbar.bind("<B1-Motion>", self.do_drag)
        self.lbl_title.bind("<ButtonPress-1>", self.start_drag)
        self.lbl_title.bind("<B1-Motion>", self.do_drag)
        self.top_border.bind("<ButtonPress-1>", self.start_drag)
        self.top_border.bind("<B1-Motion>", self.do_drag)
        
        # Controls
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
        
        self.btn_translate = ctk.CTkButton(self.toolbar, text="🔄", width=24, height=22, corner_radius=4,
                                           fg_color="transparent", hover_color="#333", text_color="#aaa", font=ctk.CTkFont(size=12),
                                           command=self.translate_area)
        self.btn_translate.pack(side="right", padx=3, pady=3)

    def setup_drag_and_resize(self):
        # Resize only right and bottom borders
        self.right_border.bind("<ButtonPress-1>", self.start_resize_right)
        self.right_border.bind("<B1-Motion>", self.do_resize_right)
        self.right_border.bind("<ButtonRelease-1>", lambda e: self.translate_area())
        
        self.bottom_border.bind("<ButtonPress-1>", self.start_resize_bottom)
        self.bottom_border.bind("<B1-Motion>", self.do_resize_bottom)
        self.bottom_border.bind("<ButtonRelease-1>", lambda e: self.translate_area())
        
        # Binds to trigger auto-translation when finished dragging
        self.toolbar.bind("<ButtonRelease-1>", lambda e: self.translate_area())
        self.lbl_title.bind("<ButtonRelease-1>", lambda e: self.translate_area())
        self.top_border.bind("<ButtonRelease-1>", lambda e: self.translate_area())

    # --- Dragging ---
    def start_drag(self, event):
        self.drag_start_x = event.x_root
        self.drag_start_y = event.y_root
        self.win_start_x = self.winfo_rootx()
        self.win_start_y = self.winfo_rooty()

    def do_drag(self, event):
        dx = event.x_root - self.drag_start_x
        dy = event.y_root - self.drag_start_y
        self.geometry(f"+{self.win_start_x + dx}+{self.win_start_y + dy}")

    # --- Resizing (Fixed with absolute X/Y to avoid jumping) ---
    def start_resize_right(self, event):
        self.resize_start_x = event.x_root
        self.resize_start_width = self.winfo_width()
        self.resize_win_x = self.winfo_rootx()
        self.resize_win_y = self.winfo_rooty()
        
    def do_resize_right(self, event):
        dx = event.x_root - self.resize_start_x
        new_w = max(self.min_width, self.resize_start_width + dx)
        self.geometry(f"{new_w}x{self.winfo_height()}+{self.resize_win_x}+{self.resize_win_y}")

    def start_resize_bottom(self, event):
        self.resize_start_y = event.y_root
        self.resize_start_height = self.winfo_height()
        self.resize_win_x = self.winfo_rootx()
        self.resize_win_y = self.winfo_rooty()
        
    def do_resize_bottom(self, event):
        dy = event.y_root - self.resize_start_y
        new_h = max(self.min_height, self.resize_start_height + dy)
        self.geometry(f"{self.winfo_width()}x{new_h}+{self.resize_win_x}+{self.resize_win_y}")

    # --- Translating ---
    def translate_precropped(self, cropped_image):
        if self.is_translating:
            return
        self.is_translating = True
        self.btn_translate.configure(text="⌛")
        self.canvas.delete("all")
        
        # Save screenshot for color analysis
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
        # Force redraw windows to ensure coordinates are updated
        self.update_idletasks()
        
        # Hide frame to capture clean screen
        self.attributes("-alpha", 0.0)
        import time
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
            
        # Save screenshot for color analysis
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
            return
            
        for item in self.last_translated_data:
            text = item["text"]
            x1, y1, x2, y2 = item["bbox"]
            
            # Analyze background and foreground text colors (Google Lens style)
            bg_color = "#FFFFFF"
            fg_color = "#000000"
            if hasattr(self, "current_screenshot") and self.current_screenshot:
                bg_color, fg_color = analyze_colors(self.current_screenshot, (x1, y1, x2, y2))
            
            # Draw seamless background rectangle without outline (erases original text)
            self.canvas.create_rectangle(
                x1 - 1, y1 - 1, x2 + 1, y2 + 1,
                fill=bg_color,
                outline="",
                width=0
            )
            
            # Draw translated text with the original color
            self.canvas.create_text(
                (x1 + x2) / 2,
                (y1 + y2) / 2,
                text=text,
                fill=fg_color,
                font=("Segoe UI", 9, "bold"),
                width=x2 - x1 + 4,
                anchor="center"
            )

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
