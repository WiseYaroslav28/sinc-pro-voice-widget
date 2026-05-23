import tkinter as tk
import customtkinter as ctk
import asyncio
import threading
from PIL import ImageGrab
import ocr_translation

class ScreenTranslatorFrame(ctk.CTkToplevel):
    def __init__(self, master, translate_to="ru"):
        super().__init__(master)
        self.master = master
        self.translate_to = translate_to
        
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.attributes("-transparentcolor", "#000001")
        self.configure(fg_color="#000001")
        
        # Initial size and position
        self.geometry("450x300+300+300")
        self.min_width = 250
        self.min_height = 150
        self.border_width = 4
        
        self.show_translation = True
        self.last_translated_data = []
        self.is_translating = False
        
        # Create borders (left, right, top, bottom) for resizing
        self.left_border = ctk.CTkFrame(self, width=self.border_width, fg_color="#007AFF", cursor="size_we")
        self.left_border.pack(side="left", fill="y")
        
        self.right_border = ctk.CTkFrame(self, width=self.border_width, fg_color="#007AFF", cursor="size_we")
        self.right_border.pack(side="right", fill="y")
        
        self.center_container = ctk.CTkFrame(self, fg_color="transparent")
        self.center_container.pack(side="top", fill="both", expand=True)
        
        self.top_border = ctk.CTkFrame(self.center_container, height=self.border_width, fg_color="#007AFF", cursor="size_ns")
        self.top_border.pack(side="top", fill="x")
        
        self.bottom_border = ctk.CTkFrame(self.center_container, height=self.border_width, fg_color="#007AFF", cursor="size_ns")
        self.bottom_border.pack(side="bottom", fill="x")
        
        # Toolbar
        self.toolbar = ctk.CTkFrame(self.center_container, height=28, fg_color="#181818", corner_radius=0)
        self.toolbar.pack(side="top", fill="x")
        self.toolbar.pack_propagate(False)
        
        # Transparent Canvas for drawings
        self.canvas = tk.Canvas(self.center_container, bg="#000001", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        
        self.setup_toolbar()
        self.setup_drag_and_resize()
        
        # Register global hotkey in main app to close on ESC
        self.bind("<Escape>", lambda e: self.destroy())

    def setup_toolbar(self):
        # Drag handler title
        self.lbl_title = ctk.CTkLabel(self.toolbar, text=" ⛶ SINC TRANSLATE", font=ctk.CTkFont(size=10, weight="bold"), text_color="#007AFF")
        self.lbl_title.pack(side="left", padx=5)
        
        # Bind drag events to title and toolbar
        self.toolbar.bind("<ButtonPress-1>", self.start_drag)
        self.toolbar.bind("<B1-Motion>", self.do_drag)
        self.lbl_title.bind("<ButtonPress-1>", self.start_drag)
        self.lbl_title.bind("<B1-Motion>", self.do_drag)
        
        # Controls on the right side
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
        # Resize right
        self.right_border.bind("<ButtonPress-1>", self.start_resize_right)
        self.right_border.bind("<B1-Motion>", self.do_resize_right)
        
        # Resize bottom
        self.bottom_border.bind("<ButtonPress-1>", self.start_resize_bottom)
        self.bottom_border.bind("<B1-Motion>", self.do_resize_bottom)
        
        # Resize left
        self.left_border.bind("<ButtonPress-1>", self.start_resize_left)
        self.left_border.bind("<B1-Motion>", self.do_resize_left)
        
        # Resize top
        self.top_border.bind("<ButtonPress-1>", self.start_resize_top)
        self.top_border.bind("<B1-Motion>", self.do_resize_top)

    # --- Window Dragging Logic ---
    def start_drag(self, event):
        self.drag_start_x = event.x_root
        self.drag_start_y = event.y_root
        self.win_start_x = self.winfo_x()
        self.win_start_y = self.winfo_y()

    def do_drag(self, event):
        dx = event.x_root - self.drag_start_x
        dy = event.y_root - self.drag_start_y
        self.geometry(f"+{self.win_start_x + dx}+{self.win_start_y + dy}")

    # --- Window Resizing Logic ---
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

    def start_resize_left(self, event):
        self.resize_start_x = event.x_root
        self.resize_start_width = self.winfo_width()
        self.resize_start_win_x = self.winfo_x()
        
    def do_resize_left(self, event):
        dx = event.x_root - self.resize_start_x
        new_w = self.resize_start_width - dx
        if new_w >= self.min_width:
            new_x = self.resize_start_win_x + dx
            self.geometry(f"{new_w}x{self.winfo_height()}+{new_x}+{self.winfo_y()}")

    def start_resize_top(self, event):
        self.resize_start_y = event.y_root
        self.resize_start_height = self.winfo_height()
        self.resize_start_win_y = self.winfo_y()
        
    def do_resize_top(self, event):
        dy = event.y_root - self.resize_start_y
        new_h = self.resize_start_height - dy
        if new_h >= self.min_height:
            new_y = self.resize_start_win_y + dy
            self.geometry(f"{self.winfo_width()}x{new_h}+{self.winfo_x()}+{new_y}")

    # --- Core Translator Functions ---
    def translate_area(self):
        if self.is_translating:
            return
        
        self.is_translating = True
        self.btn_translate.configure(text="⌛")
        self.canvas.delete("all")
        
        # We need to run the screenshot, ocr and translation asynchronously
        threading.Thread(target=self._run_translation_thread, daemon=True).start()

    def _run_translation_thread(self):
        # 1. Hide frame to get a clean screenshot of windows beneath
        self.attributes("-alpha", 0.0)
        # Give Windows a moment to hide the window
        import time
        time.sleep(0.08)
        
        # Get coordinates of the transparent canvas
        try:
            canvas_x = self.canvas.winfo_rootx()
            canvas_y = self.canvas.winfo_rooty()
            canvas_w = self.canvas.winfo_width()
            canvas_h = self.canvas.winfo_height()
            
            # 2. Grab screenshot of the area
            screenshot = ImageGrab.grab(bbox=(canvas_x, canvas_y, canvas_x + canvas_w, canvas_y + canvas_h))
        except Exception as e:
            screenshot = None
            print(f"Error capturing screen: {e}")
            
        # 3. Restore visibility immediately
        self.attributes("-alpha", 1.0)
        
        if screenshot is None:
            self.is_translating = False
            self.after(0, lambda: self.btn_translate.configure(text="🔄"))
            return
            
        # 4. Perform OCR and translation
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
            
            # Slightly expand bbox to completely cover original text
            x1 = max(0, x1 - 2)
            y1 = max(0, y1 - 2)
            x2 = x2 + 2
            y2 = y2 + 2
            
            # Draw dark background patch
            self.canvas.create_rectangle(
                x1, y1, x2, y2,
                fill="#0D0D0D", # Matches application dark theme
                outline="#007AFF", # Thin blue outline to look high-tech and premium
                width=1
            )
            
            # Draw translated text
            # Segoe UI is clean and built-in on Windows.
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
        
        # Combine all translation blocks into one structured text
        combined_text = "\n".join([item["text"] for item in self.last_translated_data])
        
        # Forward text to main app's TTS system
        # Check if master has update_text_and_play
        if hasattr(self.master, "update_text_and_play"):
            self.master.update_text_and_play(combined_text)
        elif hasattr(self.master, "master") and hasattr(self.master.master, "update_text_and_play"):
            # Fallback for nested widgets
            self.master.master.update_text_and_play(combined_text)
