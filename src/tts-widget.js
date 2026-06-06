// tts-widget.js
// Единый компонент виджета TTS для главного окна и плавающего виджета

window.renderTtsWidget = function(container, isMain = false) {
  // Базовая HTML структура виджета
  container.innerHTML = `
    <style>
      #tts-speed-slider {
        -webkit-appearance: none;
        background: #3a3545;
        border-radius: 2px;
        outline: none;
      }
      #tts-speed-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        width: 10px;
        height: 10px;
        border-radius: 50%;
        background: #8e52ff;
        cursor: pointer;
        box-shadow: 0 0 6px rgba(142,82,255,0.6);
      }
      .stop-btn-container {
        width: 0;
        opacity: 0;
        overflow: hidden;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      }
      #tts-play-stop-wrapper:hover .stop-btn-container {
        width: 28px;
        opacity: 1;
        margin-right: 4px;
      }
    </style>
    <div class="flex items-center px-2 py-2 gap-1 h-[52px]" data-tauri-drag-region>
      
      <!-- Drag Handle -->
      ${isMain ? '' : `
      <div class="flex flex-col items-center justify-center w-3 h-full cursor-move opacity-30 hover:opacity-100 pl-1" title="Перетащить виджет" data-tauri-drag-region>
        <span class="material-symbols-outlined text-[14px]" style="pointer-events: none;">drag_indicator</span>
      </div>
      `}

      <!-- 🔊 Голос -->
      <div class="relative flex-1 min-w-[80px]" id="tts-voice-wrapper">
        <button class="bg-transparent text-[#e4e1e9] border-none flex items-center justify-center gap-1.5 px-3 py-1 rounded-full text-[11px] cursor-pointer transition-all hover:bg-[#3a3545] w-full" id="tts-btn-voice" title="Выбор голоса">
          <span class="material-symbols-outlined text-[14px] text-[#ccc3d8]/60" style="font-variation-settings:'FILL' 1;">volume_up</span>
          <span id="tts-selected-voice-label" class="flex-1 text-left truncate">Загрузка...</span>
          <span class="material-symbols-outlined text-[14px] text-[#4a4455]">expand_more</span>
        </button>
        <div class="absolute top-[calc(100%+8px)] left-0 right-0 bg-[#1f1f24] border border-[#8e52ff]/30 rounded-[10px] p-1.5 hidden flex-col gap-[2px] shadow-[0_8px_24px_rgba(0,0,0,0.6)] max-h-[280px] overflow-y-auto z-50 min-w-full" id="tts-voice-menu">
          <div class="text-[9px] uppercase tracking-widest text-[#8e52ff] px-2 mb-1 opacity-70">Голоса</div>
          <!-- Заполняется динамически -->
        </div>
      </div>

      <div class="w-px h-5 bg-[#4a4455]/30 mx-1 flex-shrink-0" data-tauri-drag-region></div>

      <!-- ⚡ Скорость -->
      <div class="relative" id="tts-speed-wrapper">
        <button class="bg-transparent text-[#e4e1e9] border-none flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] cursor-pointer transition-all hover:bg-[#3a3545]" id="tts-btn-speed" title="Скорость воспроизведения">
          <span class="material-symbols-outlined text-[14px] text-[#45a29e]">bolt</span>
          <span id="tts-selected-speed-label">1.0x</span>
        </button>
        <!-- Выпадающее меню скорости -->
        <div class="absolute top-[calc(100%+8px)] left-1/2 -translate-x-1/2 bg-[#1f1f24] border border-[#8e52ff]/30 rounded-[10px] p-3 min-w-[150px] hidden flex-col shadow-[0_8px_24px_rgba(0,0,0,0.6)] z-50" id="tts-speed-menu">
          <div class="text-[9px] uppercase tracking-widest text-[#8e52ff] px-2 mb-2 opacity-70">Скорость</div>
          <div class="flex flex-row relative">
            <div class="flex flex-col flex-1 gap-1" id="tts-speed-list">
              <!-- Заполняется динамически -->
            </div>
            <div class="relative w-6 ml-1 flex flex-col items-center justify-center">
              <input type="range" id="tts-speed-slider" min="0.5" max="3.0" step="0.05" value="1.0" title="Тонкая настройка скорости"
                     style="position: absolute; transform: rotate(90deg); width: 240px; height: 4px;">
            </div>
          </div>
        </div>
      </div>

      <div class="w-px h-5 bg-[#4a4455]/30 mx-1 flex-shrink-0" data-tauri-drag-region></div>

      <!-- ▶ Play/Pause + Hover Stop (слева) -->
      <div class="flex items-center" id="tts-play-stop-wrapper">
        <div class="stop-btn-container flex items-center justify-center">
          <button class="flex items-center justify-center w-7 h-7 bg-[#2a292f] text-[#ccc3d8] rounded-md shadow-lg border border-[#4a4455]/30 hover:bg-[#3a3545] hover:border-[#ff5c5c]/50 hover:text-[#ff5c5c] cursor-pointer transition-all z-50 p-0 outline-none" id="tts-widget-stop" title="Остановить (сброс в начало)">
            <span class="material-symbols-outlined text-[16px]">stop</span>
          </button>
        </div>
        
        <button class="flex items-center justify-center w-9 h-9 rounded-full bg-[#8e52ff] text-white hover:bg-[#a377ff] transition-all active:scale-95 shadow-[0_0_12px_rgba(142,82,255,0.4)] flex-shrink-0 cursor-pointer border-0 outline-none"
                id="tts-widget-play" title="Озвучить / Пауза">
          <span class="material-symbols-outlined text-[20px]" id="tts-widget-play-icon" style="font-variation-settings:'FILL' 1;">play_arrow</span>
        </button>
      </div>

      <div class="w-px h-5 bg-[#4a4455]/30 mx-1 flex-shrink-0" data-tauri-drag-region></div>

      <!-- 文A Перевод -->
      <button class="bg-transparent text-[#ccc3d8] border-none flex items-center justify-center w-7 h-7 rounded-md cursor-pointer transition-all hover:bg-[#3a3545] hover:text-[#7bd6d1] outline-none" id="tts-btn-translate" title="Переводить перед чтением">
        <span class="material-symbols-outlined text-[18px]">translate</span>
      </button>

      ${isMain ? '' : `
      <div class="w-px h-5 bg-[#4a4455]/30 mx-1 flex-shrink-0" data-tauri-drag-region></div>
      <button class="bg-transparent text-[#ccc3d8] border-none flex items-center justify-center w-7 h-7 rounded-md cursor-pointer transition-all hover:bg-[#3a3545] hover:text-white outline-none" id="tts-btn-expand" title="Дополнительно">
        <span class="material-symbols-outlined text-[18px]" id="tts-expand-icon">open_in_full</span>
      </button>
      `}
    </div>
  `;

  // Инициализация логики компонента
  initTtsWidgetLogic(container, isMain);
};

function initTtsWidgetLogic(container, isMain) {
  const PREFERRED_VOICES = [
    { label: 'Светлана (RU)', lang: 'ru', edgeId: 'ru-RU-SvetlanaNeural' },
    { label: 'Дмитрий (RU)',  lang: 'ru', edgeId: 'ru-RU-DmitryNeural'   },
    { label: 'Guy (EN)',       lang: 'en', edgeId: 'en-US-GuyNeural'       },
    { label: 'Aria (EN)',      lang: 'en', edgeId: 'en-US-AriaNeural'      },
    { label: 'Jenny (EN)',     lang: 'en', edgeId: 'en-US-JennyNeural'     },
    { label: 'Katja (DE)',     lang: 'de', edgeId: 'de-DE-KatjaNeural'     },
    { label: 'Denise (FR)',    lang: 'fr', edgeId: 'fr-FR-DeniseNeural'    },
    { label: 'Alvaro (ES)',    lang: 'es', edgeId: 'es-ES-AlvaroNeural'    },
    { label: 'Xiaoxiao (CN)', lang: 'zh', edgeId: 'zh-CN-XiaoxiaoNeural'  },
  ];

  // 0.5 на самом верху, 3.0 в самом низу
  const SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0];

  // DOM Elements
  const btnVoice = container.querySelector('#tts-btn-voice');
  const voiceMenu = container.querySelector('#tts-voice-menu');
  const voiceLabel = container.querySelector('#tts-selected-voice-label');
  
  const btnSpeed = container.querySelector('#tts-btn-speed');
  const speedMenu = container.querySelector('#tts-speed-menu');
  const speedList = container.querySelector('#tts-speed-list');
  const speedLabel = container.querySelector('#tts-selected-speed-label');
  const speedSlider = container.querySelector('#tts-speed-slider');

  const btnPlay = container.querySelector('#tts-widget-play');
  const playIcon = container.querySelector('#tts-widget-play-icon');
  const btnStop = container.querySelector('#tts-widget-stop');
  const btnTranslate = container.querySelector('#tts-btn-translate');
  
  const savedSettings = JSON.parse(localStorage.getItem('tts-settings') || '{}');
  let currentVoice = savedSettings.voice || PREFERRED_VOICES[0].edgeId;
  let currentSpeed = savedSettings.speed || 1.0;
  let isPlaying = false;

  // Render Voices
  voiceMenu.innerHTML += PREFERRED_VOICES.map(v => 
    `<div class="px-2 py-1.5 text-[11px] cursor-pointer hover:bg-[#8e52ff]/20 rounded-md transition-colors voice-item ${v.edgeId === currentVoice ? 'bg-[#8e52ff]/20 text-[#8e52ff]' : ''}" data-id="${v.edgeId}" data-label="${v.label}">${v.label}</div>`
  ).join('');

  const activeVoice = PREFERRED_VOICES.find(v => v.edgeId === currentVoice) || PREFERRED_VOICES[0];
  voiceLabel.textContent = activeVoice.label;

  // Render Speeds
  speedList.innerHTML += SPEEDS.map(s => 
    `<div class="px-2 py-0 text-[11px] flex items-center h-[20px] cursor-pointer hover:bg-[#8e52ff]/20 rounded-md transition-colors speed-item ${s === currentSpeed ? 'bg-[#8e52ff]/20 text-[#8e52ff] font-bold' : ''}" data-speed="${s}">${s}x</div>`
  ).join('');

  // Helper function to update window size for Tauri (only for floating widget)
  function setWindowExpanded(expanded) {
    if (!isMain && window.__TAURI__) {
      container.dispatchEvent(new CustomEvent('tts-menu-toggled', {
        detail: { expanded },
        bubbles: true
      }));
    }
  }

  // Menus toggling
  function closeAllMenus() {
    const wasOpen = !voiceMenu.classList.contains('hidden') || !speedMenu.classList.contains('hidden');
    voiceMenu.classList.add('hidden');
    voiceMenu.classList.remove('flex');
    speedMenu.classList.add('hidden');
    speedMenu.classList.remove('flex');
    btnVoice.classList.remove('bg-[#3a3545]');
    btnSpeed.classList.remove('bg-[#3a3545]');
    if (wasOpen) setWindowExpanded(false);
  }

  document.addEventListener('click', closeAllMenus);

  btnVoice.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = voiceMenu.classList.contains('hidden');
    closeAllMenus();
    if (isHidden) {
      voiceMenu.classList.remove('hidden');
      voiceMenu.classList.add('flex');
      setWindowExpanded(true);
    }
  });

  btnSpeed.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = speedMenu.classList.contains('hidden');
    closeAllMenus();
    if (isHidden) {
      speedMenu.classList.remove('hidden');
      speedMenu.classList.add('flex');
      setWindowExpanded(true);
    }
  });

  voiceMenu.addEventListener('click', (e) => e.stopPropagation());
  speedMenu.addEventListener('click', (e) => e.stopPropagation());

  // Dispatch global custom event
  function notifyChange(action, payload) {
    container.dispatchEvent(new CustomEvent('tts-widget-event', {
      detail: { action, ...payload },
      bubbles: true
    }));
  }

  // Voice Select
  voiceMenu.querySelectorAll('.voice-item').forEach(item => {
    item.addEventListener('click', () => {
      voiceMenu.querySelectorAll('.voice-item').forEach(i => {
        i.classList.remove('bg-[#8e52ff]/20', 'text-[#8e52ff]');
      });
      item.classList.add('bg-[#8e52ff]/20', 'text-[#8e52ff]');
      currentVoice = item.dataset.id;
      voiceLabel.textContent = item.dataset.label;
      closeAllMenus();
      notifyChange('setting', { voice: currentVoice });
    });
  });

  // Speed Select
  function updateSpeedUI(val) {
    currentSpeed = val;
    speedLabel.textContent = val.toFixed(2).replace(/\.00$/, '.0') + 'x';
    speedSlider.value = val;
    speedList.querySelectorAll('.speed-item').forEach(i => {
      i.classList.remove('bg-[#8e52ff]/20', 'text-[#8e52ff]', 'font-bold');
      if (parseFloat(i.dataset.speed) === val) {
        i.classList.add('bg-[#8e52ff]/20', 'text-[#8e52ff]', 'font-bold');
      }
    });
  }

  speedList.querySelectorAll('.speed-item').forEach(item => {
    item.addEventListener('click', () => {
      const val = parseFloat(item.dataset.speed);
      updateSpeedUI(val);
      closeAllMenus();
      notifyChange('setting', { speed: val });
    });
  });

  speedSlider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    updateSpeedUI(val);
    notifyChange('setting', { speed: val });
  });

  // Buttons
  btnPlay.addEventListener('click', (e) => {
    e.stopPropagation();
    notifyChange(isPlaying ? 'pause' : 'play', {});
  });

  btnStop.addEventListener('click', (e) => {
    e.stopPropagation();
    notifyChange('stop', {});
  });

  let currentTranslate = false;

  btnTranslate.addEventListener('click', (e) => {
    e.stopPropagation();
    currentTranslate = !currentTranslate;
    notifyChange('setting', { translate: currentTranslate });
  });

  // Export API to update state from outside
  container.updateState = function(state) {
    if (state.isPlaying !== undefined) {
      isPlaying = state.isPlaying;
      playIcon.textContent = isPlaying ? 'pause' : 'play_arrow';
      if (isPlaying) {
        btnPlay.classList.add('play-pulse');
        btnPlay.title = 'Пауза';
      } else {
        btnPlay.classList.remove('play-pulse');
        btnPlay.title = 'Озвучить';
      }
    }
    if (state.speed !== undefined) {
      updateSpeedUI(state.speed);
    }
    if (state.voice !== undefined) {
      currentVoice = state.voice;
      voiceMenu.querySelectorAll('.voice-item').forEach(i => {
        i.classList.remove('bg-[#8e52ff]/20', 'text-[#8e52ff]');
        if (i.dataset.id === currentVoice) {
          i.classList.add('bg-[#8e52ff]/20', 'text-[#8e52ff]');
          voiceLabel.textContent = i.dataset.label;
        }
      });
    }
    if (state.translate !== undefined) {
      currentTranslate = state.translate;
      btnTranslate.style.color = currentTranslate ? '#7bd6d1' : '';
    }
  };
}
