# Реестр Состояний SINC PRO (`v3.5.19`)

Этот документ описывает актуальное состояние проекта, принятые технические решения и архитектуру. **ИИ-Агенты обязаны сверяться с этим файлом перед любыми изменениями.**

## 🏗 Архитектура

Проект построен на связке:
* **Бэкенд (Rust / Tauri v2)**: Отвечает за системные низкоуровневые хуки клавиатуры (`WH_KEYBOARD_LL`), нативный Win32 оконный субкласс (`SetWindowSubclass`) для прозрачных оверлеев, фоновый поток скруглённого hit-test (`evaluate_overlay_hit_test`), работу с нативным буфером обмена (`Save-Copy-Restore` текста и `CF_DIB`/`CF_DIBV5`), управление DPI мониторов, генерацию криптографических токенов `Sec-MS-GEC v2` (Edge TTS) и сетевые запросы к ИИ-моделям в обход CORS.
* **Фронтенд (HTML/CSS/JS)**: Vanilla ES6+ JS + Tailwind CSS v4. Стилизация по дизайн-системе Stitch (`#131318`, `#8e52ff`, `#d2bbff`, `#7bd6d1`). Аудио-тракт на базе Web Audio API (`DynamicsCompressorNode` + `GainNode` + `AnalyserNode`).

## 📌 Матрица Компонентов и Статусы

| Компонент / Фича | Файлы | Статус | Комментарий |
| :--- | :--- | :--- | :--- |
| **Плавающие оверлеи (`widget`, `capsule`)** | `lib.rs`, `widget.html`, `capsule.html`, `tts-widget.js` | `[VERIFIED v3.5.17]` | Нативный Win32 субкласс (`overlay_subclass_proc`) блокирует `WS_CAPTION`/`WS_EX_WINDOWEDGE` и очищает GDI-буфер `0x00000000`. Поток `evaluate_overlay_hit_test` переключает `WS_EX_TRANSPARENT` по уравнению скруглённой капсулы — 100% кликабельность сквозь неоновую тень и подъём к `y = 0px`. |
| **Масштабирование виджетов (`70%–150%`)** | `index.html`, `widget.html`, `capsule.html`, `lib.rs` | `[VERIFIED v3.5.16]` | Ползунок и кнопки масштабирования (`widget_scale`) в Настройках с синхронизацией размеров через `set_click_region`. |
| **Фильтр тишины (VAD / RMS) и микрофон** | `capsule.html`, `lib.rs`, `index.html` | `[VERIFIED v3.5.18]` | Двухконтурный детектор речи до отправки файла: Time-Domain RMS (`maxRecordedRms >= 2.2`) + спектр `85–3500 Гц` (`minDecibels = -75` дБ). Записи с тишиной отменяются локально без галлюцинаций и расхода квот. |
| **Мультимодальная цепочка моделей Gemini** | `lib.rs`, `translator.rs` | `[VERIFIED v3.5.18]` | Функции `is_valid_multimodal_gemini_model` и `build_audio_capable_models` отсекают текстовые модели (`gemma-4-*`) от аудио-запросов, учитывают реальные квоты Free Tier (`250–1000 RPD`) и автоматически сбрасывают `MODEL_LOCKS`, если все модели заблокированы после обрыва сети. |
| **Помощник Gemini API Key в 1 клик** | `index.html` | `[VERIFIED v3.5.18]` | Прямое открытие Google AI Studio, кнопка вставки с валидацией `^AIza[0-9A-Za-z_-]{33,45}$` и авто-перехват ключа из буфера обмена по событию `window.focus`. |
| **Edge TTS (`Sec-MS-GEC v2`) + 4-уровневый фоллбэк** | `lib.rs`, `voice-core.js` | `[VERIFIED v3.5.15]` | Самовосстановление токена `Sec-MS-GEC v2` при `403 Forbidden` + каскад резервных синтезаторов: Edge TTS → Yandex SpeechKit → Локальный Piper ONNX → Google TTS. |
| **Web Audio API Бустер громкости (`0%–200%`)** | `voice-core.js`, `tts-widget.js`, `tts.js` | `[VERIFIED v3.5.18]` | Тракт `DynamicsCompressorNode` + `GainNode` с нормализацией `1.35x` на `100%` (уровень YouTube `-14 LUFS`) и усилением до `200%` ползунком или колесом мыши. |
| **Нативный буфер и Хоткеи TTS (`Ctrl+Shift`, `Ctrl+Alt`, `Ctrl+Tab`)** | `lib.rs`, `tts.js`, `voice-core.js` | `[VERIFIED v3.5.18]` | В `simulate_ctrl_c` клавиша `VK_CONTROL` зажимается до сброса `Alt`, предотвращая перехват фокуса меню окна (`WM_SYSKEYUP(VK_MENU)`). Поддержка `CF_DIB`/`CF_DIBV5`. |
| **9 настраиваемых глобальных хоткеев** | `lib.rs`, `index.html` | `[VERIFIED v3.5.15]` | Все 9 комбинаций клавиш настраиваются интерактивно из интерфейса с синхронизацией подсказок во всех окнах. |
| **Интеллектуальная Автораскладка (`RU ↔ EN`)** | `lib.rs`, `index.html` | `[VERIFIED v3.5.15]` | 3 режима (`0`: Выкл, `1`: Хоткей `Ctrl+Pause`, `2`: Punto-автозамена на лету), двунаправленная фонетическая проверка, списки исключений слов и процессов (`Shift+Pause`), отмена по `Shift+Backspace`. |
| **Локальные ИИ-движки (Whisper.cpp, Piper, Ollama)** | `lib.rs`, `index.html` | `[VERIFIED v3.5.15]` | Скачивание в 1 клик из настроек, запуск без консольных окон (`CREATE_NO_WINDOW = 0x08000000`). |
| **Оверлей переводчика (OCR)** | `ocr.html`, `ocr.js`, `lib.rs` | `[VERIFIED]` | Локальное распознавание через `Windows.Media.Ocr` + `xcap`, сегментация предложений (`OCR_SPLITTER.md`), гибридный перевод через Gemini / Google Translate. |
| **Автообновления (Tauri Updater v2) и CI/CD** | `index.html`, `release.yml`, `docs/updater.json` | `[VERIFIED v3.5.19]` | Автоматическая проверка при старте, заметный баннер в шапке дашборда, авто-извлечение заметок релиза из `CHANGELOG.md` в GitHub Actions. |
| **Фирменная айдентика и иконки SINC PRO** | `src-tauri/icons/*`, `src/assets/sinc-pro-icon.png` | `[VERIFIED v3.5.19]` | Многослойный `icon.ico` (`16px–256px` с компактным режимом для трея/диспетчера задач), все PNG/ICNS ресурсы и логотип в сайдбаре. |

## 🛠 Принятые Технические Решения (Golden Rules)

1. **Отказ от `SetWindowRgn` и `w.set_ignore_cursor_events()` для прозрачных окон на Windows 11**:
   * В Windows 11 вызов `SetWindowRgn` отключает DWM DirectComposition и превращает прозрачный фон в непрозрачный, а вызовы методов `tao` (`set_ignore_cursor_events` / `set_always_on_top`) заново применяют стиль `WS_CAPTION` (голубая/белая классическая шапка окна).
   * **Эталонное решение (`v3.5.17`)**: Нативный Win32 субкласс (`SetWindowSubclass`) блокирует `WM_STYLECHANGING`, `WM_NCCALCSIZE`, `WM_NCPAINT`, `WM_NCACTIVATE` (`lparam = -1`), а кликабельность сквозь тень управляется напрямую через `SetWindowLongW(GWL_EXSTYLE, WS_EX_LAYERED | WS_EX_TRANSPARENT)` из нативного Rust-потока `evaluate_overlay_hit_test`.
2. **Безопасность `Ctrl + C` при зажатом физическом `Alt` (`Ctrl + Alt`)**:
   * Одиночное отпускание `Alt` (`KEYUP VK_MENU`) в Windows вызывает `WM_SYSKEYUP`, который переводит фокус активного приложения в строку меню (`Файл / Правка`) и сбрасывает выделение текста.
   * **Эталонное решение (`v3.5.18`)**: В `simulate_ctrl_c()` сначала отправляется `KEYDOWN VK_CONTROL`, и только при удерживаемом `Ctrl` отправляется `KEYUP` для `Alt` (`0x12`, `0xA4`, `0xA5`).
3. **Ленивая подгрузка аудио в HTML5 `<audio>` через `get_audio_base64`**:
   * Не использовать `convertFileSrc` при рендере карточек истории (`renderActiveCard`), так как это вызывает ложные срабатывания `audioPlayerElement.onerror`. Загружать аудио только по нажатию Play через команду `get_audio_base64`.
4. **Защита от галлюцинаций Gemini на пустых аудиофайлах**:
   * Проверять RMS амплитуду во временной области (`maxRecordedRms >= 2.2`) и речевой спектр до отправки файла, а на бэкенде допускать к `save_audio` только реальные мультимодальные модели (`is_valid_multimodal_gemini_model`).
5. **0% нагрузки на CPU в режиме ожидания**:
   * Запрещены холостые циклы `requestAnimationFrame` и бесконечные CSS-анимации `box-shadow` на скрытых/неактивных окнах. Визуализатор работает на аппаратно-ускоряемом `transform: scale(...)` с троттлингом до 20 FPS только во время активной речи.
