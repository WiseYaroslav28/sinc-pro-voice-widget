[🇷🇺 Русский](#ru) | [🇺🇸 English](#en)

---

<a id="ru"></a>
# 🇷🇺 SINC PRO - Голосовой виджет

**SINC PRO** — это элегантный, быстрый и удобный голосовой виджет для Windows, созданный для озвучивания любого выделенного текста с помощью нейросетевых голосов (Edge TTS). 

Проект разрабатывался с особой заботой и вниманием к людям с **дислексией**, так как автор программы сам является дислексиком. Главная цель SINC PRO — сделать потребление текстовой информации в любой среде (браузеры, PDF-документы, мессенджеры, рабочие программы) максимально комфортным, быстрым и не требующим усилий.

### ✨ Ключевые возможности

*   **Перевод экрана в реальном времени [В стадии доработки / WIP] (v3.1.0):** Интерактивная рамка `⛶ A文` для перевода любой области экрана. Рамку можно перемещать и растягивать. Она полностью прозрачна для кликов (click-through) — вы можете продолжать работать с элементами под ней. Переведенный текст накладывается плашками поверх оригинала. По кнопке 🔊 перевод мгновенно передается в основной плеер и озвучивается.
*   **Контекстное меню быстрого доступа (v3.0.0):** Клик правой кнопкой мыши по виджету в режимах Mini и Micro opens удобное меню для переключения режимов или закрытия приложения.
*   **Глобальный доступ отовсюду:** Выделите текст в **любой** программе, нажмите комбинацию клавиш — и программа мгновенно начнет его читать.
*   **Нейросетевые голоса:** Использование Microsoft Edge TTS обеспечивает премиальное естественное звучание. Поддерживаются русский, английский, немецкий, французский, испанский, китайский и другие языки. Вы можете легко добавлять новые языки и голоса в словари программы.
*   **Три режима интерфейса:**
    *   **Оконный режим (Full):** Полноценное окно с текстовым редактором и поддержкой Markdown.
    *   **Плеер-панель (Mini):** Компактная полоска сверху экрана поверх всех окон. Идеально для работы. Включает выдвижную текстовую панель (Text Drawer), открываемую кнопкой `📖`.
    *   **Микро-виджет (Micro):** Ультракомпактный виджет для базового управления.
*   **Всегда поверх других окон:** Виджеты не потеряются среди других программ.
*   **Кастомизация на лету:** Прямо из виджета меняйте голос (🔊), скорость (⚡) и настраивайте горячие клавиши (хоткей перевода по умолчанию: `Ctrl + Alt + T`).

---

### ⛶ Переводчик экрана (Текущее состояние и WIP)

Функция перевода области экрана находится в стадии активной разработки и доработки. 

#### Что реализовано на данный момент:
1.  **Офлайн-распознавание текста (OCR):** Быстрый захват и распознавание текста на базе встроенного в Windows 10/11 WinRT API (работает без подключения к интернету).
2.  **Объединение строк в абзацы (Connected Components):** Продвинутый алгоритм на основе графа смежности. Он автоматически связывает строки одного абзаца даже в многоколоночных макетах (например, списки, блоки кода, меню), предотвращая некорректное склеивание соседних колонок.
3.  **Бесшовная подмена текста:** Автоматическое определение цвета шрифта и фона оригинального текста для создания плашки с переводом, которая сливается с фоном страницы.
4.  **Умный расчет свободного места (Smart Padding):** Плашка перевода может безопасно расширяться вправо и вниз в свободные зоны экрана, чтобы вместить более длинный русский перевод.
5.  **Фильтрация графического мусора:** Автоматическая очистка OCR-текста от мусорных одиночных символов на границах строк (например, убираются буквы-иконки вроде "R", "C", распознанные вместо графических элементов).
6.  **Поддержка мультимониторных систем:** Точный захват и калибровка координат окна Canvas (1:1 физические пиксели) на нескольких экранах, включая мониторы с отрицательными координатами.

#### Известные проблемы и ограничения (будут исправлены в следующей версии):
*   **Вписывание текста в мелкие объекты:** Русский перевод часто длиннее английского оригинала. Алгоритм вписывания текста в кнопки и узкие элементы интерфейса еще не идеален — текст внутри плашки может смещаться вниз или вправо, предложения могут компоноваться не вполне эстетично.
*   **Магнитирование плашек:** В некоторых сложных интерфейсах плашки перевода могут «магнититься» со смещением относительно оригинальных слов.
*   **Нахлесты на иконки:** Если иконка кнопки расположена слишком близко к тексту, возможен частичный нахлест фона плашки на иконку.

---

### 🚀 Как пользоваться?

1. Запустите программу (`SINC_PRO.exe` или скрипт).
2. Выделите любой текст в любом приложении и нажмите **`Ctrl + Shift`** для голосовой озвучки.
3. Или нажмите **`Ctrl + Alt + T`**, выделите рамкой область экрана и получите мгновенный перевод поверх текста.
4. Управляйте воспроизведением (Пауза `❙❙`, Плей `▶`) из виджета.

### ⚖️ Лицензия и Правовая информация
*   **Лицензия:** Проект распространяется под свободной лицензией **MIT** (см. файл [LICENSE](file:///c:/Antigravity%20projects/voice-server/LICENSE)).
*   **Disclaimer:** Данный проект создан исключительно в образовательных, личных целях и для обеспечения доступности (Accessibility). Программа использует библиотеку `edge-tts` для доступа к публичным серверам Microsoft Edge TTS. Разработчик не несет ответственности за любое неправомерное или коммерческое использование данного ПО третьими лицами.

---

<a id="en"></a>
# 🇺🇸 SINC PRO - Voice Assistant Widget

**SINC PRO** is an elegant, fast, and convenient voice widget for Windows designed to read any selected text aloud using premium neural network voices (Edge TTS).

This project was developed with special care and attention to people with **dyslexia**, as the author is dyslexic themselves. The main goal of SINC PRO is to make consuming text in any environment (browsers, PDFs, messengers, work apps) effortless, quick, and comfortable.

### ✨ Key Features

*   **Real-time Screen Translator [Work In Progress / WIP] (v3.1.0):** An interactive crop frame `⛶ A文` to translate any screen region. The frame is resizable and moveable. It is completely click-through — you can scroll and click elements underneath it. Translated text is overlaid on patches. Click 🔊 to instantly forward and speak the translation.
*   **Quick Access Context Menu (v3.0.0):** Right-click the widget in Mini and Micro modes to toggle UI modes or exit the app.
*   **Global Access Everywhere:** Highlight text in **any** application, press the hotkey, and the program will instantly start reading it aloud.
*   **Premium Neural Voices:** Powered by Microsoft Edge TTS for natural, human-like sound. It supports English, Russian, German, French, Spanish, Chinese, and many more. You can easily add new voices to the dictionary.
*   **Three UI Modes:**
    *   **Full Mode:** A complete window with a text editor and Markdown support.
    *   **Mini Player:** A compact top-screen overlay. Perfect for background listening while working. Includes a "Text Drawer" that expands when you click `📖`.
    *   **Micro Widget:** An ultra-compact widget with minimal footprint.
*   **Always on Top:** The widget stays above other applications.
*   **On-the-fly Customization:** Change voices (🔊), reading speed (⚡), and customize hotkeys (default Screen Translate hotkey is `Ctrl + Alt + T`).

---

### ⛶ Screen Translator (Current State & WIP)

The Screen Translator feature is currently in active development and refinement.

#### What is implemented so far:
1.  **Offline Text Recognition (OCR):** High-speed, internet-free text capture powered by Windows 10/11 WinRT OCR API.
2.  **Paragraph Merging (Connected Components):** Advanced adjacency-graph-based merging. Automatically groups lines of the same paragraph, even in multi-column layouts (e.g. lists, menus, code blocks), preventing columns from blending together.
3.  **Seamless Text Overlay:** Automatic color detection for text and background to match the style of the page.
4.  **Smart Padding:** The translation patches can safely expand to the right and down to accommodate longer Russian text.
5.  **OCR Noise Filtering:** Cleans recognized text of single-letter noise at the edges of strings (e.g. removes "R" or "C" captured instead of button icons).
6.  **Multi-Monitor Support:** Precise canvas coordinate calibration (1:1 physical pixels) on secondary screens, including screens with negative coordinates.

#### Known Issues and Limitations (to be fixed in the next version):
*   **Text fitting in small objects:** Russian translation is often longer than English. Text layout inside buttons and narrow elements is not yet perfect — text can shift down or right, and line wrapping can look uneven.
*   **Patch snap offset:** In complex interfaces, translation patches might snap with a slight offset relative to the original text.
*   **Icon overlaps:** Background patches may occasionally overlap adjacent icons if the OCR bounding box borders are close to the icon.

---

### 🚀 How to use it?

1. Launch the application (`SINC_PRO.exe` or the Python script).
2. Highlight any text in any app and press **`Ctrl + Shift`** to speak it.
3. Or press **`Ctrl + Alt + T`**, select a region of the screen, and see the translation overlay.
4. Control playback (Pause `❙❙`, Play `▶`) from the floating widget.

### ⚖️ License & Disclaimer
*   **License:** Distributed under the free **MIT License** (see [LICENSE](file:///c:/Antigravity%20projects/voice-server/LICENSE)).
*   **Disclaimer:** This project is created exclusively for educational, personal, and accessibility purposes. It uses the `edge-tts` library to access Microsoft Edge TTS servers. The developer is not responsible for any misuse or commercial exploitation of this software by third parties.
