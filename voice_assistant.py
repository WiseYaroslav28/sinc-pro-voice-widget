import pystray
from PIL import Image
import keyboard
import pyperclip
import asyncio
import edge_tts
import os
import ctypes
import sys
import threading
import time
import re
import winsound

def resource_path(relative_path):
    """ Get absolute path to resource, works for dev and for PyInstaller """
    try:
        base_path = sys._MEIPASS
    except Exception:
        base_path = os.path.abspath(".")
    return os.path.join(base_path, relative_path)

# Configuration
VOICES = {"ru": "ru-RU-SvetlanaNeural", "en": "en-US-GuyNeural"}
RATE = "+0%"
HOTKEY = 'ctrl+alt+v'

# Dynamically resolve icon path
ICON_PATH = resource_path("sinc_icon.ico")
if not os.path.exists(ICON_PATH):
    ICON_PATH = "sinc_icon.ico"  # Fallback

stop_requested = False
is_speaking = False

def notify(icon, title, message):
    if icon:
        icon.notify(message, title)

def play_audio(file_path):
    global stop_requested
    winmm = ctypes.windll.winmm
    abs_path = os.path.abspath(file_path)
    
    # Close any leftover device
    winmm.mciSendStringW('close voice_ast', None, 0, None)
    
    cmd_open = f'open "{abs_path}" type mpegvideo alias voice_ast'
    res = winmm.mciSendStringW(cmd_open, None, 0, None)
    if res != 0:
        return
        
    winmm.mciSendStringW('play voice_ast', None, 0, None)
    
    while not stop_requested:
        buf = ctypes.create_unicode_buffer(128)
        winmm.mciSendStringW('status voice_ast mode', buf, 128, None)
        if buf.value != 'playing':
            break
        time.sleep(0.05)
        
    winmm.mciSendStringW('stop voice_ast', None, 0, None)
    winmm.mciSendStringW('close voice_ast', None, 0, None)

def stop_audio():
    global stop_requested
    stop_requested = True


def split_text_by_language(text):
    # Improved splitter that handles punctuation better
    parts = re.split(r'([а-яА-ЯёЁ]+[а-яА-ЯёЁ\s,.;:!?0-9]*)', text)
    segments = []
    for p in parts:
        if not p.strip(): continue
        lang = "ru" if re.search(r'[а-яА-ЯёЁ]', p) else "en"
        segments.append((lang, p))
    return segments

async def speak_text_async(text, icon=None):
    global is_speaking, stop_requested
    if not text.strip() or is_speaking:
        return
    
    is_speaking = True
    stop_requested = False
    try:
        segments = split_text_by_language(text)
        for lang, segment_text in segments:
            if stop_requested:
                break
            voice = VOICES.get(lang, VOICES["ru"])
            temp_file = os.path.join(os.environ["TEMP"], f"voice_{lang}.mp3")
            communicate = edge_tts.Communicate(segment_text, voice, rate=RATE)
            await communicate.save(temp_file)
            if stop_requested:
                break
            play_audio(temp_file)
    except Exception as e:
        print(f"Error: {e}")
    finally:
        is_speaking = False

def on_hotkey(icon=None):
    winsound.Beep(800, 100)
    
    # Wait for user to release hotkey modifiers
    start_wait = time.time()
    while (keyboard.is_pressed('ctrl') or keyboard.is_pressed('alt') or keyboard.is_pressed('v')) and (time.time() - start_wait < 1.0):
        time.sleep(0.05)
    
    time.sleep(0.1) # Small buffer
    
    # Save current clipboard
    old_clipboard = pyperclip.paste()
    
    # Try to copy selected text
    pyperclip.copy("") # Clear to detect success
    keyboard.press_and_release('ctrl+c')
    time.sleep(0.3)
    
    selected_text = pyperclip.paste()
    
    if not selected_text.strip():
        # Fallback to old clipboard if nothing new was copied (maybe user didn't highlight)
        selected_text = old_clipboard
    
    if selected_text and selected_text.strip():
        if icon:
            preview = (selected_text[:30] + '..') if len(selected_text) > 30 else selected_text
            icon.notify(f"Читаю: {preview}", "Antigravity Voice")
        
        stop_audio()
        # Wait for the previous speech thread to clean up
        while is_speaking:
            time.sleep(0.05)
            
        threading.Thread(target=lambda: asyncio.run(speak_text_async(selected_text, icon)), daemon=True).start()


def set_rate(rate_str, icon):
    global RATE
    RATE = rate_str
    icon.update_menu()

def load_app_settings():
    if getattr(sys, 'frozen', False):
        app_dir = os.path.dirname(sys.executable)
    else:
        app_dir = os.path.dirname(os.path.abspath(__file__))
    settings_file = os.path.join(app_dir, "voice_settings.json")
    
    translate_to = "ru"
    translate_hotkey = "ctrl+alt+t" # Default
    speak_hotkey = "ctrl+alt+v" # Default fallback for tray app
    
    if os.path.exists(settings_file):
        try:
            import json
            with open(settings_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                translate_to = data.get("translate_to", "ru")
                translate_hotkey = data.get("translate_hotkey", "ctrl+alt+t")
                # Auto-fix old conflicting hotkey if present in settings file
                if translate_hotkey == "ctrl+shift+t":
                    translate_hotkey = "ctrl+alt+t"
                # In settings we might have ctrl+shift for widget, 
                # but if we run from tray, we can use either the widget's hotkey
                # or fallback to ctrl+alt+v if it conflicts.
                speak_hotkey = data.get("speak_hotkey", "ctrl+alt+v")
        except:
            pass
    return translate_to, translate_hotkey, speak_hotkey

def open_screen_translator_from_tray(icon=None):
    def run_gui():
        try:
            import customtkinter as ctk
            from screen_translator import AreaSelector, ScreenTranslatorFrame
            
            # Create hidden root
            root = ctk.CTk()
            root.withdraw()
            
            translate_to, _, _ = load_app_settings()
            
            class TrayAppAdapter:
                def __init__(self, translate_to):
                    self.translate_to = translate_to
                    
                def update_text_and_play(self, text):
                    stop_audio()
                    while is_speaking:
                        time.sleep(0.05)
                    threading.Thread(target=lambda: asyncio.run(speak_text_async(text, icon)), daemon=True).start()
                    
            adapter = TrayAppAdapter(translate_to)
            
            def on_area_selected(x, y, w, h):
                if x is not None:
                    win_h = h + 28 + 2 * 4
                    win_w = w + 2 * 4
                    win_x = x - 4
                    win_y = y - 28 - 4
                    
                    win = ScreenTranslatorFrame(adapter, translate_to=translate_to)
                    win.geometry(f"{win_w}x{win_h}+{win_x}+{win_y}")
                    win.focus()
                    win.translate_area()
                    win.mainloop()
                    
            selector = AreaSelector(root, on_area_selected)
            selector.mainloop()
            
        except Exception as e:
            print(f"Error opening translator from tray: {e}")
        
    threading.Thread(target=run_gui, daemon=True).start()

def create_tray():
    image = Image.open(ICON_PATH)
    translate_to, translate_hotkey, speak_hotkey = load_app_settings()
    
    def is_checked(rate):
        return lambda item: RATE == rate

    menu = pystray.Menu(
        pystray.MenuItem(f"Озвучить ({speak_hotkey.upper()})", lambda icon: on_hotkey(icon)),
        pystray.MenuItem(f"Перевод экрана ({translate_hotkey.upper()})", lambda icon: open_screen_translator_from_tray(icon)),
        pystray.MenuItem("Остановить", lambda: stop_audio()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Скорость", pystray.Menu(
            pystray.MenuItem("0.75x", lambda icon: set_rate("-25%", icon), checked=is_checked("-25%")),
            pystray.MenuItem("1.0x", lambda icon: set_rate("+0%", icon), checked=is_checked("+0%")),
            pystray.MenuItem("1.25x", lambda icon: set_rate("+25%", icon), checked=is_checked("+25%")),
            pystray.MenuItem("1.5x", lambda icon: set_rate("+50%", icon), checked=is_checked("+50%")),
            pystray.MenuItem("1.75x", lambda icon: set_rate("+75%", icon), checked=is_checked("+75%")),
            pystray.MenuItem("2.0x", lambda icon: set_rate("+100%", icon), checked=is_checked("+100%")),
        )),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Выход", lambda icon: icon.stop())
    )
    
    icon = pystray.Icon("Antigravity Voice", image, "Antigravity Voice Assistant", menu)
    
    if speak_hotkey:
        try:
            keyboard.add_hotkey(speak_hotkey, lambda: on_hotkey(icon))
        except Exception as e:
            print(f"Failed to register speak hotkey: {e}")
            
    if translate_hotkey:
        try:
            keyboard.add_hotkey(translate_hotkey, lambda: open_screen_translator_from_tray(icon))
        except Exception as e:
            print(f"Failed to register translate hotkey: {e}")
            
    icon.run()

if __name__ == "__main__":
    create_tray()
