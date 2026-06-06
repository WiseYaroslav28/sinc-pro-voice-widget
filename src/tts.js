// tts.js
// Привязка UI плеера (index.html) к единому ядру VoiceCore и TtsWidget

document.addEventListener('DOMContentLoaded', () => {
    const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
    const listen = window.__TAURI__ ? window.__TAURI__.event.listen : null;
    
    if (!window.VoiceCore) {
        console.error("VoiceCore not found!");
        return;
    }

    const engine = new window.VoiceCore();
    window.ttsEngine = engine;

    const contentEditable = document.getElementById('voice-contenteditable');
    const progressContainer = document.getElementById('voice-progress-container');
    const timeCurrent = document.getElementById('voice-time-current');
    const statsLabel = document.getElementById('voice-stats');
    const root = document.getElementById('tts-widget-root');

    // Инициализация единого виджета TTS
    if (window.renderTtsWidget && root) {
        window.renderTtsWidget(root, true); // isMain = true
    }

    // Слушаем события от компонента виджета
    if (root) {
        root.addEventListener('tts-widget-event', (e) => {
            const { action, ...payload } = e.detail;
            
            if (action === 'play') {
                if (contentEditable && contentEditable.innerText.trim()) {
                    if (engine.currentText !== engine.cleanText(contentEditable.innerText)) {
                        engine.loadText(contentEditable.innerText);
                        engine.broadcastState('load', { text: contentEditable.innerText });
                    }
                    engine.play();
                }
            } else if (action === 'pause') {
                engine.pause();
            } else if (action === 'stop') {
                engine.stop();
            } else if (action === 'setting') {
                if (payload.speed !== undefined) {
                    engine.settings.speed = payload.speed;
                    engine.broadcastState('setting', { speed: payload.speed });
                    if (engine.isPlaying) {
                        engine.audioElement.playbackRate = engine.settings.speed;
                    }
                }
                if (payload.voice !== undefined) {
                    engine.settings.voice = payload.voice;
                    engine.broadcastState('setting', { voice: payload.voice });
                    // Если сменили голос — загружаем текст заново, чтобы перекачать кэш
                    if (contentEditable.innerText.trim()) {
                        engine.loadText(contentEditable.innerText);
                        if (engine.isPlaying) engine.play();
                    }
                }
                if (payload.translate !== undefined) {
                    engine.settings.translate = payload.translate;
                    engine.broadcastState('setting', { translate: payload.translate });
                }
            }
        });
    }

    contentEditable.addEventListener('input', () => {
        // Сброс при изменении текста
        engine.stop();
    });

    // Обратные вызовы от движка для обновления UI
    engine.onStateChange = (isPlaying, isPaused) => {
        if (root && root.updateState) {
            root.updateState({ isPlaying, isPaused });
        }
        
        if (contentEditable && engine.sentences.length > 0) {
            const wordsCount = engine.sentences.join(" ").split(/\s+/).length;
            if (statsLabel) statsLabel.textContent = `${engine.sentences.length} предложений, ~${wordsCount} слов`;
            
            contentEditable.innerHTML = engine.sentences.map((s, i) => {
                const isActive = (i === engine.currentSentenceIndex && isPlaying);
                return `<span class="transition-colors ${isActive ? 'bg-[#7bd6d1]/20 text-[#7bd6d1] font-semibold' : ''}" id="sentence-${i}">${s}</span>`;
            }).join(' ');
        }
    };

    engine.onSentenceActive = (index) => {
        engine.onStateChange(engine.isPlaying, engine.isPaused);
    };

    engine.onProgress = (percentBuffered, percentPlayed) => {
        if (progressContainer && engine.sentences.length > 0) {
            progressContainer.innerHTML = '';
            const totalChars = engine.currentText.length;
            
            if (timeCurrent) {
                if (engine.isPlaying || engine.isPaused) {
                    timeCurrent.textContent = `Чтение: ${engine.currentSentenceIndex + 1} из ${engine.sentences.length}`;
                } else {
                    timeCurrent.textContent = 'Готово';
                }
            }
            
            engine.sentences.forEach((s, i) => {
                const widthPercent = (s.length / totalChars) * 100;
                const segment = document.createElement('div');
                segment.style.width = `${widthPercent}%`;
                segment.className = 'h-full border-r border-[#1f1f24] last:border-0 relative cursor-pointer hover:bg-[#8e52ff]/30 transition-colors';
                segment.title = 'Начать с этого предложения';
                
                // Цветовая индикация буферизации
                const isDownloaded = !!engine.audioBuffers[i];
                if (isDownloaded) {
                    // Бледный фон, если предзагружено в кэш
                    segment.style.backgroundColor = 'rgba(142, 82, 255, 0.2)';
                }
                
                segment.addEventListener('click', () => {
                    engine.seek(i);
                });
                
                let fillPercent = 0;
                if (i < engine.currentSentenceIndex) fillPercent = 100;
                else if (i === engine.currentSentenceIndex) {
                    const currentAudioProgress = (engine.audioElement.duration && !isNaN(engine.audioElement.duration)) 
                        ? (engine.audioElement.currentTime / engine.audioElement.duration) 
                        : 0;
                    fillPercent = currentAudioProgress * 100;
                }
                
                // Яркий (заполненный) индикатор воспроизведения
                segment.innerHTML = `<div class="absolute top-0 left-0 h-full bg-[#8e52ff] transition-all" style="width: ${fillPercent}%;"></div>`;
                progressContainer.appendChild(segment);
            });
        }
    };

    engine.onSettingsSync = (settings) => {
        if (root && root.updateState) {
            root.updateState(settings);
        }
    };

    // Helper to add or replace text
    function handleNewText(text) {
        if (!text || !text.trim()) {
            console.warn('[TTS] handleNewText: empty text, skipping');
            return;
        }
        console.log('[TTS] handleNewText: received text, length=' + text.length);
        if (window.switchTab) window.switchTab('tab-tts');
        
        // По просьбе пользователя всегда стираем старый текст и начинаем заново
        if (contentEditable) contentEditable.innerText = text;
        engine.loadText(text);
        console.log('[TTS] handleNewText: loadText done, sentences=' + engine.sentences.length);
        engine.broadcastState('load', { text: text });
        engine.play();
        console.log('[TTS] handleNewText: play() called, isPlaying=' + engine.isPlaying);
        engine.broadcastState('play');
    }

    // Слушатель хоткеев из Rust
    if (listen && invoke) {
        listen('tts-action-read', async () => {
            try {
                const text = await invoke('capture_clipboard_text', { translate: false });
                handleNewText(text);
                const isWidgetEnabled = localStorage.getItem('ttsWidgetEnabled') !== 'false';
                if (isWidgetEnabled) {
                    await invoke('show_widget_window');
                }
            } catch (e) {
                console.error("Failed to capture and read:", e);
            }
        });
        
        listen('tts-action-translate', async () => {
            try {
                const text = await invoke('capture_clipboard_text', { translate: true });
                handleNewText(text);
                const isWidgetEnabled = localStorage.getItem('ttsWidgetEnabled') !== 'false';
                if (isWidgetEnabled) {
                    await invoke('show_widget_window');
                }
            } catch (e) {
                console.error("Failed to capture and translate:", e);
            }
        });
    }
});
