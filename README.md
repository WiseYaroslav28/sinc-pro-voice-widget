<a id="ru"></a>
<div align="center">
  <img src="src/assets/sinc-pro-icon.png" alt="SINC PRO Logo" width="96" height="96" />
  <h1>SINC PRO — Audio Intelligence</h1>
  <p><strong>Умный голосовой ИИ-ассистент, студийная озвучка текста, экранный OCR-переводчик и интеллектуальный переключатель раскладки для Windows 10/11</strong></p>
  <p>
    <a href="#ru">🇷🇺 Русский</a> • <a href="#en">🇺🇸 English</a> • <a href="https://github.com/WiseYaroslav28/sinc-pro-voice-widget/releases/latest">📥 Скачать последний релиз (v3.5.19)</a>
  </p>
</div>

---

## 🌟 Ценность для пользователя (Что умеет SINC PRO)

SINC PRO объединяет 4 ежедневных инструмента продуктивности в одном легковесном нативном приложении на базе **Rust + Tauri v2** (с 0% нагрузки на CPU в режиме ожидания):

* **🎙️ Умная голосовая диктовка и цепочки ИИ-обработки (`Ctrl + Win`)**:
  Надиктуйте мысль своими словами — ИИ мгновенно превратит её в чистый отформатированный текст, выделит краткую суть (Summary), составит список задач или обработает по вашему собственному промпту. Встроенный двухконтурный детектор голосовой активности (VAD/RMS) автоматически отсекает пустые записи с тишиной ещё до отправки на сервер.
* **🔊 Студийная озвучка любого текста и перевод на лету (`Ctrl + Shift` / `Ctrl + Alt`)**:
  Выделите текст в браузере, PDF или мессенджере — плавающий виджет озвучит его живым нейросетевым голосом с круговым индикатором прогресса, регулировкой скорости (`0.5x–2.5x`) и встроенным **Web Audio API бустером громкости до `200%`** со студийным компрессором (`-14 LUFS`, на уровне громкости YouTube). Поддерживает докидывание новых абзацев в очередь на лету по `Ctrl + Tab`.
* **⛶ Перевод текста с картинок, игр и видео на экране (`Alt + Q`)**:
  Обведите любую область экрана рамкой — локальный движок Windows OCR мгновенно распознает текст без отправки скриншота в облако, а гибридный ИИ-переводчик отобразит перевод прямо поверх оригинала («бусины на нити») или отправит его на озвучку.
* **⌨️ Интеллектуальная автораскладка RU ↔ EN (Punto-режим + ручной хоткей `Ctrl + Pause`)**:
  Забыли переключить язык и напечатали `ghbdtn` вместо `привет`? SINC PRO автоматически распознаёт ошибочную раскладку по биграммам и фонетическим словарям при нажатии `Пробел`/`Enter`, исправляет слово, переключает язык ввода Windows и позволяет отменить замену в одно касание (`Shift + Backspace`).
* **🛡️ Полная автономность и 4-уровневая отказоустойчивость**:
  Если интернет пропал или исчерпаны лимиты облачного API, SINC PRO автоматически переключается на резервные модели и локальные оффлайн-движки (**Whisper.cpp** для распознавания речи, **Piper ONNX** для озвучки, **Ollama** для ИИ-обработки и **Windows WinRT OCR** для экрана), устанавливаемые в 1 клик прямо из настроек.

---

## ⚡ Быстрый старт за 3 шага

1. **Установите приложение**: скачайте установщик `SincPro_x64.msi` или `.exe` из раздела [Releases](https://github.com/WiseYaroslav28/sinc-pro-voice-widget/releases/latest) и запустите его.
2. **Подключите бесплатный ключ Gemini в 1 клик**: откройте **Настройки** → нажмите **«🔑 Получить бесплатный ключ (1 клик)»** → скопируйте ключ в открывшемся окне Google AI Studio. При возврате в окно SINC PRO приложение **автоматически распознает ключ из буфера обмена и сохранит его**.
3. **Попробуйте горячие клавиши**: выделите любой текст и нажмите `Ctrl + Shift` для озвучки или нажмите `Ctrl + Win` для голосовой записи!

> [!TIP]
> Все **9 глобальных горячих клавиш** можно переназначить под себя во вкладках **«Настройки»** и **«Автораскладка»** простым нажатием нужной комбинации.

---

## ⌨️ Таблица горячих клавиш (по умолчанию)

| Модуль | Горячая клавиша | Действие |
| :--- | :--- | :--- |
| **🎙️ Голосовая капсула** | `Ctrl + Win` | Старт / Пауза записи (удержание — режим Push-to-Talk, двойное нажатие — Lock) |
| **🎙️ Голосовая капсула** | `Win + Alt` | Принудительно завершить запись и отправить в ИИ |
| **🔊 Озвучка (TTS)** | `Ctrl + Shift` | Скопировать выделенный текст и сразу начать озвучку |
| **🔊 Озвучка (TTS)** | `Ctrl + Alt` | Скопировать выделенный текст, **перевести на русский** и озвучить |
| **🔊 Озвучка (TTS)** | `Ctrl + Tab` | Добавить выделенный текст в конец текущей очереди чтения |
| **⛶ Экранный OCR** | `Alt + Q` | Включить рамку выделения области экрана для распознавания и перевода |
| **⌨️ Автораскладка** | `Ctrl + Pause` | Инвертировать раскладку выделенного текста или последнего слова (`RU ↔ EN`) |
| **⌨️ Автораскладка** | `Shift + Backspace` | Мгновенно отменить последнее автоисправление раскладки |
| **⌨️ Автораскладка** | `Shift + Pause` | Добавить или удалить текущее активное приложение из списка исключений автораскладки |

---

<details>
<summary>🛠️ <strong>Под капотом: Архитектура и технические решения для разработчиков</strong></summary>

### Технологический стек
* **Бэкенд**: Rust (Edition 2021), Tauri v2, Win32 API (`winapi`, `SetWindowsHookExW`, `SetWindowSubclass`, DWM API), `tokio`, `reqwest`, `xcap`, `Windows.Media.Ocr`.
* **Фронтенд**: HTML5, Vanilla ES6+ JavaScript, Tailwind CSS v4, Web Audio API (`DynamicsCompressorNode`, `GainNode`, `AnalyserNode`), IndexedDB (кэш аудио-предложений).
* **Интеграции и движки**:
  * **STT / LLM**: Google Gemini Multimodal API (`gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash`, `gemini-2.5-pro`) + локальный `whisper-cli.exe` + локальные серверы `Ollama` / OpenAI-совместимые API.
  * **TTS**: Microsoft Edge TTS (`Sec-MS-GEC v2` с динамическим самовосстановлением токена) → Yandex SpeechKit TTS → локальный `piper.exe` (ONNX) → Google Translate TTS.

### Ключевые архитектурные механизмы
1. **Безрамочные прозрачные оверлеи Windows 11 и нативный Hit-Test (`0% CPU` в простое)**:
   * Вместо `SetWindowRgn` (который в Windows 11 отключает DWM-композицию и вызывает появление классической рамки `WS_CAPTION`) используется нативный Win32 оконный субкласс (`SetWindowSubclass` в `lib.rs`), перехватывающий `WM_STYLECHANGING`, `WM_NCCALCSIZE`, `WM_NCPAINT`, `WM_NCACTIVATE` и очищающий GDI-поверхность прозрачным чёрным (`0x00000000`).
   * Нативный фоновый поток `evaluate_overlay_hit_test` проверяет попадание курсора в точное скруглённое уравнение капсулы (пилюли) и переключает стиль `WS_EX_TRANSPARENT`. Это позволяет кликать сквозь полупрозрачную неоновую тень вокруг виджета и поднимать его к самому верхнему краю экрана (`y = 0px`).
2. **Консолидация процессов WebView2 (`--process-per-site`)**:
   * Все окна приложения (`main`, `capsule`, `widget`, `ocr`, `result`, `prompt`) используют общий процесс рендеринга за счёт флага `--process-per-site`, минимизируя потребление ОЗУ.
3. **Безопасная работа с системным буфером обмена (`Save-Copy-Restore`)**:
   * При считывании выделенного текста (`simulate_ctrl_c`) бэкенд сохраняет как текстовые форматы, так и растровые изображения (`CF_DIB` / `CF_DIBV5`), зажимает `VK_CONTROL` до программного сброса `Alt` (чтобы `WM_SYSKEYUP(VK_MENU)` не активировал верхнее меню окна и не сбрасывал выделение) и восстанавливает исходный буфер обмена пользователя.
4. **Двухконтурный фильтр тишины (Pre-Send VAD) и защита от галлюцинаций**:
   * До отправки аудиофайла в Gemini проверяется среднеквадратичная амплитуда во временной области (`getByteTimeDomainData`, порог `RMS >= 2.2`) и спектральная энергия голосового диапазона (`85–3500 Гц` при `minDecibels = -75` дБ). Записи с тишиной отменяются локально без расхода квот API.
5. **Студийный тракт усиления озвучки (Web Audio API Loudness Normalization)**:
   * Аудиопоток `<audio>` проходит через `MediaElementAudioSourceNode` → `DynamicsCompressorNode` (`threshold: -20dB`, `ratio: 3.5:1`) → `GainNode` с базовым коэффициентом `1.35x` на `100%` и диапазоном регулировки до `200%` (`gain = 2.7x`).

</details>

---

## 💻 Разработка и сборка из исходников

### Требования
* [Rust / Cargo](https://rustup.rs/) (1.75+)
* [Node.js](https://nodejs.org/) (20+)

```powershell
# 1. Установка зависимостей
npm install

# 2. Сборка стилей Tailwind CSS
npm run build:css

# 3. Запуск в режиме разработки
npm run tauri dev
```

### 🔄 Публикация релиза и автообновления (CI/CD)
В проекте настроен полностью автоматизированный пайплайн GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)):
1. Обновите версию в `src-tauri/tauri.conf.json` и `src-tauri/Cargo.toml`.
2. Опишите изменения новой версии в [`CHANGELOG.md`](CHANGELOG.md) в секции `## [X.Y.Z] - YYYY-MM-DD`.
3. Создайте и отправьте тег:
   ```powershell
   git add -A
   git commit -m "v3.5.X: краткое описание релиза"
   git tag v3.5.X
   git push origin HEAD:main --tags
   ```
4. GitHub Actions автоматически соберёт и подпишет `.msi` / `.exe` установщики, извлечёт описание изменений из `CHANGELOG.md`, опубликует релиз на GitHub и обновит манифест автообновления `docs/updater.json`.

---

<a id="en"></a>
<div align="center">
  <h1>🇺🇸 SINC PRO — Audio Intelligence</h1>
  <p><strong>Smart AI Voice Dictation, Studio TTS Voiceover, Screen OCR Translator & Intelligent Layout Switcher for Windows 10/11</strong></p>
  <p>
    <a href="#ru">🇷🇺 Русский</a> • <a href="#en">🇺🇸 English</a> • <a href="https://github.com/WiseYaroslav28/sinc-pro-voice-widget/releases/latest">📥 Download Latest Release (v3.5.19)</a>
  </p>
</div>

## 🚀 Key Features

* **🎙️ Smart Voice Dictation & AI Chains (`Ctrl + Win`)**: Record voice notes and transform them with Gemini AI (Clean Transcript, Summary, Tasks, Email, or Custom Prompts). Built-in dual-stage VAD/RMS silence detection prevents sending silent recordings to the cloud.
* **🔊 Studio Voiceover Widget (`Ctrl + Shift` / `Ctrl + Alt`)**: Read any selected text aloud using neural Edge TTS with a 4-tier self-healing fallback cascade (Edge TTS → Yandex SpeechKit → Local Piper ONNX → Google TTS), circular progress indicator, queue appending (`Ctrl + Tab`), and a **Web Audio API 200% Loudness Booster + Compressor**.
* **⛶ Screen OCR & Hybrid Translator (`Alt + Q`)**: Select any screen region to extract text locally via Windows WinRT OCR (`Windows.Media.Ocr`) and translate it in place via Gemini AI or offline fallback.
* **⌨️ Intelligent Auto-Layout Switcher (`Ctrl + Pause`)**: Automatically fixes words typed in the wrong keyboard layout (`RU ↔ EN`) on Space/Enter with phonetic & bigram validation, instant undo (`Shift + Backspace`), and per-app exclusions (`Shift + Pause`).
* **🔑 1-Click Gemini API Key Assistant**: Built-in assistant opens Google AI Studio and automatically detects and saves your `AIza...` key from the clipboard as soon as you switch back to the SINC PRO window.
