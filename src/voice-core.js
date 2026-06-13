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

    loadText(text) {
        this.stop(); // Жесткая остановка старого воспроизведения при загрузке нового текста
        this.isPrefetching = false; // Останавливаем старую очередь загрузки
        this.currentText = this.cleanText(text);
        this.sentences = this.splitIntoSentences(this.currentText);
        this.audioBuffers = new Array(this.sentences.length).fill(null);
        this.audioDurations = new Array(this.sentences.length).fill(0);
        this.currentSentenceIndex = 0;
        this.isPlaying = false;
        this.isPaused = false;
        this.notifyState();
        
        // Запускаем фоновую последовательную загрузку ВСЕХ предложений
        if (this.sentences.length > 0) {
            this.startPrefetchQueue();
        }
    }

    appendText(text) {
        if (!text || !text.trim()) return;
        const cleaned = this.cleanText(text);
        this.currentText += '\n\n' + cleaned;
        
        const newSentences = this.splitIntoSentences(cleaned);
        if (newSentences.length === 0) return;
        
        this.sentences.push(...newSentences);
        this.audioBuffers.push(...new Array(newSentences.length).fill(null));
        this.audioDurations.push(...new Array(newSentences.length).fill(0));
        
        this.updateProgress();
        
        // Перезапускаем очередь загрузки, если она остановилась
        if (!this.isPrefetching) {
            this.startPrefetchQueue();
        }
    }

    async startPrefetchQueue() {
        // Уникальный ID для каждой очереди загрузки
        const queueId = Date.now() + Math.random();
        this.currentQueueId = queueId;

        // Если очередь уже идет, она прервется, так как мы изменили currentQueueId
        // Дадим ей миллисекунду на завершение (чтобы не дублировать логику)
        await new Promise(r => setTimeout(r, 10));

        this.isPrefetching = true;
        const currentBuffersRef = this.audioBuffers;

        // Формируем закольцованный обход индексов, начиная с текущего предложения
        const startIndex = this.currentSentenceIndex;
        const indices = [];
        for (let idx = 0; idx < this.sentences.length; idx++) {
            indices.push((startIndex + idx) % this.sentences.length);
        }

        for (let k = 0; k < indices.length; k++) {
            const i = indices[k];
            if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) {
                return; // Очередь прервана
            }
            
            if (!this.audioBuffers[i]) {
                try {
                    // 1. Проверяем IndexedDB кэш
                    const voiceKey = this.settings.voice || 'ru-RU-SvetlanaNeural';
                    const cachedAudio = await this.cache.get(voiceKey, this.sentences[i]);
                    if (cachedAudio) {
                        if (this.audioBuffers === currentBuffersRef) {
                            console.log(`[VoiceCore] Cache HIT for sentence ${i}`);
                            this.audioBuffers[i] = cachedAudio;
                            this.updateProgress();
                            if (this.isPlaying && this.currentSentenceIndex === i && this.audioElement.paused) {
                                console.log('[VoiceCore] cache -> triggering playCurrentSentence()');
                                this.playCurrentSentence();
                            }
                        }
                        continue; // Идем к следующему
                    }

                    // 2. Рассчитываем динамическую адаптивную задержку для защиты от DDoS/блокировок
                    // Для текущего и следующего по ходу воспроизведения предложения загружаем мгновенно (delay = 0)
                    const distance = i - this.currentSentenceIndex;
                    let delay = 0;

                    if (distance > 1 || distance < 0) {
                        // Опережающие или уже прослушанные предложения загружаются с задержками
                        delay = 400; // Базовая задержка для фоновой буферизации
                        if (i > 0 && i % 2 === 0) {
                            delay += 600; // Дополнительная задержка для партий
                        }

                        if (!this.isPlaying || this.isPaused) {
                            if (distance >= 5) delay = 2000;
                            else if (distance >= 3) delay = 1000;
                        } else {
                            if (distance >= 5) delay = 1500;
                            else if (distance >= 3) delay = 800;
                        }
                    }

                    // 3. Выполняем адаптивное ожидание задержки (с шагом 50мс)
                    const startWait = Date.now();
                    while (Date.now() - startWait < delay) {
                        if (this.currentQueueId !== queueId || this.audioBuffers !== currentBuffersRef) return;
                        
                        const currentDistance = i - this.currentSentenceIndex;
                        let currentDelay = 0;
                        if (currentDistance > 1 || currentDistance < 0) {
                            currentDelay = 400;
                            if (i > 0 && i % 2 === 0) currentDelay += 600;

                            if (!this.isPlaying || this.isPaused) {
                                if (currentDistance >= 5) currentDelay = 2000;
                                else if (currentDistance >= 3) currentDelay = 1000;
                            } else {
                                if (currentDistance >= 5) currentDelay = 1500;
                                else if (currentDistance >= 3) currentDelay = 800;
                            }
                        }

                        if (Date.now() - startWait >= currentDelay) {
                            break;
                        }
                        await new Promise(r => setTimeout(r, 50));
                    }

                    if (window.__TAURI__) {
                        console.log(`[VoiceCore] Fetching sentence ${i} (delay=${delay}ms, distance=${distance})`);
                        const voiceKey = this.settings.voice || 'ru-RU-SvetlanaNeural';
                        const base64Audio = await window.__TAURI__.core.invoke('speak_edge_tts', {
                            text: this.sentences[i],
                            voice: voiceKey,
                            rate: 1.0
                        });
                        
                        if (this.audioBuffers === currentBuffersRef) {
                            const dataUrl = `data:audio/mp3;base64,${base64Audio}`;
                            this.audioBuffers[i] = dataUrl;
                            this.updateProgress();
                            
                            // Сохраняем в локальный кэш
                            await this.cache.set(voiceKey, this.sentences[i], dataUrl);
                            
                            if (this.isPlaying && this.currentSentenceIndex === i && this.audioElement.paused) {
                                console.log('[VoiceCore] prefetch -> triggering playCurrentSentence()');
                                this.playCurrentSentence();
                            }
                        }
                    }
                } catch (err) {
                    console.error("Prefetch error at index " + i + ":", err);
                    if (window.showToast) window.showToast("Ошибка TTS: " + err, true);
                    this.audioBuffers[i] = "ERROR";
                    
                    if (this.isPlaying && this.currentSentenceIndex === i && this.audioElement.paused) {
                        this.currentSentenceIndex++;
                        this.playCurrentSentence();
                    }
                    continue;
                }
            }
        }
        this.isPrefetching = false;
    }

    seek(index) {
        if (index >= 0 && index < this.sentences.length) {
            this.currentSentenceIndex = index;
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
        console.log('[VoiceCore] play() called, sentences=' + this.sentences.length);
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
        console.log('[VoiceCore] play() state: hasSrc=' + hasSrc + ' ended=' + ended + ' paused=' + paused);

        if (hasSrc && !ended && paused) {
            console.log('[VoiceCore] play() -> resuming audio');
            this.audioElement.play().catch(e => {
                console.error("Audio play error:", e);
                if (e.name === 'NotAllowedError') {
                    if (window.showToast) window.showToast("Кликните в любое место программы для разблокировки звука", true);
                    this.pause();
                }
            });
        } else {
            console.log('[VoiceCore] play() -> playCurrentSentence()');
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
        this.notifyState();
        if (this.onProgress) this.onProgress(0, 0);
        if (this.onSentenceActive) this.onSentenceActive(-1);
        if (shouldBroadcast) {
            this.broadcastState('stop');
        }
    }

    async playCurrentSentence() {
        console.log('[VoiceCore] playCurrentSentence() index=' + this.currentSentenceIndex + ' isPlaying=' + this.isPlaying);
        if (!this.isPlaying) return;
        
        if (this.currentSentenceIndex >= this.sentences.length) {
            this.stop(); // Естественное окончание текста
            return;
        }

        if (this.onSentenceActive) {
            this.onSentenceActive(this.currentSentenceIndex);
        }

        // Если аудио уже скачано
        const bufferState = this.audioBuffers[this.currentSentenceIndex] ? (this.audioBuffers[this.currentSentenceIndex] === 'ERROR' ? 'ERROR' : 'READY') : 'NULL';
        console.log('[VoiceCore] playCurrentSentence() buffer=' + bufferState);
        if (this.audioBuffers[this.currentSentenceIndex]) {
            const srcVal = this.audioBuffers[this.currentSentenceIndex];
            if (srcVal === "ERROR" || !srcVal.startsWith("data:")) {
                console.warn('[VoiceCore] Invalid or error audio buffer at index ' + this.currentSentenceIndex);
                this.currentSentenceIndex++;
                this.playCurrentSentence();
                return;
            }
            this.audioElement.src = srcVal;
            this.audioElement.playbackRate = this.settings.speed;
            console.log('[VoiceCore] playCurrentSentence() calling audioElement.play()');
            this.audioElement.play().catch(e => {
                console.error('[VoiceCore] Audio play FAILED:', e.name, e.message);
                if (e.name === 'NotAllowedError') {
                    if (window.showToast) window.showToast("Кликните в любое место программы для разблокировки звука", true);
                    this.pause();
                }
            });
        } else {
            console.log('[VoiceCore] playCurrentSentence() buffer not ready, waiting for prefetch...');
        }
        this.updateProgress();
    }

    setupAudioEvents() {
        this.audioElement.addEventListener('ended', () => {
            if (this.isPlaying) {
                this.currentSentenceIndex++;
                this.playCurrentSentence();
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
            console.log('[VoiceCore] recording-started detected, pausing playback');
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
