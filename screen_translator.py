import tkinter as tk
import customtkinter as ctk
import asyncio
import threading
from PIL import ImageGrab, ImageEnhance, ImageTk
import ocr_translation

class AreaSelector(ctk.CTkToplevel):
    def __init__(self, master, on_selected):
        super().__init__(master)
        self.on_selected = on_selected
        
        self.overrideredirect(True)
        self.attributes("-fullscreen", True)
        self.attributes("-topmost", True)
        
        # Grab screenshot of the entire screen
        self.original_screenshot = ImageGrab.grab(all_screens=True)
        
        # Create dark/muted version for "snipping" effect
        enhancer = ImageEnhance.Brightness(self.original_screenshot)
        self.dark_screenshot = enhancer.enhance(0.4)
        
        self.photo_dark = ImageTk.PhotoImage(self.dark_screenshot)
        
        self.canvas = tk.Canvas(self, cursor="cross", highlightthickness=0)
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
            self.on_selected(x1, y1, w, h)
        else:
            self.on_selected(None, None, None, None)

    def cancel(self):
        self.destroy()
        self.on_selected(None, None, None, None)


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
        
        # Top border can be used for dragging
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
        # Resize only right and bottom borders to avoid X/Y coordinates jittering
        self.right_border.bind("<ButtonPress-1>", self.start_resize_right)
        self.right_border.bind("<B1-Motion>", self.do_resize_right)
        
        self.bottom_border.bind("<ButtonPress-1>", self.start_resize_bottom)
        self.bottom_border.bind("<B1-Motion>", self.do_resize_bottom)

    # --- Dragging ---
    def start_drag(self, event):
        self.drag_start_x = event.x_root
        self.drag_start_y = event.y_root
        self.win_start_x = self.winfo_x()
        self.win_start_y = self.winfo_y()

    def do_drag(self, event):
        dx = event.x_root - self.drag_start_x
        dy = event.y_root - self.drag_start_y
        self.geometry(f"+{self.win_start_x + dx}+{self.win_start_y + dy}")

    # --- Resizing (Safe, only width and height, no X/Y shifting) ---
    def start_resize_right(self, event):
        self.resize_start_x = event.x_root
        self.resize_start_width = self.winfo_width()
        
    def do_resize_right(self, event):
        dx = event.x_root - self.resize_start_x
        new_w = max(self.min_width, self.resize_start_width + dx)
        self.geometry(f"{new_w}x{self.winfo_height()}")

    def start_resize_bottom(self, event):
        self.resize_start_y = event.y_root
        self.resize_start_height = self.winfo_height()
        
    def do_resize_bottom(self, event):
        dy = event.y_root - self.resize_start_y
        new_h = max(self.min_height, self.resize_start_height + dy)
        self.geometry(f"{self.winfo_width()}x{new_h}")

    # --- Translating ---
    def translate_area(self):
        if self.is_translating:
            return
        
        self.is_translating = True
        self.btn_translate.configure(text="⌛")
        self.canvas.delete("all")
        
        threading.Thread(target=self._run_translation_thread, daemon=True).start()

    def _run_translation_thread(self):
        # 1. Hide frame to get a clean screenshot
        self.attributes("-alpha", 0.0)
        import time
        time.sleep(0.08)
        
        try:
            canvas_x = self.canvas.winfo_rootx()
            canvas_y = self.canvas.winfo_rooty()
            canvas_w = self.canvas.winfo_width()
            canvas_h = self.canvas.winfo_height()
            
            # 2. Grab screenshot
            screenshot = ImageGrab.grab(bbox=(canvas_x, canvas_y, canvas_x + canvas_w, canvas_y + canvas_h))
        except Exception as e:
            screenshot = None
            print(f"Error capturing screen: {e}")
            
        # 3. Restore visibility
        self.attributes("-alpha", 1.0)
        
        if screenshot is None:
            self.is_translating = False
            self.after(0, lambda: self.btn_translate.configure(text="🔄"))
            return
            
        # 4. Run OCR and Translation
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
            
            x1 = max(0, x1 - 2)
            y1 = max(0, y1 - 2)
            x2 = x2 + 2
            y2 = y2 + 2
            
            self.canvas.create_rectangle(
                x1, y1, x2, y2,
                fill="#0D0D0D",
                outline="#007AFF",
                width=1
            )
            
            self.canvas.create_text(
                (x1 + x2) / 2,
                (y1 + y2) / 2,
                text=text,
                fill="#FFFFFF",
                font=("Segoe UI", 9, "bold"),
                width=x2 - x1,
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
