# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas_pysbd, binaries_pysbd, hiddenimports_pysbd = collect_all('pysbd')

a = Analysis(
    ['voice_widget.py'],
    pathex=[],
    binaries=binaries_pysbd,
    datas=[('sinc_icon.ico', '.'), ('translation_engine.py', '.'), ('ocr_translation.py', '.'), ('screen_translator.py', '.')] + datas_pysbd,
    hiddenimports=['pyttsx3.drivers', 'pyttsx3.drivers.sapi5', 'winrt.windows.media.ocr', 'winrt.windows.storage', 'winrt.windows.graphics.imaging', 'winrt.windows.storage.streams', 'winrt.windows.globalization', 'comtypes', 'comtypes.stream'] + hiddenimports_pysbd,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib', 'scipy', 'pandas', 'pytest', 'notebook', 'IPython', 'docutils', 'sphinx',
        'torch', 'tensorflow', 'onnxruntime', 'argostranslate', 'ctranslate2', 'spacy', 'thinc', 'tensorboard', 'lxml'
    ],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='SINC_PRO',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['sinc_icon.ico'],
)
