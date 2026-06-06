// voice-core.js
// Единое ядро логики Озвучки (TTS) и управления состоянием плеера
// Обеспечивает потоковое воспроизведение, расчет умного таймлайна и синхронизацию состояний.

class VoiceCore {
    constructor() {
        this.currentText = "";
        this.sentences = [];
        this.audioBuffers = []; // Base64 strings for each sentence
        this.audioDurations = []; // Durations for smart timeline
        
        this.currentSentenceIndex = 0;
        this.isPlaying = false;
        this.isPaused = false;
        
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




































































































































































































                // Ждем пока скачается
                if (this.onSentenceActive) this.onSentenceActive(this.currentSentenceIndex);
            }
            this.updateProgress();
        } else {
            this.stop(); // Конец текста
        }
    }

    updateProgress() {
        if (!this.onProgress || this.sentences.length === 0) return;
        
        let totalChars = this.currentText.length;
        if (totalChars === 0) return;

        // Расчет буферизации (сколько загружено)
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
        
        // Расчет текущего проигрывания
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

