import asyncio
import os
import tempfile
import uuid
from PIL import Image
from deep_translator import GoogleTranslator

# Windows Runtime imports (will be resolved at runtime after pip install)
try:
    from winrt.windows.graphics.imaging import BitmapDecoder
    from winrt.windows.media.ocr import OcrEngine
    from winrt.windows.storage import StorageFile, FileAccessMode
    winrt_available = True
except ImportError:
    winrt_available = False

async def run_ocr_on_file(file_path: str) -> list:
    """Runs Windows OCR on an image file and returns a list of dictionaries:
    {'text': str, 'bbox': (x1, y1, x2, y2)}
    """
    if not winrt_available:
        raise ImportError("WinRT OCR libraries are not installed or not supported on this platform.")

    abs_path = os.path.abspath(file_path)
    file = await StorageFile.get_file_from_path_async(abs_path)
    stream = await file.open_async(FileAccessMode.READ)
    decoder = await BitmapDecoder.create_async(stream)
    software_bitmap = await decoder.get_software_bitmap_async()

    # Create engine based on user profile languages
    engine = OcrEngine.try_create_from_user_profile_languages()
    if not engine:
        raise RuntimeError("Failed to create OcrEngine. Make sure language packs are installed.")

    result = await engine.recognize_async(software_bitmap)
    
    lines_data = []
    for line in result.lines:
        words = list(line.words)
        if not words:
            continue
        
        # Calculate bounding box for the entire line from its words
        min_x = min(w.bounding_rect.x for w in words)
        min_y = min(w.bounding_rect.y for w in words)
        max_x = max(w.bounding_rect.x + w.bounding_rect.width for w in words)
        max_y = max(w.bounding_rect.y + w.bounding_rect.height for w in words)
        
        lines_data.append({
            "text": line.text,
            "bbox": (min_x, min_y, max_x, max_y)
        })
        
    return lines_data

def translate_batch_texts(texts: list, target_lang: str) -> list:
    """Translates a list of texts using GoogleTranslator (deep-translator) in batch."""
    if not texts:
        return []
    try:
        translator = GoogleTranslator(source='auto', target=target_lang)
        # translate_batch returns list of translated strings
        return translator.translate_batch(texts)
    except Exception as e:
        print(f"Translation error: {e}")
        # Return original texts as fallback
        return texts

async def perform_ocr_and_translation(image: Image.Image, target_lang: str) -> list:
    """Saves Pillow Image, runs OCR, translates texts, and returns list of:
    {'text': str, 'bbox': (x1, y1, x2, y2), 'original_text': str}
    """
    temp_dir = tempfile.gettempdir()
    temp_filename = os.path.join(temp_dir, f"ocr_{uuid.uuid4().hex}.png")
    
    try:
        # Save image to temp file (WinRT OCR works best with file decoder)
        # Using PNG format to preserve text clarity
        image.save(temp_filename, format="PNG")
        
        # Run OCR
        ocr_lines = await run_ocr_on_file(temp_filename)
        if not ocr_lines:
            return []
            
        # Extract texts for batch translation
        original_texts = [line["text"] for line in ocr_lines]
        
        # Run translation in a thread pool to avoid blocking the asyncio loop
        loop = asyncio.get_running_loop()
        translated_texts = await loop.run_in_executor(
            None, 
            translate_batch_texts, 
            original_texts, 
            target_lang
        )
        
        # Combine back
        result = []
        for i, line in enumerate(ocr_lines):
            translated = translated_texts[i] if i < len(translated_texts) else line["text"]
            result.append({
                "text": translated,
                "original_text": line["text"],
                "bbox": line["bbox"]
            })
            
        return result
        
    finally:
        # Clean up temp file
        if os.path.exists(temp_filename):
            try:
                os.remove(temp_filename)
            except:
                pass
