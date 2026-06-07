// widget.js
// Логика плавающего виджета

document.addEventListener('DOMContentLoaded', () => {
  // Кросс-версионное получение текущего окна Tauri
  let appWindow = null;
  if (window.__TAURI__) {
    if (window.__TAURI__.webviewWindow) {
      appWindow = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
    } else if (window.__TAURI__.window) {
      appWindow = window.__TAURI__.window.getCurrentWindow();
    }
  }

  // Скрываем виджет при старте, если он отключен в настройках
  if (window.__TAURI__ && appWindow) {
    const isWidgetEnabled = localStorage.getItem('ttsWidgetEnabled') !== 'false';
    if (!isWidgetEnabled) {
      appWindow.hide().catch(console.error);
    }
  }

  // Принудительная инициализация WinAPI SetWindowPos для обхода бага с системной рамкой DWM
  async function initPosition() {
    if (!window.__TAURI__ || !appWindow) return;
    const { invoke } = window.__TAURI__.core;
    try {
      await new Promise(r => setTimeout(r, 100)); // Задержка для DWM
      const size = await appWindow.innerSize();
      const pos = await appWindow.outerPosition();
      console.log(`[Widget] WinAPI init: size=${size.width}x${size.height}, pos=${pos.x},${pos.y}`);
      await invoke('resize_bottom_up_phys', {
        width: size.width,
        height: size.height,
        x: pos.x,
        y: pos.y
      });
    } catch (e) {
      console.error('[Widget] initPosition WinAPI failed:', e);
    }
  }

  if (window.__TAURI__) {
    initPosition();
  }

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

  const WIN_WIDTH = 560;
  const WIN_HEIGHT_COLLAPSED = 100; // 52px панель + 16px padding-top + 32px тень снизу
  const WIN_HEIGHT_EXPANDED = 480;

  let isRowExpanded = false;
  let isDropdownOpen = false;

  async function updateWindowHeight() {
    // Больше не изменяем физический размер окна Tauri (всегда 560x380) для предотвращения сброса DWM стилей и появления нативной рамки
  }

  // ======================================================================
  // ОБРЕЗКА ОКНА ЧЕРЕЗ WIN32 REGION (Идеальный прозрачный хитбокс)
  // Точная копия паттерна из capsule.html — updateClickRegion
  // ======================================================================

  async function updateClickRegion(state) {
    if (!window.__TAURI__) return;
    const { invoke } = window.__TAURI__.core;

    try {
      let w, h, x, y;

      // Контейнер виджета w=500px, отцентрован по горизонтали в окне 560px -> x = (560 - 500) / 2 = 30px
      // Даем максимальный запас по бокам для тени: x = 2px, w = 556px (оставляем 2px зазора по бокам).
      // Внутренний отступ сверху: padding-top: 32px.
      // Зададим y = 30px для сохранения верхней тени и гарантированного отсечения Titlebar (y < 30px).
      x = 2;
      y = 30;
      w = 556;

      if (state === 'collapsed') {
        h = 118; // 52px панель + 66px запас для плавного затухания нижней тени
      } else if (state === 'expanded') {
        h = 165; // 52px панель + 45px второй ряд + 68px запас для тени
      } else {
        // dropdown
        h = 443; // 480px высота окна - 37px отступов (30px сверху, 7px снизу)
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
  updateWindowHeight();
  updateClickRegion('collapsed');

  if (btnExpand && expandedRow) {
    btnExpand.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = expandedRow.classList.contains('hidden');
      if (isHidden) {
        expandedRow.classList.remove('hidden');
        expandedRow.classList.add('flex');
        expandIcon.textContent = 'close_fullscreen';
        isRowExpanded = true;
        updateWindowHeight();
        updateClickRegion(isDropdownOpen ? 'dropdown' : 'expanded');
      } else {
        expandedRow.classList.remove('flex');
        expandedRow.classList.add('hidden');
        expandIcon.textContent = 'open_in_full';
        isRowExpanded = false;
        updateWindowHeight();
        updateClickRegion(isDropdownOpen ? 'dropdown' : 'collapsed');
      }
    });
  }

  root.addEventListener('tts-menu-toggled', (e) => {
    isDropdownOpen = e.detail.expanded;
    updateWindowHeight();
    updateClickRegion(isDropdownOpen ? 'dropdown' : (isRowExpanded ? 'expanded' : 'collapsed'));
  });

  // Взаимодействие с Tauri (Отправка и прием)
  if (window.__TAURI__) {
    const { invoke } = window.__TAURI__.core;
    const { listen, emit } = window.__TAURI__.event;

    // При показе окна принудительно переприменяем регион кликов после завершения анимаций DWM
    listen('widget-shown', () => {
      emit('widget-visibility-changed', true);
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

    // Инициализация тумблеров через WindowToggleManager (DRY)
    const togglesContainer = document.getElementById('widget-toggles-container');
    if (togglesContainer && window.WindowToggleManager) {
      togglesContainer.innerHTML = 
        WindowToggleManager.renderToggle('toggle-capsule-widget', 'mic', 'Показать/скрыть капсулу диктовки') +
        WindowToggleManager.renderToggle('toggle-widget-widget', 'record_voice_over', 'Скрыть плавающий виджет');

      WindowToggleManager.initToggle('toggle-capsule-widget', 'capsule');
      WindowToggleManager.initToggle('toggle-widget-widget', 'widget');
    }
  }
});
