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
    const selectedVoiceLabel = d





























































































































































































































































































































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

