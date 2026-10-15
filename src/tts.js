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

    let isTextChanged = false; // Флаг ручного изменения текста пользователем

    const contentEditable = document.getElementById('voice-contenteditable');
    const progressContainer = document.getElementById('voice-progress-container');
    const timeCurrent = document.getElementById('voice-time-current');
    const statsLabel = document.getElementById('voice-stats');
    const root = document.getElementById('tts-widget-root');

    // Инициализация единого виджета TTS
    if (window.renderTtsWidget && root) {
        window.renderTtsWidget(root, true); // isMain = true
        if (root.updateState) {
            root.updateState(engine.settings);
        }
    }

    // Слушаем события от компонента виджета
    if (root) {
        root.addEventListener('tts-widget-event', (e) => {
            const { action, ...payload } = e.detail;
            
            if (action === 'play') {
                if (contentEditable && contentEditable.innerText.trim()) {
                    const textToPlay = contentEditable.innerText.trim();
                    if (textToPlay === DEFAULT_PLACEHOLDER) {
                        return;
                    }
                    if (isTextChanged || !engine.currentText) {
                        engine.loadText(textToPlay);
                        engine.broadcastState('load', { text: textToPlay });
                        isTextChanged = false;
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
                if (payload.volume !== undefined) {
                    engine.applyEffectiveVolume(payload.volume);
                    engine.broadcastState('setting', { volume: engine.settings.volume });
                }
                if (payload.voice !== undefined || payload.tts_local_voice !== undefined || payload.tts_engine !== undefined) {
                    if (payload.voice !== undefined) engine.settings.voice = payload.voice;
                    if (payload.tts_engine !== undefined) engine.settings.tts_engine = payload.tts_engine;
                    if (payload.tts_local_voice !== undefined) engine.settings.tts_local_voice = payload.tts_local_voice;
                    
                    engine.broadcastState('setting', { 
                        voice: engine.settings.voice,
                        tts_engine: engine.settings.tts_engine,
                        tts_local_voice: engine.settings.tts_local_voice
                    });
                    
                    // Если сменили голос — загружаем текст заново, чтобы перекачать кэш
                    if (contentEditable && contentEditable.innerText.trim() && contentEditable.innerText.trim() !== DEFAULT_PLACEHOLDER) {
                        engine.loadText(contentEditable.innerText);
                        isTextChanged = false;
                        if (engine.isPlaying) engine.play();
                    }
                }
                if (payload.translate !== undefined) {
                    engine.settings.translate = payload.translate;
                    localStorage.setItem('tts-settings', JSON.stringify(engine.settings));
                    if (invoke) {
                        invoke('update_config_fields', { fields: { tts_translate: payload.translate } }).catch(() => {});
                    }
                    engine.broadcastState('setting', { translate: payload.translate });
                }
            }
        });
    }

    const DEFAULT_PLACEHOLDER = "Вставьте сюда текст для озвучивания, или выделите текст в любом приложении и нажмите Ctrl+Shift...";

    contentEditable.addEventListener('input', () => {
        // Сброс при изменении текста
        isTextChanged = true;
        engine.stop();
    });

    contentEditable.addEventListener('focus', () => {
        isTextChanged = true;
        if (contentEditable.innerText.trim() === DEFAULT_PLACEHOLDER) {
            contentEditable.innerText = '';
        }
        if (engine.isPlaying || engine.isPaused) {
            engine.stop();
        }
    });

    contentEditable.addEventListener('blur', () => {
        if (contentEditable.innerText.trim() === '') {
            contentEditable.innerText = DEFAULT_PLACEHOLDER;
        }
    });

    let renderedSentencesRef = null;
    let lastActiveSentenceIdx = -1;

    function updateActiveSentenceHighlight(newIdx) {
        if (!contentEditable || document.activeElement === contentEditable) return;
        if (renderedSentencesRef !== engine.sentences) {
            renderedSentencesRef = engine.sentences;
            lastActiveSentenceIdx = -1;
            const wordsCount = engine.sentences.join(" ").split(/\s+/).length;
            if (statsLabel) statsLabel.textContent = `${engine.sentences.length} предложений, ~${wordsCount} слов`;
            // Рендерим span-обертки один раз при смене массива предложений
            contentEditable.innerHTML = engine.sentences.map((s, i) => {
                const isActive = (i === newIdx);
                return `<span class="transition-colors ${isActive ? 'bg-[#7bd6d1]/20 text-[#7bd6d1] font-semibold' : ''}" id="sentence-${i}">${s}</span>`;
            }).join(' ');
            lastActiveSentenceIdx = newIdx;
            return;
        }
        if (lastActiveSentenceIdx === newIdx) return;
        if (lastActiveSentenceIdx >= 0) {
            const prevEl = document.getElementById(`sentence-${lastActiveSentenceIdx}`);
            if (prevEl) prevEl.className = 'transition-colors';
        }
        if (newIdx >= 0) {
            const nextEl = document.getElementById(`sentence-${newIdx}`);
            if (nextEl) nextEl.className = 'transition-colors bg-[#7bd6d1]/20 text-[#7bd6d1] font-semibold';
        }
        lastActiveSentenceIdx = newIdx;
    }

    // Обратные вызовы от движка для обновления UI
    engine.onStateChange = (isPlaying, isPaused) => {
        if (root && root.updateState) {
            root.updateState({ isPlaying, isPaused });
        }
        
        if (contentEditable) {
            const text = contentEditable.innerText.trim();
            if (text && text !== DEFAULT_PLACEHOLDER) {
                // Если пользователь редактирует текст (фокус на поле), очищаем span-теги для нормального ввода
                if (document.activeElement === contentEditable) {
                    if (contentEditable.querySelector('span')) {
                        contentEditable.innerHTML = contentEditable.innerText;
                        renderedSentencesRef = null;
                    }
                } else if (engine.sentences.length > 0) {
                    updateActiveSentenceHighlight(engine.currentSentenceIndex);
                }
            } else {
                if (statsLabel) statsLabel.textContent = `0 предложений`;
            }
        }
    };

    engine.onSentenceActive = (index) => {
        if (root && root.updateState) {
            root.updateState({ isPlaying: engine.isPlaying, isPaused: engine.isPaused });
        }
        if (engine.sentences.length > 0) {
            updateActiveSentenceHighlight(index);
        }
    };

    let progressSegmentsRef = null;
    let progressSegmentEls = [];

    engine.onProgress = (percentBuffered, percentPlayed) => {
        if (!progressContainer) return;
        if (engine.sentences.length === 0) {
            if (timeCurrent) {
                timeCurrent.textContent = engine.isPlaying ? 'Подготовка озвучки...' : 'Готово';
            }
            return;
        }

        if (timeCurrent) {
            if (engine.isPlaying || engine.isPaused) {
                timeCurrent.textContent = `Чтение: ${engine.currentSentenceIndex + 1} из ${engine.sentences.length}`;
            } else {
                timeCurrent.textContent = 'Готово';
            }
        }

        // Для больших текстов (> 80 предложений) используем плавную единую шкалу без создания сотен DOM-элементов
        if (engine.sentences.length > 80) {
            if (progressSegmentsRef !== 'continuous') {
                progressSegmentsRef = 'continuous';
                progressSegmentEls = [];
                progressContainer.innerHTML = `
                    <div id="tts-cont-buf" class="absolute top-0 left-0 h-full transition-all" style="background-color: rgba(142, 82, 255, 0.25); width: 0%;"></div>
                    <div id="tts-cont-play" class="absolute top-0 left-0 h-full bg-[#8e52ff] transition-all" style="width: 0%;"></div>
                `;
            }
            const bufEl = document.getElementById('tts-cont-buf');
            const playEl = document.getElementById('tts-cont-play');
            if (bufEl) bufEl.style.width = `${Math.min(100, Math.max(0, percentBuffered || 0))}%`;
            if (playEl) playEl.style.width = `${Math.min(100, Math.max(0, percentPlayed || 0))}%`;
            return;
        }

        const totalChars = engine.currentText.length || 1;
        if (progressSegmentsRef !== engine.sentences || progressSegmentEls.length !== engine.sentences.length) {
            progressSegmentsRef = engine.sentences;
            progressSegmentEls = [];
            progressContainer.innerHTML = '';
            engine.sentences.forEach((s, i) => {
                const widthPercent = (s.length / totalChars) * 100;
                const segment = document.createElement('div');
                segment.style.width = `${widthPercent}%`;
                segment.className = 'h-full border-r border-[#1f1f24] last:border-0 relative cursor-pointer hover:bg-[#8e52ff]/30 transition-colors';
                segment.title = 'Начать с этого предложения';
                segment.addEventListener('click', () => {
                    engine.seek(i);
                });
                const fillEl = document.createElement('div');
                fillEl.className = 'absolute top-0 left-0 h-full bg-[#8e52ff] transition-all';
                fillEl.style.width = '0%';
                segment.appendChild(fillEl);
                progressContainer.appendChild(segment);
                progressSegmentEls.push({ segment, fillEl });
            });
        }

        for (let i = 0; i < progressSegmentEls.length; i++) {
            const { segment, fillEl } = progressSegmentEls[i];
            const isDownloaded = !!engine.audioBuffers[i];
            segment.style.backgroundColor = isDownloaded ? 'rgba(142, 82, 255, 0.2)' : '';
            let fillPercent = 0;
            if (i < engine.currentSentenceIndex) fillPercent = 100;
            else if (i === engine.currentSentenceIndex) {
                const currentAudioProgress = (engine.audioElement.duration && !isNaN(engine.audioElement.duration))
                    ? (engine.audioElement.currentTime / engine.audioElement.duration)
                    : 0;
                fillPercent = currentAudioProgress * 100;
            }
            fillEl.style.width = `${fillPercent}%`;
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
            engine.stop();
            return;
        }
        console.log('[TTS] handleNewText: received text, length=' + text.length);
        if (window.switchTab) window.switchTab('tab-tts');
        
        isTextChanged = false;
        renderedSentencesRef = null;
        progressSegmentsRef = null;
        // По просьбе пользователя всегда стираем старый текст и начинаем заново
        if (contentEditable) contentEditable.innerText = text;
        engine.loadText(text, true);
        console.log('[TTS] handleNewText: loadText done, sentences=' + engine.sentences.length);
        engine.play();
        console.log('[TTS] handleNewText: play() called, isPlaying=' + engine.isPlaying);
    }

    function handleAppendText(text) {
        if (!text || !text.trim()) {
            console.warn('[TTS] handleAppendText: empty text, skipping');
            return;
        }
        console.log('[TTS] handleAppendText: received text for append, length=' + text.length);
        if (window.switchTab) window.switchTab('tab-tts');
        
        isTextChanged = false;
        renderedSentencesRef = null;
        progressSegmentsRef = null;
        if (contentEditable) {
            const currentVal = contentEditable.innerText.trim();
            if (currentVal.length > 0) {
                contentEditable.innerText = currentVal + "\n\n" + text;
            } else {
                contentEditable.innerText = text;
            }
        }
        
        const wasPlaying = engine.isPlaying;
        engine.appendText(text);
        console.log('[TTS] handleAppendText: appendText done, sentences=' + engine.sentences.length);
        
        if (!wasPlaying) {
            engine.play();
            console.log('[TTS] handleAppendText: play() called because it was not playing');
        }
    }

    // Слушатель хоткеев из Rust
    if (listen && invoke) {
        let cachedWidgetMode = parseInt(localStorage.getItem('widgetMode') || '2', 10);
        invoke('load_config').then(cfg => {
            if (cfg && cfg.widget_mode !== undefined) cachedWidgetMode = cfg.widget_mode;
        }).catch(() => {});
        listen('config-updated', (e) => {
            if (e.payload && e.payload.widget_mode !== undefined) {
                cachedWidgetMode = e.payload.widget_mode;
            }
        });

        // Слушаем изменение текста снаружи (сквозной пайплайн OCR -> TTS)
        listen('tts-state-sync', (event) => {
            if (event.payload && event.payload.action === 'load') {
                const newText = event.payload.text;
                if (contentEditable && contentEditable.innerText !== newText) {
                    contentEditable.innerText = newText;
                    isTextChanged = false;
                    if (event.payload.source !== 'dashboard' && window.switchTab) {
                        window.switchTab('tab-tts');
                    }
                }
            }
        });

        listen('tts-action-read', async () => {
            try {
                // МГНОВЕННО (0 мс) переключаем кнопку Play -> Pause и выключаем режим перевода (гасим 文A)
                if (cachedWidgetMode === 2) {
                    invoke('show_widget_window').catch(() => {});
                }
                engine.settings.translate = false;
                localStorage.setItem('tts-settings', JSON.stringify(engine.settings));
                invoke('update_config_fields', { fields: { tts_translate: false } }).catch(() => {});
                if (root && root.updateState) {
                    root.updateState({ translate: false });
                }
                engine.broadcastState('setting', { translate: false });
                engine.preparePlayback();

                const text = await invoke('capture_clipboard_text', { translate: false });
                if (!text || !text.trim()) {
                    console.warn('[TTS] tts-action-read: clipboard/selection empty');
                    engine.stop();
                    return;
                }
                handleNewText(text);
            } catch (e) {
                console.error("Failed to capture and read:", e);
                engine.stop();
            }
        });
        
        listen('tts-action-translate', async () => {
            try {
                // МГНОВЕННО (0 мс) переключаем кнопку Play -> Pause и включаем режим перевода (подсвечиваем 文A)
                if (cachedWidgetMode === 2) {
                    invoke('show_widget_window').catch(() => {});
                }
                engine.settings.translate = true;
                localStorage.setItem('tts-settings', JSON.stringify(engine.settings));
                invoke('update_config_fields', { fields: { tts_translate: true } }).catch(() => {});
                if (root && root.updateState) {
                    root.updateState({ translate: true });
                }
                engine.broadcastState('setting', { translate: true });
                engine.preparePlayback();

                const text = await invoke('capture_clipboard_text', { translate: true });
                if (!text || !text.trim()) {
                    console.warn('[TTS] tts-action-translate: clipboard/selection empty');
                    engine.stop();
                    return;
                }
                handleNewText(text);
            } catch (e) {
                console.error("Failed to capture and translate:", e);
                engine.stop();
            }
        });

        listen('tts-action-append', async () => {
            try {
                if (cachedWidgetMode === 2) {
                    invoke('show_widget_window').catch(() => {});
                }
                const shouldTranslate = !!(engine.settings && engine.settings.translate);
                const text = await invoke('capture_clipboard_text', { translate: shouldTranslate });
                if (!text || !text.trim()) return;
                handleAppendText(text);
            } catch (e) {
                console.error("Failed to capture and append:", e);
            }
        });
    }
});
