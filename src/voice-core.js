// voice-core.js
// Единое ядро логики Озвучки (TTS) и управления состоянием плеера
// Обеспечивает потоковое воспроизведение, расчет умного таймлайна и синхронизацию состояний.

class TtsCacheDB {
    constructor() {
        this.dbName = "SincProTtsCache_v2";
        this.legacyDbName = "SincProTtsCache";
        this.storeName = "audio_cache";
        this.maxEntries = 400;
        this.ttlMs = 24 * 3600 * 1000; // 24 часа
        this.db = null;
        this.initPromise = this.init();
    }

    init() {
        // Удаляем старую базу v1, в которой могли закэшироваться фрагменты с резервным голосом Google TTS
        try {
            indexedDB.deleteDatabase(this.legacyDbName);
        } catch (e) {}

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onerror = (e) => {
                console.error("IndexedDB open error:", e);
                reject(e);
            };
            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { keyPath: "id" });
                }
            };
        });
    }

    async get(voice, text) {
        await this.initPromise;
        if (!this.db) return null;
        const id = `${voice}_${text.trim()}`;
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);
            request.onsuccess = (e) => {
                const record = e.target.result;
                if (record) {
                    if (Date.now() - (record.lastUsed || 0) > this.ttlMs) {
                        store.delete(id);
                        resolve(null);
                        return;
                    }
                    record.lastUsed = Date.now();
                    store.put(record);
                    resolve(record.audio);
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => resolve(null);
        });
    }

    async set(voice, text, audio) {
        await this.initPromise;
        if (!this.db) return;
        const id = `${voice}_${text.trim()}`;
        const record = {
            id,
            voice,
            text: text.trim(),
            audio,
            lastUsed: Date.now()
        };
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const request = store.put(record);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
        });
    }

    async clearAll() {
        await this.initPromise;
        if (!this.db) return 0;
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const countReq = store.count();
            let total = 0;
            countReq.onsuccess = () => {
                total = countReq.result || 0;
            };
            const clearReq = store.clear();
            clearReq.onsuccess = () => {
                console.log(`[TtsCacheDB] Cleared all ${total} cached records`);
                resolve(total);
            };
            clearReq.onerror = () => resolve(0);
        });
    }

    async cleanOldRecords() {
        await this.initPromise;
        if (!this.db) return;
        const limitTime = Date.now() - this.ttlMs;
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const request = store.getAll();
            request.onsuccess = (e) => {
                const records = e.target.result || [];
                let deletedCount = 0;
                const validRecords = [];

                for (const rec of records) {
                    if (!rec.lastUsed || rec.lastUsed < limitTime) {
                        store.delete(rec.id);
                        deletedCount++;
                    } else {
                        validRecords.push(rec);
                    }
                }

                // Если записей больше лимита (400), удаляем самые старые по LRU
                if (validRecords.length > this.maxEntries) {
                    validRecords.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
                    const excess = validRecords.length - this.maxEntries;
                    for (let i = 0; i < excess; i++) {
                        store.delete(validRecords[i].id);
                        deletedCount++;
                    }
                }

                if (deletedCount > 0) {
                    console.log(`[TtsCacheDB] Cleaned ${deletedCount} expired/excess records`);
                }
                resolve();
            };
            request.onerror = () => resolve();
        });
    }
}

class VoiceCore {
    constructor() {
        this.instanceId = Math.random().toString(36).substring(2);
        this.currentText = "";
        this.sentences = [];
        this.audioBuffers = []; // Base64 strings for each sentence
        this.audioDurations = []; // Durations for smart timeline
        
        this.currentSentenceIndex = 0;
        this.isPlaying = false;
        this.isPaused = false;
        this.isPrefetching = false; // Флаг работы фоновой очереди
        this.currentlyLoading = new Set(); // Набор индексов предложений, находящихся в процессе загрузки
        this.lastNetworkRequestTime = 0; // Время завершения последнего сетевого запроса к Edge TTS
        this.isNetworkFetching = false; // Флаг активного сетевого запроса к Edge TTS
        
        this.cache = new TtsCacheDB();
        this.cache.cleanOldRecords();
        
        // Настройки по умолчанию
        this.settings = {
            voice: 'ru-RU-SvetlanaNeural',
            speed: 1.0,
            volume: 1.0,
            translate: false,
            tts_engine: 'edge',
            tts_local_voice: 'ru_RU-dmitri-medium.onnx'
        };
        this._lastProgressBroadcastTime = 0;
        this._lastBroadcastPlayedPct = -1;
        this._lastBroadcastBufferedPct = -1;

        if (window.__TAURI__) {
            const { invoke } = window.__TAURI__.core;
            Promise.all([
                invoke('load_config'),
                invoke('get_installed_voices').catch(() => [])
            ]).then(([config, voices]) => {
                if (config.tts_voice) this.settings.voice = config.tts_voice;
                if (config.tts_speed) this.settings.speed = config.tts_speed;
                if (config.tts_volume !== undefined) this.settings.volume = Math.max(0, Math.min(2.0, parseFloat(config.tts_volume)));
                if (config.tts_translate !== undefined) this.settings.translate = config.tts_translate;
                if (config.tts_engine) this.settings.tts_engine = config.tts_engine;
                if (config.tts_local_voice) this.settings.tts_local_voice = config.tts_local_voice;
                this.settings.installedVoices = voices;
                this.audioElement.playbackRate = this.settings.speed;
                this.applyEffectiveVolume(this.settings.volume);
                if (this.onSettingsSync) this.onSettingsSync(this.settings);
                this.broadcastState('settings', this.settings);
            }).catch(()=>{});
        } else {
            const savedSettings = JSON.parse(localStorage.getItem('tts-settings') || '{}');
            this.settings = {
                voice: savedSettings.voice || 'ru-RU-SvetlanaNeural',
                speed: savedSettings.speed || 1.0,
                volume: savedSettings.volume !== undefined ? Math.max(0, Math.min(2.0, parseFloat(savedSettings.volume))) : 1.0,
                translate: savedSettings.translate || false,
                tts_engine: savedSettings.tts_engine || 'edge',
                tts_local_voice: savedSettings.tts_local_voice || 'ru_RU-dmitri-medium.onnx'
            };
        }

        this.audioElement = new Audio();
        this.audioElement.crossOrigin = "anonymous";
        this.audioElement.playbackRate = this.settings.speed;
        this._audioCtx = null;
        this._gainNode = null;
        this._compressorNode = null;
        this._sourceNode = null;
        this.applyEffectiveVolume(this.settings.volume);
        
        // Слушатели событий
        this.onProgress = null;       // (percentBuffered, percentPlayed)
        this.onSentenceActive = null; // (index)
        this.onStateChange = null;    // (isPlaying, isPaused)
        this.onSettingsSync = null;   // (settingsObj)

        this.setupAudioEvents();
        this.setupTauriSync();
    }

    ensureAudioBoostGraph() {
        try {
            if (!this._audioCtx) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return false;
                this._audioCtx = new AudioCtx();
                this._sourceNode = this._audioCtx.createMediaElementSource(this.audioElement);
                this._compressorNode = this._audioCtx.createDynamicsCompressor();
                // Мягкая вещательная нормализация (-14 LUFS как на YouTube) без искажений на пиках
                this._compressorNode.threshold.value = -20;
                this._compressorNode.knee.value = 18;
                this._compressorNode.ratio.value = 3.0;
                this._compressorNode.attack.value = 0.003;
                this._compressorNode.release.value = 0.20;

                this._gainNode = this._audioCtx.createGain();
                this._sourceNode.connect(this._compressorNode);
                this._compressorNode.connect(this._gainNode);
                this._gainNode.connect(this._audioCtx.destination);
            }
            if (this._audioCtx && this._audioCtx.state === 'suspended') {
                this._audioCtx.resume().catch(() => {});
            }
            return !!this._gainNode;
        } catch (err) {
            console.warn('[VoiceCore] WebAudio boost fallback:', err);
            return false;
        }
    }

    applyEffectiveVolume(vol) {
        const clamped = Math.max(0, Math.min(2.0, isNaN(vol) ? 1.0 : parseFloat(vol)));
        this.settings.volume = clamped;
        if (!this.audioElement) return;
        if (this._gainNode && this._audioCtx) {
            this.audioElement.volume = 1.0;
            // Базовый буст 1.35x на 100% выравнивает громкость синтеза речи (-18 LUFS) с уровнем YouTube (-14 LUFS),
            // а при 200% даёт до 2.7x усиления с защитой от перегруза через компрессор
            const boostedGain = clamped <= 0.001 ? 0.0 : (clamped * 1.35);
            this._gainNode.gain.value = boostedGain;
        } else {
            this.audioElement.volume = Math.max(0, Math.min(1.0, clamped));
        }
    }

    log(message) {
        const msg = `[VoiceCore] ${message}`;
        console.log(msg);
        if (window.__TAURI__) {
            window.__TAURI__.core.invoke('write_js_log', { log: msg }).catch(()=>{});
        }
    }

    removeMarkdown(text) {
        if (!text) return "";
        let str = text;

        // 1. Убираем блоки кода ```lang ... ```
        str = str.replace(/```[a-z]*\n([\s\S]*?)\n```/g, '$1');
        
        // 2. Убираем inline-код `code`
        str = str.replace(/`([^`]+)`/g, '$1');
        
        // 3. Убираем изображения ![alt](url) -> оставляем alt-текст
        str = str.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
        
        // 4. Убираем ссылки [text](url) -> оставляем текст ссылки
        str = str.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
        
        // 5. Убираем заголовки #, ##, ### в начале строки
        str = str.replace(/^(#{1,6})\s+/gm, '');
        
        // 6. Убираем жирный и курсив (**текст**, *текст*, __текст__, _текст_)
        str = str.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2');
        str = str.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2');
        
        // 7. Убираем горизонтальные линии ---, ***, ___
        str = str.replace(/^\s*([-*_])\1{2,}\s*$/gm, '');

        // 8. Убираем маркеры списков с чекбоксами (например: "- [ ] Задача" -> "Задача")
        str = str.replace(/^\s*([-*+])\s+\[[ xX]\]\s+/gm, '');
        
        // 9. Убираем обычные маркеры списков в начале строки (например: "- Элемент" -> "Элемент")
        str = str.replace(/^\s*([-*+])\s+/gm, '');

        return str;
    }

    cleanFormulasForSpeech(text) {
        if (!text) return "";
        let str = text;

        // 1. Склеиваем задвоенные при копировании из KaTeX / MathML формулы и выражения:
        // Например: "O(1)O(1)" -> "O(1)", "E = mc^2E = mc^2" -> "E = mc^2", "x_1 + y_1\nx_1 + y_1" -> "x_1 + y_1"
        str = str.replace(/([A-Za-zΑ-Ωα-ω0-9_^+*/=<>≤≥≈≠±×÷()\[\]\-.,]{2,60}?)\s*\1/g, (match, g1) => {
            // Схлопываем только если фрагмент похож на формулу/токен (содержит цифры, мат. знаки или латиницу со скобками/индексами),
            // а не просто два одинаковых обычных слова через пробел
            if (/[0-9=+*/^_<>≤≥≈≠±×÷()\[\]]/.test(g1) || /^[A-Za-zΑ-Ωα-ω]{1,4}$/.test(g1.trim())) {
                return g1;
            }
            return match;
        });

        // 2. Если KaTeX скопировал raw-LaTeX и сразу следом — отрендеренный вид (например "\frac{a}{b} a/b" или "$x^2$ x²")
        str = str.replace(/\$\$([^$]+)\$\$/g, '$1');
        str = str.replace(/\$([^$\n]+)\$/g, '$1');

        // 3. Преобразуем частые LaTeX-команды в читаемые математические символы, чтобы диктор не спеллинговал их по-английски
        str = str.replace(/\\text\{([^}]*)\}/g, '$1');
        str = str.replace(/\\(?:mathrm|mathbf|mathit|mathsf)\{([^}]*)\}/g, '$1');
        str = str.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1 делить на $2)');
        str = str.replace(/\\sqrt\{([^}]+)\}/g, 'корень из $1');
        str = str.replace(/\\(?:cdot|times)\b/g, ' умножить на ');
        str = str.replace(/\\(?:le|leq)\b/g, ' ≤ ');
        str = str.replace(/\\(?:ge|geq)\b/g, ' ≥ ');
        str = str.replace(/\\(?:ne|neq)\b/g, ' ≠ ');
        str = str.replace(/\\approx\b/g, ' ≈ ');
        str = str.replace(/\\pm\b/g, ' ± ');
        str = str.replace(/\\(?:to|rightarrow)\b/g, ' → ');
        str = str.replace(/\\Delta\b/g, 'дельта ');
        str = str.replace(/\\alpha\b/g, 'альфа ');
        str = str.replace(/\\beta\b/g, 'бета ');
        str = str.replace(/\\gamma\b/g, 'гамма ');
        str = str.replace(/\\lambda\b/g, 'лямбда ');
        str = str.replace(/\\sigma\b/g, 'сигма ');
        str = str.replace(/\\pi\b/g, 'пи ');

        // 4. Заменяем степени ^2, ^3 и нижние индексы _1 на компактный вид без служебных символов ^ и _
        str = str.replace(/\^2\b/g, '²').replace(/\^3\b/g, '³');
        str = str.replace(/([A-Za-zА-Яа-яЁё0-9)])\^([A-Za-z0-9]+)/g, '$1 в степени $2');
        str = str.replace(/([A-Za-z])\s*_\s*([0-9]+)\b/g, '$1$2');

        // 5. Повторно схлопываем идентичные соседние формулы после очистки LaTeX (например, когда KaTeX отдал LaTeX + HTML)
        str = str.replace(/([A-Za-zΑ-Ωα-ω0-9²³=+*/<>≤≥≈≠±×÷()\[\]\-]{2,50}?)\s*\1/g, (match, g1) => {
            if (/[0-9²³=+*/<>≤≥≈≠±×÷()\[\]]/.test(g1)) {
                return g1;
            }
            return match;
        });

        return str;
    }

    cleanText(text) {
        if (!text) return "";
        let cleaned = text.trim();
        // Санитаризация Markdown-разметки и задвоенных формул KaTeX/LaTeX
        cleaned = this.removeMarkdown(cleaned);
        cleaned = this.cleanFormulasForSpeech(cleaned);
        // Убираем кавычки, если нейросеть вернула текст в них
        if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
            cleaned = cleaned.substring(1, cleaned.length - 1).trim();
        }
        if (cleaned.startsWith('«') && cleaned.endsWith('»')) {
            cleaned = cleaned.substring(1, cleaned.length - 1).trim();
        }
        return cleaned;
    }

    splitIntoSentences(text) {
        text = this.cleanText(text);
        if (!text) return [];

        // Нормализуем переносы строк (убираем \r)
        let processed = text.replace(/\r\n/g, "\n");

        // Защищаем числа (3.3)
        processed = processed.replace(/(\d)\.(\d)/g, "$1<DOT>$2");
        // Защищаем нумерацию списков (1., 2.)
        processed = processed.replace(/(^\s*\d+)\./gm, "$1<DOT>");
        processed = processed.replace(/(\s\d+)\./g, "$1<DOT>");
        // Защищаем аббревиатуры
        processed = processed.replace(/т\.к\./gi, "т<DOT>к<DOT>");
        processed = processed.replace(/т\.д\./gi, "т<DOT>д<DOT>");
        processed = processed.replace(/т\.е\./gi, "т<DOT>е<DOT>");
        processed = processed.replace(/т\.п\./gi, "т<DOT>п<DOT>");
        processed = processed.replace(/г\./gi, "г<DOT>");
        processed = processed.replace(/ул\./gi, "ул<DOT>");
        processed = processed.replace(/пр\./gi, "пр<DOT>");
        // Защищаем многоточия
        processed = processed.replace(/\.\.\./g, "<ELLIPSIS>");

        // Разбиваем по концам предложений (. ! ?), по точке с запятой (;), И по всем переносам строк (\n+).
        // ВАЖНО: НЕ режем по каждому двоеточию внутри строки (чтобы не дробить "Основная: gpt-6.1", время "19:30" или смайлики),
        // но режем по переносам строк, чтобы тезисы/списки после заголовка с двоеточием всегда шли отдельными предложениями!
        let rawSentences = processed.split(/(?<=[.!?])\s+|(?<=;)\s+|\n+/u);

        let initialChunks = [];
        const MAX_CHUNK_LEN = 220;

        for (let s of rawSentences) {
            s = s.replace(/<DOT>/g, ".");
            s = s.replace(/<ELLIPSIS>/g, "...");
            const trimmed = s.trim();
            if (trimmed.length === 0 || !/[\p{L}\p{N}]/u.test(trimmed)) continue;

            // Если это длинный абзац без точек (> 160 символов), где после заголовка с двоеточием идут тезисы подряд в одну строку,
            // аккуратно отделяем заголовок с двоеточием и делим длинный хвост по тире / запятым / пробелам
            let subParts = [trimmed];
            if (trimmed.length > 160) {
                const colonMatch = trimmed.match(/^([^:]{4,90}:)\s+(.+)$/u);
                if (colonMatch && !/\d:$/.test(colonMatch[1])) {
                    subParts = [colonMatch[1].trim(), colonMatch[2].trim()];
                }
            }

            for (const part of subParts) {
                if (part.length <= MAX_CHUNK_LEN) {
                    initialChunks.push(part);
                } else {
                    let remaining = part;
                    while (remaining.length > MAX_CHUNK_LEN) {
                        let splitIdx = -1;
                        const slice = remaining.slice(0, MAX_CHUNK_LEN);
                        const dashIdx = Math.max(slice.lastIndexOf(' — '), slice.lastIndexOf(' - '));
                        const colonIdx = slice.lastIndexOf(': ');
                        const commaIdx = slice.lastIndexOf(', ');
                        const punctMatch = Math.max(dashIdx, colonIdx, commaIdx);

                        if (punctMatch >= 65) {
                            splitIdx = punctMatch + (slice[punctMatch] === ' ' ? 3 : 1);
                        } else {
                            const spaceIdx = slice.lastIndexOf(' ');
                            splitIdx = spaceIdx >= 65 ? spaceIdx : MAX_CHUNK_LEN;
                        }
                        const chunk = remaining.slice(0, splitIdx).trim();
                        if (chunk.length > 0 && /[\p{L}\p{N}]/u.test(chunk)) {
                            initialChunks.push(chunk);
                        }
                        remaining = remaining.slice(splitIdx).trim();
                    }
                    if (remaining.length > 0 && /[\p{L}\p{N}]/u.test(remaining)) {
                        initialChunks.push(remaining);
                    }
                }
            }
        }

        // Склеиваем совсем крошечные фрагменты (< 22 символов) со следующим предложением,
        // если они не заканчиваются на двоеточие (заголовок списка) и сумма <= MAX_CHUNK_LEN
        let sentences = [];
        for (let i = 0; i < initialChunks.length; i++) {
            let curr = initialChunks[i];
            if (
                curr.length < 22 &&
                !curr.endsWith(':') &&
                i + 1 < initialChunks.length &&
                (curr.length + 1 + initialChunks[i + 1].length) <= MAX_CHUNK_LEN
            ) {
                initialChunks[i + 1] = `${curr} ${initialChunks[i + 1]}`;
            } else {
                sentences.push(curr);
            }
        }

        return sentences;
    }

    async clearCache() {
        this.audioBuffers = new Array(this.sentences.length).fill(null);
        this.currentlyLoading.clear();
        const count = await this.cache.clearAll();
        if (this.sentences.length > 0) {
            this.updateProgress();
        }
        return count;
    }

    async loadCachedSentences(startIndex = 0) {
        const currentBuffersRef = this.audioBuffers;
        const voiceKey = this.settings.voice || 'ru-RU-SvetlanaNeural';
        const BATCH_SIZE = 8;

        // Проверяем кэш небольшими порциями, чтобы не забивать очередь IndexedDB при больших текстах
        for (let batchStart = startIndex; batchStart < this.sentences.length; batchStart += BATCH_SIZE) {
            if (this.audioBuffers !== currentBuffersRef) return;
            const end = Math.min(batchStart + BATCH_SIZE, this.sentences.length);
            const batchPromises = [];
            for (let i = batchStart; i < end; i++) {
                if (currentBuffersRef[i] || this.currentlyLoading.has(i)) continue;
                const sentence = this.sentences[i];
                batchPromises.push((async () => {
                    try {
                        const cachedAudio = await this.cache.get(voiceKey, sentence);
                        if (cachedAudio && this.audioBuffers === currentBuffersRef) {
                            this.audioBuffers[i] = cachedAudio;
                        }
                    } catch (e) {
                        this.log(`Failed to check cache for sentence ${i}: ${e}`);
                    }
                })());
            }
            if (batchPromises.length > 0) {
                await Promise.all(batchPromises);
            }
        }

        if (this.audioBuffers === currentBuffersRef) {
            this.updateProgress();

            // Если мы сейчас играем текущее предложение и оно только что подгрузилось из кэша, запустим его
            if (this.isPlaying && !this.audioElement.src) {
                const currentBuffer = this.audioBuffers[this.currentSentenceIndex];
                if (currentBuffer && currentBuffer !== "ERROR") {
                    this.log(`Instant cache load triggered playCurrentSentence() for active index ${this.currentSentenceIndex}`);
                    this.playCurrentSentence();
                }
            }
        }
    }

    preparePlayback() {
        this.audioElement.pause();
        this.audioElement.removeAttribute('src');
        this.isPlaying = true;
        this.isPaused = false;
        this.notifyState();
        this.broadcastState('play');
        if (this.onProgress) {
            this.onProgress(6, 0);
        }
        if (window.__TAURI__) {
            window.__TAURI__.event.emit('tts-state-sync', {
                action: 'progress',
                percentBuffered: 6,
                percentPlayed: 0
            });
        }
    }

    loadText(text, autoPlay = false) {
        if (autoPlay) {
            this.audioElement.pause();
            this.audioElement.removeAttribute('src');
            this.currentlyLoading.clear();
        } else {
            this.stop(); // Остановка старого воспроизведения при ручной загрузке нового текста
        }
        this._playingSentenceIndex = -1;
        this.isPrefetching = false; // Останавливаем старую очередь загрузки
        this.currentQueueId = null;
        this.currentText = this.cleanText(text);
        this.sentences = this.splitIntoSentences(this.currentText);
        this.log(`loadText() called, sentences count: ${this.sentences.length}, autoPlay=${autoPlay}`);
        this.audioBuffers = new Array(this.sentences.length).fill(null);
        this.audioDurations = new Array(this.sentences.length).fill(0);
        this.currentSentenceIndex = 0;
        this.isPlaying = autoPlay;
        this.isPaused = false;
        this.notifyState();
        
        if (this.sentences.length > 0) {
            // СРАЗУ запускаем 3 параллельных воркера префетча с 0-го, 1-го и 2-го предложений!
            this.startPrefetchQueue();
            // Остальные предложения проверяем в кэше фоново батчами
            if (this.sentences.length > 1) {
                this.loadCachedSentences(1);
            }
        }
    }

    appendText(text) {
        if (!text || !text.trim()) return;
        const cleaned = this.cleanText(text);
        const oldLength = this.sentences.length;
        this.currentText += '\n\n' + cleaned;
        
        const newSentences = this.splitIntoSentences(cleaned);
        if (newSentences.length === 0) return;
        
        this.sentences.push(...newSentences);
        this.audioBuffers.push(...new Array(newSentences.length).fill(null));
        this.audioDurations.push(...new Array(newSentences.length).fill(0));
        
        this.updateProgress();
        
        if (!this.isPrefetching) {
            this.startPrefetchQueue();
        }
        this.loadCachedSentences(oldLength);
    }

    async fetchSentence(i, queueId, currentBuffersRef) {
        this.currentlyLoading.add(i);

        try {
            const isLocal = this.settings.tts_engine === 'local';
            const voiceKey = isLocal 
                ? (this.settings.tts_local_voice || 'ru_RU-dmitri-medium.onnx')
                : (this.settings.voice || 'ru-RU-SvetlanaNeural');
            
            // 1. Проверяем IndexedDB кэш (мгновенно, без задержек)
            const cachedAudio = await this.cache.get(voiceKey, this.sentences[i]);
            if (cachedAudio) {
                if (this.audioBuffers === currentBuffersRef) {
                    this.log(`Cache HIT for sentence ${i}`);
                    this.audioBuffers[i] = cachedAudio;
                    this.updateProgress();
                    if (this.isPlaying && this.currentSentenceIndex === i) {
                        this.log(`cache -> triggering playCurrentSentence() for index ${i}`);
                        this.playCurrentSentence();
                    }
                }
                return;
            }

            // 2. Минимальный интервал между стартами сетевых запросов (35 мс)
            const timeSinceLastRequest = Date.now() - this.lastNetworkRequestTime;
            const minDelay = 35;
            if (timeSinceLastRequest < minDelay) {
                const waitTime = minDelay - timeSinceLastRequest;
                await new Promise(r => setTimeout(r, waitTime));
            }
            this.lastNetworkRequestTime = Date.now();

            // Проверяем, не сменилась ли очередь за время ожидания
            if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) {
                return;
            }

            if (window.__TAURI__) {
                const maxAttempts = 4;
                let lastErr = null;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) {
                        return;
                    }

                    const distance = i - this.currentSentenceIndex;
                    this.log(`Fetching sentence ${i} from network (distance=${distance}, attempt=${attempt}/${maxAttempts})`);
                    
                    try {
                        const base64Audio = await window.__TAURI__.core.invoke('speak_edge_tts', {
                            text: this.sentences[i],
                            voice: voiceKey,
                            rate: 1.0
                        });
                        
                        if (this.audioBuffers === currentBuffersRef) {
                            const dataUrl = `data:audio/mp3;base64,${base64Audio}`;
                            this.audioBuffers[i] = dataUrl;
                            this.updateProgress();
                            
                            if (this.isPlaying && this.currentSentenceIndex === i) {
                                this.log(`prefetch -> triggering playCurrentSentence() for index ${i}`);
                                this.playCurrentSentence();
                            }

                            // Сохраняем в локальный кэш асинхронно, не блокируя воркер предзагрузки следующего предложения!
                            this.cache.set(voiceKey, this.sentences[i], dataUrl).catch(() => {});
                        }
                        return; // Успешно загружено — выходим из цикла попыток
                    } catch (err) {
                        lastErr = err;
                        this.log(`Attempt ${attempt}/${maxAttempts} failed for sentence ${i}: ${err}`);
                        if (attempt < maxAttempts) {
                            await new Promise(r => setTimeout(r, 400 * attempt));
                        }
                    }
                }

                // Все попытки исчерпаны
                throw lastErr || new Error("Не удалось синтезировать предложение после нескольких попыток");
            }
        } catch (err) {
            this.log(`Prefetch error at index ${i} after all retries: ${err}`);
            if (window.showToast) window.showToast("Ошибка TTS: " + err, true);
            if (this.audioBuffers === currentBuffersRef) {
                this.audioBuffers[i] = "ERROR";
                this._lastFailedSentenceIndex = i;
                
                if (this.isPlaying && this.currentSentenceIndex === i) {
                    this.currentSentenceIndex++;
                    this._playingSentenceIndex = -1;
                    this.playCurrentSentence();
                }
            }
        } finally {
            this.currentlyLoading.delete(i);
        }
    }

    async startPrefetchQueue() {
        if (this.isPrefetching) {
            return;
        }

        const queueId = Date.now() + Math.random();
        this.currentQueueId = queueId;
        this.isPrefetching = true;

        const currentBuffersRef = this.audioBuffers;
        const windowSize = 15; // current + 14 предложений наперед
        const CONCURRENCY = 3; // 3 параллельных воркера (0-е, 1-е и 2-е предложения грузятся одновременно со старта!)
        this.log('Prefetch queue started with ID ' + queueId);

        const runWorker = async (workerIdx) => {
            if (workerIdx > 0) {
                // Легкий сдвиг 35мс, чтобы воркер 0 первым забрал текущее предложение, а воркеры 1 и 2 сразу следом взяли +1 и +2
                await new Promise(r => setTimeout(r, workerIdx * 35));
            }
            while (true) {
                if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) {
                    return;
                }

                const startIndex = this.currentSentenceIndex;
                const endIndex = Math.min(startIndex + windowSize, this.sentences.length);

                let targetIndex = -1;
                for (let i = startIndex; i < endIndex; i++) {
                    if (!this.audioBuffers[i] && !this.currentlyLoading.has(i)) {
                        targetIndex = i;
                        break;
                    }
                }

                if (targetIndex === -1) {
                    let anyLoadingInWindow = false;
                    for (let i = startIndex; i < endIndex; i++) {
                        if (this.currentlyLoading.has(i)) {
                            anyLoadingInWindow = true;
                            break;
                        }
                    }
                    if (anyLoadingInWindow) {
                        await new Promise(r => setTimeout(r, 80));
                        continue;
                    }
                    return;
                }

                // Синхронно резервируем индекс до await, чтобы соседний воркер сразу взял следующее предложение!
                this.currentlyLoading.add(targetIndex);
                await this.fetchSentence(targetIndex, queueId, currentBuffersRef);
            }
        };

        try {
            await Promise.all(Array.from({ length: CONCURRENCY }, (_, idx) => runWorker(idx)));
        } catch (err) {
            this.log('Error in prefetch queue loop: ' + err);
        } finally {
            if (this.currentQueueId === queueId) {
                this.isPrefetching = false;
                this.log('Prefetch queue ' + queueId + ' stopped');
            }
        }
    }

    seek(index) {
        if (index >= 0 && index < this.sentences.length) {
            this.log(`seek() called to index ${index}`);
            this.currentSentenceIndex = index;
            this._playingSentenceIndex = -1;
            if (this.audioBuffers[index] === "ERROR") {
                this.audioBuffers[index] = null;
            }
            
            // Принудительно сбрасываем предыдущий префетч при seek
            this.isPrefetching = false;
            this.currentQueueId = null;
            
            this.startPrefetchQueue();
            if (this.isPlaying) {
                this.audioElement.pause();
                this.playCurrentSentence();
            } else {
                this.updateProgress();
                if (this.onSentenceActive) this.onSentenceActive(this.currentSentenceIndex);
            }
        }
    }

    async play(shouldBroadcast = true) {
        this.log('play() called, sentences=' + this.sentences.length);
        if (this.sentences.length === 0) {
            this.stop(shouldBroadcast); 
            return;
        }
        
        this.isPlaying = true;
        this.isPaused = false;
        this.notifyState();
        
        if (window.__TAURI__) {
            window.__TAURI__.event.emit('tts-playing-started');
        }
        
        if (shouldBroadcast) {
            this.broadcastState('play');
        }

        const hasSrc = this.audioElement.hasAttribute('src');
        const ended = this.audioElement.ended;
        const paused = this.audioElement.paused;
        this.log('play() state: hasSrc=' + hasSrc + ' ended=' + ended + ' paused=' + paused);

        if (hasSrc && !ended && paused && this._playingSentenceIndex === this.currentSentenceIndex) {
            this.log('play() -> resuming audio');
            this.ensureAudioBoostGraph();
            this.applyEffectiveVolume(this.settings.volume !== undefined ? this.settings.volume : 1.0);
            this.audioElement.play().catch(e => {
                this.log("Audio play error: " + e.name + " " + e.message);
                if (e.name === 'NotAllowedError') {
                    if (window.showToast) window.showToast("Кликните в любое место программы для разблокировки звука", true);
                    this.pause();
                }
            });
        } else {
            this.log('play() -> playCurrentSentence()');
            this.playCurrentSentence();
        }
    }

    pause(shouldBroadcast = true) {
        this.isPlaying = false;
        this.isPaused = true;
        this.audioElement.pause();
        this.notifyState();
        if (shouldBroadcast) {
            this.broadcastState('pause');
        }
    }

    stop(shouldBroadcast = true) {
        this.isPlaying = false;
        this.isPaused = false;
        this._playingSentenceIndex = -1;
        this.audioElement.pause();
        this.audioElement.removeAttribute('src'); // Правильное удаление ресурса
        this.currentSentenceIndex = 0; // Полный сброс к началу
        this.currentlyLoading.clear(); // Очищаем набор загрузок
        this.notifyState();
        if (this.onProgress) this.onProgress(0, 0);
        if (this.onSentenceActive) this.onSentenceActive(-1);
        if (shouldBroadcast) {
            this.broadcastState('stop');
        }
    }

    async playCurrentSentence() {
        this.log('playCurrentSentence() index=' + this.currentSentenceIndex + ' isPlaying=' + this.isPlaying);
        if (!this.isPlaying) return;
        
        if (this.currentSentenceIndex >= this.sentences.length) {
            this.log('playCurrentSentence() - reached end of sentences');
            this.stop(); // Естественное окончание текста
            return;
        }

        if (this.onSentenceActive) {
            this.onSentenceActive(this.currentSentenceIndex);
        }

        const currentBuf = this.audioBuffers[this.currentSentenceIndex];
        const bufferState = currentBuf ? (currentBuf === 'ERROR' ? 'ERROR' : 'READY') : 'NULL';
        this.log('playCurrentSentence() bufferState=' + bufferState);

        if (currentBuf === "ERROR") {
            // Если ошибка произошла только что после 4 попыток — переходим дальше;
            // иначе сбрасываем статус ошибки и пробуем догрузить предложение заново
            if (this._lastFailedSentenceIndex === this.currentSentenceIndex) {
                this._lastFailedSentenceIndex = -1;
                this.currentSentenceIndex++;
                this._playingSentenceIndex = -1;
                this.playCurrentSentence();
                return;
            } else {
                this.audioBuffers[this.currentSentenceIndex] = null;
                if (!this.isPrefetching) {
                    this.startPrefetchQueue();
                }
                return;
            }
        }

        if (currentBuf && currentBuf.startsWith("data:")) {
            // Защита от повторного перезапуска уже играющего предложения
            if (this._playingSentenceIndex === this.currentSentenceIndex && this.audioElement.hasAttribute('src') && !this.audioElement.ended) {
                if (this.audioElement.paused) {
                    this.audioElement.play().catch(() => {});
                }
                return;
            }
            this._playingSentenceIndex = this.currentSentenceIndex;
            this.audioElement.src = currentBuf;
            this.audioElement.playbackRate = this.settings.speed;
            this.ensureAudioBoostGraph();
            this.applyEffectiveVolume(this.settings.volume !== undefined ? this.settings.volume : 1.0);
            this.log('playCurrentSentence() calling audioElement.play() for index ' + this.currentSentenceIndex);
            this.audioElement.play().catch(e => {
                this.log('Audio play FAILED: ' + e.name + ' ' + e.message);
                if (e.name === 'NotAllowedError') {
                    if (window.showToast) window.showToast("Кликните в любое место программы для разблокировки звука", true);
                    this.pause();
                }
            });
        } else {
            this.log('playCurrentSentence() - buffer not ready, ensuring prefetch queue is active and waiting...');
            if (!this.isPrefetching) {
                this.startPrefetchQueue();
            }
        }
        this.updateProgress();
    }

    setupAudioEvents() {
        this.audioElement.addEventListener('ended', () => {
            this.log('audioElement ended event for index ' + this.currentSentenceIndex);
            if (this.isPlaying) {
                this.currentSentenceIndex++;
                this._playingSentenceIndex = -1;
                this.playCurrentSentence();
                this.startPrefetchQueue(); // Сдвигаем окно буферизации и догружаем следующее предложение
            }
        });

        this.audioElement.addEventListener('timeupdate', () => {
            this.updateProgress();
        });
    }

    setupTauriSync() {
        if (!window.__TAURI__) return;
        
        window.__TAURI__.event.listen('tts-state-sync', (event) => {
            if (event.payload) {
                const p = event.payload;
                if (p.sender === this.instanceId) return;
                if (p.action === 'play') {
                    if (!this.isPlaying) this.play(false);
                } else if (p.action === 'pause') {
                    if (this.isPlaying) this.pause(false);
                } else if (p.action === 'stop') {
                    this.stop(false);
                } else if (p.action === 'load') {
                    if (this.currentText !== this.cleanText(p.text)) {
                        this.loadText(p.text);
                    }
                } else if (p.action === 'append') {
                    this.appendText(p.text);
                } else if (p.action === 'settings' || p.action === 'setting') {
                    const src = p.settings || p;
                    if (p.settings) {
                        this.settings = { ...this.settings, ...p.settings };
                    } else {
                        if (p.speed !== undefined) this.settings.speed = p.speed;
                        if (p.volume !== undefined) this.settings.volume = Math.max(0, Math.min(2.0, parseFloat(p.volume)));
                        if (p.voice !== undefined) this.settings.voice = p.voice;
                        if (p.translate !== undefined) this.settings.translate = p.translate;
                        if (p.tts_engine !== undefined) this.settings.tts_engine = p.tts_engine;
                        if (p.tts_local_voice !== undefined) this.settings.tts_local_voice = p.tts_local_voice;
                        if (p.installedVoices !== undefined) this.settings.installedVoices = p.installedVoices;
                    }
                    if (src.speed !== undefined) {
                        this.audioElement.playbackRate = this.settings.speed;
                    }
                    if (src.volume !== undefined) {
                        this.applyEffectiveVolume(src.volume);
                    }
                    localStorage.setItem('tts-settings', JSON.stringify(this.settings));
                    if (window.__TAURI__) {
                        const { invoke } = window.__TAURI__.core;
                        invoke('update_config_fields', { fields: {
                            tts_voice: this.settings.voice,
                            tts_speed: this.settings.speed,
                            tts_volume: this.settings.volume,
                            tts_translate: this.settings.translate,
                            tts_engine: this.settings.tts_engine,
                            tts_local_voice: this.settings.tts_local_voice
                        }}).catch(()=>{});
                    }
                    if (this.onSettingsSync) this.onSettingsSync(this.settings);
                }
            }
        });

        window.__TAURI__.event.listen('recording-started', () => {
            this.log('recording-started detected, pausing playback');
            if (this.isPlaying) {
                this.pause();
            }
        });
    }

    notifyState() {
        if (this.onStateChange) {
            this.onStateChange(this.isPlaying, this.isPaused);
        }
    }

    broadcastState(action, extra = {}) {
        if (!window.__TAURI__) return;
        window.__TAURI__.event.emit('tts-state-sync', { action, sender: this.instanceId, ...extra });
    }

    updateProgress() {
        if (this.sentences.length === 0) return;
        
        let totalChars = this.currentText.length;
        if (totalChars === 0) return;

        let bufferedChars = 0;
        let playedCharsBeforeCurrent = 0;

        for (let i = 0; i < this.sentences.length; i++) {
            if (this.audioBuffers[i]) {
                bufferedChars += this.sentences[i].length;
            }
            if (i < this.currentSentenceIndex) {
                playedCharsBeforeCurrent += this.sentences[i].length;
            }
        }

        const percentBuffered = (bufferedChars / totalChars) * 100;
        
        let currentSentenceChars = this.sentences[this.currentSentenceIndex] ? this.sentences[this.currentSentenceIndex].length : 0;
        let currentAudioProgress = 0;
        
        if (this.audioElement.duration && !isNaN(this.audioElement.duration)) {
            currentAudioProgress = this.audioElement.currentTime / this.audioElement.duration;
        }

        const playedChars = playedCharsBeforeCurrent + (currentSentenceChars * currentAudioProgress);
        const percentPlayed = (playedChars / totalChars) * 100;

        if (this.onProgress) {
            this.onProgress(percentBuffered, percentPlayed);
        }

        if (window.__TAURI__) {
            const now = Date.now();
            const playedDiff = Math.abs(percentPlayed - this._lastBroadcastPlayedPct);
            const bufDiff = Math.abs(percentBuffered - this._lastBroadcastBufferedPct);
            const isBoundary = percentPlayed <= 0.1 || percentPlayed >= 99.5 || percentBuffered >= 99.9;
            if (isBoundary || (now - this._lastProgressBroadcastTime >= 180 && (playedDiff >= 0.4 || bufDiff >= 0.4))) {
                this._lastProgressBroadcastTime = now;
                this._lastBroadcastPlayedPct = percentPlayed;
                this._lastBroadcastBufferedPct = percentBuffered;
                window.__TAURI__.event.emit('tts-state-sync', {
                    action: 'progress',
                    percentBuffered,
                    percentPlayed
                });
            }
        }
    }
}

window.VoiceCore = VoiceCore;

// WindowToggleManager для чистого переиспользования логики и верстки 3-позиционных переключателей
class WindowToggleManager {
    static renderToggle(id, icon, title) {
        // Рендерим 3-позиционный слайдер (иконка + тумблер, без текстовой подписи)
        return `
            <div class="tri-switch-wrapper" id="${id}-wrapper" title="${title}" data-state="2">
                <span class="material-symbols-outlined tri-switch-icon">${icon}</span>
                <div class="tri-switch-container">
                    <input type="range" class="tri-slider" min="0" max="2" value="2" id="${id}">
                </div>
            </div>
        `;
    }

    static renderToggle2State(id, icon, title) {
        // Рендерим 2-позиционный слайдер (0: Выкл, 2: Вкл) с использованием step="2"
        return `
            <div class="tri-switch-wrapper" id="${id}-wrapper" title="${title}" data-state="2">
                <span class="material-symbols-outlined tri-switch-icon">${icon}</span>
                <div class="tri-switch-container">
                    <input type="range" class="tri-slider" min="0" max="2" step="2" value="2" id="${id}">
                </div>
            </div>
        `;
    }

    static initToggle(sliderId, targetWindowLabel) {
        const slider = document.getElementById(sliderId);
        const wrapper = document.getElementById(sliderId + '-wrapper');
        if (!slider || !wrapper) return;

        const eventName = `${targetWindowLabel}-mode-changed`;
        const showCommand = `show_${targetWindowLabel}_window`;
        const hideCommand = `hide_${targetWindowLabel}_window`;

        // 1. Инициализация начального состояния при старте
        let defaultVal = "2";
        if (targetWindowLabel === 'ocr') {
            defaultVal = "0"; // Оверлей OCR выключен по умолчанию при старте
        }

        if (window.__TAURI__) {
            const { invoke } = window.__TAURI__.core;
            const { listen, emit } = window.__TAURI__.event;

            invoke('load_config').then((config) => {
                let modeVal = defaultVal;
                if (targetWindowLabel === 'capsule' && config.capsule_mode !== undefined) modeVal = String(config.capsule_mode);
                if (targetWindowLabel === 'widget' && config.widget_mode !== undefined) modeVal = String(config.widget_mode);
                if (targetWindowLabel === 'ocr' && config.ocr_mode_switch !== undefined) modeVal = String(config.ocr_mode_switch);
                if (targetWindowLabel === 'layout' && config.layout_converter_mode !== undefined) modeVal = String(config.layout_converter_mode);

                slider.value = modeVal;
                wrapper.setAttribute('data-state', modeVal);

                const modeNum = parseInt(modeVal, 10);
                invoke('set_module_mode', { module: targetWindowLabel, mode: modeNum }).catch(()=>{});

                if (targetWindowLabel === 'widget' && modeNum === 2) {
                    invoke(showCommand).catch(() => {});
                }
            }).catch(() => {
                const savedMode = localStorage.getItem(`${targetWindowLabel}Mode`) || defaultVal;
                slider.value = savedMode;
                wrapper.setAttribute('data-state', savedMode);
            });

            // 2. Обработчик изменения ползунка
            slider.addEventListener('input', async () => {
                const val = slider.value;
                wrapper.setAttribute('data-state', val);
                localStorage.setItem(`${targetWindowLabel}Mode`, val);

                const currentModeNum = parseInt(val, 10);

                try {
                    // Сохраняем в единый конфиг на бэкенде
                    const fields = {};
                    if (targetWindowLabel === 'capsule') fields.capsule_mode = currentModeNum;
                    if (targetWindowLabel === 'widget') fields.widget_mode = currentModeNum;
                    if (targetWindowLabel === 'ocr') fields.ocr_mode_switch = currentModeNum;
                    if (targetWindowLabel === 'layout') fields.layout_converter_mode = currentModeNum;
                    await invoke('update_config_fields', { fields });

                    if (currentModeNum === 2) {
                        // Только widget показывается сразу при включении режима 2 (Все включено)
                        if (targetWindowLabel === 'widget') {
                            await invoke(showCommand).catch(() => {});
                        }
                    } else {
                        // При режимах 1 (Только хоткеи) и 0 (Выключено) скрываем окна (кроме layout)
                        if (targetWindowLabel !== 'layout') {
                            await invoke(hideCommand).catch(() => {});
                        }
                    }

                    // Оповещаем другие окна об изменении режима
                    await emit(eventName, currentModeNum);
                } catch (err) {
                    console.error(`[WindowToggleManager] Error toggling mode for ${targetWindowLabel}:`, err);
                }
            });

            // 3. Синхронизация при внешних изменениях (из других окон)
            listen(eventName, (event) => {
                const val = event.payload;
                slider.value = val;
                wrapper.setAttribute('data-state', val);
                localStorage.setItem(`${targetWindowLabel}Mode`, val);
                
                const currentModeNum = parseInt(val, 10);
                invoke('set_module_mode', { module: targetWindowLabel, mode: currentModeNum }).catch(()=>{});
            });
        } else {
            const savedMode = localStorage.getItem(`${targetWindowLabel}Mode`) || defaultVal;
            slider.value = savedMode;
            wrapper.setAttribute('data-state', savedMode);
        }
    }
}

window.WindowToggleManager = WindowToggleManager;
