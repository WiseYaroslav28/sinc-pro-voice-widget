[🇷🇺 Русский](#ru) | [🇺🇸 English](#en)

---

<a id="ru"></a>
# 🇷🇺 SINC PRO — Умный голосовой помощник и переводчик экрана

> **SINC PRO** — это элегантное, невероятно быстрое и отзывчивое приложение для Windows, созданное для того, чтобы превратить чтение с экрана в легкий и комфортный процесс. 

Проект разрабатывался с особой заботой о людях с **дислексией** (автор программы сам является дислексиком). Главная цель SINC PRO — убрать барьеры при потреблении сложной текстовой информации в любой среде: будь то научные PDF-статьи, техническая документация, код в IDE, мессенджеры или веб-страницы.

---

## ✨ В чем суперсила SINC PRO? (Ценность для вас)

*   **🎧 Чтение в один клик из любой программы:**
    Просто выделите текст мышкой в *абсолютно любом* приложении и нажмите `Ctrl + Shift`. Нейросетевые голоса Microsoft Edge TTS мгновенно озвучат его с естественной интонацией.
*   **⛶ «Живой» оверлей-переводчик экрана (Чтение некопируемого текста):**
    Нажмите `Ctrl + Alt + T`, выделите область экрана рамкой — и перевод появится прямо поверх оригинального текста. Окно переводчика **прозрачно для кликов (click-through)**, вы можете продолжать скроллить и кликать интерфейс под ним.
    > **В чем суперсила:** Эта функция незаменима, когда текст защищен от выделения и копирования (PDF-файлы с защитой, надписи на картинках, неактивные элементы интерфейса или кнопки программ, игры). Оверлей распознает некопируемый текст на лету, позволяя озвучить его, перевести или скопировать без риска случайно кликнуть по интерактивным элементам под ним.
*   **🧠 Режим интерактивного чтения (Click Lock):**
    Нажмите `Space` (Пробел) внутри рамки переводчика. Окно притенится, фиксируя клики. Теперь вы можете взаимодействовать с текстом:
    *   *Клик ЛКМ по предложению* — озвучить перевод.
    *   *Ctrl + ЛКМ* — озвучить оригинал на английском.
    *   *ПКМ по предложению* — открыть мини-редактор и скорректировать перевод вручную.
*   **🔍 Быстрый перевод слов (Double Click):**
    Дважды кликните по любому незнакомому слову в оверлее, и над ним появится стильная всплывающая подсказка с точным переводом и кнопкой индивидуальной озвучки.
*   **〰 Нити чтения (Flow Threads) и неоновая подсветка:**
    Умная неоновая подсветка предложений адаптируется к яркости фона (светлый/темный). А штрихпунктирные нити физически соединяют слова, помогая вашим глазам плавно вести строку и не терять фокус при дислексии или усталости.
*   **⚡ Автообновление экрана (Auto Scan):**
    Включите автосканирование (кнопка `⚡`), и переводчик сам обновит текст и рамки, если картинка или код под оверлеем изменятся.
*   **🔒 Локальный перевод и LLM:**
    Переводите оффлайн с помощью встроенного Argos Translate, либо подключите локальные нейросети через Ollama или Msty. Ваши данные не уйдут в сеть.

---

## 🚀 Быстрый старт за 15 секунд

1.  Скачайте и запустите программу (`SINC_PRO.exe` из релизов или запустите скрипт `voice_widget.py`).
2.  Выделите текст в любом месте и нажмите **`Ctrl + Shift`** для озвучки.
3.  Или нажмите **`Ctrl + Alt + T`** и выделите область экрана для интерактивного перевода.

### ⌨️ Горячие клавиши по умолчанию

| Сочетание | Действие |
| :--- | :--- |
| **`Ctrl + Shift`** | Озвучить выделенный текст в любой программе |
| **`Ctrl + Alt + T`** | Вызвать рамку перевода экрана |
| **`Space` (Пробел)** | Включить/выключить интерактивный режим (Click Lock) внутри рамки |
| **`Esc`** | Закрыть оверлей перевода / закрыть настройки |

---

## 🎮 Интерактивный гид по оверлею

Когда вы включили интерактивный режим (`Space` или кнопка `🔊/A`), вам доступны следующие жесты:

*   **Одинарный клик ЛКМ:** Озвучивает перевод предложения на русском языке.
*   **`Ctrl` + ЛКМ:** Озвучивает предложение на языке оригинала.
*   **Двойной клик ЛКМ:** Открывает быстрый перевод выбранного слова.
*   **Клик правой кнопкой (ПКМ):** Открывает меню ручного редактирования перевода. Вы можете ввести свой вариант, сбросить его или обновить кэш.

### Панель инструментов оверлея:
*   `✨` — включить/выключить неоновые рамки предложений.
*   `Aa` — скрыть/показать подсветку слов.
*   `〰` — скрыть/показать направляющие нити чтения.
*   `⚡` — включить автоотслеживание изменений на экране.

---

## 🎭 Режимы интерфейса

SINC PRO умеет менять облик под ваши рабочие задачи:
1.  **Редактор (Full):** Полноценное окно с текстовым полем, поддержкой Markdown и скраббером (прогресс-баром) для перемотки озвучки по предложениям.
2.  **Плеер (Mini):** Компактная полоска поверх всех окон. Идеально для фонового прослушивания документации при работе. Кнопка `📖` выдвигает текстовый ящик.
3.  **Микро (Micro):** Ультракомпактная кнопка-кругляшок для управления воспроизведением с минимальным следом на экране.

---

<details>
<summary>🛠️ Под капотом (Технические детали реализации для разработчиков)</summary>

### Технологический стек:
*   **Интерфейс:** `customtkinter` (Python-обертка над Tkinter с поддержкой темной темы и DPI-awareness на нескольких мониторах).
*   **Распознавание (OCR):** Windows OCR WinRT API (высокая скорость, 100% оффлайн, поддержка DPI масштабирования 1:1).
*   **Синтез речи (TTS):** Microsoft Edge TTS (`edge-tts`) — естественные нейросетевые голоса без необходимости платных API ключей.
*   **База данных:** SQLite (`translation_cache.db`) для кэширования переводов и хранения пользовательских правок.

### Ключевые алгоритмы:
1.  **Абстрагирование чисел:** Для экономии трафика и повторного использования кэша все числа в предложениях заменяются токенами перед отправкой в переводчик, а затем возвращаются обратно.
2.  **Связные компоненты (Paragraph Merging):** Алгоритм на основе графа смежности объединяет строки OCR в единые абзацы, анализируя высоту шрифта, расстояние по Y, пунктуацию на стыках и регистр символов. Предотвращает ложное слияние табличных колонок.
3.  **Hybrid OCR:** При нахождении смешанных слов (с дефисами или mixed-языком) область точечно вырезается, масштабируется в 3 раза фильтром `LANCZOS` и повторно сканируется русским движком WinRT.
4.  **Избирательный перевод mixed-текста:** В русско-английских технических текстах переводятся только отдельные латинские термины длиной от 3 букв (с разбиением CamelCase), сохраняя русский контекст нетронутым.
5.  **Фоновый валидатор кэша:** Воркер раз в 12 секунд проверяет валидность переводов в БД SQLite и фоново обновляет устаревшие записи.

</details>

---

<a id="en"></a>
# 🇺🇸 SINC PRO — Smart Voice Assistant & Screen Translator

**SINC PRO** is an elegant, incredibly fast, and responsive Windows application designed to make reading from your screen effortless and comfortable.

The project was developed with special care for people with **dyslexia** (the author is dyslexic themselves). The main goal of SINC PRO is to remove barriers when consuming complex text in any environment: scientific PDFs, technical documentation, code in IDEs, messengers, or web pages.

---

## ✨ Key Features (Value for You)

*   **🎧 One-Click Reading from Any App:**
    Simply highlight text in *any* application and press `Ctrl + Shift`. Premium neural network voices from Microsoft Edge TTS will instantly read it aloud with natural intonations.
*   **⛶ "Live" Screen Translation Overlay (Read Uncopyable Text):**
    Press `Ctrl + Alt + T`, crop a region of the screen, and the translation will appear directly over the original text. The window is **click-through**, allowing you to scroll and click elements underneath it.
    > **Why it's a superpower:** This feature is irreplaceable when text cannot be selected or copied (secured PDFs, images, inactive UI elements, program buttons, or games). The overlay recognizes uncopyable text on the fly, allowing you to speak, translate, or copy it to the clipboard without the risk of accidentally clicking the interactive elements underneath.
*   **🧠 Interactive Reading Mode (Click Lock):**
    Press `Space` inside the translator frame. The window dims and locks mouse clicks. Now you can interact with the text:
    *   *Left Click a sentence* — speak the translation.
    *   *Ctrl + Left Click* — speak the original English text.
    *   *Right Click a sentence* — open a mini-editor to manually edit the translation.
*   **🔍 Double Click Word Translation:**
    Double-click any unfamiliar word in the overlay to show a sleek tooltip with its translation and a quick speak button.
*   **〰 Flow Threads & Neon Highlighting:**
    The neon border brightness automatically adapts to the background (light/dark). The *Flow Threads* (dashed lines) physically connect words in reading order, helping your eyes maintain focus and follow the line smoothly.
*   **⚡ Auto Scan Screen Updates:**
    Turn on auto-scanning (the `⚡` button), and the overlay will automatically refresh text and shapes if the content or code underneath changes.
*   **🔒 Local Translation & LLMs:**
    Translate offline using the built-in Argos Translate engine, or connect local LLMs via Ollama or Msty. Your data never leaves your computer.

---

## 🚀 Quick Start in 15 Seconds

1.  Download and run the application (`SINC_PRO.exe` from releases or run `voice_widget.py`).
2.  Highlight text anywhere and press **`Ctrl + Shift`** to speak.
3.  Or press **`Ctrl + Alt + T`** and select a screen region for interactive translation.

### ⌨️ Default Hotkeys

| Hotkey | Action |
| :--- | :--- |
| **`Ctrl + Shift`** | Read selected text from any program |
| **`Ctrl + Alt + T`** | Open screen translation frame |
| **`Space`** | Toggle Interactive Mode (Click Lock) inside the frame |
| **`Esc`** | Close translation overlay / settings overlay |

---

## 🎮 Interactive Overlay Guide

Once interactive mode is active (`Space` or `🔊/A` button), use the following gestures:

*   **Single Left Click:** Speaks the sentence translation in Russian.
*   **`Ctrl` + Left Click:** Speaks the original sentence text.
*   **Double Left Click:** Opens a quick translation for the clicked word.
*   **Right Click:** Opens the manual translation editor to write a custom translation, reset it, or refresh the cache.

### Overlay Toolbar Options:
*   `✨` — toggle neon sentence borders.
*   `Aa` — toggle word underlines.
*   `〰` — toggle guiding flow threads.
*   `⚡` — toggle auto-scanning for screen changes.

---

## 🎭 UI Modes

SINC PRO adapts to your workflow:
1.  **Editor (Full):** A complete window with a text field, Markdown rendering, and a scrubber (progress bar) to rewind speech by sentences.
2.  **Player (Mini):** A compact bar on top of all windows. Ideal for listening to documentation while working. The `📖` button slides out the text drawer.
3.  **Micro (Micro):** An ultra-compact widget with basic controls and a minimal desktop footprint.

---

<details>
<summary>🛠️ Under the Hood (Technical Details for Developers)</summary>

### Technology Stack:
*   **UI:** `customtkinter` (a wrapper over Tkinter with dark mode support and multi-monitor DPI awareness).
*   **OCR:** Windows Runtime OCR API (high speed, 100% offline, 1:1 physical pixel DPI mapping).
*   **TTS:** Microsoft Edge TTS (`edge-tts`) — natural neural voices without the need for API keys.
*   **Database:** SQLite (`translation_cache.db`) for caching translations and storing custom edits.

### Core Algorithms:
1.  **Digit Abstraction:** Pre-replaces digits with temporary tokens (e.g. `99990`) before translating to reuse the template cache efficiently, restoring them afterwards.
2.  **Connected Components (Paragraph Merging):** Adjacency-graph merging of OCR lines based on font size, vertical gaps, trailing punctuation, and letter casing. Prevents columns in tables from merging together.
3.  **Hybrid OCR:** If a mixed-language word (e.g., with dashes) is missed by the main OCR, the region is cropped, upscaled 3x using `LANCZOS` filter, and rescanned with the Russian WinRT engine.
4.  **Mixed-Text Translation:** Translates only English terms (length >= 3, CamelCase aware) within Russian/English technical texts to preserve the overall Russian context.
5.  **Background Cache Validator:** Runs a loop every 12 seconds to re-verify translations in SQLite and update stale entries in the background.

</details>
