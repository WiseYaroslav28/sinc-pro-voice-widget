// widget.js
// Логика плавающего виджета

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('tts-widget-root');
  
  // Рендерим общий UI
  if (window.renderTtsWidget) {
    window.renderTtsWidget(root, false);
  }

  // Декорации отключены в tauri.conf.json статически для стабильности DWM

  const btnExpand = document.getElementById('tts-btn-expand');
  const expandedRow = document.getElementById('expanded-row');
  const expandIcon = document.getElementById('tts-expand-icon');

  let isMenuOpen = false;

  // ======================================================================
  // РАЗМЕР ОКНА И ХИТБОКС — по аналогии с capsule.html
  // Окно из tauri.conf.json: width=500, height=380
  // Виджет-контейнер: w-[500px], панель h-[52px]
  // ======================================================================

  const WIN_WIDTH = 520;
  const WIN_HEIGHT_COLLAPSED = 64;
  const WIN_HEIGHT_EXPANDED = 380;



  // ======================================================================
  // ОБРЕЗКА ОКНА ЧЕРЕЗ WIN32 REGION (Идеальный прозрачный хитбокс)
  // Точная копия паттерна из capsule.html — updateClickRegion
  // ======================================================================

  async function updateClickRegion(state) {
    if (!window.__TAURI__) return;
    const { invoke } = window.__TAURI__.core;

    try {
      let w, h, x, y;

      if (state === 'collapsed') {
        // Только верхняя панель с кнопками (500×52 + немного отступа под тень)
        w = 504;
        h = 56;
        x = (WIN_WIDTH - w) / 2;
        y = 0;
      } else if (state === 'expanded') {
        // Панель + дропдауны голосов/скорости + нижний ряд
        w = 504;
        h = WIN_HEIGHT_EXPANDED;
        x = (WIN_WIDTH - w) / 2;
        y = 0;
      } else if (state === 'dropdown') {
        // При открытых дропдаунах — полная высота
        w = 504;
        h = WIN_HEIGHT_EXPANDED;
        x = (WIN_WIDTH - w) / 2;
        y = 0;
      }

      const scaleFactor = window.devicePixelRatio || 1;
      await invoke('set_click_region', {
        rects: [{ x, y, width: w, height: h }],
        scaleFactor
      });
    } catch (e) {
      console.error('[Widget] Region err:', e);
    }
  }

  // При старте — свернутый режим
  updateClickRegion('collapsed');

  if (btnExpand && expandedRow) {
    btnExpand.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = expandedRow.classList.contains('hidden');
      if (isHidden) {
        expandedRow.classList.remove('hidden');
        expandedRow.classList.add('flex');
        expandIcon.textContent = 'close_fullscreen';
        isMenuOpen = true;
        updateClickRegion('expanded');
      } else {
        expandedRow.classList.remove('flex');
        expandedRow.classList.add('hidden');
        expandIcon.textContent = 'open_in_full';
        isMenuOpen = false;
        updateClickRegion('collapsed');
      }
    });
  }

  root.addEventListener('tts-menu-toggled', (e) => {
    isMenuOpen = e.detail.expanded;
    updateClickRegion(isMenuOpen ? 'dropdown' : 'collapsed');
  });

  // Взаимодействие с Tauri (Отправка и прием)
  if (window.__TAURI__) {
    const { invoke } = window.__TAURI__.core;
    const { listen, emit } = window.__TAURI__.event;

    // При показе окна принудительно переприменяем регион кликов после завершения анимаций DWM
    listen('widget-shown', () => {
      setTimeout(() => {
        const isRowVisible = expandedRow && !expandedRow.classList.contains('hidden');
        updateClickRegion(isRowVisible ? 'expanded' : 'collapsed');
      }, 100);
    });

    // Слушаем клики из UI компонента
    root.addEventListener('tts-widget-event', async (e) => {
      const { action, ...payload } = e.detail;
      
      // Отправляем в главное окно
      if (action === 'play' || action === 'pause' || action === 'stop') {
        await emit('tts-state-sync', { action });
      } else if (action === 'setting') {
        // VoiceCore ожидает action: 'settings' в событии tts-state-sync
        await emit('tts-state-sync', { action: 'settings', settings: payload });
      }
    });

    // Кнопка перевода
    const btnTranslate = document.getElementById('tts-btn-translate');
    if (btnTranslate) {
      let translateEnabled = false;
      btnTranslate.addEventListener('click', () => {
        translateEnabled = !translateEnabled;
        btnTranslate.style.color = translateEnabled ? '#45a29e' : '';
      });
    }

    // Слушаем прилетающие обновления из главного окна
    listen('tts-state-sync', (event) => {
      if (event.payload) {
        const p = event.payload;
        if (p.action === 'play') {
          root.updateState({ isPlaying: true, isPaused: false });
        } else if (p.action === 'pause') {
          root.updateState({ isPlaying: false, isPaused: true });
        } else if (p.action === 'stop') {
          root.updateState({ isPlaying: false, isPaused: false });
        } else if (p.action === 'settings' || p.action === 'setting') {
          root.updateState(p.settings || p);
        }
      }
    });
  }
});
