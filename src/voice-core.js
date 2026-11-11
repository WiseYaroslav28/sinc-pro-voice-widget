// voice-core.js
// Единое ядро логики Озвучки (TTS) и управления состоянием плеера
// Обеспечивает потоковое воспроизведение, расчет умного таймлайна и синхронизацию состояний.

class TtsCacheDB {
    constructor() {
        this.dbName = "SincProTtsCache_v3";
        this.legacyDbName = "SincProTtsCache";
        this.legacyDbNameV2 = "SincProTtsCache_v2";
        this.storeName = "audio_cache";
        this.maxEntries = 1000;
        this.ttlMs = 3 * 24 * 3600 * 1000; // 3 дня (72 часа)
        this.db = null;
        this.memCache = new Map(); // Мгновенный синхронный кэш в оперативной памяти
        this.initPromise = this.init();
    }

    init() {
        // Удаляем старые базы v1 и v2, в которых могли сохраниться обрезанные фрагменты или мультиязычные голоса v3.5.32
        try {
            indexedDB.deleteDatabase(this.legacyDbName);
            indexedDB.deleteDatabase(this.legacyDbNameV2);
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

    getSync(voice, text) {
        if (!text) return null;
        const id = `${voice}_${text.trim()}`;
        return this.memCache.get(id) || null;
    }

    async get(voice, text) {
        if (!text) return null;
        const id = `${voice}_${text.trim()}`;
        const memHit = this.memCache.get(id);
        if (memHit) return memHit;

        await this.initPromise;
        if (!this.db) return null;
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            const request = store.get(id);
            request.onsuccess = (e) => {
                const record = e.target.result;
                if (record && record.audio) {
                    if (Date.now() - (record.lastUsed || 0) > this.ttlMs) {
                        this.memCache.delete(id);
                        resolve(null);
                        return;
                    }
                    this.memCache.set(id, record.audio);
                    resolve(record.audio);
                } else {
                    resolve(null);
                }
            };
            request.onerror = () => resolve(null);
        });
    }

    async set(voice, text, audio) {
        if (!text || !audio) return;
        const id = `${voice}_${text.trim()}`;
        this.memCache.set(id, audio);

        await this.initPromise;
        if (!this.db) return;
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
        this.memCache.clear();
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
                        this.memCache.delete(rec.id);
                        deletedCount++;
                    } else {
                        validRecords.push(rec);
                    }
                }

                // Если записей больше лимита (1000), удаляем самые старые по LRU
                if (validRecords.length > this.maxEntries) {
                    validRecords.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
                    const excess = validRecords.length - this.maxEntries;
                    for (let i = 0; i < excess; i++) {
                        store.delete(validRecords[i].id);
                        this.memCache.delete(validRecords[i].id);
                        deletedCount++;
                    }
                    validRecords.splice(0, excess);
                }

                // Предзагружаем актуальные записи из базы в быстрый RAM-кэш
                for (const rec of validRecords) {
                    if (rec.id && rec.audio) {
                        this.memCache.set(rec.id, rec.audio);
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
        this.isPrebuffering = false; // Флаг начального накопления буфера перед стартом звука
        this._prebufferCompleted = false;
        this._initialBufferCompleted = false;
        this._forceBypassBuffer = false;
        this._endingTransition = false;
        this._endedTimer = null;
        this._failedSentenceIndices = new Set();
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
            expressive: true,
            startBufferChars: 300,
            tts_engine: 'edge',
            tts_local_voice: 'ru_RU-dmitri-medium.onnx',
            tts_gemini_model: 'gemini-2.5-flash-native-audio-latest',
            tts_gemini_thinking: 'off'
        };
        this._lastProgressBroadcastTime = 0;
        this._lastBroadcastPlayedPct = -1;
        this._lastBroadcastBufferedPct = -1;
        this._lastBroadcastPrebuffering = null;

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
                if (config.tts_expressive_intonation !== undefined) this.settings.expressive = !!config.tts_expressive_intonation;
                if (config.tts_start_buffer_chars !== undefined) {
                    const parsedBuf = parseInt(config.tts_start_buffer_chars, 10);
                    this.settings.startBufferChars = isNaN(parsedBuf) ? 300 : Math.max(0, Math.min(5000, parsedBuf));
                }
                if (config.tts_engine) this.settings.tts_engine = config.tts_engine;
                if (config.tts_local_voice) this.settings.tts_local_voice = config.tts_local_voice;
                if (config.tts_gemini_model) this.settings.tts_gemini_model = config.tts_gemini_model;
                if (config.tts_gemini_thinking) this.settings.tts_gemini_thinking = config.tts_gemini_thinking;
                this.settings.installedVoices = voices;
                this.audioElement.playbackRate = this.settings.speed;
                this.applyEffectiveVolume(this.settings.volume);
                if (this.onSettingsSync) this.onSettingsSync(this.settings);
                this.broadcastState('settings', this.settings);
            }).catch(()=>{});
        } else {
            const savedSettings = JSON.parse(localStorage.getItem('tts-settings') || '{}');
            const parsedBuf = parseInt(savedSettings.startBufferChars, 10);
            this.settings = {
                voice: savedSettings.voice || 'ru-RU-SvetlanaNeural',
                speed: savedSettings.speed || 1.0,
                volume: savedSettings.volume !== undefined ? Math.max(0, Math.min(2.0, parseFloat(savedSettings.volume))) : 1.0,
                translate: savedSettings.translate || false,
                expressive: savedSettings.expressive !== undefined ? !!savedSettings.expressive : true,
                startBufferChars: isNaN(parsedBuf) ? 300 : Math.max(0, Math.min(5000, parsedBuf)),
                tts_engine: savedSettings.tts_engine || 'edge',
                tts_local_voice: savedSettings.tts_local_voice || 'ru_RU-dmitri-medium.onnx',
                tts_gemini_model: savedSettings.tts_gemini_model || 'gemini-2.5-flash-native-audio-latest',
                tts_gemini_thinking: savedSettings.tts_gemini_thinking || 'off'
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
        
        // 3. Убираем изображения ![alt](url) -> оставляем alt-текст (только если в скобках реальный URL/путь)
        str = str.replace(/!\[([^\]]*)\]\((?:https?:\/\/|file:\/\/|\/)[^)]+\)/gi, '$1');
        
        // 4. Убираем ссылки [text](url) -> оставляем текст ссылки (только для реальных URL, чтобы не удалять код вроде arr[i](x) или пояснения в скобках)
        str = str.replace(/\[([^\]]+)\]\((?:https?:\/\/|file:\/\/|mailto:)[^)]+\)/gi, '$1');
        
        // 5. Убираем заголовки #, ##, ### в начале строки
        str = str.replace(/^(#{1,6})\s+/gm, '');
        
        // 6. Убираем жирный и курсив (**текст**, *текст*, __текст__, _текст_), проверяя границы слов,
        // чтобы не повреждать операторы умножения (a * b * c) и snake_case токены (PERSON_1, fallback_on_AuthenticationError)
        str = str.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1');
        str = str.replace(/(?<![\p{L}\p{N}_])__(?=\S)([^\n]*?\S)__(?![\p{L}\p{N}_])/gu, '$1');
        str = str.replace(/(?<![\p{L}\p{N}*])\*(?=\S)([^\n*]*?\S)\*(?![\p{L}\p{N}*])/gu, '$1');
        str = str.replace(/(?<![\p{L}\p{N}_])_(?=\S)([^\n_]*?\S)_(?![\p{L}\p{N}_])/gu, '$1');
        
        // 7. Убираем горизонтальные линии ---, ***, ___, ===
        str = str.replace(/^\s*([-*_=])\1{2,}\s*$/gm, '');

        // 8. Убираем маркеры списков с чекбоксами (например: "- [ ] Задача" -> "Задача")
        str = str.replace(/^\s*([-*+])\s+\[[ xX]\]\s+/gm, '');
        
        // 9. Убираем обычные маркеры списков в начале строки (например: "- Элемент" -> "Элемент")
        str = str.replace(/^\s*([-*+])\s+/gm, '');

        return str;
    }

    cleanFormulasForSpeech(text) {
        if (!text) return "";
        let str = text;

        // Преобразуем только явные LaTeX-команды (начинающиеся с обратного слэша \),
        // не затрагивая программный код, переменные ($var), индексы (arr[i](x)), snake_case и спецсимволы
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

        return str;
    }

    cleanText(text) {
        if (!text) return "";
        let cleaned = text.trim();
        // Санитаризация Markdown-разметки и явных LaTeX-команд (без искажения кода и спецсимволов)
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

    isGeminiEngine() {
        return this.settings.tts_engine === 'gemini' || Boolean(this.settings.voice && this.settings.voice.startsWith('gemini:'));
    }

    splitIntoSentences(text) {
        text = this.cleanText(text);
        if (!text) return [];

        // Нормализуем переносы строк (убираем \r)
        let processed = text.replace(/\r\n/g, "\n");

        // Разделяем склеенные при копировании из HTML/мессенджеров РУССКИЕ заголовки и предложения без пробелов,
        // НЕ затрагивая латинский код (window.VoiceCore, System.Console, std::String, arr[0]Item, !isValid):
        processed = processed.replace(/([а-яё])([А-ЯЁ])/g, "$1. $2");
        processed = processed.replace(/([)»])([А-ЯЁ][а-яё])/g, "$1. $2");
        processed = processed.replace(/([а-яё]{2,}[.!?])([А-ЯЁ][а-яё])/g, "$1 $2");
        processed = processed.replace(/([а-яё]{2,}[:;])([А-ЯЁ][а-яё])/g, "$1 $2");

        // Защищаем числа (3.3)
        processed = processed.replace(/(\d)\.(\d)/g, "$1<DOT>$2");
        // Защищаем нумерацию списков (1., 2., Приём А., Пункт Б.)
        processed = processed.replace(/(^\s*\d+)\./gm, "$1<DOT>");
        processed = processed.replace(/(\s\d+)\./g, "$1<DOT>");
        processed = processed.replace(/(\b[А-ЯЁA-Z])\.\s+/g, "$1<DOT> ");
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

        // Разбиваем по концам предложений (. ! ?), по точке с запятой (;), И по всем переносам строк (\n+)
        let rawSentences = processed.split(/(?<=[.!?])\s+|(?<=;)\s+|\n+/u);

        const splitLongSentence = (sentence, maxLen = 340) => {
            if (sentence.length <= maxLen) return [sentence];
            const parts = [];
            let remaining = sentence.trim();
            while (remaining.length > maxLen) {
                // Ищем естественную пунктуационную границу клаузы (тире, двоеточие, запятая) в окне до maxLen + 40,
                // НЕ разрывая предложение по закрывающей скобке ") " или слэшу " / " внутри фразы
                const punctLimit = Math.min(maxLen + 110, Math.max(80, remaining.length - 25));
                const punctSlice = remaining.slice(0, punctLimit);
                const dashIdx = Math.max(punctSlice.lastIndexOf(' — '), punctSlice.lastIndexOf(' – '), punctSlice.lastIndexOf(' - '));
                const colonIdx = punctSlice.lastIndexOf(': ');
                const commaIdx = punctSlice.lastIndexOf(', ');
                let punctMatch = Math.max(dashIdx, commaIdx);
                if (punctMatch < 35) {
                    punctMatch = colonIdx;
                }
                let splitIdx = -1;
                if (punctMatch >= 35) {
                    splitIdx = punctMatch + (punctSlice[punctMatch] === ' ' ? 3 : 1);
                } else {
                    const spaceLimit = Math.min(maxLen, Math.max(80, remaining.length - 40));
                    const spaceSlice = remaining.slice(0, spaceLimit);
                    const spaceIdx = spaceSlice.lastIndexOf(' ');
                    splitIdx = spaceIdx >= 60 ? spaceIdx : spaceLimit;
                }
                const chunk = remaining.slice(0, splitIdx).trim();
                if (chunk.length > 0 && /[\p{L}\p{N}]/u.test(chunk)) {
                    parts.push(chunk);
                }
                remaining = remaining.slice(splitIdx).trim();
            }
            if (remaining.length > 0 && /[\p{L}\p{N}]/u.test(remaining)) {
                parts.push(remaining);
            }
            return parts;
        };

        const maxChunkLen = 340;
        const rawClean = [];
        for (let s of rawSentences) {
            s = s.replace(/<DOT>/g, ".");
            s = s.replace(/<ELLIPSIS>/g, "...");
            const trimmed = s.trim();
            if (trimmed.length === 0 || !/[\p{L}\p{N}]/u.test(trimmed)) continue;
            // Не разрываем обычные предложения по двоеточию (": "), чтобы не создавать искусственные
            // незавершённые обрывки на ":" и лишние сетевые запросы
            for (const sub of splitLongSentence(trimmed, maxChunkLen)) {
                rawClean.push(sub);
            }
        }

        // Объединяем короткие маркеры списков (< 12 симв., например "1.") и короткие вводные заголовки на ":"
        // (<= 85 симв.) со следующим основным предложением (если следующее само не является заголовком на ":"),
        // чтобы диктор читал вступление и суть слитно, без катафорических пауз и зависаний на ":".
        const finalSentences = [];
        for (let i = 0; i < rawClean.length; i++) {
            let cur = rawClean[i];
            while (
                i + 1 < rawClean.length && (
                    cur.length < 12 ||
                    (cur.endsWith(':') && cur.length <= 85 && !rawClean[i + 1].endsWith(':') && (cur.length + 1 + rawClean[i + 1].length) <= maxChunkLen)
                )
            ) {
                i++;
                cur += " " + rawClean[i];
            }
            finalSentences.push(cur);
        }

        return finalSentences;
    }

    getCacheVoiceKey() {
        const isLocal = this.settings.tts_engine === 'local';
        const isGemini = this.settings.tts_engine === 'gemini' || (this.settings.voice && this.settings.voice.startsWith('gemini:'));
        const baseVoiceKey = isLocal 
            ? (this.settings.tts_local_voice || 'ru_RU-dmitri-medium.onnx')
            : isGemini
                ? `${this.settings.voice || 'gemini:Aoede'}_${this.settings.tts_gemini_model || 'gemini-2.5-flash-native-audio-latest'}_${this.settings.tts_gemini_thinking || 'off'}_pad5`
                : `${this.settings.voice || 'ru-RU-SvetlanaNeural'}_pad3`;
        return `${baseVoiceKey}${this.settings.expressive !== false ? '' : '_flat'}`;
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
        const cacheVoiceKey = this.getCacheVoiceKey();
        const BATCH_SIZE = 10;

        // Проверяем кэш порциями в IndexedDB и синхронном memCache
        for (let batchStart = startIndex; batchStart < this.sentences.length; batchStart += BATCH_SIZE) {
            if (this.audioBuffers !== currentBuffersRef) return;
            const end = Math.min(batchStart + BATCH_SIZE, this.sentences.length);
            const batchPromises = [];
            for (let i = batchStart; i < end; i++) {
                if (currentBuffersRef[i]) continue;
                const sentence = this.sentences[i];
                const syncHit = this.cache.getSync(cacheVoiceKey, sentence);
                if (syncHit) {
                    this.audioBuffers[i] = syncHit;
                    continue;
                }
                batchPromises.push((async () => {
                    try {
                        const cachedAudio = await this.cache.get(cacheVoiceKey, sentence);
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

            // Если активное предложение загрузилось из кэша и плеер ждёт старта — сразу запускаем озвучку
            if (this.isPlaying && !this._endingTransition && this._playingSentenceIndex !== this.currentSentenceIndex && !this.audioElement.hasAttribute('src') && this.audioBuffers[this.currentSentenceIndex] && this.audioBuffers[this.currentSentenceIndex] !== "ERROR") {
                this.log(`Cache load ready -> triggering playCurrentSentence() for active index ${this.currentSentenceIndex}`);
                this.playCurrentSentence();
            }
        }
    }

    getStartBufferStatus() {
        if (!this.sentences || this.sentences.length === 0 || this.currentSentenceIndex >= this.sentences.length) {
            return { loadedChars: 0, targetChars: 0, allLoaded: true, isReady: true, neededSentencesCount: 0 };
        }
        const rawLimit = parseInt(this.settings.startBufferChars, 10);
        const limitChars = isNaN(rawLimit) ? 300 : Math.max(0, rawLimit);

        let totalRemainingChars = 0;
        let allRemainingLoaded = true;
        let neededSentencesCount = 0;
        let accTargetChars = 0;

        for (let i = this.currentSentenceIndex; i < this.sentences.length; i++) {
            const len = (this.sentences[i] || '').length;
            totalRemainingChars += len;
            if (accTargetChars < limitChars) {
                accTargetChars += len;
                neededSentencesCount++;
            }
            const buf = this.audioBuffers[i];
            if (!buf || (!buf.startsWith('data:') && buf !== 'ERROR')) {
                allRemainingLoaded = false;
            }
        }

        const targetChars = Math.min(limitChars, totalRemainingChars);

        // Считаем суммарную длину непрерывно загруженных предложений начиная с currentSentenceIndex
        let loadedChars = 0;
        for (let i = this.currentSentenceIndex; i < this.sentences.length; i++) {
            const buf = this.audioBuffers[i];
            if (buf && (buf.startsWith('data:') || buf === 'ERROR')) {
                loadedChars += (this.sentences[i] || '').length;
            } else {
                break;
            }
        }

        const firstReady = !!(this.audioBuffers[this.currentSentenceIndex] && this.audioBuffers[this.currentSentenceIndex].startsWith('data:'));
        const isReady = firstReady && (
            this._forceBypassBuffer ||
            this._initialBufferCompleted ||
            targetChars <= 0 ||
            loadedChars >= targetChars ||
            allRemainingLoaded
        );

        return {
            loadedChars,
            targetChars,
            allLoaded: allRemainingLoaded,
            isReady,
            neededSentencesCount: Math.max(1, neededSentencesCount)
        };
    }

    preparePlayback() {
        if (this._endedTimer) {
            clearTimeout(this._endedTimer);
            this._endedTimer = null;
        }
        this._endingTransition = false;
        this.audioElement.pause();
        this.audioElement.removeAttribute('src');
        this._playingSentenceIndex = -1;
        this.isPrefetching = false;
        const limitChars = Math.max(0, parseInt(this.settings.startBufferChars ?? 300, 10) || 0);
        this.isPrebuffering = limitChars > 0;
        this._prebufferCompleted = false;
        this._initialBufferCompleted = false;
        this._forceBypassBuffer = false;
        this._liveStreamBytesByIndex = {};
        this._liveStreamSeconds = 0;
        this._failedSentenceIndices = new Set();
        this.currentQueueId = null;
        this.currentlyLoading.clear();
        this.currentText = "";
        this.sentences = [];
        this.audioBuffers = [];
        this.audioDurations = [];
        this.currentSentenceIndex = 0;
        this.isPlaying = true;
        this.isPaused = false;
        this.notifyState();
        this.broadcastState('play', {
            isPrebuffering: this.isPrebuffering,
            bufferedChars: 0,
            targetBufferChars: limitChars
        });
        if (this.onProgress) {
            this.onProgress(4, 0);
        }
        if (window.__TAURI__) {
            window.__TAURI__.event.emit('tts-state-sync', {
                action: 'progress',
                percentBuffered: 4,
                percentPlayed: 0,
                isPrebuffering: this.isPrebuffering,
                bufferedChars: 0,
                targetBufferChars: limitChars
            });
        }
    }

    loadText(text, autoPlay = false) {
        // Сохраняем уже загруженные в память аудио-буферы от предыдущего состояния на случай повторного запуска
        const prevBuffersBySentence = new Map();
        if (Array.isArray(this.sentences) && Array.isArray(this.audioBuffers)) {
            for (let idx = 0; idx < this.sentences.length; idx++) {
                const s = this.sentences[idx];
                const b = this.audioBuffers[idx];
                if (s && b && typeof b === 'string' && b.startsWith('data:')) {
                    prevBuffersBySentence.set(s.trim(), b);
                }
            }
        }

        if (this._endedTimer) {
            clearTimeout(this._endedTimer);
            this._endedTimer = null;
        }
        this._endingTransition = false;
        if (autoPlay) {
            this.audioElement.pause();
            this.audioElement.removeAttribute('src');
            this.currentlyLoading.clear();
        } else {
            this.stop(); // Остановка старого воспроизведения при ручной загрузке нового текста
        }
        this._playingSentenceIndex = -1;
        this.isPrefetching = false; // Останавливаем старую очередь загрузки
        this._activeWorkers = 0;
        this.currentQueueId = null;
        this.currentText = this.cleanText(text);
        this.sentences = this.splitIntoSentences(this.currentText);
        this.log(`loadText() called, sentences count: ${this.sentences.length}, autoPlay=${autoPlay}`);

        const cacheVoiceKey = this.getCacheVoiceKey();
        this.audioBuffers = this.sentences.map(s => {
            const trimmed = s.trim();
            return prevBuffersBySentence.get(trimmed) || this.cache.getSync(cacheVoiceKey, trimmed) || null;
        });
        this.audioDurations = new Array(this.sentences.length).fill(0);
        this._retryCountByIndex = {};
        this._failedSentenceIndices = new Set();
        this._liveStreamBytesByIndex = {};
        this._liveStreamSeconds = 0;
        this.currentSentenceIndex = 0;
        this.isPlaying = autoPlay;
        this.isPaused = false;
        this._initialBufferCompleted = false;
        this._forceBypassBuffer = false;
        const bufStatus = this.getStartBufferStatus();
        this.isPrebuffering = autoPlay && this.sentences.length > 0 && !bufStatus.isReady;
        this._prebufferCompleted = !this.isPrebuffering;
        this.notifyState();
        this.updateProgress();
        
        if (this.sentences.length > 0) {
            if (autoPlay) {
                this.playCurrentSentence();
            }
            // Мгновенно запускаем очередь предзагрузки и параллельно поднимаем закэшированные предложения из базы IndexedDB
            this.startPrefetchQueue();
            this.loadCachedSentences(0);
        }
    }

    appendText(text) {
        if (!text || !text.trim()) return;
        const cleaned = this.cleanText(text);
        const oldLength = this.sentences.length;
        this.currentText += '\n\n' + cleaned;
        
        const newSentences = this.splitIntoSentences(cleaned);
        if (newSentences.length === 0) return;
        
        const cacheVoiceKey = this.getCacheVoiceKey();
        this.sentences.push(...newSentences);
        this.audioBuffers.push(...newSentences.map(s => this.cache.getSync(cacheVoiceKey, s) || null));
        this.audioDurations.push(...new Array(newSentences.length).fill(0));
        
        this.updateProgress();
        
        this.loadCachedSentences(oldLength).finally(() => {
            this.startPrefetchQueue();
        });
    }

    async fetchSentence(i, queueId, currentBuffersRef) {
        this.currentlyLoading.add(i);

        try {
            const isLocal = this.settings.tts_engine === 'local';
            const voiceKey = isLocal 
                ? (this.settings.tts_local_voice || 'ru_RU-dmitri-medium.onnx')
                : (this.settings.voice || 'ru-RU-SvetlanaNeural');
            const cacheVoiceKey = this.getCacheVoiceKey();
            
            // 1. Проверяем синхронный RAM-кэш и 3-дневную базу IndexedDB (мгновенно, без сетевых запросов)
            const cachedAudio = this.cache.getSync(cacheVoiceKey, this.sentences[i]) || await this.cache.get(cacheVoiceKey, this.sentences[i]);
            if (cachedAudio) {
                if (this.audioBuffers === currentBuffersRef) {
                    this.log(`Cache HIT for sentence ${i}`);
                    this.audioBuffers[i] = cachedAudio;
                    this.updateProgress();
                    if (this.isPlaying && this._playingSentenceIndex !== this.currentSentenceIndex && i >= this.currentSentenceIndex) {
                        this.log(`cache -> triggering playCurrentSentence() after index ${i}`);
                        this.playCurrentSentence();
                    }
                }
                return;
            }

            // 2. Пауза 250 мс между сетевыми запросами выдерживается нативно в Rust (speak_edge_tts через tokio::time::sleep),
            // что защищает очередь от троттлинга JS-таймеров WebView2 в свёрнутом состоянии и исключает параллельный спам.
            if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) {
                return;
            }

            if (window.__TAURI__) {
                const maxAttempts = 2;
                let lastErr = null;

                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef || i < this.currentSentenceIndex) {
                        return;
                    }

                    const distance = i - this.currentSentenceIndex;
                    this.log(`Fetching sentence ${i} sequentially from network (len=${this.sentences[i].length}, distance=${distance}, attempt=${attempt}/${maxAttempts})`);
                    if (this._liveStreamBytesByIndex) {
                        this._liveStreamBytesByIndex[i] = 0;
                    }
                    const streamId = `${this.instanceId}_${queueId}_${i}`;
                    
                    try {
                        const base64Audio = await window.__TAURI__.core.invoke('speak_edge_tts', {
                            text: this.sentences[i],
                            voice: voiceKey,
                            rate: 1.0,
                            streamId,
                            sentenceIndex: i
                        });
                        this.lastNetworkRequestTime = Date.now();
                        
                        if (this.audioBuffers === currentBuffersRef) {
                            const mime = base64Audio.startsWith('UklGR') ? 'audio/wav' : 'audio/mp3';
                            const dataUrl = `data:${mime};base64,${base64Audio}`;
                            this.audioBuffers[i] = dataUrl;
                            if (this._failedSentenceIndices) {
                                this._failedSentenceIndices.delete(i);
                            }
                            if (this._liveStreamBytesByIndex) {
                                delete this._liveStreamBytesByIndex[i];
                            }
                            this._liveStreamSeconds = 0;
                            // Сохраняем в RAM и 3-дневную базу IndexedDB
                            this.cache.set(cacheVoiceKey, this.sentences[i], dataUrl).catch(() => {});
                            this.updateProgress();
                            
                            // Проверяем готовность к старту или возобновлению после накопления буфера
                            if (this.isPlaying && this._playingSentenceIndex !== this.currentSentenceIndex && i >= this.currentSentenceIndex) {
                                this.log(`prefetch -> checking playCurrentSentence() after index ${i}`);
                                this.playCurrentSentence();
                            }
                        }
                        return; // Успешно загружено — выходим из цикла попыток
                    } catch (err) {
                        this.lastNetworkRequestTime = Date.now();
                        lastErr = err;
                        this.log(`Attempt ${attempt}/${maxAttempts} failed for sentence ${i}: ${err}`);
                        if (attempt < maxAttempts && i >= this.currentSentenceIndex) {
                            await new Promise(r => setTimeout(r, 400 * attempt));
                        }
                    }
                }

                // Все попытки исчерпаны
                throw lastErr || new Error("Не удалось синтезировать предложение после нескольких попыток");
            }
        } catch (err) {
            if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef || i < this.currentSentenceIndex) {
                return;
            }
            this.log(`Prefetch error at index ${i} after all retries: ${err}`);
            if (this.audioBuffers === currentBuffersRef) {
                if (!this._retryCountByIndex) this._retryCountByIndex = {};
                this._retryCountByIndex[i] = (this._retryCountByIndex[i] || 0) + 1;
                // Если это фоновая предзагрузка, делаем не более 1 мягкого повторного цикла с паузой 650 мс,
                // чтобы не создавать шторм десятков TLS-рукопожатий подряд при кратковременной сетевой просадке.
                if (i > this.currentSentenceIndex && this._retryCountByIndex[i] <= 1) {
                    this.audioBuffers[i] = null;
                    await new Promise(r => setTimeout(r, 650));
                    return;
                }
                if (window.showToast) window.showToast("Ошибка TTS: " + err, true);
                this.audioBuffers[i] = "ERROR";
                if (!this._failedSentenceIndices) this._failedSentenceIndices = new Set();
                this._failedSentenceIndices.add(i);
                this.updateProgress();
                
                if (this.isPlaying && this.currentSentenceIndex === i) {
                    this.currentSentenceIndex++;
                    this._playingSentenceIndex = -1;
                    this.playCurrentSentence();
                } else if (this.isPlaying && this._playingSentenceIndex !== this.currentSentenceIndex) {
                    this.playCurrentSentence();
                }
            }
        } finally {
            if (this.currentQueueId === queueId) {
                this.currentlyLoading.delete(i);
            }
        }
    }

    async startPrefetchQueue() {
        // Строго 1 последовательный воркер (CONCURRENCY = 1): предложения качаются строго по порядку (0 -> 1 -> 2 -> 3...)
        // без перепрыгивания через загружаемое предложение и без образования «дырок» (разрывов) на шкале буфера!
        const CONCURRENCY = 1;
        const baseWindowSize = 8; // минимум 8 предложений наперёд

        if (!this.currentQueueId) {
            this.currentQueueId = Date.now() + Math.random();
            this._activeWorkers = 0;
        }
        const queueId = this.currentQueueId;
        const currentBuffersRef = this.audioBuffers;

        const getEffectiveWindowEnd = () => {
            const startIndex = this.currentSentenceIndex;
            const { neededSentencesCount } = this.getStartBufferStatus();
            const dynamicWindow = Math.max(baseWindowSize, (neededSentencesCount || 0) + 3);
            return Math.min(startIndex + dynamicWindow, this.sentences.length);
        };

        const hasUnloadedInWindow = () => {
            const startIndex = this.currentSentenceIndex;
            const endIndex = getEffectiveWindowEnd();
            for (let i = startIndex; i < endIndex; i++) {
                if (!this.audioBuffers[i] && !this.currentlyLoading.has(i)) {
                    return true;
                }
            }
            return false;
        };

        if ((this._activeWorkers || 0) >= CONCURRENCY || !hasUnloadedInWindow()) {
            return;
        }

        const runWorker = async () => {
            this._activeWorkers = (this._activeWorkers || 0) + 1;
            this.isPrefetching = true;
            try {
                while (true) {
                    if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) {
                        return;
                    }

                    const startIndex = this.currentSentenceIndex;
                    const endIndex = getEffectiveWindowEnd();

                    let targetIndex = -1;
                    for (let i = startIndex; i < endIndex; i++) {
                        if (!this.audioBuffers[i] && !this.currentlyLoading.has(i)) {
                            targetIndex = i;
                            break;
                        }
                    }

                    if (targetIndex === -1) {
                        return;
                    }

                    this.currentlyLoading.add(targetIndex);
                    await this.fetchSentence(targetIndex, queueId, currentBuffersRef);
                }
            } catch (err) {
                this.log('Error in prefetch worker: ' + err);
            } finally {
                if (this.currentQueueId === queueId) {
                    this._activeWorkers = Math.max(0, (this._activeWorkers || 1) - 1);
                    this.isPrefetching = this._activeWorkers > 0;
                    if (this.audioBuffers === currentBuffersRef && hasUnloadedInWindow() && this._activeWorkers < CONCURRENCY) {
                        this.startPrefetchQueue();
                    }
                }
            }
        };

        while ((this._activeWorkers || 0) < CONCURRENCY && hasUnloadedInWindow()) {
            runWorker();
        }
    }

    seek(index) {
        if (index >= 0 && index < this.sentences.length) {
            this.log(`seek() called to index ${index}`);
            if (this._endedTimer) {
                clearTimeout(this._endedTimer);
                this._endedTimer = null;
            }
            this._endingTransition = false;
            this.currentSentenceIndex = index;
            this._playingSentenceIndex = -1;
            this._initialBufferCompleted = false;
            this._forceBypassBuffer = false;
            this.isPrebuffering = false;
            this._rebufferTargetIndex = -1;
            if (this._failedSentenceIndices) {
                this._failedSentenceIndices.delete(index);
            }
            if (this.audioBuffers[index] === "ERROR") {
                this.audioBuffers[index] = null;
            }
            
            // Принудительно сбрасываем предыдущий префетч при seek
            this.isPrefetching = false;
            this._activeWorkers = 0;
            this.currentQueueId = null;
            this.currentlyLoading.clear();
            
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

    forcePlay(shouldBroadcast = true) {
        this.log('forcePlay() called — bypassing start buffer wait');
        if (this.sentences.length === 0) {
            return;
        }
        this._forceBypassBuffer = true;
        this._initialBufferCompleted = true;
        this.isPlaying = true;
        this.isPaused = false;
        this.isPrebuffering = false;
        this._rebufferTargetIndex = -1;
        this.notifyState();
        if (shouldBroadcast) {
            this.broadcastState('play', { isPrebuffering: false });
        }
        this.playCurrentSentence();
    }

    async play(shouldBroadcast = true) {
        this.log('play() called, sentences=' + this.sentences.length + ', isPlaying=' + this.isPlaying + ', isPrebuffering=' + this.isPrebuffering);
        if (this.sentences.length === 0) {
            this.stop(shouldBroadcast); 
            return;
        }

        // Если уже находимся в состоянии накопления стартового буфера (кнопка Play мигает) и пользователь нажал Play вручную —
        // принудительно запускаем озвучку сразу, не дожидаясь полного буфера!
        if (this.isPlaying && this.isPrebuffering) {
            this.forcePlay(shouldBroadcast);
            return;
        }
        
        this.isPlaying = true;
        this.isPaused = false;
        this._rebufferTargetIndex = -1;

        const hasSrc = this.audioElement.hasAttribute('src');
        const ended = this.audioElement.ended;
        const paused = this.audioElement.paused;
        this.log('play() state: hasSrc=' + hasSrc + ' ended=' + ended + ' paused=' + paused);

        if (hasSrc && !ended && paused && this._playingSentenceIndex === this.currentSentenceIndex) {
            this.isPrebuffering = false;
            this._initialBufferCompleted = true;
            this.notifyState();
            if (window.__TAURI__) {
                window.__TAURI__.event.emit('tts-playing-started');
            }
            if (shouldBroadcast) {
                this.broadcastState('play', { isPrebuffering: false });
            }
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
            const bufStatus = this.getStartBufferStatus();
            this.isPrebuffering = !bufStatus.isReady;
            this.notifyState();
            if (window.__TAURI__) {
                window.__TAURI__.event.emit('tts-playing-started');
            }
            if (shouldBroadcast) {
                this.broadcastState('play', {
                    isPrebuffering: this.isPrebuffering,
                    bufferedChars: bufStatus.loadedChars,
                    targetBufferChars: bufStatus.targetChars
                });
            }
            this.log('play() -> playCurrentSentence()');
            this.playCurrentSentence();
        }
    }

    pause(shouldBroadcast = true) {
        if (this._endedTimer) {
            clearTimeout(this._endedTimer);
            this._endedTimer = null;
        }
        this._endingTransition = false;
        this.isPlaying = false;
        this.isPaused = true;
        this.isPrebuffering = false;
        this.audioElement.pause();
        this.notifyState();
        if (shouldBroadcast) {
            this.broadcastState('pause');
        }
    }

    stop(shouldBroadcast = true) {
        if (this._endedTimer) {
            clearTimeout(this._endedTimer);
            this._endedTimer = null;
        }
        this._endingTransition = false;
        this.isPlaying = false;
        this.isPaused = false;
        this.isPrebuffering = false;
        this._initialBufferCompleted = false;
        this._forceBypassBuffer = false;
        this._rebufferTargetIndex = -1;
        this._prebufferCompleted = true;
        this._playingSentenceIndex = -1;
        this.isPrefetching = false;
        this._activeWorkers = 0;
        this.currentQueueId = null;
        this.audioElement.pause();
        this.audioElement.removeAttribute('src'); // Правильное удаление ресурса
        this.currentSentenceIndex = 0; // Сброс позиции к началу, но сохраняем уже скачанные audioBuffers в памяти!
        this.currentlyLoading.clear();
        if (this._failedSentenceIndices) {
            this._failedSentenceIndices.clear();
        }
        this.notifyState();
        if (this.sentences.length > 0) {
            this.updateProgress();
        } else if (this.onProgress) {
            this.onProgress(0, 0);
        }
        if (this.onSentenceActive) this.onSentenceActive(-1);
        if (shouldBroadcast) {
            this.broadcastState('stop');
        }
    }

    async playCurrentSentence() {
        this.log('playCurrentSentence() index=' + this.currentSentenceIndex + ' isPlaying=' + this.isPlaying);
        if (!this.isPlaying) return;
        if (this._endingTransition) {
            this.log('playCurrentSentence() skipped during 85ms ended transition');
            return;
        }
        
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
            // Если предложение уже упало в текущей сессии после всех попыток — переходим дальше,
            // не застревая в повторном цикле перезагрузки при нескольких упавших фразах подряд
            if (this._failedSentenceIndices && this._failedSentenceIndices.has(this.currentSentenceIndex)) {
                this._failedSentenceIndices.delete(this.currentSentenceIndex);
                this.currentSentenceIndex++;
                this._playingSentenceIndex = -1;
                this.playCurrentSentence();
                return;
            } else {
                this.audioBuffers[this.currentSentenceIndex] = null;
                this.startPrefetchQueue();
                return;
            }
        }

        // Если мы догнали загрузку в середине текста и следующего предложения ещё нет в памяти,
        // для быстрых движков (Edge TTS) включаем повторное накопление буфера, а для Gemini Live ждём только текущее предложение
        if (!currentBuf || !currentBuf.startsWith("data:")) {
            if (!this._forceBypassBuffer && !this.isGeminiEngine()) {
                this._initialBufferCompleted = false;
            }
        }

        const bufStatus = this.getStartBufferStatus();
        if (!bufStatus.isReady) {
            const wasPrebuffering = this.isPrebuffering;
            this.isPrebuffering = true;
            this.notifyState();
            if (!wasPrebuffering) {
                this.broadcastState('prebuffering', {
                    isPrebuffering: true,
                    bufferedChars: bufStatus.loadedChars,
                    targetBufferChars: bufStatus.targetChars
                });
            }
            this.log(`playCurrentSentence() - waiting for start buffer (${bufStatus.loadedChars}/${bufStatus.targetChars} chars, allLoaded=${bufStatus.allLoaded})`);
            this.startPrefetchQueue();
            this.updateProgress();
            return;
        }

        if (currentBuf && currentBuf.startsWith("data:")) {
            const wasPrebuffering = this.isPrebuffering;
            this.isPrebuffering = false;
            this._initialBufferCompleted = true;
            this._forceBypassBuffer = false;
            this._rebufferTargetIndex = -1;
            this.notifyState();
            if (wasPrebuffering) {
                this.broadcastState('play', { isPrebuffering: false });
            }

            // Защита от повторного перезапуска уже играющего или только что доигравшего предложения
            if (this._playingSentenceIndex === this.currentSentenceIndex && this.audioElement.hasAttribute('src')) {
                if (this.audioElement.paused && !this.audioElement.ended) {
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
            // Убеждаемся, что пока играет текущее предложение, фоновая очередь подгружает окно вперёд
            this.startPrefetchQueue();
        } else {
            this.log('playCurrentSentence() - buffer not ready, ensuring prefetch queue is active and waiting...');
            this.startPrefetchQueue();
        }
        this.updateProgress();
    }

    setupAudioEvents() {
        this.audioElement.addEventListener('ended', () => {
            if (!this.isPlaying) return;
            // Защита от ложного/повторного срабатывания ended от предыдущего предложения,
            // которое могло бы перескочить через текущее предложение (currentSentenceIndex++)
            if (this._playingSentenceIndex !== this.currentSentenceIndex) {
                this.log(`Ignoring stale ended event (playing=${this._playingSentenceIndex}, current=${this.currentSentenceIndex})`);
                return;
            }
            const finishedIdx = this.currentSentenceIndex;
            this.log('audioElement ended event for index ' + finishedIdx);
            this._endingTransition = true;
            if (this._endedTimer) {
                clearTimeout(this._endedTimer);
            }
            // Даём 85 мс на полное опустошение буфера WebAudio компрессора и ресемплера (особенно на скорости 1.5x–2.0x),
            // чтобы гарантированно не проглатывалось последнее слово перед сменой src
            this._endedTimer = setTimeout(() => {
                this._endedTimer = null;
                this._endingTransition = false;
                if (!this.isPlaying || this._playingSentenceIndex !== finishedIdx || this.currentSentenceIndex !== finishedIdx) {
                    return;
                }
                this._playingSentenceIndex = -1;
                this.audioElement.removeAttribute('src');
                this.currentSentenceIndex++;
                this.playCurrentSentence();
                this.startPrefetchQueue(); // Сдвигаем окно буферизации и догружаем следующее предложение
            }, 85);
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
                    if (!this.isPlaying) {
                        this.play(false);
                    } else if (this.isPrebuffering && p.isPrebuffering === false) {
                        this.forcePlay(false);
                    }
                } else if (p.action === 'force_play') {
                    this.forcePlay(false);
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
                    const prevCacheKey = this.getCacheVoiceKey();
                    const src = p.settings || p;
                    if (p.settings) {
                        this.settings = { ...this.settings, ...p.settings };
                    } else {
                        if (p.speed !== undefined) this.settings.speed = p.speed;
                        if (p.volume !== undefined) this.settings.volume = Math.max(0, Math.min(2.0, parseFloat(p.volume)));
                        if (p.voice !== undefined) this.settings.voice = p.voice;
                        if (p.translate !== undefined) this.settings.translate = p.translate;
                        if (p.expressive !== undefined) this.settings.expressive = !!p.expressive;
                        if (p.startBufferChars !== undefined) {
                            const parsedBuf = parseInt(p.startBufferChars, 10);
                            this.settings.startBufferChars = isNaN(parsedBuf) ? 300 : Math.max(0, Math.min(5000, parsedBuf));
                        }
                        if (p.tts_engine !== undefined) this.settings.tts_engine = p.tts_engine;
                        if (p.tts_local_voice !== undefined) this.settings.tts_local_voice = p.tts_local_voice;
                        if (p.tts_gemini_model !== undefined) this.settings.tts_gemini_model = p.tts_gemini_model;
                        if (p.tts_gemini_thinking !== undefined) this.settings.tts_gemini_thinking = p.tts_gemini_thinking;
                        if (p.installedVoices !== undefined) this.settings.installedVoices = p.installedVoices;
                    }
                    if (src.tts_engine !== undefined) {
                        const ttsEngEl = document.getElementById('setting-tts-engine');
                        if (ttsEngEl) ttsEngEl.value = src.tts_engine;
                    }
                    if (src.startBufferChars !== undefined) {
                        const parsedBuf = parseInt(src.startBufferChars, 10);
                        this.settings.startBufferChars = isNaN(parsedBuf) ? 300 : Math.max(0, Math.min(5000, parsedBuf));
                        if (this.isPlaying && this.isPrebuffering) {
                            this.startPrefetchQueue();
                            this.playCurrentSentence();
                        }
                    }
                    if (src.speed !== undefined) {
                        this.audioElement.playbackRate = this.settings.speed;
                    }
                    if (src.volume !== undefined) {
                        this.applyEffectiveVolume(src.volume);
                    }
                    const nextCacheKey = this.getCacheVoiceKey();
                    if (nextCacheKey !== prevCacheKey && this.sentences.length > 0) {
                        if (this._endedTimer) {
                            clearTimeout(this._endedTimer);
                            this._endedTimer = null;
                        }
                        this._endingTransition = false;
                        if (this._failedSentenceIndices) {
                            this._failedSentenceIndices.clear();
                        }
                        this.audioBuffers = this.sentences.map(s => this.cache.getSync(nextCacheKey, s) || null);
                        this.currentlyLoading.clear();
                        this.isPrefetching = false;
                        this.currentQueueId = null;
                        this._playingSentenceIndex = -1;
                        this._initialBufferCompleted = false;
                        this._forceBypassBuffer = false;
                        const bufStatus = this.getStartBufferStatus();
                        this.isPrebuffering = this.isPlaying && !bufStatus.isReady;
                        this._prebufferCompleted = !this.isPrebuffering;
                        if (this.isPlaying) {
                            this.playCurrentSentence();
                        }
                        this.startPrefetchQueue();
                        this.loadCachedSentences(0);
                    }
                    localStorage.setItem('tts-settings', JSON.stringify(this.settings));
                    if (window.__TAURI__) {
                        const { invoke } = window.__TAURI__.core;
                        invoke('update_config_fields', { fields: {
                            tts_voice: this.settings.voice,
                            tts_speed: this.settings.speed,
                            tts_volume: this.settings.volume,
                            tts_translate: this.settings.translate,
                            tts_expressive_intonation: this.settings.expressive,
                            tts_start_buffer_chars: this.settings.startBufferChars,
                            tts_engine: this.settings.tts_engine,
                            tts_local_voice: this.settings.tts_local_voice,
                            tts_gemini_model: this.settings.tts_gemini_model,
                            tts_gemini_thinking: this.settings.tts_gemini_thinking
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

        window.__TAURI__.event.listen('gemini-live-audio-chunk', (event) => {
            const p = event.payload;
            if (!p || !p.streamId || !String(p.streamId).startsWith(`${this.instanceId}_${this.currentQueueId}_`)) return;
            const sIdx = typeof p.sentenceIndex === 'number' ? p.sentenceIndex : -1;
            if (sIdx < 0 || sIdx >= this.sentences.length) return;
            if (!this._liveStreamBytesByIndex) this._liveStreamBytesByIndex = {};
            if (p.isFirstChunk) {
                this._liveStreamBytesByIndex[sIdx] = 0;
            }
            const chunkBytes = p.pcmBase64 ? Math.floor((p.pcmBase64.length * 3) / 4) : 0;
            this._liveStreamBytesByIndex[sIdx] = (this._liveStreamBytesByIndex[sIdx] || 0) + chunkBytes;
            if (sIdx === this.currentSentenceIndex) {
                // 24 кГц 16-бит моно = 48000 байт/сек
                this._liveStreamSeconds = this._liveStreamBytesByIndex[sIdx] / 48000;
            }
            this.updateProgress();
        });
    }

    notifyState() {
        if (this.onStateChange) {
            const bufStatus = this.getStartBufferStatus();
            this.onStateChange(this.isPlaying, this.isPaused, this.isPrebuffering, bufStatus.loadedChars, bufStatus.targetChars);
        }
    }

    broadcastState(action, extra = {}) {
        if (!window.__TAURI__) return;
        window.__TAURI__.event.emit('tts-state-sync', { action, sender: this.instanceId, ...extra });
    }

    updateProgress() {
        if (this.sentences.length === 0) return;
        
        let totalChars = 0;
        let bufferedChars = 0;
        let playedCharsBeforeCurrent = 0;

        for (let i = 0; i < this.sentences.length; i++) {
            const sLen = (this.sentences[i] || '').length;
            totalChars += sLen;
            if (this.audioBuffers[i] && this.audioBuffers[i] !== "ERROR") {
                bufferedChars += sLen;
            } else if (this._liveStreamBytesByIndex && this._liveStreamBytesByIndex[i] > 0) {
                // Плавное отображение live-потока Gemini (примерно 3600 байт PCM на 1 символ текста)
                const estFraction = Math.min(0.95, this._liveStreamBytesByIndex[i] / Math.max(18000, sLen * 3600));
                bufferedChars += sLen * estFraction;
            }
            if (i < this.currentSentenceIndex) {
                playedCharsBeforeCurrent += sLen;
            }
        }

        if (totalChars === 0) return;

        const percentBuffered = Math.min(100, (bufferedChars / totalChars) * 100);
        
        let currentSentenceChars = this.sentences[this.currentSentenceIndex] ? this.sentences[this.currentSentenceIndex].length : 0;
        let currentAudioProgress = 0;
        
        if (this.audioElement.duration && !isNaN(this.audioElement.duration)) {
            currentAudioProgress = this.audioElement.currentTime / this.audioElement.duration;
        }

        const playedChars = playedCharsBeforeCurrent + (currentSentenceChars * currentAudioProgress);
        const percentPlayed = Math.min(100, (playedChars / totalChars) * 100);
        const bufStatus = this.getStartBufferStatus();

        if (this.onProgress) {
            this.onProgress(percentBuffered, percentPlayed, this.isPrebuffering, bufStatus.loadedChars, bufStatus.targetChars);
        }

        if (window.__TAURI__) {
            const now = Date.now();
            const playedDiff = Math.abs(percentPlayed - this._lastBroadcastPlayedPct);
            const bufDiff = Math.abs(percentBuffered - this._lastBroadcastBufferedPct);
            const prebufChanged = this.isPrebuffering !== this._lastBroadcastPrebuffering;
            const isBoundary = percentPlayed <= 0.1 || percentPlayed >= 99.5 || percentBuffered >= 99.9;
            // При изменении буфера (скачано новое предложение) или смене режима буферизации отправляем мгновенно (0 мс)
            if (isBoundary || prebufChanged || bufDiff >= 0.1 || (now - this._lastProgressBroadcastTime >= 150 && playedDiff >= 0.4)) {
                this._lastProgressBroadcastTime = now;
                this._lastBroadcastPlayedPct = percentPlayed;
                this._lastBroadcastBufferedPct = percentBuffered;
                this._lastBroadcastPrebuffering = this.isPrebuffering;
                window.__TAURI__.event.emit('tts-state-sync', {
                    action: 'progress',
                    percentBuffered,
                    percentPlayed,
                    isPrebuffering: this.isPrebuffering,
                    bufferedChars: bufStatus.loadedChars,
                    targetBufferChars: bufStatus.targetChars
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
