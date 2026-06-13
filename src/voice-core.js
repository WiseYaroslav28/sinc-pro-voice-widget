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
        const savedSettings = JSON.parse(localStorage.getItem('tts-settings') || '{}');
        this.settings = {
            voice: savedSettings.voice || 'ru-RU-SvetlanaNeural',
            speed: savedSettings.speed || 1.0,
            translate: savedSettings.translate || false
        };

        this.audioElement = new Audio();
        this.audioElement.playbackRate = this.settings.speed;
        
        // Слушатели событий
        this.onProgress = null;       // (percentBuffered, percentPlayed)
        this.onSentenceActive = null; // (index)
        this.onStateChange = null;    // (isPlaying, isPaused)
        this.onSettingsSync = null;   // (settingsObj)

        this.setupAudioEvents();
        this.setupTauriSync();
        
        setTimeout(() => {
            this.broadcastState('settings', this.settings);
        }, 500);
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
        let rawSentences = processed.split(/(?<=[.!?])\s+(?=\p{Lu})|\n+/u);
        
        let sentences = [];
        for (let s of rawSentences) {
            s = s.replace(/<DOT>/g, ".");
            s = s.replace(/<ELLIPSIS>/g, "...");
            const trimmed = s.trim();
            // Предложение должно содержать хотя бы одну букву или цифру для озвучки
            if (trimmed.length > 0 && /[\p{L}\p{N}]/u.test(trimmed)) {
                sentences.push(trimmed);
            }
        }
        return sentences;
    }

    async loadCachedSentences(startIndex = 0) {
        const currentBuffersRef = this.audioBuffers;
        const voiceKey = this.settings.voice || 'ru-RU-SvetlanaNeural';
        
        // Создаем массив промисов для проверки кэша для всех предложений, начиная с startIndex
        const promises = this.sentences.slice(startIndex).map(async (sentence, relativeIndex) => {
            const i = startIndex + relativeIndex;
            if (currentBuffersRef[i]) return;
            
            try {
                const cachedAudio = await this.cache.get(voiceKey, sentence);
                if (cachedAudio && this.audioBuffers === currentBuffersRef) {
                    this.log(`Instant Cache load for sentence ${i}`);
                    this.audioBuffers[i] = cachedAudio;
                }
            } catch (e) {
                this.log(`Failed to instantly check cache for sentence ${i}: ${e}`);
            }
        });

        await Promise.all(promises);
        
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

    loadText(text) {
        this.stop(); // Жесткая остановка старого воспроизведения при загрузке нового текста
        this.isPrefetching = false; // Останавливаем старую очередь загрузки
        this.currentText = this.cleanText(text);
        this.sentences = this.splitIntoSentences(this.currentText);
        this.log(`loadText() called, sentences count: ${this.sentences.length}`);
        this.audioBuffers = new Array(this.sentences.length).fill(null);
        this.audioDurations = new Array(this.sentences.length).fill(0);
        this.currentSentenceIndex = 0;
        this.isPlaying = false;
        this.isPaused = false;
        this.notifyState();
        
        if (this.sentences.length > 0) {
            // Мгновенная массовая загрузка кэшированных предложений из IndexedDB
            this.loadCachedSentences(0).then(() => {
                // После того как кэшированные подгрузились, запускаем префетч очередь для недостающих предложений
                this.startPrefetchQueue();
            });
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
        
        // Мгновенная массовая загрузка кэшированных предложений для новых индексов
        this.loadCachedSentences(oldLength).then(() => {
            // Перезапускаем очередь загрузки, если она остановилась
            if (!this.isPrefetching) {
                this.startPrefetchQueue();
            }
        });
    }

    async fetchSentence(i, queueId, currentBuffersRef) {
        this.currentlyLoading.add(i);

        try {
            const voiceKey = this.settings.voice || 'ru-RU-SvetlanaNeural';
            
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

            // 2. Выдерживаем задержку в 500 мс после предыдущего сетевого запроса к Edge TTS
            const timeSinceLastRequest = Date.now() - this.lastNetworkRequestTime;
            const minDelay = 500;
            if (timeSinceLastRequest < minDelay) {
                const waitTime = minDelay - timeSinceLastRequest;
                await new Promise(r => setTimeout(r, waitTime));
            }

            // Проверяем, не сменилась ли очередь за время ожидания
            if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) {
                return;
            }

            if (window.__TAURI__) {
                const distance = i - this.currentSentenceIndex;
                this.log(`Fetching sentence ${i} from network (distance=${distance})`);
                
                this.isNetworkFetching = true;
                try {
                    const base64Audio = await window.__TAURI__.core.invoke('speak_edge_tts', {
                        text: this.sentences[i],
                        voice: voiceKey,
                        rate: 1.0
                    });
                    
                    // Фиксируем время окончания сетевого запроса
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
                } finally {
                    this.isNetworkFetching = false;
                }
            }
        } catch (err) {
            this.log(`Prefetch error at index ${i}: ${err}`);
            if (window.showToast) window.showToast("Ошибка TTS: " + err, true);
            if (this.audioBuffers === currentBuffersRef) {
                this.audioBuffers[i] = "ERROR";
                
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
                const windowSize = 4; // current + 3 предложения наперед
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
                    // Но если какое-то предложение из текущего окна еще загружается в фоне,
                    // мы не должны выходить из цикла префетча совсем, иначе при завершении этой загрузки
                    // цикл не пойдет дальше. Мы просто подождем.
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

        // Если аудио уже скачано
        const bufferState = this.audioBuffers[this.currentSentenceIndex] ? (this.audioBuffers[this.currentSentenceIndex] === 'ERROR' ? 'ERROR' : 'READY') : 'NULL';
        this.log('playCurrentSentence() bufferState=' + bufferState);
        if (this.audioBuffers[this.currentSentenceIndex]) {
            const srcVal = this.audioBuffers[this.currentSentenceIndex];
            if (srcVal === "ERROR" || !srcVal.startsWith("data:")) {
                this.log('playCurrentSentence() - invalid buffer at index ' + this.currentSentenceIndex + ', skipping');
                this.currentSentenceIndex++;
                this.playCurrentSentence();
                return;
            }
            this.audioElement.src = srcVal;
            this.audioElement.playbackRate = this.settings.speed;
            this.log('playCurrentSentence() calling audioElement.play() for index ' + this.currentSentenceIndex);
            this.audioElement.play().catch(e => {
                this.log('Audio play FAILED: ' + e.name + ' ' + e.message);
                if (e.name === 'NotAllowedError') {
                    if (window.showToast) window.showToast("Кликните в любое место программы для разблокировки звука", true);
                    this.pause();
                }
            });
        } else {
            this.log('playCurrentSentence() - buffer not ready, waiting for prefetch...');
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
                    if (p.settings) {
                        this.settings = { ...this.settings, ...p.settings };
                    } else {
                        if (p.speed !== undefined) this.settings.speed = p.speed;
                        if (p.voice !== undefined) this.settings.voice = p.voice;
                        if (p.translate !== undefined) this.settings.translate = p.translate;
                    }
                    if (this.isPlaying && p.speed !== undefined) {
                        this.audioElement.playbackRate = this.settings.speed;
                    }
                    localStorage.setItem('tts-settings', JSON.stringify(this.settings));
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
        window.__TAURI__.event.emit('tts-state-sync', { action, ...extra });
    }

    updateProgress() {
        if (!this.onProgress || this.sentences.length === 0) return;
        
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

        this.onProgress(percentBuffered, percentPlayed);
    }
}

window.VoiceCore = VoiceCore;

// WindowToggleManager для чистого переиспользования логики и верстки 3-позиционных переключателей
class WindowToggleManager {
    static renderToggle(id, icon, title) {
        // Рендерим 3-позиционный слайдер на базе input range
        return `
            <div class="tri-switch-wrapper" id="${id}-wrapper" title="${title}" data-state="2">
                <span class="material-symbols-outlined tri-switch-icon">${icon}</span>
                <div class="tri-switch-container">
                    <input type="range" class="tri-slider" min="0" max="2" value="2" id="${id}">
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

        const savedMode = localStorage.getItem(`${targetWindowLabel}Mode`) || defaultVal;
        slider.value = savedMode;
        wrapper.setAttribute('data-state', savedMode);

        if (window.__TAURI__) {
            const { invoke } = window.__TAURI__.core;
            const { listen, emit } = window.__TAURI__.event;

            const modeNum = parseInt(savedMode, 10);
            // Синхронизируем начальный режим с Rust
            invoke('set_module_mode', { module: targetWindowLabel, mode: modeNum }).catch(()=>{});

            // Для виджета: если режим "Все включено" (2) при старте, показываем его
            if (targetWindowLabel === 'widget' && modeNum === 2) {
                invoke(showCommand).catch(() => {});
            }

            // 2. Обработчик изменения ползунка
            slider.addEventListener('input', async () => {
                const val = slider.value;
                wrapper.setAttribute('data-state', val);
                localStorage.setItem(`${targetWindowLabel}Mode`, val);

                const currentModeNum = parseInt(val, 10);

                try {
                    // Отправляем режим на бэкенд в Rust
                    await invoke('set_module_mode', { module: targetWindowLabel, mode: currentModeNum }).catch(()=>{});

                    if (currentModeNum === 2) {
                        // Только widget показывается сразу при включении режима 2 (Все включено)
                        if (targetWindowLabel === 'widget') {
                            await invoke(showCommand).catch(() => {});
                        }
                    } else {
                        // При режимах 1 (Только хоткеи) и 0 (Выключено) скрываем окна
                        await invoke(hideCommand).catch(() => {});
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
        }
    }
}

window.WindowToggleManager = WindowToggleManager;
