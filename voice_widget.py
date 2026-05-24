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
import sys
if sys.platform.startswith("win"):
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2) # PROCESS_PER_MONITOR_DPI_AWARE
    except:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except:
            pass
import queue
import hashlib
from PIL import Image as PILImage, ImageDraw as PILImageDraw, ImageFont as PILImageFont

def create_translate_icon(size=24, color="#007AFF"):
    """Dynamically draws an icon: a crop border containing letters A and 文"""
    image = PILImage.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = PILImageDraw.Draw(image)
    
    # Draw corners (⛶ style)
    w = size
    d = 4 # thickness of corners
    l = 6 # length of corner lines
    
    # Top-left
    draw.line([(d, d), (d + l, d)], fill=color, width=2)
    draw.line([(d, d), (d, d + l)], fill=color, width=2)
    # Top-right
    draw.line([(w - d, d), (w - d - l, d)], fill=color, width=2)
    draw.line([(w - d, d), (w - d, d + l)], fill=color, width=2)
    # Bottom-left
    draw.line([(d, w - d), (d + l, w - d)], fill=color, width=2)
    draw.line([(d, w - d), (d, w - d - l)], fill=color, width=2)
    # Bottom-right
    draw.line([(w - d, w - d), (w - d - l, w - d)], fill=color, width=2)
    draw.line([(w - d, w - d), (w - d, w - d - l)], fill=color, width=2)
    
    # Try to load fonts for A and 文
    try:
        font = PILImageFont.truetype("msyh.ttc", 9)
    except IOError:
        try:
            font = PILImageFont.truetype("Arial.ttf", 9)
        except IOError:
            font = PILImageFont.load_default()
            
    draw.text((size/2 - 6, size/2 - 7), "A", fill="#FFFFFF", font=font)
    draw.text((size/2, size/2 - 2), "文", fill="#FFFFFF", font=font)
    return image

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

DEFAULT_VOICES_BY_LANG = {
    "ru": "Светлана (RU)",
    "en": "Guy (EN)",
    "de": "Katja (DE)",
    "fr": "Denise (FR)",
    "es": "Alvaro (ES)",
    "zh-CN": "Xiaoxiao (CN)"
}

def is_voice_matching_lang(voice_name, lang_code):
    v_upper = voice_name.upper()
    l_upper = lang_code.split('-')[0].upper()
    if l_upper == "ZH":
        return "CN" in v_upper
    return f"({l_upper})" in v_upper
# Persistent Settings Path
if getattr(sys, 'frozen', False):
    APP_DIR = os.path.dirname(sys.executable)
else:
    APP_DIR = os.path.dirname(os.path.abspath(__file__))

SETTINGS_FILE = os.path.join(APP_DIR, "voice_settings.json")
CREATE_NO_WINDOW = 0x08000000

class ContextMenu(ctk.CTkToplevel):
    def __init__(self, master, x, y, options):
        super().__init__(master)
        self.overrideredirect(True)
        self.attributes("-topmost", True)
        self.configure(fg_color="#181818")
        
        self.border_frame = ctk.CTkFrame(self, fg_color="#181818", border_width=1, border_color="#007AFF", corner_radius=6)
        self.border_frame.pack(fill="both", expand=True, padx=1, pady=1)
        
        for opt in options:
            if opt is None:
                sep = ctk.CTkFrame(self.border_frame, height=1, fg_color="#333333")
                sep.pack(fill="x", padx=10, pady=5)
            else:
                label, command = opt
                btn = ctk.CTkButton(
                    self.border_frame,
                    text=label,
                    anchor="w",
                    fg_color="transparent",
                    hover_color="#007AFF",
                    text_color="#ffffff",
                    font=ctk.CTkFont(family="Segoe UI", size=11),
                    height=26,
                    corner_radius=4,
                    command=self.make_cmd(command)
                )
                btn.pack(fill="x", padx=5, pady=2)
                
        # Smart positioning logic
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        w = 200
        h = sum([30 if opt is not None else 10 for opt in options]) + 15
        
        x_pos = x if x + w <= sw else x - w
        y_pos = y if y + h <= sh else y - h
        
        x_pos = max(10, min(sw - w - 10, x_pos))
        y_pos = max(10, min(sh - h - 10, y_pos))
        
        self.geometry(f"{w}x{h}+{x_pos}+{y_pos}")
        
        self.bind("<FocusOut>", lambda e: self.destroy())
        self.bind("<ButtonPress-1>", self.on_click_outside)
        self.bind("<Escape>", lambda e: self.destroy())
        
        self.after(100, self.grab_focus)
        
    def make_cmd(self, command):
        def cmd():
            self.destroy()
            command()
        return cmd
        
    def grab_focus(self):
        try:
            self.focus_force()
            self.grab_set()
        except:
            pass
            
    def on_click_outside(self, event):
        x, y = event.x, event.y
        if x < 0 or y < 0 or x > self.winfo_width() or y > self.winfo_height():
            self.destroy()

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
        self.translation_active = False
        self.original_raw_text = ""
        self.translated_raw_text = None
        self.pre_translation_voice = None

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
        self.current_voice = "Светлана (RU)"
        self.current_rate = 1.0
        self.font_size = 15
        self.markdown_enabled = True
        self.translate_to = "ru"
        self.translate_hotkey = "ctrl+alt+t"
        self.speak_hotkey = "ctrl+shift"
        self.speak_translate_hotkey = "ctrl+alt+x"
        self.translation_engine = "google_cache"
        self.ollama_model = "gemma2"
        self.ollama_url = "http://localhost:11434"
        self.msty_model = "Gemma 4"
        self.msty_url = "http://localhost:8080"
        try:
            if os.path.exists(SETTINGS_FILE):
                with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    self.current_voice = data.get("voice", "Светлана (RU)")
                    self.current_rate = data.get("rate", 1.0)
                    self.font_size = data.get("font_size", 15)
                    self.markdown_enabled = data.get("markdown_enabled", True)
                    self.translate_to = data.get("translate_to", "ru")
                    self.translate_hotkey = data.get("translate_hotkey", "ctrl+alt+t")
                    self.speak_hotkey = data.get("speak_hotkey", "ctrl+shift")
                    self.speak_translate_hotkey = data.get("speak_translate_hotkey", "ctrl+alt+x")
                    self.translation_engine = data.get("translation_engine", "google_cache")
                    self.ollama_model = data.get("ollama_model", "gemma2")
                    self.ollama_url = data.get("ollama_url", "http://localhost:11434")
                    self.msty_model = data.get("msty_model", "Gemma 4")
                    self.msty_url = data.get("msty_url", "http://localhost:8080")
                    # Auto-fix old conflicting hotkey if present in settings file
                    if self.translate_hotkey == "ctrl+shift+t":
                        self.translate_hotkey = "ctrl+alt+t"
        except: pass

    def save_settings(self):
        try:
            with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
                json.dump({
                    "voice": self.current_voice, 
                    "rate": self.current_rate,
                    "font_size": self.font_size,
                    "markdown_enabled": self.markdown_enabled,
                    "translate_to": self.translate_to,
                    "translate_hotkey": self.translate_hotkey,
                    "speak_hotkey": self.speak_hotkey,
                    "speak_translate_hotkey": self.speak_translate_hotkey,
                    "translation_engine": self.translation_engine,
                    "ollama_model": self.ollama_model,
                    "ollama_url": self.ollama_url,
                    "msty_model": self.msty_model,
                    "msty_url": self.msty_url
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

        # Dynamically generate Translate icon
        self.img_translate = ctk.CTkImage(
            light_image=create_translate_icon(),
            dark_image=create_translate_icon(),
            size=(24, 24)
        )
        
        # Mode Toggles
        self.btn_to_full = ctk.CTkButton(self.top_bar, text="🗖", width=30, height=30, corner_radius=6, 
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=20), command=lambda: self.apply_mode("full"))
        
        self.btn_to_mini = ctk.CTkButton(self.top_bar, text="▬", width=30, height=30, corner_radius=6, 
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=14, weight="bold"), command=lambda: self.apply_mode("mini"))

        self.btn_to_micro = ctk.CTkButton(self.top_bar, text="●", width=30, height=30, corner_radius=6, 
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=12), command=self.enter_micro_mode)

        self.btn_restore = ctk.CTkButton(self.top_bar, text="▬", width=30, height=30, corner_radius=6, 
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=14, weight="bold"), command=self.restore_mode)

        self.btn_text_drawer = ctk.CTkButton(self.top_bar, text="📖", width=30, height=30, corner_radius=6,
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=18), command=self.toggle_text_drawer)

        self.btn_screen_translate = ctk.CTkButton(self.top_bar, image=self.img_translate, text="", width=30, height=30, corner_radius=6,
                                   fg_color="#222", hover_color="#333", command=self.open_screen_translator)

        self.btn_translate_toggle = ctk.CTkButton(self, text="A文", width=30, height=30, corner_radius=6,
                                   fg_color="#222", hover_color="#333", text_color="#ccc", font=ctk.CTkFont(size=12, weight="bold"), command=self.toggle_translation_mode)

        self.btn_settings = ctk.CTkButton(self.top_bar, text="⚙", width=30, height=30, corner_radius=6, 
                                   fg_color="transparent", hover_color="#333", text_color="#888", font=ctk.CTkFont(size=20), command=self.show_appearance_overlay)

        self.btn_help = ctk.CTkButton(self.top_bar, text="❓", width=30, height=30, corner_radius=6, 
                                   fg_color="transparent", hover_color="#333", text_color="#888", font=ctk.CTkFont(size=16), command=self.show_help_overlay)

        self.btn_clear = ctk.CTkButton(self.top_bar, text="🧹", width=30, height=30, corner_radius=6,
                                   fg_color="#222", hover_color="#c0392b", text_color="#ccc", font=ctk.CTkFont(size=16), command=self.clear_text_box)

        # Status-bar tooltips
        def set_status(txt):
            if not self.is_speaking:
                self.c_status.configure(text=txt, text_color="#aaa")
                
        def reset_status():
            if not self.is_speaking:
                self.c_status.configure(text="Выделите текст и нажмите Ctrl+Shift", text_color="#888")

        self.btn_to_full.bind("<Enter>", lambda e: set_status("Открыть редактор (🗖)"))
        self.btn_to_full.bind("<Leave>", lambda e: reset_status())
        
        self.btn_to_mini.bind("<Enter>", lambda e: set_status("Свернуть в плеер-панель (▬)"))
        self.btn_to_mini.bind("<Leave>", lambda e: reset_status())
        
        self.btn_to_micro.bind("<Enter>", lambda e: set_status("Свернуть в мини-виджет (●)"))
        self.btn_to_micro.bind("<Leave>", lambda e: reset_status())
        
        self.btn_restore.bind("<Enter>", lambda e: set_status("Открыть плеер-панель (▬)"))
        self.btn_restore.bind("<Leave>", lambda e: reset_status())
        
        self.btn_screen_translate.bind("<Enter>", lambda e: set_status("Перевод области экрана (⛶ A文)"))
        self.btn_screen_translate.bind("<Leave>", lambda e: reset_status())

        self.btn_translate_toggle.bind("<Enter>", lambda e: set_status("Перевести текст в редакторе (A文)"))
        self.btn_translate_toggle.bind("<Leave>", lambda e: reset_status())

        self.btn_text_drawer.bind("<Enter>", lambda e: set_status("Показать/скрыть текст (📖)"))
        self.btn_text_drawer.bind("<Leave>", lambda e: reset_status())

        self.btn_clear.bind("<Enter>", lambda e: set_status("Очистить текст (🧹)"))
        self.btn_clear.bind("<Leave>", lambda e: reset_status())

        self.btn_help.bind("<Enter>", lambda e: set_status("Инструкция и легенда (❓)"))
        self.btn_help.bind("<Leave>", lambda e: reset_status())

        # Micro mode controls
        self.play_micro = ctk.CTkButton(self.top_bar, text="▶", width=30, height=30, corner_radius=6, fg_color="#007AFF", font=ctk.CTkFont(size=18), command=self.toggle_play_pause)

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
        self.play_mini = ctk.CTkButton(self.right_frame, text="▶", width=30, height=30, corner_radius=6, fg_color="#007AFF", font=ctk.CTkFont(size=18), command=self.toggle_play_pause)

        # Order: Voice -> Speed -> Play
        self.btn_mini_voice.pack(side="left", padx=2)
        self.btn_mini_speed.pack(side="left", padx=2)
        self.play_mini.pack(side="left", padx=2)

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

        self.btn_translate_toggle.grid(in_=self.footer, row=1, column=2, padx=15, pady=(15, 15), sticky="w")
        self.btn_translate_toggle.lift()

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
        
        # Right click context menu binding for widgets
        self.bind_right_click(self)

    def bind_right_click(self, widget):
        # We don't override standard textbox right click menu
        if not isinstance(widget, ctk.CTkTextbox):
            try:
                widget.bind("<Button-3>", self.show_context_menu)
            except:
                pass
        for child in widget.winfo_children():
            self.bind_right_click(child)

    def show_context_menu(self, event):
        options = [
            (f"{'✓ ' if self.display_mode == 'full' else '    '}🗖 Редактор (Full)", lambda: self.apply_mode("full")),
            (f"{'✓ ' if self.display_mode == 'mini' else '    '}▬ Плеер-панель (Mini)", lambda: self.apply_mode("mini")),
            (f"{'✓ ' if self.display_mode == 'micro' else '    '}● Микро-виджет (Micro)", self.enter_micro_mode),
            None,
            ("⚙ Настройки и функции", self.show_appearance_overlay),
            ("⛶ Перевод экрана", self.open_screen_translator),
            ("📖 Инструкция и легенда", self.show_help_overlay),
            ("ℹ О программе", self.show_about_overlay),
            None,
            ("✕ Закрыть приложение", self.on_closing)
        ]
        x_mouse, y_mouse = self.winfo_pointerxy()
        ContextMenu(self, x_mouse, y_mouse, options)

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
        self.btn_clear.grid_forget()
        if hasattr(self, 'btn_help'):
            self.btn_help.grid_forget()
        self.play_micro.grid_forget()
        self.mini_center.grid_forget()
        self.right_frame.grid_forget()
        self.scrub_container_mini.pack_forget()
        if hasattr(self, 'btn_text_drawer'):
            self.btn_text_drawer.grid_forget()
        self.mini_drawer_open = False
        if hasattr(self, 'btn_text_drawer'):
            self.btn_text_drawer.configure(fg_color="#222")
            
        # Hide translate button by default
        self.btn_screen_translate.grid_forget()
        self.btn_translate_toggle.grid_forget()
        self.btn_translate_toggle.pack_forget()
        
        if mode == "full":
            self.overrideredirect(False)
            self.geometry("480x600")
            self.apply_dark_titlebar()
            
            self.grid_rowconfigure(0, weight=0)
            self.grid_rowconfigure(1, weight=1)
            self.grid_rowconfigure(2, weight=0)
            
            self.btn_to_mini.grid(row=0, column=0, padx=5)
            self.btn_to_micro.grid(row=0, column=1, padx=5)
            self.full_header.grid(row=0, column=2, sticky="w", padx=10)
            self.btn_screen_translate.grid(row=0, column=4, padx=5, sticky="e")
            self.btn_clear.grid(row=0, column=5, padx=5, sticky="e")
            self.btn_help.grid(row=0, column=6, padx=5, sticky="e")
            self.btn_settings.grid(row=0, column=7, padx=5, sticky="e")
            
            # Configure top_bar column weights for full mode
            self.top_bar.grid_columnconfigure(0, weight=0)
            self.top_bar.grid_columnconfigure(1, weight=0)
            self.top_bar.grid_columnconfigure(2, weight=0)
            self.top_bar.grid_columnconfigure(3, weight=1) # spacer
            self.top_bar.grid_columnconfigure(4, weight=0)
            self.top_bar.grid_columnconfigure(5, weight=0)
            self.top_bar.grid_columnconfigure(6, weight=0)
            self.top_bar.grid_columnconfigure(7, weight=0)
            
            self.btn_translate_toggle.configure(width=40, height=35, corner_radius=10)
            self.btn_translate_toggle.grid(in_=self.footer, row=1, column=2, padx=15, pady=(15, 15), sticky="w")
            self.btn_translate_toggle.lift()
            
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
            self.btn_screen_translate.grid(row=0, column=4, padx=5)
            
            self.btn_translate_toggle.configure(width=30, height=30, corner_radius=6)
            self.btn_translate_toggle.pack(in_=self.right_frame, side="left", padx=2, before=self.play_mini)
            self.btn_translate_toggle.lift()
            
            self.mini_center.grid(row=0, column=5, sticky="ew", padx=10)
            self.right_frame.grid(row=0, column=6, padx=5)
            
            # Configure top_bar column weights for mini mode
            self.top_bar.grid_columnconfigure(0, weight=0)
            self.top_bar.grid_columnconfigure(1, weight=0)
            self.top_bar.grid_columnconfigure(2, weight=0)
            self.top_bar.grid_columnconfigure(3, weight=0)
            self.top_bar.grid_columnconfigure(4, weight=0) # translate button
            self.top_bar.grid_columnconfigure(5, weight=1) # mini_center expanded
            self.top_bar.grid_columnconfigure(6, weight=0)
            
            if self.is_speaking:
                self.scrub_container_mini.pack(in_=self.mini_center, fill="x", expand=True)
                self.c_status.pack_forget()
            else:
                self.c_status.pack(expand=True)
                
        elif mode == "micro":
            self.overrideredirect(True)
            self.geometry("170x60")
            
            self.grid_rowconfigure(0, weight=1)
            self.grid_rowconfigure(1, weight=0)
            self.grid_rowconfigure(2, weight=0)
            
            self.drag_h.grid(row=0, column=0, padx=5)
            self.btn_restore.grid(row=0, column=1, padx=3)
            self.btn_to_full.grid(row=0, column=2, padx=3)
            self.play_micro.grid(row=0, column=4, padx=3)
            
            # Configure top_bar column weights for micro mode
            self.top_bar.grid_columnconfigure(0, weight=0)
            self.top_bar.grid_columnconfigure(1, weight=0)
            self.top_bar.grid_columnconfigure(2, weight=0)
            self.top_bar.grid_columnconfigure(3, weight=1) # spacer
            self.top_bar.grid_columnconfigure(4, weight=0)
            
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
        self.update_idletasks()

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
    def show_help_overlay(self):
        if getattr(self, "current_overlay", None) == "help":
            self.close_overlay()
            return
        self.close_overlay()
        self.current_overlay = "help"
        if hasattr(self, 'btn_help'): self.btn_help.configure(fg_color="#34C759")
        
        self.overlay_frame = ctk.CTkScrollableFrame(self, fg_color="#111", corner_radius=10, border_width=1, border_color="#333")
        if self.display_mode == "full":
            self.overlay_frame.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.82, relheight=0.85)
        else:
            self.geometry("480x480")
            self.overlay_frame.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
            
        ctk.CTkLabel(self.overlay_frame, text="📖 ИНСТРУКЦИЯ ПО ИСПОЛЬЗОВАНИЮ", font=ctk.CTkFont(size=12, weight="bold"), text_color="#007AFF").pack(pady=(15, 10))
        
        def add_section(title, text):
            ctk.CTkLabel(self.overlay_frame, text=title, font=ctk.CTkFont(size=11, weight="bold"), text_color="#34C759", anchor="w").pack(fill="x", padx=15, pady=(8, 2))
            lbl = ctk.CTkLabel(self.overlay_frame, text=text, font=ctk.CTkFont(size=11), justify="left", anchor="w", wraplength=340)
            lbl.pack(fill="x", padx=25, pady=(0, 5))
            
        add_section(
            "1. Голосовая озвучка (TTS)",
            "Выделите любой текст в любом стороннем приложении и нажмите сочетание клавиш [Ctrl + Shift] (или задайте свой хоткей в настройках ⚙).\n"
            "Программа скопирует текст и начнет читать его вслух."
        )
        
        add_section(
            "2. Распознавание и перевод экрана (OCR)",
            "Нажмите [Ctrl + Alt + T] (или кнопку ⛶ на панели).\n"
            "Затем выделите рамкой нужную область экрана. Откроется прозрачное окно чтения."
        )
        
        add_section(
            "3. Интерактивное чтение (Click Lock)",
            "Внутри рамки перевода нажмите клавишу [Space] (Пробел) или кнопку 🔊/A на верхней панели.\n"
            "Окно слегка притенится, блокируя клики сквозь себя (защита от случайных нажатий на кнопки под оверлеем).\n\n"
            "• ЛКМ по предложению — озвучить его перевод на русский язык.\n"
            "• Ctrl + ЛКМ — озвучить предложение в оригинале.\n"
            "• ПКМ по предложению — показать всплывающее окошко с текстом перевода.\n\n"
            "Нажмите [Space] еще раз для возврата в прозрачный режим просмотра."
        )
        
        add_section(
            "4. Постоянная подсветка",
            "Все распознанные OCR предложения постоянно обводятся нежными рамками. Если какое-то слово не обведено — оно не распозналось (попробуйте скорректировать область выделения)."
        )
        
        ctk.CTkButton(self.overlay_frame, text="ПОНЯТНО", height=28, corner_radius=6, fg_color="#007AFF", hover_color="#005BBB", command=self.close_overlay).pack(pady=(15, 10))

    def show_about_overlay(self):
        if getattr(self, "current_overlay", None) == "about":
            self.close_overlay()
            return
        self.close_overlay()
        self.current_overlay = "about"
        
        self.overlay_frame = ctk.CTkFrame(self, fg_color="#111", corner_radius=10, border_width=1, border_color="#333")
        if self.display_mode == "full":
            self.overlay_frame.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.75, relheight=0.6)
        else:
            self.geometry("480x320")
            self.overlay_frame.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
            
        ctk.CTkLabel(self.overlay_frame, text="О ПРОГРАММЕ SINC PRO", font=ctk.CTkFont(size=12, weight="bold"), text_color="#007AFF").pack(pady=(15, 10))
        
        ctk.CTkLabel(self.overlay_frame, text="Разработчик:", font=ctk.CTkFont(size=10, weight="bold"), text_color="#888").pack(pady=(5, 0))
        ctk.CTkLabel(self.overlay_frame, text="Wise Yaroslav", font=ctk.CTkFont(size=12, weight="bold")).pack()
        
        ctk.CTkLabel(self.overlay_frame, text="Текущая версия:", font=ctk.CTkFont(size=10, weight="bold"), text_color="#888").pack(pady=(10, 0))
        ctk.CTkLabel(self.overlay_frame, text="v3.3.3 (2026-05-24)", font=ctk.CTkFont(size=12)).pack()
        
        ctk.CTkLabel(self.overlay_frame, text="GitHub Репозиторий:", font=ctk.CTkFont(size=10, weight="bold"), text_color="#888").pack(pady=(10, 0))
        
        repo_lbl = ctk.CTkLabel(self.overlay_frame, text="Открыть репозиторий на GitHub ↗", font=ctk.CTkFont(size=11, underline=True), text_color="#007AFF", cursor="hand2")
        repo_lbl.pack(pady=2)
        import webbrowser
        repo_lbl.bind("<Button-1>", lambda e: webbrowser.open_new("https://github.com/WiseYaroslav28/sinc-pro-voice-widget"))
        
        ctk.CTkButton(self.overlay_frame, text="ЗАКРЫТЬ", height=28, corner_radius=6, fg_color="#333", command=self.close_overlay).pack(pady=(15, 10))

    def show_appearance_overlay(self):
        if getattr(self, "current_overlay", None) == "settings":
            self.close_overlay()
            return
        self.close_overlay()
        self.current_overlay = "settings"
        if hasattr(self, 'btn_settings'): self.btn_settings.configure(fg_color="#007AFF")
        self.overlay_frame = ctk.CTkScrollableFrame(self, fg_color="#111", corner_radius=10, border_width=1, border_color="#333")
        if self.display_mode == "full":
            self.overlay_frame.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.78, relheight=0.82)
        else:
            self.geometry("480x480")
            self.overlay_frame.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
            
        ctk.CTkLabel(self.overlay_frame, text="ОБЩИЕ НАСТРОЙКИ", font=ctk.CTkFont(size=12, weight="bold"), text_color="#888").pack(pady=(10, 5))
        
        # 1. Font size settings
        self.font_lbl = ctk.CTkLabel(self.overlay_frame, text=f"Размер шрифта: {self.font_size}")
        self.font_lbl.pack(pady=1)
        f_slider = ctk.CTkSlider(self.overlay_frame, from_=10, to=40, command=self.update_font_slider)
        f_slider.set(self.font_size)
        f_slider.pack(fill="x", padx=30, pady=2)
        
        # 2. Markdown switch
        md_switch = ctk.CTkSwitch(self.overlay_frame, text="Markdown форматирование", command=self.toggle_markdown)
        if self.markdown_enabled: md_switch.select()
        md_switch.pack(pady=3)
        
        # 3. Translate hotkey setting
        ctk.CTkLabel(self.overlay_frame, text="Хоткей перевода экрана:", font=ctk.CTkFont(size=11, weight="bold")).pack(pady=(4, 1))
        self.hotkey_entry = ctk.CTkEntry(self.overlay_frame, width=150, placeholder_text="ctrl+shift+t", height=24)
        self.hotkey_entry.insert(0, self.translate_hotkey)
        self.hotkey_entry.pack(pady=1)
        
        # 4. Speak hotkey setting
        ctk.CTkLabel(self.overlay_frame, text="Хоткей озвучки текста:", font=ctk.CTkFont(size=11, weight="bold")).pack(pady=(4, 1))
        self.speak_hotkey_entry = ctk.CTkEntry(self.overlay_frame, width=150, placeholder_text="ctrl+shift", height=24)
        self.speak_hotkey_entry.insert(0, self.speak_hotkey)
        self.speak_hotkey_entry.pack(pady=1)
        
        # 4b. Speak with translate hotkey setting
        ctk.CTkLabel(self.overlay_frame, text="Хоткей озвучки С ПЕРЕВОДОМ:", font=ctk.CTkFont(size=11, weight="bold")).pack(pady=(4, 1))
        self.speak_translate_hotkey_entry = ctk.CTkEntry(self.overlay_frame, width=150, placeholder_text="ctrl+alt+x", height=24)
        self.speak_translate_hotkey_entry.insert(0, self.speak_translate_hotkey)
        self.speak_translate_hotkey_entry.pack(pady=1)
        
        # 5. Target language for translation
        ctk.CTkLabel(self.overlay_frame, text="Язык перевода экрана:", font=ctk.CTkFont(size=11, weight="bold")).pack(pady=(4, 1))
        langs = {"Русский": "ru", "English": "en", "Deutsch": "de", "Français": "fr", "Español": "es", "Chinese": "zh-CN"}
        curr_lang_name = "Русский"
        for name, code in langs.items():
            if code == self.translate_to:
                curr_lang_name = name
                break
        self.lang_option = ctk.CTkOptionMenu(self.overlay_frame, values=list(langs.keys()), command=self.change_translate_lang, height=24)
        self.lang_option.set(curr_lang_name)
        self.lang_option.pack(pady=1)

        # 6. Translation engine setting
        ctk.CTkLabel(self.overlay_frame, text="Движок перевода:", font=ctk.CTkFont(size=11, weight="bold")).pack(pady=(4, 1))
        engines = {"Google Translate": "google_cache", "Argos (Оффлайн)": "argos"}
        curr_eng_name = "Google Translate"
        for name, code in engines.items():
            if code == self.translation_engine:
                curr_eng_name = name
                break
        self.engine_option = ctk.CTkOptionMenu(self.overlay_frame, values=list(engines.keys()), command=self.on_change_engine, height=24)
        self.engine_option.set(curr_eng_name)
        self.engine_option.pack(pady=1)

        # 7. Argos status frame (dynamic container)
        self.argos_status_frame = ctk.CTkFrame(self.overlay_frame, fg_color="transparent")
        self.argos_status_frame.pack(pady=1)
        self.argos_status_label = None
        self.argos_download_btn = None
        
        # 8. Help & Save buttons
        self.help_btn = ctk.CTkButton(self.overlay_frame, text="📖 ИНСТРУКЦИЯ (ЛЕГЕНДА)", height=26, corner_radius=6, fg_color="#34C759", hover_color="#28A745", command=self.show_help_overlay)
        self.save_btn = ctk.CTkButton(self.overlay_frame, text="СОХРАНИТЬ И ЗАКРЫТЬ", height=26, corner_radius=6, fg_color="#007AFF", hover_color="#005BBB", command=self.save_and_close_overlay)
        
        # Initialize engine
        self.on_change_engine(curr_eng_name)
    def on_change_engine(self, selected_name):
        for child in self.argos_status_frame.winfo_children():
            child.destroy()
            
        # Скрываем временный статус-фрейм и кнопки перед переупаковкой
        self.argos_status_frame.pack_forget()
        if hasattr(self, "help_btn"):
            self.help_btn.pack_forget()
        if hasattr(self, "save_btn"):
            self.save_btn.pack_forget()
            
        # Получаем движок для проверки
        from translation_engine import get_engine
        engine = get_engine("argos")
        target_lang = getattr(self, "translate_to", "ru")
        is_installed = engine.is_model_installed('en', target_lang)

        if selected_name == "Argos (Оффлайн)":
            if not is_installed:
                self.argos_status_label = ctk.CTkLabel(self.argos_status_frame, text="Локальная модель EN->RU не установлена", text_color="#FF9500", font=ctk.CTkFont(size=10))
                self.argos_status_label.pack(pady=2)
                
                self.argos_download_btn = ctk.CTkButton(
                    self.argos_status_frame, 
                    text="Скачать модель (~150MB)", 
                    height=24, 
                    corner_radius=6, 
                    fg_color="#34C759", 
                    hover_color="#28A745",
                    command=self.start_argos_download
                )
                self.argos_download_btn.pack(pady=2)
                
                # Показываем статус и кнопку "Скачать"
                self.argos_status_frame.pack(pady=1)
            else:
                # Если модель установлена, показываем красивую зеленую надпись
                self.argos_status_label = ctk.CTkLabel(self.argos_status_frame, text="Локальная модель EN->RU готова", text_color="#34C759", font=ctk.CTkFont(size=10, weight="bold"))
                self.argos_status_label.pack(pady=2)
                self.argos_status_frame.pack(pady=1)
        else:
            # Для Google Translate скрываем фрейм статуса полностью
            pass
            
        # Всегда перепаковываем кнопки инструкции и сохранения в самый низ оверлея
        if hasattr(self, "help_btn"):
            self.help_btn.pack(pady=(8, 2))
        if hasattr(self, "save_btn"):
            self.save_btn.pack(pady=(2, 5))

        # Управляем геометрией окна в режиме mini для предотвращения пустот
        if self.display_mode == "mini":
            if selected_name == "Argos (Оффлайн)":
                if not is_installed:
                    self.geometry("480x440")
                else:
                    self.geometry("480x370")
            else:
                self.geometry("480x360")

    def start_argos_download(self):
        self.argos_download_btn.configure(state="disabled")
        self.engine_option.configure(state="disabled")
        
        import threading
        threading.Thread(target=self._run_argos_download, daemon=True).start()

    def _run_argos_download(self):
        from translation_engine import get_engine
        engine = get_engine("argos")
        target_lang = getattr(self, "translate_to", "ru")
        
        def update_status(msg):
            if hasattr(self, "argos_status_label") and self.argos_status_label and self.argos_status_label.winfo_exists():
                self.after(0, lambda: self.argos_status_label.configure(text=msg))
            
        success = engine.download_model('en', target_lang, progress_callback=update_status)
        
        def on_finish():
            if hasattr(self, "engine_option") and self.engine_option.winfo_exists():
                self.engine_option.configure(state="normal")
                self.on_change_engine(self.engine_option.get())
            
        self.after(0, on_finish)

    def change_translate_lang(self, name):
        langs = {"Русский": "ru", "English": "en", "Deutsch": "de", "Français": "fr", "Español": "es", "Chinese": "zh-CN"}
        self.translate_to = langs.get(name, "ru")
        if hasattr(self, "screen_translator_win") and self.screen_translator_win.winfo_exists():
            self.screen_translator_win.translate_to = self.translate_to
        self.save_settings()
        
    def save_and_close_overlay(self):
        try:
            if hasattr(self, "hotkey_entry") and self.hotkey_entry.winfo_exists():
                hk = self.hotkey_entry.get().strip().lower()
                if hk:
                    self.translate_hotkey = hk
            if hasattr(self, "speak_hotkey_entry") and self.speak_hotkey_entry.winfo_exists():
                shk = self.speak_hotkey_entry.get().strip().lower()
                if shk:
                    self.speak_hotkey = shk
            if hasattr(self, "speak_translate_hotkey_entry") and self.speak_translate_hotkey_entry.winfo_exists():
                sthk = self.speak_translate_hotkey_entry.get().strip().lower()
                if sthk:
                    self.speak_translate_hotkey = sthk
            if hasattr(self, "engine_option") and self.engine_option.winfo_exists():
                engines = {"Google Translate": "google_cache", "Argos (Оффлайн)": "argos", "Msty / Local API": "msty", "Ollama": "ollama"}
                sel_eng = self.engine_option.get()
                self.translation_engine = engines.get(sel_eng, "google_cache")
        except Exception as e:
            print(f"Error saving settings in overlay: {e}")
            
        self.save_settings()
        self.close_overlay()

    def update_font_slider(self, val):
        self.font_size = int(val)
        if hasattr(self, "font_lbl"):
            self.font_lbl.configure(text=f"Размер шрифта: {self.font_size}")
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
        if self.display_mode != "full": self.geometry("480x280")
        
        self.overlay_frame = ctk.CTkFrame(self, fg_color="#111", corner_radius=10, border_width=1, border_color="#333")
        if self.display_mode != "full": self.overlay_frame.grid(row=1, column=0, sticky="nsew", padx=10, pady=(0, 10))
        else: self.overlay_frame.place(relx=0.5, rely=0.5, anchor="center", relwidth=0.8, relheight=0.42)
        
        ctk.CTkLabel(self.overlay_frame, text="НАСТРОЙКА СКОРОСТИ", font=ctk.CTkFont(size=12, weight="bold"), text_color="#888").pack(pady=10)
        self.val_lbl = ctk.CTkLabel(self.overlay_frame, text=f"{self.current_rate}x", font=ctk.CTkFont(size=20, weight="bold"), text_color="#007AFF")
        self.val_lbl.pack()
        slider = ctk.CTkSlider(self.overlay_frame, from_=0.5, to=3.0, command=self.change_speed)
        slider.set(self.current_rate)
        slider.bind("<ButtonRelease-1>", lambda e: self.on_speed_slider_release())
        slider.pack(fill="x", padx=30, pady=(10, 5))
        
        # Ряд кнопок-пресетов скорости
        presets_frame = ctk.CTkFrame(self.overlay_frame, fg_color="transparent")
        presets_frame.pack(pady=(5, 10))
        
        def set_preset_speed(rate_val):
            slider.set(rate_val)
            self.change_speed(rate_val)
            self.on_speed_slider_release()
            
        presets = [1.0, 1.25, 1.5, 1.75, 2.0, 2.5]
        for p in presets:
            btn = ctk.CTkButton(
                presets_frame, 
                text=f"{p}x", 
                width=42, 
                height=22, 
                corner_radius=5, 
                fg_color="#222", 
                hover_color="#333",
                font=ctk.CTkFont(size=11),
                command=lambda val=p: set_preset_speed(val)
            )
            btn.pack(side="left", padx=2)
            
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
        
    def select_voice_no_save(self, voice):
        self.current_voice = voice
        self.btn_voice.configure(text=f"🔊 {self.current_voice.split(' ')[0]}")

    def translate_single_text(self, text):
        if not text:
            return ""
        try:
            from translation_engine import get_engine
            import re
            
            target_lang = self.translate_to
            
            def needs_translation(txt):
                latin_alpha = sum(1 for c in txt if ('A' <= c <= 'Z') or ('a' <= c <= 'z'))
                cyrillic_alpha = sum(1 for c in txt if ('а' <= c <= 'я' or c.lower() == 'ё'))
                if target_lang == "ru":
                    return latin_alpha >= 3
                else:
                    return cyrillic_alpha >= 3

            def is_mixed_text(txt):
                latin_alpha = sum(1 for c in txt if ('A' <= c <= 'Z') or ('a' <= c <= 'z'))
                cyrillic_alpha = sum(1 for c in txt if ('а' <= c <= 'я' or c.lower() == 'ё'))
                return latin_alpha > 0 and cyrillic_alpha > 0

            def get_translatable_words(txt):
                if target_lang == "ru":
                    words = re.findall(r'\b[a-zA-Z]{3,}\b', txt)
                    valid_words = {}
                    for w in words:
                        if '_' in w or any(c.isdigit() for c in w):
                            continue
                        if re.search(r'\.[a-zA-Z0-9]*\b' + re.escape(w) + r'\b', txt):
                            continue
                        if re.search(r'\b' + re.escape(w) + r'\.[a-zA-Z0-9]+', txt):
                            continue
                        if re.search(r'[a-zA-Z0-9_]*[\/\\]' + re.escape(w) + r'\b', txt) or re.search(r'\b' + re.escape(w) + r'[\/\\][a-zA-Z0-9_]*', txt):
                            continue
                        prepared = re.sub(r'(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])', ' ', w)
                        valid_words[w] = prepared
                    return valid_words
                else:
                    words = re.findall(r'\b[а-яА-ЯёЁ]{2,}\b', txt)
                    valid_words = {}
                    for w in words:
                        valid_words[w] = w
                    return valid_words

            sentences = self.split_into_sentences(text)
            texts_to_translate = []
            tasks = []
            
            translated_sentences = [text[start:end] for start, end in sentences]
            
            for i, (start, end) in enumerate(sentences):
                sent_text = text[start:end]
                if needs_translation(sent_text):
                    if is_mixed_text(sent_text):
                        words_map = get_translatable_words(sent_text)
                        if words_map:
                            for raw_w, prep_w in words_map.items():
                                if prep_w not in texts_to_translate:
                                    texts_to_translate.append(prep_w)
                                tasks.append(('word', i, raw_w, prep_w))
                    else:
                        if sent_text not in texts_to_translate:
                            texts_to_translate.append(sent_text)
                        tasks.append(('full', i, sent_text))

            trans_map = {}
            if texts_to_translate:
                kwargs = {}
                if self.translation_engine == "ollama":
                    kwargs["ollama_model"] = self.ollama_model
                    kwargs["ollama_url"] = self.ollama_url
                elif self.translation_engine == "msty":
                    kwargs["msty_model"] = self.msty_model
                    kwargs["msty_url"] = self.msty_url
                    
                engine = get_engine(self.translation_engine, **kwargs)
                batch_results = engine.translate_batch(texts_to_translate, target_lang)
                for orig, trans in zip(texts_to_translate, batch_results):
                    trans_map[orig] = trans

            for task_info in tasks:
                task_type = task_info[0]
                if task_type == 'full':
                    sent_idx, orig_text = task_info[1], task_info[2]
                    translated_sentences[sent_idx] = trans_map.get(orig_text, orig_text)
                elif task_type == 'word':
                    sent_idx, raw_w, prep_w = task_info[1], task_info[2], task_info[3]
                    word_trans = trans_map.get(prep_w)
                    if word_trans and word_trans.lower() != prep_w.lower():
                        curr_sent = translated_sentences[sent_idx]
                        pattern = r'\b' + re.escape(raw_w) + r'\b'
                        translated_sentences[sent_idx] = re.sub(pattern, word_trans, curr_sent)

            last_idx = 0
            final_parts = []
            for i, (start, end) in enumerate(sentences):
                if start > last_idx:
                    final_parts.append(text[last_idx:start])
                final_parts.append(translated_sentences[i])
                last_idx = end
                
            if last_idx < len(text):
                final_parts.append(text[last_idx:])
                
            return "".join(final_parts)
        except Exception as e:
            print(f"Error in translate_single_text: {e}")
            return text

    def toggle_translation_mode(self):
        self.stop_speech()
        self.translation_active = not self.translation_active
        
        if self.translation_active:
            self.pre_translation_voice = self.current_voice
            target_lang = self.translate_to
            if not is_voice_matching_lang(self.current_voice, target_lang):
                default_v = DEFAULT_VOICES_BY_LANG.get(target_lang, "Светлана (RU)")
                self.select_voice_no_save(default_v)
                
            self.btn_translate_toggle.configure(fg_color="#34C759", text_color="#fff")
            current_text = self.text_box.get("1.0", "end").strip()
            self.original_raw_text = current_text
            self.c_status.configure(text="Перевод текста...")
            threading.Thread(target=self.async_translate_text, args=(current_text,), daemon=True).start()
        else:
            if hasattr(self, 'pre_translation_voice') and self.pre_translation_voice:
                self.select_voice_no_save(self.pre_translation_voice)
                
            self.btn_translate_toggle.configure(fg_color="#222", text_color="#ccc")
            if hasattr(self, 'original_raw_text') and self.original_raw_text:
                self.text_box.delete("0.0", "end")
                self.text_box.insert("0.0", self.original_raw_text)
                if self.markdown_enabled: self.apply_markdown_tags()
                self.text_box.mark_set("insert", "1.0")
                self.play_from_text(0)

    def async_translate_text(self, text):
        if not text: return
        try:
            translated = self.translate_single_text(text)
            self.after(0, lambda: self.apply_translated_text(translated))
        except Exception as e:
            print(f"Error in async_translate_text: {e}")
            self.after(0, lambda: self.c_status.configure(text="Ошибка перевода"))

    def apply_translated_text(self, translated):
        self.translated_raw_text = translated
        if self.translation_active:
            self.text_box.delete("0.0", "end")
            self.text_box.insert("0.0", translated)
            if self.markdown_enabled: self.apply_markdown_tags()
            self.text_box.mark_set("insert", "1.0")
            if not self.is_speaking:
                self.c_status.configure(text="Выделите текст и нажмите Ctrl+Shift", text_color="#888")
            self.play_from_text(0)

    def async_translate_and_play(self, text):
        try:
            translated = self.translate_single_text(text)
            self.after(0, lambda: self.apply_translated_and_play(translated))
        except Exception as e:
            print(f"Error in async_translate_and_play: {e}")
            self.after(0, lambda: self.apply_translated_and_play(text))

    def apply_translated_and_play(self, translated):
        self.translated_raw_text = translated
        if self.translation_active:
            self.text_box.delete("0.0", "end")
            self.text_box.insert("0.0", translated)
            if self.markdown_enabled: self.apply_markdown_tags()
            self.text_box.mark_set("insert", "1.0")
            self.play_from_text(0)

    def close_overlay(self):
        if self.overlay_frame:
            try:
                self.overlay_frame.place_forget()
            except: pass
            try:
                self.overlay_frame.grid_forget()
            except: pass
            try:
                self.overlay_frame.pack_forget()
            except: pass
            
            try:
                self.overlay_frame.destroy()
            except Exception as e:
                print(f"Error destroying overlay_frame: {e}")
                try:
                    with open(os.path.join(APP_DIR, "overlay_destroy_error.log"), "w", encoding="utf-8") as f:
                        import traceback
                        f.write(traceback.format_exc())
                except:
                    pass
            
            self.overlay_frame = None
            self.current_overlay = None
            if hasattr(self, 'btn_settings'): self.btn_settings.configure(fg_color="transparent")
            if hasattr(self, 'btn_help'): self.btn_help.configure(fg_color="transparent")
            if hasattr(self, 'btn_speed'): self.btn_speed.configure(fg_color="#222")
            if hasattr(self, 'btn_mini_speed'): self.btn_mini_speed.configure(fg_color="#222")
            if hasattr(self, 'btn_voice'): self.btn_voice.configure(fg_color="#222")
            if hasattr(self, 'btn_mini_voice'): self.btn_mini_voice.configure(fg_color="#222")
            if self.display_mode == "mini":
                self.geometry("480x350" if getattr(self, "mini_drawer_open", False) else "480x60")
            elif self.display_mode == "micro":
                self.geometry("170x60")

    def change_speed(self, value):
        self.current_rate = round(float(value), 2)
        self.val_lbl.configure(text=f"{self.current_rate}x")
        self.btn_speed.configure(text=f"⚡ {self.current_rate}x")
        self.btn_mini_speed.configure(text=f"{self.current_rate}x")
        self.save_settings()

    # --- Play Logic ---
    def open_screen_translator(self):
        # Check if screen translator window is already open
        if hasattr(self, "screen_translator_win") and self.screen_translator_win.winfo_exists():
            # Если оверлей уже открыт, то клик закрывает его
            try:
                self.screen_translator_win.destroy()
            except:
                pass
        else:
            from screen_translator import AreaSelector
            def on_area_selected(x, y, w, h, cropped_img):
                if x is not None:
                    from screen_translator import ScreenTranslatorFrame
                    # Рамки по 5 пикселей, верхний отступ под тулбар 28 пикселей.
                    win_w = w + 10
                    win_h = h + 38
                    win_x = x - 5
                    win_y = y - 33
                    
                    self.screen_translator_win = ScreenTranslatorFrame(
                        self, 
                        translate_to=self.translate_to, 
                        target_x=x, 
                        target_y=y
                    )
                    self.screen_translator_win.geometry(f"{win_w}x{win_h}+{win_x}+{win_y}")
                    self.screen_translator_win.focus()
                    self.screen_translator_win.translate_precropped(cropped_img)
                    
                    # Подсвечиваем синим цветом кнопку перевода экрана в главном окне
                    if hasattr(self, "btn_screen_translate"):
                        self.btn_screen_translate.configure(fg_color="#007AFF")
                    
            selector = AreaSelector(self, on_area_selected)

    def on_screen_translator_closed(self):
        # Сбрасываем подсветку кнопки перевода экрана в главном окне
        if hasattr(self, "btn_screen_translate"):
            self.btn_screen_translate.configure(fg_color="#222")

    def start_hotkey_listener(self):
        def check_hotkey():
            while True:
                try:
                    if hasattr(self, "translate_hotkey") and self.translate_hotkey:
                        if keyboard.is_pressed(self.translate_hotkey):
                            self.after(0, self.open_screen_translator)
                            time.sleep(1.0)
                            continue
                            
                    if hasattr(self, "speak_translate_hotkey") and self.speak_translate_hotkey:
                        if keyboard.is_pressed(self.speak_translate_hotkey):
                            self.on_hotkey_triggered(force_translate=True)
                            time.sleep(1.0)
                            continue

                    if hasattr(self, "speak_hotkey") and self.speak_hotkey:
                        if keyboard.is_pressed(self.speak_hotkey):
                            self.on_hotkey_triggered(force_translate=False)
                            time.sleep(1.0)
                            continue
                except Exception as e:
                    pass
                time.sleep(0.05)
        threading.Thread(target=check_hotkey, daemon=True).start()

    def on_hotkey_triggered(self, force_translate=False):
        timeout = time.time() + 1.0
        while (keyboard.is_pressed('ctrl') or keyboard.is_pressed('shift') or keyboard.is_pressed('alt')) and time.time() < timeout:
            time.sleep(0.05)
        time.sleep(0.1)
        pyperclip.copy("") 
        ctypes.windll.user32.keybd_event(0x11, 0, 0, 0)
        ctypes.windll.user32.keybd_event(0x43, 0, 0, 0)
        ctypes.windll.user32.keybd_event(0x43, 0, 2, 0)
        ctypes.windll.user32.keybd_event(0x11, 0, 2, 0)
        time.sleep(0.3)
        text = pyperclip.paste().strip()
        if text: self.after(0, lambda: self.update_text_and_play(text, force_translate=force_translate))

    def update_text_and_play(self, text, force_translate=False):
        if force_translate and not self.translation_active:
            self.toggle_translation_mode()
            
        self.original_raw_text = text
        self.translated_raw_text = None
            
        if self.translation_active:
            self.text_box.delete("0.0", "end")
            self.text_box.insert("0.0", "Перевод текста...")
            self.stop_speech()
            threading.Thread(target=self.async_translate_and_play, args=(text,), daemon=True).start()
        else:
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

    def split_into_sentences(self, text):
        if not text:
            return []
        
        try:
            import pysbd
            import re
            
            # Динамически определяем доминирующий язык текста
            latin_chars = sum(1 for c in text if ('a' <= c.lower() <= 'z'))
            cyrillic_chars = sum(1 for c in text if ('а' <= c.lower() <= 'я' or c.lower() == 'ё'))
            lang = "ru" if cyrillic_chars > latin_chars else "en"
            
            segmenter = pysbd.Segmenter(language=lang, clean=False, char_span=True)
            spans = segmenter.segment(text)
            
            sentences = []
            for span in spans:
                s = span.sent
                stripped = s.strip()
                if stripped:
                    leading_spaces = len(s) - len(s.lstrip())
                    trailing_spaces = len(s) - len(s.rstrip())
                    sentences.append((span.start + leading_spaces, span.end - trailing_spaces))
            
            # Склеиваем разорванные инициалы без пробела (например, "А.С." и "Пушкин")
            merged_sentences = []
            for start, end in sentences:
                if not merged_sentences:
                    merged_sentences.append((start, end))
                else:
                    prev_start, prev_end = merged_sentences[-1]
                    prev_text = text[prev_start:prev_end].strip()
                    curr_text = text[start:end].strip()
                    
                    is_initial = False
                    if re.search(r'\b[А-ЯЁA-Z]\.[А-ЯЁA-Z]\.$', prev_text):
                        is_initial = True
                    elif re.search(r'\b[А-ЯЁA-Z]\.$', prev_text):
                        is_initial = True
                        # Если перед одиночной буквой стоит строчное слово длиной > 3, то это не инициал
                        match = re.search(r'([a-zA-Zа-яА-ЯёЁ-]+)\s+[А-ЯЁA-Z]\.$', prev_text)
                        if match:
                            before_word = match.group(1)
                            if before_word[0].islower() and len(before_word) > 3:
                                is_initial = False
                                
                    starts_with_upper = curr_text and curr_text[0].isupper()
                    
                    if is_initial and starts_with_upper:
                        merged_sentences[-1] = (prev_start, end)
                    else:
                        merged_sentences.append((start, end))
            
            return merged_sentences
        except Exception as e:
            print(f"Error using pysbd, falling back to regex: {e}")
            import re
            sentences = []
            for m in re.finditer(r'[^.!?]+[.!?]*', text):
                s = m.group()
                stripped = s.strip()
                if stripped:
                    leading_spaces = len(s) - len(s.lstrip())
                    trailing_spaces = len(s) - len(s.rstrip())
                    sentences.append((m.start() + leading_spaces, m.end() - trailing_spaces))
            return sentences

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
        self.sentence_offsets = self.split_into_sentences(full_text)
        raw_sentences = [full_text[start:end] for start, end in self.sentence_offsets]
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
        
        if self.display_mode == "mini":
            self.c_status.pack_forget()
            self.scrub_container_mini.pack(in_=self.mini_center, fill="x", expand=True)
            
        while not self.item_queue.empty(): self.item_queue.get()
        threading.Thread(target=self.producer_thread, args=(self.current_sentences, start_idx, reuse_cache), daemon=True).start()
        threading.Thread(target=self.consumer_thread, args=(len(self.current_sentences), start_idx), daemon=True).start()

    def clear_text_box(self):
        self.stop_speech()
        self.text_box.delete("0.0", "end")

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
        self.play_main.configure(text="▶ ПЛЕЙ")
        if hasattr(self, 'play_mini'):
            self.play_mini.configure(text="▶")
        if hasattr(self, 'play_micro'):
            self.play_micro.configure(text="▶")

    def resume_speech(self):
        if not self.is_speaking or not self.is_paused:
            return
        self.is_paused = False
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
        sentences_with_offsets = self.split_into_sentences(full_text)
                
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

        async def download_sentence(i, text):
            if self.stop_requested:
                return i, None
            s_hash = hashlib.md5(f"{text}_{self.current_voice}_{self.current_rate}".encode()).hexdigest()
            file_path = os.path.join(temp_dir, f"c_{s_hash}.mp3")
            if not os.path.exists(file_path):
                try:
                    rate_str = f"{int((self.current_rate - 1) * 100):+d}%"
                    voice_id = VOICES.get(self.current_voice, VOICES["Светлана (RU)"])
                    communicate = edge_tts.Communicate(text, voice_id, rate=rate_str)
                    await communicate.save(file_path)
                except Exception as e:
                    print(f"Download failed for sentence {i}: {e}")
                    file_path = None
            return i, file_path

        async def start_downloads():
            tasks = [asyncio.create_task(download_sentence(i, sentences[i])) for i in range(start_idx, len(sentences))]
            return tasks

        # Запускаем все скачивания параллельно
        tasks = loop.run_until_complete(start_downloads())

        # Ожидаем завершения каждой задачи строго по порядку и отправляем в плеер
        for i, task in enumerate(tasks):
            if self.stop_requested:
                break
            actual_idx = start_idx + i
            idx, file_path = loop.run_until_complete(task)
            
            p = (actual_idx + 1) / len(sentences)
            self.after(0, lambda val=p: self.buffer_prog_full.set(val))
            self.after(0, lambda val=p: self.buffer_prog_mini.set(val))
            self.after(0, lambda idx=actual_idx: self.highlight_sentence(idx, "buffered"))
            
            self.item_queue.put((actual_idx, file_path))
            
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
                    
                    was_paused = False
                    while not self.stop_requested:
                        if self.is_paused:
                            if not was_paused:
                                winmm.mciSendStringW('stop widget_audio', None, 0, None)
                                was_paused = True
                            time.sleep(0.05)
                            continue
                            
                        if was_paused:
                            winmm.mciSendStringW('close widget_audio', None, 0, None)
                            winmm.mciSendStringW(cmd_open, None, 0, None)
                            winmm.mciSendStringW('play widget_audio', None, 0, None)
                            was_paused = False
                            
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
