// voice-core.js
// Единое ядро логики Озвучки (TTS) и управления состоянием плеера
// Обеспечивает потоковое воспроизведение, расчет умного таймлайна и синхронизацию состояний.

class TtsCacheDB {
    constructor() {
        this.dbName = "SincProTtsCache";
        this.storeName = "audio_cache";
        this.db = null;
        this.initPromise = this.init();
    }

    init() {
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

    async cleanOldRecords() {
        await this.initPromise;
        if (!this.db) return;
        const limitTime = Date.now() - 48 * 3600 * 1000; // 48 часов назад
        return new Promise((resolve) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            const request = store.openCursor();
            let deletedCount = 0;
            request.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const record = cursor.value;
                    if (record.lastUsed < limitTime) {
                        cursor.delete();
                        deletedCount++;
                    }
                    cursor.continue();
                } else {
                    console.log(`[TtsCacheDB] Cleaned ${deletedCount} records older than 48 hours`);
                    resolve();
                }
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

    cleanText(text) {
        if (!text) return "";
        let cleaned = text.trim();
        // Санитаризация Markdown-разметки
        cleaned = this.removeMarkdown(cleaned);
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
        // Защищаем абзацы (двойные и более переносы)
        processed = processed.replace(/\n{2,}/g, "<ABZAC>");
        // Заменяем одиночные переносы строк на пробелы, только если после них идет строчная буква (Unicode)
        processed = processed.replace(/\n+(?=\s*\p{Ll})/gu, " ");
        // Возвращаем абзацы обратно
        processed = processed.replace(/<ABZAC>/g, "\n");

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
        
        // Разбиваем по концам предложений ИЛИ по символам переноса строки (абзацам \n)
        let rawSentences = processed.split(/(?<=[.!?])\s+(?=\p{Lu})|(?<=[:;])\s+|\n+/u);
        
        let sentences = [];
        const MAX_CHUNK_LEN = 260;
        for (let s of rawSentences) {
            s = s.replace(/<DOT>/g, ".");
            s = s.replace(/<ELLIPSIS>/g, "...");
            const trimmed = s.trim();
            // Предложение должно содержать хотя бы одну букву или цифру для озвучки
            if (trimmed.length > 0 && /[\p{L}\p{N}]/u.test(trimmed)) {
                if (trimmed.length <= MAX_CHUNK_LEN) {
                    sentences.push(trimmed);
                } else {
                    // Длинные предложения без точек (например, в больших статьях или списках) делим по запятым/тире/пробелам,
                    // чтобы первое предложение синтезировалось мгновенно без многосекундного ожидания
                    let remaining = trimmed;
                    while (remaining.length > MAX_CHUNK_LEN) {
                        let splitIdx = -1;
                        const slice = remaining.slice(0, MAX_CHUNK_LEN);
                        const punctMatch = Math.max(
                            slice.lastIndexOf(', '),
                            slice.lastIndexOf(' — '),
                            slice.lastIndexOf(' - '),
                            slice.lastIndexOf('. ')
                        );
                        if (punctMatch >= 80) {
                            splitIdx = punctMatch + 1;
                        } else {
                            const spaceIdx = slice.lastIndexOf(' ');
                            splitIdx = spaceIdx >= 80 ? spaceIdx : MAX_CHUNK_LEN;
                        }
                        const chunk = remaining.slice(0, splitIdx).trim();
                        if (chunk.length > 0 && /[\p{L}\p{N}]/u.test(chunk)) {
                            sentences.push(chunk);
                        }
                        remaining = remaining.slice(splitIdx).trim();
                    }
                    if (remaining.length > 0 && /[\p{L}\p{N}]/u.test(remaining)) {
                        sentences.push(remaining);
                    }
                }
            }
        }
        return sentences;
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
            // СРАЗУ запускаем префетч с 0-го предложения (без ожидания проверки всех N предложений в IndexedDB!)
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

            // 2. Выдерживаем небольшую паузу после предыдущего сетевого запроса
            const timeSinceLastRequest = Date.now() - this.lastNetworkRequestTime;
            const minDelay = 250;
            if (timeSinceLastRequest < minDelay) {
                const waitTime = minDelay - timeSinceLastRequest;
                await new Promise(r => setTimeout(r, waitTime));
            }

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
                    
                    this.isNetworkFetching = true;
                    try {
                        const base64Audio = await window.__TAURI__.core.invoke('speak_edge_tts', {
                            text: this.sentences[i],
                            voice: voiceKey,
                            rate: 1.0
                        });
                        
                        this.lastNetworkRequestTime = Date.now();
                        
                        if (this.audioBuffers === currentBuffersRef) {
                            const dataUrl = `data:audio/mp3;base64,${base64Audio}`;
                            this.audioBuffers[i] = dataUrl;
                            this.updateProgress();
                            
                            // Сохраняем в локальный кэш
                            await this.cache.set(voiceKey, this.sentences[i], dataUrl);
                            
                            if (this.isPlaying && this.currentSentenceIndex === i) {
                                this.log(`prefetch -> triggering playCurrentSentence() for index ${i}`);
                                this.playCurrentSentence();
                            }
                        }
                        return; // Успешно загружено — выходим из цикла попыток
                    } catch (err) {
                        lastErr = err;
                        this.log(`Attempt ${attempt}/${maxAttempts} failed for sentence ${i}: ${err}`);
                        if (attempt < maxAttempts) {
                            await new Promise(r => setTimeout(r, 600 * attempt));
                        }
                    } finally {
                        this.isNetworkFetching = false;
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
                    this.playCurrentSentence();
                }
            }
        } finally {
            this.currentlyLoading.delete(i);
        }
    }

    async startPrefetchQueue() {
        // Если префетч уже запущен, он сам адаптируется к смене currentSentenceIndex,
        // так как он динамически проверяет границы на каждом шаге цикла.
        if (this.isPrefetching) {
            this.log('Prefetch queue is already running, skipping restart');
            return;
        }

        const queueId = Date.now() + Math.random();
        this.currentQueueId = queueId;
        this.isPrefetching = true;

        // Дадим предыдущей очереди время на завершение
        await new Promise(r => setTimeout(r, 10));
        if (this.currentQueueId !== queueId) return;

        const currentBuffersRef = this.audioBuffers;
        this.log('Prefetch queue started with ID ' + queueId);

        try {
            while (true) {
                if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) {
                    this.log('Prefetch queue ' + queueId + ' superseded or text changed');
                    return;
                }

                // Если идет активный сетевой запрос, ждем его завершения
                if (this.isNetworkFetching) {
                    await new Promise(r => setTimeout(r, 100));
                    continue;
                }

                const startIndex = this.currentSentenceIndex;
                const windowSize = 5; // current + 4 предложения наперед
                const endIndex = Math.min(startIndex + windowSize, this.sentences.length);

                // Находим первое незагруженное предложение в текущем окне буферизации
                let targetIndex = -1;
                for (let i = startIndex; i < endIndex; i++) {
                    if (!this.audioBuffers[i] && !this.currentlyLoading.has(i)) {
                        targetIndex = i;
                        break;
                    }
                }

                // Если все предложения в текущем окне загружены или уже загружаются, цикл засыпает
                if (targetIndex === -1) {
                    let anyLoadingInWindow = false;
                    for (let i = startIndex; i < endIndex; i++) {
                        if (this.currentlyLoading.has(i)) {
                            anyLoadingInWindow = true;
                            break;
                        }
                    }
                    
                    if (anyLoadingInWindow) {
                        await new Promise(r => setTimeout(r, 100));
                        continue;
                    }

                    this.log('Prefetch queue ' + queueId + ' has nothing to load, sleeping...');
                    break;
                }

                // Загружаем предложение targetIndex строго последовательно
                await this.fetchSentence(targetIndex, queueId, currentBuffersRef);
            }
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

        if (hasSrc && !ended && paused) {
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
