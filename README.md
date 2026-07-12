<a name="ru"></a>
# [🇷🇺] SINC PRO - Умный Голосовой Ассистент & Виджет Озвучки

[🇷🇺 Русский](#ru) | [🇺🇸 English](#en)

SINC PRO — это локальное и облачное desktop-приложение для Windows на базе Tauri, Vanilla JS и Rust, предоставляющее мощные инструменты умной диктовки голосом через Gemini AI, быстрого перевода интерфейсов (OCR) и озвучки текста (Edge TTS).

## 🚀 Основные возможности

*   **🎙️ Смарт-микрофон (SINC Orb / Капсула)**: Запись голоса по нажатию `Ctrl + Win` с мгновенным форматированием с помощью Gemini AI (пресеты: краткая суть, надиктованный текст, или собственный промпт).
*   **🧠 Среда ИИ-обработки (Новый запрос)**: Создание точечных ИИ-запросов на основе аудиозаписи, исходного текста транскрипции или любых ранее полученных ИИ-результатов. Позволяет выстраивать последовательные цепочки обработки (например, выделить «Суть» из текста, а затем перевести эту «Суть» на другой язык кастомным промптом).
*   **🔊 Виджет озвучки (Edge TTS)**: Озвучивание выделенного текста по нажатию `Ctrl + Shift + S` с выбором голоса, скорости и тона. Поддерживает компактный плавающий режим с круговой шкалой прогресса (буферизация/воспроизведение) и автосворачиванием по ховеру.
*   **🔍 Оверлей переводчика (OCR)**: Мгновенное распознавание текста на экране по `Alt + Q` с переводом через ИИ или локальный движок.
*   **🔌 Отказоустойчивость ИИ (Локальный Fallback)**: При сбое или отсутствии доступа к облачному API Gemini, приложение автоматически перенаправляет запросы на локальные ИИ-модели: Whisper для распознавания речи (STT) и Ollama/локальные серверы для текстового анализа.
*   **⌨️ Автоматическая и ручная смена раскладки текста**:
    *   **Ручной режим**: Смена раскладки выделенного или последнего введенного слова по настраиваемому хоткею (по умолчанию `Ctrl + Pause`) с автоматическим переключением языка ввода Windows.
    *   **Автоматический режим (на лету)**: Интеллектуальный Punto-анализатор проверяет слова при вводе пробела или Enter и автоматически исправляет текст с мягким кликающим звуком.
    *   **Отмена автозамены**: Нажатие `Shift + Backspace` мгновенно отменяет автоисправление, возвращая исходный текст и раскладку (работает строго сразу после исправления).
*   **🛠️ Системный трей и автозапуск**: Сворачивание в трей при закрытии, запуск вместе с Windows и умное восстановление открытых окон.
*   **💾 Сохранение геометрии**: Все окна автоматически запоминают свои координаты и размеры, адаптируясь под изменение количества мониторов.

---

## 🛠️ Стек технологий

*   **Бэкенд**: Rust, Tauri v2, Windows API (winapi), Win32 хуки клавиатуры.
*   **Фронтенд**: HTML5, Vanilla JavaScript, CSS3 (Tailwind CSS v4).
*   **Интеграции**: Google Gemini API, Yandex Translate API, Microsoft Edge TTS.

---

## 📦 Быстрый старт (Запуск разработчика)

### Требования
1. Установленный [Rust / Cargo](https://rustup.rs/) (версия 1.75+).
2. [Node.js](https://nodejs.org/) (версия 18+).

### Инструкция за 3 шага

1.  **Установка зависимостей**:
    ```bash
    npm install
    ```
2.  **Сборка стилей Tailwind**:
    ```bash
    npm run build:css
    ```
3.  **Запуск приложения в режиме разработки**:
    ```bash
    npm run tauri dev
    ```

---

<details>
<summary>⚙️ Под капотом (Архитектура и логика работы)</summary>

### 3-позиционные переключатели режимов
Для каждого модуля (Капсула, Виджет, OCR) доступно 3 состояния:
*   **0 (Выключен)**: Модуль полностью деактивирован, хуки клавиатуры не перехватываются.
*   **1 (Только хоткеи)**: Окна виджетов скрыты с экрана. При нажатии горячих клавиш окно временно появляется на время работы и автоматически скрывается обратно.
*   **2 (Все включено)**: Виджеты постоянно отображаются на экране поверх других окон.

### Автоматическая смена раскладки текста (Автораскладка)
Модуль смены раскладки клавиатуры переведен в полноценный 3-позиционный режим:
*   **0 (Выключено)**: Анализ клавиатуры и перехват хоткеев отключены.
*   **1 (Ручной режим)**: Быстрая смена раскладки по настраиваемому хоткею (например, `Ctrl + Pause`).
*   **2 (Автозамена на лету)**: Автоматическое исправление текста по пробелу или Enter на основе эвристического анализа букв и буквосочетаний.

**Дополнительные механизмы модуля:**
*   **Выделенный раздел управления**: В боковой панели меню добавлен раздел «Автораскладка», где можно настраивать хоткеи, просматривать текущие комбинации, а также управлять списками исключений.
*   **Исключения слов**: Интерактивный список слов (тегов-чипсов), которые не будут автоматически исправляться (например, сленговые слова).
*   **Исключения приложений (Черный список процессов)**: Настройка программ (например, `code.exe`, `cmd.exe`), в которых автозамена раскладки полностью отключается.
*   **Игнорирование аббревиатур (ALL CAPS)**: Слова, написанные целиком заглавными буквами (например `RGB`, `HTML`), автоматически игнорируются автозаменой.
*   **Очистка буфера по таймауту**: При паузе в печати более 2 секунд буфер ввода сбрасывается, исключая рассинхронизацию.
*   **Защита от зацикливания**: Во время симуляции нажатий клавиш бэкенд выставляет флаг `LAYOUT_PROCESSING`, блокируя повторный перехват хука клавиатуры.

### Запуск в свернутом виде (Автозапуск в трей)
При старте ОС с флагом `--minimized` приложение:
1. Оставляет главное окно (дашборд) скрытым в трее, если пользователь сам закрыл его перед выходом.
2. Автоматически запускает и показывает на экране active виджеты (в режиме `2`).

### Мультимониторная безопасность
Перед восстановлением сохраненных координат X, Y приложение опрашивает API `availableMonitors()`. Если сохраненные координаты ведут на отключенный монитор, окно автоматически центрируется на основном экране для предотвращения «улетания» за видимые границы.

### Локальный OCR переводчик (WinRT API & xcap)
*   **Захват экрана**: Захват выделенной области осуществляется кроссплатформенной библиотекой `xcap` с автоматическим расчетом масштабирования (DPI scale factor) монитора, на котором находится курсор.
*   **Локальное распознавание**: OCR-обработка происходит локально средствами встроенного системного движка Windows (`Windows.Media.Ocr`), что гарантирует конфиденциальность и мгновенный отклик без отправки скриншотов на внешние сервера.
*   **ИИ-постобработка**: Распознанный сырой текст отправляется в Gemini для сегментации на грамматически и логически связные предложения по специальному JSON-промпту, после чего переводится.

### Динамическая установка локальных ИИ-расширений (Whisper & Piper)
В приложении реализована система "плагинов", позволяющая в один клик скачать и развернуть локальные движки для оффлайн-работы:
*   **STT (Распознавание речи)**: Скачивается CLI-версия `whisper.cpp` с `ffmpeg.exe` и выбранная пользователем модель (tiny/base) напрямую с HuggingFace.
*   **TTS (Синтез речи / Озвучка)**: Разворачивается легковесный движок `piper.exe` с `espeak-ng-data` и выбранный голос (мужской `dmitri` или женский `irina`) в формате ONNX с HuggingFace.

### Интеллектуальный гибридный перевод и офлайн-фоллбэк
*   **Гибридный перевод**: Перевод оверлея по умолчанию выполняется через Gemini API. При отсутствии сети или API-ключа приложение автоматически переключается на бесплатный веб-интерфейс Google Translate API, избирательно вычленяя только англоязычные фрагменты и заменяя их в тексте для экономии трафика и сохранения разметки.
*   **Текстовый фоллбэк**: Текстовая обработка диктовки при сбое Gemini автоматически каскадируется на локальный сервер Ollama с поиском запущенных локальных моделей (`gemma2:9b`, `gemma2`, `llama3`, `qwen2.5`, `mistral`).

</details>

---

## 🔄 Сборка релизов и автообновления

В приложении настроен механизм автоматических обновлений (Tauri Updater v2) на базе GitHub Releases.

### 🔑 Генерация ключей подписи обновлений
Для безопасности все обновления должны быть подписаны цифровой подписью. Генерация пары ключей:
```bash
npx tauri signer generate --ci -w .tauri-keys/sinc-pro.key -p <PASSWORD>
```
*Примечание: папка `.tauri-keys/` автоматически добавлена в `.gitignore` для предотвращения утечки приватного ключа.*

### 🛠️ Сборка подписанного релиза
Для компиляции приложения в режиме релиза с подписью, укажите приватный ключ и пароль в переменных окружения:
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri-keys/sinc-pro.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "ВАШ_ПАРОЛЬ"
npm run tauri build
```
После завершения Tauri сгенерирует файлы установщиков `.msi` / `.exe` и их подписи `.sig` в папке `src-tauri/target/release/bundle/`.

### 🚀 Публикация релиза на GitHub
1. Создайте тег версии и отправьте его на GitHub:
   ```bash
   git tag v3.5.0
   git push origin v3.5.0
   ```
2. Создайте GitHub Release на базе тега и загрузите собранные файлы установщиков `.msi` и `.exe`.
3. Обновите манифест обновлений `docs/updater.json` в репозитории: пропишите новую версию, URL установщика на GitHub и скопируйте Base64 подпись из файла `.msi.sig`.

## 🧪 Тестирование

Запуск сквозных тестов Playwright:
```bash
npm test
```

---
<a name="en"></a>
# [🇺🇸] SINC PRO - Smart Voice Assistant & Voiceover Widget

[🇷🇺 Русский](#ru) | [🇺🇸 English](#en)

SINC PRO is a local and cloud-based Windows desktop application powered by Tauri, Vanilla JS, and Rust, providing robust tools for smart voice dictation via Gemini AI, quick screen translation (OCR), and text-to-speech (Edge TTS).

## 🚀 Key Features

*   **🎙️ Smart Microphone (SINC Orb / Capsule)**: Voice recording triggered by `Ctrl + Win` with instant formatting using Gemini AI (presets: key summary, transcribed text, or custom prompt).
*   **🧠 AI Request Chain Environment (New Request)**: Granular AI requests based on audio recordings, raw transcripts, or any prior AI outcomes, enabling sequential pipelines (e.g., extracting "Summary" from text and then translating it into another language).
*   **🔊 Voiceover Widget (Edge TTS)**: Speech generation from highlighted text with `Ctrl + Shift + S`, allowing selection of voice, speed, and pitch. Features a floating player with circular progress tracking and autohide on hover.
*   **🔍 Screen Translator (OCR)**: Screen OCR translator overlay opened by `Alt + Q` with translation via cloud AI or local engine.
*   **🔌 Offline AI Fallback**: Automatic routing to offline models (Whisper for STT and Ollama/local servers for text) in case of cloud API connection drops.
*   **⌨️ Automatic and Manual Layout Switching**:
    *   **Manual Mode**: Quick layout inversion of the selected or last-typed word via a customizable hotkey (default `Ctrl + Pause`) with automatic Windows input language toggling.
    *   **Automatic Mode (On-the-fly)**: Intelligent Punto-style analyzer checking words as you hit Space or Enter, fixing typos with a soft click sound.
    *   **Autocorrect Undo**: Pressing `Shift + Backspace` immediately reverts the autocorrection, restoring the original layout and characters (available strictly right after autocorrect triggers).
*   **🛠️ System Tray & Autostart**: Hiding to tray on window close, startup with Windows, and smart window restoration.
*   **💾 Geometry Saving**: All windows remember their size and coordinates, auto-aligning to active monitors on change.

---

## 🛠️ Tech Stack

*   **Backend**: Rust, Tauri v2, Windows API (winapi), Win32 keyboard hooks.
*   **Frontend**: HTML5, Vanilla JavaScript, CSS3 (Tailwind CSS v4).
*   **Integrations**: Google Gemini API, Yandex Translate API, Microsoft Edge TTS.

---

## 📦 Quick Start (Developer Setup)

### Prerequisites
1. [Rust / Cargo](https://rustup.rs/) installed (version 1.75+).
2. [Node.js](https://nodejs.org/) installed (version 18+).

### Instructions

1.  **Install dependencies**:
    ```bash
    npm install
    ```
2.  **Build Tailwind styles**:
    ```bash
    npm run build:css
    ```
3.  **Run in development mode**:
    ```bash
    npm run tauri dev
    ```

---

<details>
<summary>⚙️ Under the Hood (Architecture & Logic)</summary>

### 3-Position Mode Switchers
Each module (Capsule, Widget, OCR) has 3 states:
*   **0 (Disabled)**: Module is deactivated, keyboard hooks are bypassed.
*   **1 (Hotkeys Only)**: Widget windows are hidden. Hotkeys temporarily spawn the window, and it autohides on task completion.
*   **2 (All On)**: Widget windows are persistent on the screen.

### Automatic Text Layout Switching (Autocorrect)
The keyboard layout module features a 3-position switcher:
*   **0 (Disabled)**: Typing hooks and hotkeys are completely off.
*   **1 (Manual Mode)**: Quick word correction via a hotkey combo (e.g., `Ctrl + Pause`).
*   **2 (Autocorrect On-the-fly)**: Automatic typing correction on hitting Space or Enter based on letter structures.

**Additional layout mechanisms:**
*   **Dedicated Management Panel**: A new "Autocontrol" tab in the sidebar lets you bind keys and manage exclusion lists.
*   **Word Exclusions**: Interactive list of words (managed as tag pills) that won't be auto-corrected (e.g., code functions or slang).
*   **App Exclusions (Process Blacklist)**: Add executable names (like `code.exe`, `cmd.exe`) to disable layout switcher entirely in target apps.
*   **Abbreviation Bypass (ALL CAPS)**: Words typed in UPPERCASE (like `RGB`, `HTML`) bypass autocorrection rules.
*   **Timeout Buffer Flush**: The keystroke buffer resets after 2 seconds of inactivity, preventing stale character mixes.
*   **Recursion Block**: The hook is blocked (`LAYOUT_PROCESSING`) during keystroke simulation.

### Minimized Startup (Autostart to Tray)
On starting with the `--minimized` flag:
1. The dashboard window remains hidden in the tray if closed previously.
2. Active widgets (in mode `2`) are displayed on top of the screen.

### Multi-Monitor Safety
Prior to restoring coordinates, the app queries `availableMonitors()`. If coordinates point to an inactive monitor, the window is centered on the primary display.

### Local OCR Translator (WinRT API & xcap)
*   **Screen Capture**: Screenshot capture of the selected area is performed via `xcap` cross-platform library, dynamically computing DPI scale factor of the target monitor under user cursor.
*   **Local Recognition**: OCR is executed locally on user's machine using built-in system API (`Windows.Media.Ocr`), ensuring high speed and absolute privacy without sending screen captures to external APIs.
*   **AI Post-Processing**: The recognized raw text undergoes segmentation into gramatically and logically structured sentences using Gemini AI with a specific JSON schema prompt, and is then translated.

### Dynamic Installation of Local AI Extensions (Whisper & Piper)
SINC PRO features a plugin manager enabling one-click download of offline AI models:
*   **STT (Speech-to-Text)**: Downloads a standalone `whisper.cpp` CLI binary along with `ffmpeg.exe` and user-chosen models (tiny/base) directly from HuggingFace.
*   **TTS (Text-to-Speech)**: Deploys a lightweight `piper.exe` binary with `espeak-ng-data` assets and ONNX voice models (male `dmitri` or female `irina`) from HuggingFace.

### Intelligent Hybrid Translation & Offline Fallback
*   **Hybrid Translation**: Overlay translation defaults to Gemini API. In case of network errors or missing API key, the app transparently shifts to the free Google Translate API, selectively parsing and translating only foreign language parts to preserve structure.
*   **Text Processing Fallback**: Speech dictation processing cascades to a local Ollama server running locally on port 11434, seeking active local models (`gemma2:9b`, `gemma2`, `llama3`, `qwen2.5`, `mistral`).

</details>

---

## 🔄 Release Building & Auto-updates

The application features built-in auto-updates (Tauri Updater v2) via GitHub Releases.

### 🔑 Signing Keys Generation
Updates must be digitally signed. Generate a key pair:
```bash
npx tauri signer generate --ci -w .tauri-keys/sinc-pro.key -p <PASSWORD>
```
*Note: `.tauri-keys/` is added to `.gitignore` to prevent leaking the private key.*

### 🛠️ Building a Signed Release
Specify the private key and password in env variables:
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri-keys/sinc-pro.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "YOUR_PASSWORD"
npm run tauri build
```
Compiled `.msi` / `.exe` bundles and `.sig` signatures will be generated in `src-tauri/target/release/bundle/`.

### 🚀 Publishing to GitHub
1. Tag and push to origin:
   ```bash
   git tag v3.5.0
   git push origin v3.5.0
   ```
2. Create a GitHub Release and upload `.msi` and `.exe` bundles.
3. Update `docs/updater.json` with the new version, package URL, and signature from the `.msi.sig` file.

## 🧪 Testing

Run Playwright E2E tests:
```bash
npm test
```
