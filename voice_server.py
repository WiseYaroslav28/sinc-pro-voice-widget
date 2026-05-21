import asyncio
import os
import ctypes
import time
import tempfile
import uuid
import edge_tts
from mcp.server.fastmcp import FastMCP

# Create an MCP server
mcp = FastMCP("Antigravity Voice")

VOICES = {
    "ru": "ru-RU-SvetlanaNeural",
    "en": "en-US-GuyNeural"
}

def play_audio_mci(file_path):
    """Play audio on Windows using MCI (Media Control Interface)."""
    winmm = ctypes.windll.winmm
    abs_path = os.path.abspath(file_path)
    
    # Unique alias for this playback
    alias = f"mcp_{uuid.uuid4().hex}"
    
    cmd_open = f'open "{abs_path}" type mpegvideo alias {alias}'
    res = winmm.mciSendStringW(cmd_open, None, 0, None)
    if res != 0:
        raise Exception(f"Failed to open audio file via MCI, code {res}")
        
    winmm.mciSendStringW(f'play {alias}', None, 0, None)
    
    while True:
        buf = ctypes.create_unicode_buffer(128)
        winmm.mciSendStringW(f'status {alias} mode', buf, 128, None)
        if buf.value != 'playing':
            break
        time.sleep(0.05)
        
    winmm.mciSendStringW(f'close {alias}', None, 0, None)

async def play_audio_windows(file_path):
    """Play audio on Windows in a non-blocking background thread."""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, play_audio_mci, file_path)

@mcp.tool()
async def say(text: str, lang: str = "ru", rate: str = "+0%") -> str:
    """
    Speaks the provided text aloud.
    :param text: The text to speak.
    :param lang: Language code ('ru' or 'en'). Default is 'ru'.
    :param rate: Speed rate (e.g. '+0%', '-20%', '+50%'). Default is '+0%'.
    """
    voice = VOICES.get(lang, VOICES["ru"])
    temp_dir = tempfile.gettempdir()
    temp_file = os.path.join(temp_dir, f"mcp_voice_{uuid.uuid4().hex}.mp3")
    
    try:
        communicate = edge_tts.Communicate(text, voice, rate=rate)
        await communicate.save(temp_file)
        
        await play_audio_windows(temp_file)
        
        return f"Successfully spoke: {text[:50]}..."
    except Exception as e:
        return f"Error in voice synthesis: {str(e)}"
    finally:
        if os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except:
                pass


if __name__ == "__main__":
    mcp.run()

