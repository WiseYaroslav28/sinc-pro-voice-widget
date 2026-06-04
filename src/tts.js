// tts.js
// Привязка UI к единому ядру VoiceCore

document.addEventListener('DOMContentLoaded', () => {
    const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;
    const listen = window.__TAURI__ ? window.__TAURI__.event.listen : null;
    
    // Инициализация ядра
    const engine = new window.VoiceCore();
    window.ttsEngine = engine; // Глобальный доступ для дебага и вызовов
    
    // DOM Элементы главной страницы
    const widgetsPool = document.getElementById('widgets-pool');
    const widgetVoice = document.getElementById('widget-voice');
    const widgetJournal = document.getElementById('widget-journal');
    const homeDynamicContainer = document.getElementById('home-dynamic-container');
    const voiceContainer = document.getElementById('voice-container');
    
    // DOM Элементы плеера
    const voiceContentEditable = document.getElementById('voice-contenteditable');
    const btnVoicePlay = document.getElementById('btn-voice-play');
    const voicePlayIcon = document.getElementById('voice-play-icon');
    
    const voiceProgressBar = document.getElementById('voice-progress-bar');
    const voiceTimeCurrent = document.getElementById('voice-time-current');
    
    const btnVoice = document.getElementById('btn-voice');
    const voiceMenu = document.getElementById('voice-menu');
    const selectedVoiceLabel = document.getElementById('selected-voice-label');
    
    const btnSpeed = document.getElementById('btn-speed');
    const speedMenu = document.getElementById('speed-menu');
    const selectedSpeedLabel = document.getElementById('selected-speed-label');
    
    const btnTranslate = document.getElementById('btn-voice-translate');

    let currentActivity = localStorage.getItem('dashboard-last-activity') || 'journal';
    
    // Переключение виджетов на главной
    window.updateDashboardWidget = (activityType = currentActivity) => {
        currentActivity = activityType;
        localStorage.setItem('dashboard-last-activity', currentActivity);
        
        if (widgetVoice && widgetVoice.parentElement !== widgetsPool) widgetsPool.appendChild(widgetVoice);
        if (widgetJournal && widgetJournal.parentElement !== widgetsPool) widgetsPool.appendChild(widgetJournal);
        
        const activeTab = document.querySelector('.sidebar-item.active')?.getAttribute('data-tab');
        if (activeTab === 'tab-home') {
            if (currentActivity === 'voice') homeDynamicContainer?.appendChild(widgetVoice);
            else homeDynamicContainer?.appendChild(widgetJournal);
        } else if (activeTab === 'tab-voice') {
            voiceContainer?.appendChild(widgetVoice);
        } else if (activeTab === 'tab-history') {
            const historyDetail = document.getElementById('history-detail-container');
            if (historyDetail && widgetJournal) {
                historyDetail.appendChild(widgetJournal);
            }
        }
    };
    
    setTimeout(() => window.updateDashboardWidget(), 100);

    // Восстановление и сохранение текста
    if (voiceContentEditable) {
        const savedText = localStorage.getItem('tts-last-text');
        if (savedText) {
            voiceContentEditable.textContent = savedText;
        }
        voiceContentEditable.addEventListener('input', () => {
            localStorage.setItem('tts-last-text', voiceContentEditable.textContent);
        });
    }

    // Загрузка голосов
    async function loadVoices() {
        if (!invoke) return;
        try {
            // Загружаем список из Rust (заглушка для UI, используем базовые пока что)
            const voices = [
                { id: 'ru-RU-SvetlanaNeural', name: 'Светлана (RU)' },
                { id: 'ru-RU-DmitryNeural', name: 'Дмитрий (RU)' },
                { id: 'en-US-GuyNeural', name: 'Guy (EN)' },
                { id: 'en-US-AriaNeural', name: 'Aria (EN)' },
                { id: 'en-US-JennyNeural', name: 'Jenny (EN)' },
                { id: 'de-DE-KatjaNeural', name: 'Katja (DE)' },
                { id: 'fr-FR-DeniseNeural', name: 'Denise (FR)' },
                { id: 'es-ES-AlvaroNeural', name: 'Alvaro (ES)' },
                { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao (CN)' }
            ];
            
            if (voiceMenu) {
                voiceMenu.innerHTML = '<div class="menu-section-label">Голоса</div>' +
                    voices.map(v => `<div class="dropdown-item ${engine.settings.voice === v.id ? 'selected' : ''}" data-voice="${v.id}">${v.name}</div>`).join('');
                
                // Подсветка текущего
                updateVoiceLabel();
                
                // Клики по голосам
                voiceMenu.querySelectorAll('.dropdown-item').forEach(el => {
                    el.addEventListener('click', () => {
                        engine.setVoice(el.getAttribute('data-voice'));
                        voiceMenu.classList.remove('open');
                    });
                });
            }
        } catch (e) {
            console.error(e);
        }
    }
    
    loadVoices();

    function updateVoiceLabel() {
        if (voiceMenu && selectedVoiceLabel) {
            const selected = voiceMenu.querySelector(`.dropdown-item[data-voice="${engine.settings.voice}"]`);
            if (selected) {
                selectedVoiceLabel.textContent = selected.textContent;
                voiceMenu.querySelectorAll('.dropdown-item').forEach(e => e.classList.remove('selected'));
                selected.classList.add('selected');
            }
        }
    }

    // UI Обработчики
    document.addEventListener('click', (e) => {
        if (btnVoice && !btnVoice.contains(e.target) && voiceMenu && !voiceMenu.contains(e.target)) {
            voiceMenu.classList.remove('open');
        }
        if (btnSpeed && !btnSpeed.contains(e.target) && speedMenu && !speedMenu.contains(e.target)) {
            speedMenu.classList.remove('open');
        }
    });

    if (btnVoice) btnVoice.addEventListener('click', () => voiceMenu.classList.toggle('open'));
    if (btnSpeed) btnSpeed.addEventListener('click', () => speedMenu.classList.toggle('open'));

    if (speedMenu) {
        speedMenu.querySelectorAll('.dropdown-item').forEach(el => {
            el.addEventListener('click', () => {
                engine.setSpeed(el.getAttribute('data-speed'));
                speedMenu.classList.remove('open');
            });
        });

        const speedSlider = document.getElementById('speed-slider');
        if (speedSlider) {
            speedSlider.addEventListener('input', (e) => {
                engine.setSpeed(e.target.value);
            });
        }
    }

    if (btnTranslate) {
        btnTranslate.addEventListener('click', () => {
            const enabled = !engine.settings.translate;
            engine.setTranslate(enabled);
            if (enabled) btnTranslate.classList.add('text-[#8e52ff]');
            else btnTranslate.classList.remove('text-[#8e52ff]');
        });
    }

    // Привязка событий Core к UI
    engine.onSettingsSync = (settings) => {
        updateVoiceLabel();
        if (selectedSpeedLabel) selectedSpeedLabel.textContent = settings.speed.toFixed(2) + 'x';
        if (speedMenu) {
            speedMenu.querySelectorAll('.dropdown-item').forEach(e => e.classList.remove('selected'));
            const speedEl = speedMenu.querySelector(`.dropdown-item[data-speed="${settings.speed}"]`);
            if (speedEl) speedEl.classList.add('selected');
            const speedSlider = document.getElementById('speed-slider');
            if (speedSlider) speedSlider.value = settings.speed;
        }
        if (btnTranslate) {
            if (settings.translate) btnTranslate.classList.add('text-[#8e52ff]');
            else btnTranslate.classList.remove('text-[#8e52ff]');
        }
    };
    // Вызов синхронизации для инициализации UI (кнопки скорости и т.д.)
    engine.onSettingsSync(engine.settings);

    const btnSmartStopMenu = document.getElementById('btn-smart-stop-menu');
    const ttsControlsWrapper = document.getElementById('tts-controls-wrapper');

    if (btnSmartStopMenu) {
        btnSmartStopMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            if (window.ttsEngine) window.ttsEngine.stop();
            localStorage.removeItem('tts-last-text');
        });
    }

    function updateSmartButtonState(isActiveForThisItem, isPlaying) {
        const iconSmartSpeak = document.getElementById('icon-smart-speak');
        const ttsHoverMenu = document.getElementById('tts-hover-menu');
        const ttsHoverArea = document.getElementById('tts-hover-area');

        if (!iconSmartSpeak) return;

        // Обновляем визуал кнопок
        if (isActiveForThisItem) {
            if (ttsControlsWrapper) ttsControlsWrapper.classList.add('active-tts');
            if (ttsHoverMenu) ttsHoverMenu.classList.remove('hidden');
            if (ttsHoverArea) ttsHoverArea.classList.remove('hidden');
            
            // Если текст совпадает, показываем состояние (Play/Pause)
            if (isPlaying) {
                // Играет (зеленая)
                iconSmartSpeak.className = 'material-symbols-outlined text-[15px] transition-colors duration-300 text-[#4ade80] animate-pulse';
                iconSmartSpeak.textContent = 'volume_up';
            } else {
                // На паузе (желтая)
                iconSmartSpeak.className = 'material-symbols-outlined text-[15px] transition-colors duration-300 text-[#fbbf24]';
                iconSmartSpeak.textContent = 'pause_circle';
            }
        } else {
            if (ttsControlsWrapper) ttsControlsWrapper.classList.remove('active-tts');
            if (ttsHoverMenu) ttsHoverMenu.classList.add('hidden');
            if (ttsHoverArea) ttsHoverArea.classList.add('hidden');
            // Возвращаем дефолтный вид
            iconSmartSpeak.className = 'material-symbols-outlined text-[15px] transition-colors duration-300 text-[#ccc3d8]';
            iconSmartSpeak.textContent = 'volume_up';
        }
    }

    engine.onStateChange = (isPlaying, isPaused) => {
        if (voicePlayIcon) {
            voicePlayIcon.textContent = isPlaying ? 'pause' : 'play_arrow';
        }
        
        // Синхронизация умной кнопки в Журнале ИИ
        // Используем innerText, так как textContent игнорирует <br> и склеивает слова
        const currentItemText = document.getElementById('summary-text')?.innerText || "";
        const normalizedEngineText = engine.currentText.replace(/\s+/g, ' ').trim();
        const normalizedItemText = currentItemText.replace(/\s+/g, ' ').trim();
        const isActiveForThisItem = engine.currentText !== "" && normalizedEngineText === normalizedItemText;

        // Если не играет и не на паузе, значит полностью остановлено
        const isStopped = !isPlaying && !isPaused;

        updateSmartButtonState(isActiveForThisItem && !isStopped, isPlaying);
    };

    engine.onStop = () => {
        if (voicePlayIcon) voicePlayIcon.textContent = 'play_arrow';
        updateSmartButtonState(false, false);
    };

    engine.onProgress = (percentBuffered, percentPlayed) => {
        // Здесь можно анимировать background прогресс бара
        // Для простоты пока просто заливаем его цветом played
        if (voiceProgressBar) {
            voiceProgressBar.style.width = `${percentPlayed}%`;
            // Индикатор буферизации можно сделать через background-image
            voiceProgressBar.parentElement.style.background = `linear-gradient(to right, #35343a ${percentBuffered}%, #1b1b20 ${percentBuffered}%)`;
        }
        if (voiceTimeCurrent) {
            // Фейковое время на основе процентов
            const totalChars = engine.currentText.length;
            const playedChars = (percentPlayed / 100) * totalChars;
            // Приближенно 15 символов в секунду
            const currentSecs = playedChars / 15;
            const m = Math.floor(currentSecs / 60);
            const s = Math.floor(currentSecs % 60);
            voiceTimeCurrent.textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }
    };

    engine.onSentenceActive = (index) => {
        if (voiceContentEditable) {
            const spans = voiceContentEditable.querySelectorAll('span');
            spans.forEach((span, i) => {
                if (i === index) span.classList.add('bg-[#7bd6d1]/20');
                else span.classList.remove('bg-[#7bd6d1]/20');
            });
            // Автоскролл
            const activeSpan = spans[index];
            if (activeSpan) {
                activeSpan.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    };

    // Глобальные события (хоткеи и Remote Control от виджетов)
    if (listen) {
        // --- Remote Control от widget.html ---
        listen('tts-control-toggle', () => {
            if (engine.isPlaying) engine.pause();
            else if (engine.currentText) engine.play();
            else startReadingEditor();
        });

        listen('tts-control-voice', (event) => {
            if (event.payload) engine.setVoice(event.payload);
        });

        listen('tts-control-speed', (event) => {
            if (event.payload) engine.setSpeed(event.payload);
        });

        listen('tts-control-translate-toggle', () => {
            engine.setTranslate(!engine.settings.translate);
        });

        // --- Глобальные хоткеи (Ctrl+Shift) ---
        listen('tts-action-read', async () => {
            console.log("TTS Action: Read Triggered");
            try {
                const text = await invoke('capture_clipboard_text');
                if (text && text.trim()) {
                    if (voiceContentEditable) {
                        voiceContentEditable.textContent = text.trim();
                        localStorage.setItem('tts-last-text', text.trim());
                    }
                    startReadingEditor();
                }
            } catch (e) {
                console.error("Clipboard read error:", e);
            }
        });
        
        listen('tts-action-translate', async () => {
            console.log("TTS Action: Translate Triggered");
            try {
                const text = await invoke('capture_clipboard_text');
                if (text && text.trim()) {
                    if (voiceContentEditable) {
                        voiceContentEditable.textContent = text.trim();
                        localStorage.setItem('tts-last-text', text.trim());
                    }
                    engine.setTranslate(true);
                    startReadingEditor();
                }
            } catch (e) {
                console.error("Clipboard read error:", e);
            }
        });
    }

    function startReadingEditor() {
        if (window.switchTab) window.switchTab('tab-home');
        window.updateDashboardWidget('voice');
        
        const text = voiceContentEditable?.innerText || voiceContentEditable?.textContent;
        if (text && text.trim().length > 0) {
            engine.loadText(text);
            if (voiceContentEditable) {
                voiceContentEditable.innerHTML = engine.sentences.map((s, i) => `<span id="sentence-${i}">${s}</span>`).join('');
            }
        }
    }

    if (btnVoicePlay) {
        btnVoicePlay.addEventListener('click', () => {
            if (engine.isPlaying) {
                engine.pause();
            } else if (engine.currentText) {
                engine.play();
            } else {
                startReadingEditor();
            }
        });
    }
    
    // Интеграция с кнопкой "Озвучить" в Журнале ИИ
    document.addEventListener('journal-play-text', (e) => {
        if (engine.isPlaying) {
            engine.pause();
            return;
        }
        if (e.detail && e.detail.text) {
            if (voiceContentEditable) {
                voiceContentEditable.textContent = e.detail.text;
                localStorage.setItem('tts-last-text', e.detail.text);
            }
            engine.loadText(e.detail.text);
            if (voiceContentEditable) {
                voiceContentEditable.innerHTML = engine.sentences.map((s, i) => `<span id="sentence-${i}">${s}</span>`).join('');
            }
            engine.play();
        }
    });
    
    // Инициализация текста при запуске
    if (voiceContentEditable && voiceContentEditable.textContent.trim().length > 0) {
        engine.currentText = voiceContentEditable.textContent.trim();
        engine.sentences = engine.currentText.match(/[^.!?]+[.!?]+[\s]*/g) || [engine.currentText];
        voiceContentEditable.innerHTML = engine.sentences.map((s, i) => `<span id="sentence-${i}">${s}</span>`).join('');
    }
});
