import customtkinter as ctk
import keyboard
import pyperclip
import asyncio
import edge_tts
import subprocess
import os
import threading
import time
import re
import json
import ctypes
import queue
import hashlib
import sys

def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

# Configuration
VOICES = {
    "Светлана (RU)": "ru-RU-SvetlanaNeural",
    "Дмитрий (RU)": "ru-RU-DmitryNeural",
    "Guy (EN)": "en-US-GuyNeural",
    "Aria (EN)": "en-US-AriaNeural",
    "Katja (DE)": "de-DE-KatjaNeural",
    "Denise (FR)": "fr-FR-DeniseNeural",
    "Alvaro (ES)": "es-ES-AlvaroNeural",
    "Xiaoxiao (CN)": "zh-CN-XiaoxiaoNeural"
}
VOICE_AVATARS = {
    "Светлана (RU)": "🇷🇺",
    "Дмитрий (RU)": "🇷🇺",
    "Guy (EN)": "🇺🇸",
    "Aria (EN)": "🇺🇸",
    "Katja (DE)": "🇩🇪",
    "Denise (FR)": "🇫🇷",
    "Alvaro (ES)": "🇪🇸",
    "Xiaoxiao (CN)": "🇨🇳"
}
# Persistent Settings Path
if getattr(sys, 'frozen', False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

SETTINGS_FILE = os.path.join(APP_DIR, "voice_settings.json")
CREATE_NO_WINDOW = 0x08000000

class VoiceAssistantApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("SINC PRO")
        self.attributes("-topmost", True)
        self.configure(fg_color="#0D0D0D") 
        
        # State
        self.current_voice = "Светлана (RU)"
        self.current_rate = 1.0
        self.is_speaking = False
        self.is_paused = False
        self.stop_requested = False
        self.playback_process = None
        self.item_queue = queue.Queue()
        self.last_text_hash = ""
        self.current_sentences = []
        self.sentence_offsets = []
        self.display_mode = "full" # "full", "mini", "micro"
        self.previous_mode = "mini"
        self.is_scrubbing = False
        self.drag_data = {"x": 0, "y": 0}
        self.overlay_frame = None
        self.current_play_ratio = 0.0
        self.current_sentence_idx = 0
        self.font_size = 15
        self.markdown_enabled = True
        self.mini_drawer_open = False
        self.current_overlay = None

        self.load_settings()
        self.setup_ui_once()
        self.start_hotkey_listener()
        self.protocol("WM_DELETE_WINDOW", self.on_closing)
        
        self.apply_mode("full", initial=True)
        
        # Set window icon
        try:
            icon_p = resource_path("sinc_icon.ico")
            if os.path.exists(icon_p):
                self.iconbitmap(icon_p)
        except: pass

    def apply_dark_titlebar(self):
        if sys.platform.startswith("win"):
            try:
                self.update_idletasks()
                hwnd = ctypes.windll.user32.GetParent(self.winfo_id())
                if hwnd == 0:
                    hwnd = self.winfo_id()
                value = ctypes.c_int(1)
                ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 19, ctypes.byref(value), ctypes.sizeof(value))
                ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 20, ctypes.byref(value), ctypes.sizeof(value))
            except Exception:
                pass

    def load_settings(self):
        try:
            if os.path.exists(SETTINGS_FILE):
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.current_voice = data.get("voice", "Светлана (RU)")
                    self.current_rate = data.get("rate", 1.0)
                    self.font_size = data.get("font_size", 15)
                    self.markdown_enabled = data.get("markdown_enabled", True)
        except: pass

    def save_settings(self):
        try:
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump({
                    "voice": self.current_voice, 
                    "rate": self.current_rate,
                    "font_size": self.font_size,
                    "markdown_enabled": self.markdown_enabled
                }, f)
        except: pass

    def setup_ui_once(self):
        self.grid_columnconfigure(0, weight=1)

        # --- Top Bar (Shared) ---
        self.top_bar = ctk.CTkFrame(self, fg_color="transparent")
        self.top_bar.grid(row=0, column=0, sticky="nsew", padx=10, pady=5)
        self.top_bar.grid_columnconfigure(3, weight=1)
        self.top_bar.grid_rowconfigure(0, weight=1)

        # Drag handle (left)
        self.drag_h = ctk.CTkLabel(self.top_bar, text="⠿", text_color="#555", cursor="fleur", font=ctk.CTkFont(size=18))
        self.drag_h.bind("<ButtonPress-1>", self.start_drag)
        self.drag_h.bind("<B1-Motion>", self.do_drag)

        # Mode Toggles
        self.btn_to_full = ctk.CTkButton(self.top_bar, text="🗖", width=30, height=30, corner_radius=6, 
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=20), command=lambda: self.apply_mode("full"))
        
        self.btn_to_mini = ctk.CTkButton(self.top_bar, text="⛶", width=30, height=30, corner_radius=6, 
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=20), command=lambda: self.apply_mode("mini"))

        self.btn_to_micro = ctk.CTkButton(self.top_bar, text="-", width=30, height=30, corner_radius=6, 
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=22, weight="bold"), command=self.enter_micro_mode)

        self.btn_restore = ctk.CTkButton(self.top_bar, text="⛶", width=30, height=30, corner_radius=6, 
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=20), command=self.restore_mode)

        self.btn_text_drawer = ctk.CTkButton(self.top_bar, text="📖", width=30, height=30, corner_radius=6,
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=18), command=self.toggle_text_drawer)

        self.btn_settings = ctk.CTkButton(self.top_bar, text="⚙", width=30, height=30, corner_radius=6, 
                                   fg_color="transparent", hover_color="#333", text_color="#888", font=ctk.CTkFont(size=20), command=self.show_appearance_overlay)

        # Status-bar tooltips
        def set_status(txt):
            if not self.is_speaking:
                self.c_status.configure(text=txt, text_color="#aaa")
                
        def reset_status():
            if not self.is_speaking:
                self.c_status.configure(text="Выделите текст и нажмите Ctrl+Shift", text_color="#888")

        self.btn_to_full.bind("<Enter>", lambda e: set_status("Открыть редактор (🗖)"))
        self.btn_to_full.bind("<Leave>", lambda e: reset_status())
        
        self.btn_to_mini.bind("<Enter>", lambda e: set_status("Свернуть в плеер-панель (⛶)"))
        self.btn_to_mini.bind("<Leave>", lambda e: reset_status())
        
        self.btn_to_micro.bind("<Enter>", lambda e: set_status("Свернуть в мини-виджет (-)"))
        self.btn_to_micro.bind("<Leave>", lambda e: reset_status())
        
        self.btn_restore.bind("<Enter>", lambda e: set_status("Открыть плеер-панель (⛶)"))
        self.btn_restore.bind("<Leave>", lambda e: reset_status())

        self.btn_text_drawer.bind("<Enter>", lambda e: set_status("Показать/скрыть текст (📖)"))
        self.btn_text_drawer.bind("<Leave>", lambda e: reset_status())

        # Micro mode controls
        self.play_micro = ctk.CTkButton(self.top_bar, text="▶", width=30, height=30, corner_radius=6, fg_color="#007AFF", font=ctk.CTkFont(size=18), command=self.toggle_play_pause)
        self.stop_micro = ctk.CTkButton(self.top_bar, text="■", width=30, height=30, corner_radius=6, fg_color="#c0392b", font=ctk.CTkFont(size=18), command=self.stop_speech)

        # Full mode header
        self.full_header = ctk.CTkFrame(self.top_bar, fg_color="transparent")
        ctk.CTkLabel(self.full_header, text="SINC", font=ctk.CTkFont(size=24, weight="bold"), text_color="#007AFF").pack(side="left")
        ctk.CTkLabel(self.full_header, text="by Wise Yaroslav", font=ctk.CTkFont(size=10), text_color="#444").pack(side="left", padx=10, pady=(6,0))

        # Mini mode center (Instruction / Scrubber)
        self.mini_center = ctk.CTkFrame(self.top_bar, fg_color="transparent", cursor="fleur")
        self.c_status = ctk.CTkLabel(self.mini_center, text="Выделите текст и нажмите Ctrl+Shift", font=ctk.CTkFont(size=12), text_color="#888", cursor="fleur")
        # Bind center area for dragging
        self.mini_center.bind("<ButtonPress-1>", self.start_drag)
        self.mini_center.bind("<B1-Motion>", self.do_drag)
        self.c_status.bind("<ButtonPress-1>", self.start_drag)
        self.c_status.bind("<B1-Motion>", self.do_drag)

        # Right buttons in Top Bar (Mini mode)
        self.right_frame = ctk.CTkFrame(self.top_bar, fg_color="transparent")
        
        self.btn_mini_voice = ctk.CTkButton(self.right_frame, text="🔊", width=30, height=30, corner_radius=6, fg_color="#222", hover_color="#333", font=ctk.CTkFont(size=16), command=self.show_voice_overlay)
        self.btn_mini_speed = ctk.CTkButton(self.right_frame, text=f"{self.current_rate}x", width=45, height=30, corner_radius=6, fg_color="#222", hover_color="#333", font=ctk.CTkFont(size=12, weight="bold"), command=self.show_speed_overlay)
        self.c_action_btn = ctk.CTkButton(self.right_frame, text="■", width=30, height=30, corner_radius=6, fg_color="#c0392b", font=ctk.CTkFont(size=18), command=self.stop_speech)
        self.play_mini = ctk.CTkButton(self.right_frame, text="▶", width=30, height=30, corner_radius=6, fg_color="#007AFF", font=ctk.CTkFont(size=18), command=self.toggle_play_pause)

        # Order: Voice -> Speed -> Stop -> Play
        self.btn_mini_voice.pack(side="left", padx=2)
        self.btn_mini_speed.pack(side="left", padx=2)
        self.c_action_btn.pack(side="left", padx=2)
        self.play_mini.pack(side="left", padx=2)
        self.c_action_btn.pack_forget() # Hidden initially

        # --- Mini Scrubber ---
        self.scrub_container_mini = ctk.CTkFrame(self, fg_color="transparent", height=20, cursor="hand2")
        self.scrub_container_mini.pack_propagate(False) 
        self.buffer_prog_mini = ctk.CTkProgressBar(self.scrub_container_mini, height=6, fg_color="#222", progress_color="#007AFF")
        self.buffer_prog_mini.place(relx=0.5, rely=0.5, anchor="center", relwidth=1.0)
        self.buffer_prog_mini.set(0)
        
        self.scrub_thumb_mini = ctk.CTkButton(self.scrub_container_mini, text="", width=14, height=14, corner_radius=7, fg_color="#E74C3C", hover_color="#C0392B", border_width=0)
        self.scrub_thumb_mini.place(relx=0, rely=0.5, anchor="center")

        self.scrub_container_mini.bind("<ButtonPress-1>", lambda e: self.on_scrub_start(e, "mini"))
        self.scrub_container_mini.bind("<B1-Motion>", lambda e: self.on_scrub_drag(e, "mini"))
        self.scrub_container_mini.bind("<ButtonRelease-1>", self.on_scrub_end)
        self.scrub_thumb_mini.bind("<ButtonPress-1>", lambda e: self.on_scrub_start(e, "mini"))
        self.scrub_thumb_mini.bind("<B1-Motion>", lambda e: self.on_scrub_drag(e, "mini"))
        self.scrub_thumb_mini.bind("<ButtonRelease-1>", self.on_scrub_end)

        # --- Full Mode Elements ---
        self.text_box = ctk.CTkTextbox(self, font=("Inter", self.font_size), fg_color="#111", border_width=0, text_color="#BBBBCC", padx=20, pady=20)
        self.text_box.bind("<Control-MouseWheel>", self.on_zoom)
        
        # Access underlying tkinter widget to bypass font restrictions
        self.text_box._textbox.tag_configure("md_bold", font=("Inter", self.font_size, "bold"), foreground="#007AFF")
        self.text_box._textbox.tag_configure("md_h1", font=("Inter", int(self.font_size * 1.5), "bold"), foreground="#FFFFFF")
        self.text_box._textbox.tag_configure("md_h2", font=("Inter", int(self.font_size * 1.3), "bold"), foreground="#FFFFFF")
        self.text_box._textbox.tag_configure("md_hide", elide=True)
        self.text_box.tag_config("buffered", background="#222222") # Subtle gray highlight
        self.text_box.tag_config("playing", background="#3d3d00")  # Gold highlighter effect
        
        # Ensure highlights don't overwrite text colors (priority)
        self.text_box._textbox.tag_lower("playing")
        self.text_box._textbox.tag_lower("buffered")

        self.footer = ctk.CTkFrame(self, fg_color="#181818", corner_radius=15, height=80)
        self.footer.grid_columnconfigure((0,1,2,3), weight=1) # Ensure columns stretch properly

        self.btn_voice = ctk.CTkButton(self.footer, text=f"🔊 {self.current_voice.split(' ')[0]}", width=40, height=35, corner_radius=10, fg_color="#222", hover_color="#333", font=ctk.CTkFont(size=12), command=self.show_voice_overlay)
        self.btn_voice.grid(row=1, column=0, padx=15, pady=(15, 15), sticky="w")

        self.btn_speed = ctk.CTkButton(self.footer, text=f"⚡ {self.current_rate}x", width=40, height=35, corner_radius=10, fg_color="#222", hover_color="#333", font=ctk.CTkFont(size=12), command=self.show_speed_overlay)
        self.btn_speed.grid(row=1, column=1, padx=0, pady=(15, 15), sticky="w")

        self.btn_stop = ctk.CTkButton(self.footer, text="■", width=40, height=35, corner_radius=10, fg_color="#c0392b", hover_color="#e74c3c", font=ctk.CTkFont(size=22), command=self.stop_speech)
        self.btn_stop.grid(row=1, column=2, padx=10, pady=(15, 15))

        self.play_main = ctk.CTkButton(self.footer, text="▶ ПЛЕЙ", width=90, height=35, corner_radius=10, fg_color="#007AFF", font=ctk.CTkFont(size=14, weight="bold"), command=self.toggle_play_pause)
        self.play_main.grid(row=1, column=3, padx=15, pady=(15, 15), sticky="e")

        # --- Full Scrubber ---
        self.scrub_container_full = ctk.CTkFrame(self.footer, fg_color="transparent", height=20, cursor="hand2")
        self.buffer_prog_full = ctk.CTkProgressBar(self.scrub_container_full, height=6, fg_color="#222", progress_color="#007AFF")
        self.buffer_prog_full.place(relx=0.5, rely=0.5, anchor="center", relwidth=1.0)
        self.buffer_prog_full.set(0)
        
        self.scrub_thumb_full = ctk.CTkButton(self.scrub_container_full, text="", width=14, height=14, corner_radius=7, fg_color="#E74C3C", hover_color="#C0392B", border_width=0)
        self.scrub_thumb_full.place(relx=0, rely=0.5, anchor="center")

        self.scrub_container_full.bind("<ButtonPress-1>", lambda e: self.on_scrub_start(e, "full"))
        self.scrub_container_full.bind("<B1-Motion>", lambda e: self.on_scrub_drag(e, "full"))
        self.scrub_container_full.bind("<ButtonRelease-1>", self.on_scrub_end)
        self.scrub_thumb_full.bind("<ButtonPress-1>", lambda e: self.on_scrub_start(e, "full"))
        self.scrub_thumb_full.bind("<B1-Motion>", lambda e: self.on_scrub_drag(e, "full"))
        self.scrub_thumb_full.bind("<ButtonRelease-1>", self.on_scrub_end)
        
        self.scrub_container_full.grid(row=0, column=0, columnspan=4, sticky="ew", padx=15, pady=(15, 0))

    def apply_mode(self, mode, initial=False):
        if not initial:
            self.withdraw()
            self.close_overlay()
            
        self.display_mode = mode
        
        # Reset all layout elements first
        self.text_box.grid_forget()
        self.footer.grid_forget()
        self.full_header.grid_forget()
        self.drag_h.grid_forget()
        self.btn_to_full.grid_forget()
        self.btn_to_mini.grid_forget()
        self.btn_to_micro.grid_forget()
        self.btn_restore.grid_forget()
        self.btn_settings.grid_forget()
        self.play_micro.grid_forget()
        self.stop_micro.grid_forget()
        self.mini_center.grid_forget()
        self.right_frame.grid_forget()
        self.scrub_container_mini.pack_forget()
        if hasattr(self, 'btn_text_drawer'):
            self.btn_text_drawer.grid_forget()
        self.mini_drawer_open = False
        if hasattr(self, 'btn_text_drawer'):
            self.btn_text_drawer.configure(fg_color="#222")
            
        if mode == "full":
            self.overrideredirect(False)
            self.geometry("480x650")
            self.apply_dark_titlebar()
            
            self.grid_rowconfigure(0, weight=0)
            self.grid_rowconfigure(1, weight=1)
            self.grid_rowconfigure(2, weight=0)
            
            self.btn_to_mini.grid(row=0, column=0, padx=5)
            self.btn_to_micro.grid(row=0, column=1, padx=5)
            self.full_header.grid(row=0, column=2, sticky="w", padx=10)
            self.btn_settings.grid(row=0, column=4, padx=5, sticky="e")
            
            # Configure top_bar column weights for full mode
            self.top_bar.grid_columnconfigure(0, weight=0)
            self.top_bar.grid_columnconfigure(1, weight=0)
            self.top_bar.grid_columnconfigure(2, weight=0)
            self.top_bar.grid_columnconfigure(3, weight=1) # spacer
            self.top_bar.grid_columnconfigure(4, weight=0)
            self.top_bar.grid_columnconfigure(5, weight=0)
            
            self.text_box.grid(row=1, column=0, padx=20, pady=0, sticky="nsew")
            self.footer.grid(row=2, column=0, sticky="ew", padx=20, pady=20)
            
        elif mode == "mini":
            self.overrideredirect(True)
            self.geometry("480x60")
            
            self.grid_rowconfigure(0, weight=1)
            self.grid_rowconfigure(1, weight=0)
            self.grid_rowconfigure(2, weight=0)
            
            self.drag_h.grid(row=0, column=0, padx=5)
            self.btn_to_micro.grid(row=0, column=1, padx=5)
            self.btn_to_full.grid(row=0, column=2, padx=5)
            self.btn_text_drawer.grid(row=0, column=3, padx=5)
            
            self.mini_center.grid(row=0, column=4, sticky="ew", padx=10)
            self.right_frame.grid(row=0, column=5, padx=5)
            
            # Configure top_bar column weights for mini mode
            self.top_bar.grid_columnconfigure(0, weight=0)
            self.top_bar.grid_columnconfigure(1, weight=0)
            self.top_bar.grid_columnconfigure(2, weight=0)
            self.top_bar.grid_columnconfigure(3, weight=0)
            self.top_bar.grid_columnconfigure(4, weight=1) # mini_center expanded
            self.top_bar.grid_columnconfigure(5, weight=0)
            
            if self.is_speaking:
                self.scrub_container_mini.pack(in_=self.mini_center, fill="x", expand=True)
                self.c_status.pack_forget()
            else:
                self.c_status.pack(expand=True)
                
        elif mode == "micro":
            self.overrideredirect(True)
            self.geometry("210x60")
            
            self.grid_rowconfigure(0, weight=1)
            self.grid_rowconfigure(1, weight=0)
            self.grid_rowconfigure(2, weight=0)
            
            self.drag_h.grid(row=0, column=0, padx=5)
            self.btn_restore.grid(row=0, column=1, padx=3)
            self.btn_to_full.grid(row=0, column=2, padx=3)
            self.play_micro.grid(row=0, column=5, padx=3)
            
            # Configure top_bar column weights for micro mode
            self.top_bar.grid_columnconfigure(0, weight=0)
            self.top_bar.grid_columnconfigure(1, weight=0)
            self.top_bar.grid_columnconfigure(2, weight=0)
            self.top_bar.grid_columnconfigure(3, weight=1) # spacer
            self.top_bar.grid_columnconfigure(4, weight=0)
            self.top_bar.grid_columnconfigure(5, weight=0)
            
            if self.is_speaking:
                self.stop_micro.grid(row=0, column=4, padx=3)
            
        if not initial:
            self.after(50, self.deiconify)
            
    def toggle_text_drawer(self):
        if self.display_mode != "mini":
            return
        self.mini_drawer_open = not self.mini_drawer_open
        if self.mini_drawer_open:
            self.geometry("480x350")
            self.grid_rowconfigure(1, weight=1)
            self.text_box.grid(row=1, column=0, padx=10, pady=(5, 10), sticky="nsew")
            self.btn_text_drawer.configure(fg_color="#007AFF")
        else:
            self.geometry("480x60")
            self.grid_rowconfigure(1, weight=0)
            self.text_box.grid_forget()
            self.btn_text_drawer.configure(fg_color="#222")

    def enter_micro_mode(self):
        if self.display_mode in ["full", "mini"]:
            self.previous_mode = self.display_mode
        self.apply_mode("micro")

    def restore_mode(self):
        self.apply_mode(self.previous_mode)

    def start_drag(self, event):
        if self.display_mode == "full": return
        self.drag_data["x"] = event.x
        self.drag_data["y"] = event.y

    def do_drag(self, event):
        if self.display_mode == "full": return
        x = self.winfo_x() + (event.x - self.drag_data["x"])
        y = self.winfo_y() + (event.y - self.drag_data["y"])
        self.geometry(f"+{x}+{y}")

    # --- Custom Scrubbing Logic ---
    def on_scrub_start(self, event, source):
        self.is_scrubbing = True
        self.on_scrub_drag(event, source)

    def on_scrub_drag(self, event, source):
        if not self.is_scrubbing: return
        container = self.scrub_container_full if source == "full" else self.scrub_container_mini
        x = event.x_root - container.winfo_rootx()
        w = container.winfo_width()
        if w <= 0: return
        p = max(0.0, min(1.0, x / w))
        self.current_play_ratio = p
        self.scrub_thumb_full.place(relx=p, rely=0.5, anchor="center")
        self.scrub_thumb_mini.place(relx=p, rely=0.5, anchor="center")

    def on_scrub_end(self, event):
        self.is_scrubbing = False
        if not self.current_sentences:
            self.current_play_ratio = 0.0
            self.scrub_thumb_full.place(relx=0.0, rely=0.5, anchor="center")
            self.scrub_thumb_mini.place(relx=0.0, rely=0.5, anchor="center")
            return
        
        target_idx = int(self.current_play_ratio * len(self.current_sentences))
        if target_idx >= len(self.current_sentences): target_idx = max(0, len(self.current_sentences) - 1)
        
        self.stop_speech()
        self.after(100, lambda: self.play_from_text(target_idx))

    def update_thumb_pos(self, ratio):
        self.current_play_ratio = ratio
        if not self.is_scrubbing:
            self.scrub_thumb_full.place(relx=ratio, rely=0.5, anchor="center")
            self.scrub_thumb_mini.place(relx=ratio, rely=0.5, anchor="center")

    def on_zoom(self, event):
        if event.delta > 0: self.font_size += 1
        else: self.font_size = max(8, self.font_size - 1)
        self.apply_font_size()
        self.save_settings()

    def apply_font_size(self):
        self.text_box.configure(font=("Inter", self.font_size))
        self.text_box._textbox.tag_configure("md_bold", font=("Inter", self.font_size, "bold"))
        self.text_box._textbox.tag_configure("md_h1", font=("Inter", int(self.font_size * 1.5), "bold"))
        self.text_box._textbox.tag_configure("md_h2", font=("Inter", int(self.font_size * 1.3), "bold"))

    # --- Overlays ---
    def show_appearance_overlay(self):
        if getattr(self, "current_overlay", None) == "settings":
            self.close_overlay()
            return
        self.close_overlay()
        self.current_overlay = "settings"
        if hasattr(self, 'btn_settings'): self.btn_settings.configure(fg_color="#007AFF")
        self.overlay_frame = ctk.CTkFrame(self, fg_color="#111", corner_radius=10, border_width=1, border_color="#333")
        if self.display_mode == "full":
            self.overlay_frame.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.7, relheight=0.5)
        else:
            self.geometry("480x250")
            self.overlay_frame.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
            
        ctk.CTkLabel(self.overlay_frame, text="НАСТРОЙКИ ВИДА", font=ctk.CTkFont(size=12, weight="bold"), text_color="#888").pack(pady=10)
        
        ctk.CTkLabel(self.overlay_frame, text=f"Размер шрифта: {self.font_size}").pack()
        f_slider = ctk.CTkSlider(self.overlay_frame, from_=10, to=40, command=self.update_font_slider)
        f_slider.set(self.font_size)
        f_slider.pack(fill="x", padx=30, pady=5)
        
        md_switch = ctk.CTkSwitch(self.overlay_frame, text="Markdown форматирование", command=self.toggle_markdown)
        if self.markdown_enabled: md_switch.select()
        md_switch.pack(pady=10)
        
        ctk.CTkButton(self.overlay_frame, text="ЗАКРЫТЬ", height=28, corner_radius=6, fg_color="#333", command=self.close_overlay).pack(pady=10)

    def update_font_slider(self, val):
        self.font_size = int(val)
        self.apply_font_size()
        self.save_settings()

    def toggle_markdown(self):
        self.markdown_enabled = not self.markdown_enabled
        self.save_settings()
        self.refresh_text_display()

    def refresh_text_display(self):
        txt = self.text_box.get("0.0", "end").strip()
        self.text_box.delete("0.0", "end")
        self.text_box.insert("0.0", txt)
        if self.markdown_enabled: self.apply_markdown_tags()

    # --- Overlays ---
    def show_speed_overlay(self):
        if getattr(self, "current_overlay", None) == "speed":
            self.close_overlay()
            return
        self.close_overlay()
        self.current_overlay = "speed"
        if hasattr(self, 'btn_speed'): self.btn_speed.configure(fg_color="#007AFF")
        if hasattr(self, 'btn_mini_speed'): self.btn_mini_speed.configure(fg_color="#007AFF")
        if self.display_mode != "full": self.geometry("480x250")
        
        self.overlay_frame = ctk.CTkFrame(self, fg_color="#111", corner_radius=10, border_width=1, border_color="#333")
        if self.display_mode != "full": self.overlay_frame.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
        else: self.overlay_frame.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.6, relheight=0.3)
        
        ctk.CTkLabel(self.overlay_frame, text="НАСТРОЙКА СКОРОСТИ", font=ctk.CTkFont(size=12, weight="bold"), text_color="#888").pack(pady=10)
        self.val_lbl = ctk.CTkLabel(self.overlay_frame, text=f"{self.current_rate}x", font=ctk.CTkFont(size=20, weight="bold"), text_color="#007AFF")
        self.val_lbl.pack()
        slider = ctk.CTkSlider(self.overlay_frame, from_=0.5, to=3.0, command=self.change_speed)
        slider.set(self.current_rate)
        slider.bind("<ButtonRelease-1>", lambda e: self.on_speed_slider_release())
        slider.pack(fill="x", padx=30, pady=10)
        ctk.CTkButton(self.overlay_frame, text="ЗАКРЫТЬ", height=28, corner_radius=6, fg_color="#333", command=self.close_overlay).pack(pady=10)

    def on_speed_slider_release(self):
        if self.is_speaking:
            self.play_from_text(self.current_sentence_idx)

    def show_voice_overlay(self):
        if getattr(self, "current_overlay", None) == "voice":
            self.close_overlay()
            return
        self.close_overlay()
        self.current_overlay = "voice"
        if hasattr(self, 'btn_voice'): self.btn_voice.configure(fg_color="#007AFF")
        if hasattr(self, 'btn_mini_voice'): self.btn_mini_voice.configure(fg_color="#007AFF")
        if self.display_mode != "full": self.geometry("480x280")
        
        self.overlay_frame = ctk.CTkFrame(self, fg_color="#111", corner_radius=10, border_width=1, border_color="#333")
        if self.display_mode != "full": self.overlay_frame.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
        else: self.overlay_frame.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.7, relheight=0.45)
        
        ctk.CTkLabel(self.overlay_frame, text="ВЫБОР ГОЛОСА", font=ctk.CTkFont(size=12, weight="bold"), text_color="#888").pack(pady=10)
        for name, icon in VOICE_AVATARS.items():
            btn = ctk.CTkButton(self.overlay_frame, text=f"{icon} {name}", anchor="w", fg_color="#222", corner_radius=6,
                                hover_color="#333", height=28, command=lambda v=name: self.select_voice(v))
            btn.pack(fill="x", padx=20, pady=4)
        ctk.CTkButton(self.overlay_frame, text="ЗАКРЫТЬ", height=28, corner_radius=6, fg_color="#333", command=self.close_overlay).pack(pady=10)

    def select_voice(self, voice):
        self.current_voice = voice
        self.save_settings()
        self.close_overlay()
        self.btn_voice.configure(text=f"🔊 {self.current_voice.split(' ')[0]}")

    def close_overlay(self):
        if self.overlay_frame:
            self.overlay_frame.destroy()
            self.overlay_frame = None
            self.current_overlay = None
            if hasattr(self, 'btn_settings'): self.btn_settings.configure(fg_color="transparent")
            if hasattr(self, 'btn_speed'): self.btn_speed.configure(fg_color="#222")
            if hasattr(self, 'btn_mini_speed'): self.btn_mini_speed.configure(fg_color="#222")
            if hasattr(self, 'btn_voice'): self.btn_voice.configure(fg_color="#222")
            if hasattr(self, 'btn_mini_voice'): self.btn_mini_voice.configure(fg_color="#222")
            if self.display_mode == "mini":
                self.geometry("480x350" if getattr(self, "mini_drawer_open", False) else "480x60")
            elif self.display_mode == "micro":
                self.geometry("210x60")

    def change_speed(self, value):
        self.current_rate = round(float(value), 2)
        self.val_lbl.configure(text=f"{self.current_rate}x")
        self.btn_speed.configure(text=f"⚡ {self.current_rate}x")
        self.btn_mini_speed.configure(text=f"{self.current_rate}x")
        self.save_settings()

    # --- Play Logic ---
    def start_hotkey_listener(self):
        def check_hotkey():
            while True:
                if keyboard.is_pressed('ctrl+shift'):
                    self.on_hotkey_triggered()
                    time.sleep(1.0)
                time.sleep(0.05)
        threading.Thread(target=check_hotkey, daemon=True).start()

    def on_hotkey_triggered(self):
        timeout = time.time() + 1.0
        while (keyboard.is_pressed('ctrl') or keyboard.is_pressed('shift')) and time.time() < timeout:
            time.sleep(0.05)
        time.sleep(0.1)
        pyperclip.copy("") 
        ctypes.windll.user32.keybd_event(0x11, 0, 0, 0)
        ctypes.windll.user32.keybd_event(0x43, 0, 0, 0)
        ctypes.windll.user32.keybd_event(0x43, 0, 2, 0)
        ctypes.windll.user32.keybd_event(0x11, 0, 2, 0)
        time.sleep(0.3)
        text = pyperclip.paste().strip()
        if text: self.after(0, lambda: self.update_text_and_play(text))

    def update_text_and_play(self, text):
        self.text_box.delete("0.0", "end")
        self.text_box.insert("0.0", text)
        if self.markdown_enabled: self.apply_markdown_tags()
        self.text_box.mark_set("insert", "1.0")
        self.play_from_text(0)

    def apply_markdown_tags(self):
        self.text_box.tag_remove("md_bold", "1.0", "end")
        self.text_box.tag_remove("md_h1", "1.0", "end")
        self.text_box.tag_remove("md_h2", "1.0", "end")
        self.text_box.tag_remove("md_hide", "1.0", "end")
        
        content = self.text_box.get("1.0", "end")
        
        # Simple Regex-based Markdown highlights
        lines = content.split('\n')
        for i, line in enumerate(lines):
            idx = i + 1
            # Headers
            if line.startswith('# '):
                self.text_box.tag_add("md_h1", f"{idx}.0", f"{idx}.end")
                self.text_box.tag_add("md_hide", f"{idx}.0", f"{idx}.2")
            elif line.startswith('## '):
                self.text_box.tag_add("md_h2", f"{idx}.0", f"{idx}.end")
                self.text_box.tag_add("md_hide", f"{idx}.0", f"{idx}.3")
            
            # Bold **text**
            import re
            for m in re.finditer(r'(\*\*|__)(.*?)(\1)', line):
                start_match = m.start()
                end_match = m.end()
                self.text_box.tag_add("md_bold", f"{idx}.{start_match}", f"{idx}.{end_match}")
                # Hide start and end markers
                self.text_box.tag_add("md_hide", f"{idx}.{start_match}", f"{idx}.{start_match+2}")
                self.text_box.tag_add("md_hide", f"{idx}.{end_match-2}", f"{idx}.{end_match}")

    def clean_markdown_for_tts(self, text):
        import re
        # Remove headers
        text = re.sub(r'^#+\s+', '', text, flags=re.MULTILINE)
        # Remove bold/italic
        text = re.sub(r'\*\*|__|[\*_]', '', text)
        # Remove links [text](url) -> text
        text = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', text)
        return text

    def play_from_text(self, start_idx=0):
        self.stop_speech()
        time.sleep(0.1)
        full_text = self.text_box.get("0.0", "end").strip()
        if not full_text: return
        
        # Get raw sentences and their offsets
        raw_sentences = []
        self.sentence_offsets = []
        for m in re.finditer(r'[^.!?]+[.!?]*', full_text):
            s = m.group()
            stripped = s.strip()
            if stripped:
                leading_spaces = len(s) - len(s.lstrip())
                trailing_spaces = len(s) - len(s.rstrip())
                s_start = m.start() + leading_spaces
                s_end = m.end() - trailing_spaces
                raw_sentences.append(stripped)
                self.sentence_offsets.append((s_start, s_end))
                
        self.current_sentences = [self.clean_markdown_for_tts(s) for s in raw_sentences]
        if not self.current_sentences: return
        
        # Correct start_idx if out of bounds
        if start_idx >= len(self.current_sentences):
            start_idx = 0
        
        config_hash = hashlib.md5(f"{full_text}_{self.current_voice}_{self.current_rate}".encode()).hexdigest()
        reuse_cache = (config_hash == self.last_text_hash)
        self.last_text_hash = config_hash

        self.stop_requested = False
        self.is_paused = False
        self.is_speaking = True
        self.is_scrubbing = False
        self.play_main.configure(text="❙❙ ПАУЗА")
        if hasattr(self, 'play_mini'):
            self.play_mini.configure(text="❙❙")
        if hasattr(self, 'play_micro'):
            self.play_micro.configure(text="❙❙")
        
        self.buffer_prog_full.set(0)
        self.buffer_prog_mini.set(0)
        self.update_thumb_pos(0)
        
        self.c_action_btn.pack(side="left", padx=2, before=self.play_mini)
        
        if self.display_mode == "mini":
            self.c_status.pack_forget()
            self.scrub_container_mini.pack(in_=self.mini_center, fill="x", expand=True)
        elif self.display_mode == "micro":
            self.stop_micro.grid(row=0, column=4, padx=3)
            
        while not self.item_queue.empty(): self.item_queue.get()
        threading.Thread(target=self.producer_thread, args=(self.current_sentences, start_idx, reuse_cache), daemon=True).start()
        threading.Thread(target=self.consumer_thread, args=(len(self.current_sentences), start_idx), daemon=True).start()

    def stop_speech(self):
        self.stop_requested = True
        self.is_paused = False
        self.is_speaking = False
        
        # Stop and close MCI device
        try:
            winmm = ctypes.windll.winmm
            winmm.mciSendStringW('stop widget_audio', None, 0, None)
            winmm.mciSendStringW('close widget_audio', None, 0, None)
        except:
            pass
            
        self.play_main.configure(text="▶ ПЛЕЙ")
        if hasattr(self, 'play_mini'):
            self.play_mini.configure(text="▶")
        if hasattr(self, 'play_micro'):
            self.play_micro.configure(text="▶")
        
        self.c_action_btn.pack_forget()
        if hasattr(self, 'stop_micro'):
            self.stop_micro.grid_forget()
            
        if self.display_mode == "mini":
            self.scrub_container_mini.pack_forget()
            self.c_status.pack(expand=True)

    def toggle_play_pause(self):
        if not self.is_speaking:
            start_idx = self.get_sentence_index_from_cursor()
            self.play_from_text(start_idx)
        elif self.is_paused:
            self.resume_speech()
        else:
            self.pause_speech()

    def pause_speech(self):
        if not self.is_speaking or self.is_paused:
            return
        self.is_paused = True
        try:
            winmm = ctypes.windll.winmm
            winmm.mciSendStringW('pause widget_audio', None, 0, None)
        except:
            pass
        self.play_main.configure(text="▶ ПЛЕЙ")
        if hasattr(self, 'play_mini'):
            self.play_mini.configure(text="▶")
        if hasattr(self, 'play_micro'):
            self.play_micro.configure(text="▶")

    def resume_speech(self):
        if not self.is_speaking or not self.is_paused:
            return
        self.is_paused = False
        try:
            winmm = ctypes.windll.winmm
            winmm.mciSendStringW('resume widget_audio', None, 0, None)
        except:
            pass
        self.play_main.configure(text="❙❙ ПАУЗА")
        if hasattr(self, 'play_mini'):
            self.play_mini.configure(text="❙❙")
        if hasattr(self, 'play_micro'):
            self.play_micro.configure(text="❙❙")

    def get_sentence_index_from_cursor(self):
        full_text = self.text_box.get("0.0", "end").strip()
        if not full_text:
            return 0
            
        try:
            start_pos = self.text_box.index("sel.first")
        except ctk.TclError:
            start_pos = self.text_box.index("insert")
            
        char_offset = len(self.text_box.get("1.0", start_pos))
        
        # Calculate sentence offsets on the fly
        sentences_with_offsets = []
        for m in re.finditer(r'[^.!?]+[.!?]*', full_text):
            s = m.group()
            stripped = s.strip()
            if stripped:
                leading_spaces = len(s) - len(s.lstrip())
                trailing_spaces = len(s) - len(s.rstrip())
                s_start = m.start() + leading_spaces
                s_end = m.end() - trailing_spaces
                sentences_with_offsets.append((s_start, s_end))
                
        for idx, (s_start, s_end) in enumerate(sentences_with_offsets):
            if s_start <= char_offset <= s_end:
                return idx
        return 0

    def on_closing(self):
        self.stop_speech()
        
        # Clean up temp folder
        temp_dir = os.path.join(os.environ["TEMP"], "sinc_cache")
        if os.path.exists(temp_dir):
            for f in os.listdir(temp_dir):
                try: os.remove(os.path.join(temp_dir, f))
                except: pass
            try: os.rmdir(temp_dir)
            except: pass
            
        self.destroy()

    def producer_thread(self, sentences, start_idx, reuse_cache):
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        temp_dir = os.path.join(os.environ["TEMP"], "sinc_cache")
        if not os.path.exists(temp_dir): os.makedirs(temp_dir)
        if not reuse_cache:
            for f in os.listdir(temp_dir):
                try: os.remove(os.path.join(temp_dir, f))
                except: pass
        for i in range(start_idx, len(sentences)):
            if self.stop_requested: break
            s_hash = hashlib.md5(f"{sentences[i]}_{self.current_voice}_{self.current_rate}".encode()).hexdigest()
            file_path = os.path.join(temp_dir, f"c_{s_hash}.mp3")
            if not os.path.exists(file_path):
                try:
                    rate_str = f"{int((self.current_rate - 1) * 100):+d}%"
                    voice_id = VOICES.get(self.current_voice, VOICES["Светлана (RU)"])
                    communicate = edge_tts.Communicate(sentences[i], voice_id, rate=rate_str)
                    loop.run_until_complete(communicate.save(file_path))
                except: file_path = None
            
            p = (i + 1) / len(sentences)
            self.after(0, lambda val=p: self.buffer_prog_full.set(val))
            self.after(0, lambda val=p: self.buffer_prog_mini.set(val))
            self.after(0, lambda i=i: self.highlight_sentence(i, "buffered"))
            
            self.item_queue.put((i, file_path))
        self.item_queue.put(None)

    def consumer_thread(self, total, start_idx):
        for _ in range(start_idx): self.item_queue.put((0, None)) 
        
        while not self.stop_requested:
            try:
                item = self.item_queue.get(timeout=0.5)
                if item is None: break
                idx, file_path = item
                self.current_sentence_idx = idx
                if file_path and os.path.exists(file_path):
                    p = idx / max(1, total - 1)
                    if not self.is_scrubbing:
                        self.after(0, lambda val=p: self.update_thumb_pos(val))
                        self.after(0, lambda i=idx: self.highlight_sentence(i, "playing"))
                    
                    abs_path = os.path.abspath(file_path)
                    
                    winmm = ctypes.windll.winmm
                    winmm.mciSendStringW('close widget_audio', None, 0, None)
                    
                    cmd_open = f'open "{abs_path}" type mpegvideo alias widget_audio'
                    res = winmm.mciSendStringW(cmd_open, None, 0, None)
                    if res != 0:
                        continue
                        
                    winmm.mciSendStringW('play widget_audio', None, 0, None)
                    
                    while not self.stop_requested:
                        if self.is_paused:
                            time.sleep(0.05)
                            continue
                            
                        buf = ctypes.create_unicode_buffer(128)
                        winmm.mciSendStringW('status widget_audio mode', buf, 128, None)
                        if buf.value != 'playing' and buf.value != 'paused':
                            break
                        time.sleep(0.05)
                        
                    winmm.mciSendStringW('stop widget_audio', None, 0, None)
                    winmm.mciSendStringW('close widget_audio', None, 0, None)
                    
                if self.stop_requested: break
            except queue.Empty: continue
        self.is_speaking = False
        if not self.stop_requested:
            self.after(0, lambda: self.stop_speech())

    def highlight_sentence(self, idx, tag):
        if idx >= len(self.sentence_offsets): return
        s_start, s_end = self.sentence_offsets[idx]
        start_pos = f"1.0 + {s_start} chars"
        end_pos = f"1.0 + {s_end} chars"
        if tag == "playing": 
            self.text_box.tag_remove("playing", "1.0", "end")
            self.text_box.see(start_pos)
        self.text_box.tag_add(tag, start_pos, end_pos)

if __name__ == "__main__":
    import sys
    import ctypes
    if sys.platform.startswith("win"):
        try:
            mutex_name = "Local\\SINC_PRO_SingleInstanceMutex_WiseYaroslav"
            kernel32 = ctypes.windll.kernel32
            mutex = kernel32.CreateMutexW(None, True, mutex_name)
            last_error = kernel32.GetLastError()
            if last_error == 183: # ERROR_ALREADY_EXISTS
                sys.exit(0)
            _single_instance_mutex = mutex
        except Exception:
            pass

    app = VoiceAssistantApp()
    app.mainloop()
