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

  // Скрываем/показываем виджет при старте в зависимости от режима
  if (window.__TAURI__ && appWindow) {
    const { invoke } = window.__TAURI__.core;
    invoke('is_minimized_startup').then((isMinimized) => {
      invoke('load_config').then((config) => {
        const widgetMode = config.widget_mode !== undefined ? config.widget_mode : 2;
        if (isMinimized) {
          appWindow.hide().catch(console.error);
        } else {
          if (widgetMode === 0 || widgetMode === 1) {
            appWindow.hide().catch(console.error);
          } else {
            appWindow.show().catch(console.error);
            initPosition();
          }
        }
      }).catch(err => {
        console.error('[Widget] Failed to load config:', err);
        const widgetMode = parseInt(localStorage.getItem('widgetMode') || '2', 10);
        if (isMinimized || widgetMode === 0 || widgetMode === 1) {
          appWindow.hide().catch(console.error);
        } else {
          appWindow.show().catch(console.error);
          initPosition();
        }
      });
    }).catch(() => {
      const widgetMode = parseInt(localStorage.getItem('widgetMode') || '2', 10);
      if (widgetMode === 0 || widgetMode === 1) {
        appWindow.hide().catch(console.error);
      } else {
        appWindow.show().catch(console.error);
        initPosition();
      }
    });
  }

  // Принудительная инициализация WinAPI SetWindowPos для обхода бага с системной рамкой DWM
  async function initPosition() {
    if (!window.__TAURI__ || !appWindow) return;
    const { invoke } = window.__TAURI__.core;
    try {
      await new Promise(r => setTimeout(r, 100)); // Задержка для DWM
      const size = await appWindow.innerSize();
      let pos = await appWindow.outerPosition();

      // Пробуем восстановить сохраненные координаты с проверкой мониторов
      const savedPos = localStorage.getItem('widget_pos');
      if (savedPos) {
        try {
          const parsed = JSON.parse(savedPos);
          if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            const monitors = await appWindow.availableMonitors();
            let isInsideAnyMonitor = false;
            for (const mon of monitors) {
              const mx = mon.position.x;
              const my = mon.position.y;
              const mw = mon.size.width;
              const mh = mon.size.height;
              if (parsed.x >= mx - 40 && parsed.x < mx + mw && parsed.y >= my - 40 && parsed.y < my + mh) {
                isInsideAnyMonitor = true;
                break;
              }
            }
            if (isInsideAnyMonitor) {
              pos = { x: parsed.x, y: parsed.y };
              const { PhysicalPosition } = window.__TAURI__.dpi;
              await appWindow.setPosition(new PhysicalPosition(pos.x, pos.y));
              console.log(`[Widget] Position restored: x=${pos.x}, y=${pos.y}`);
            }
          }
        } catch (e) {
          console.error('[Widget] Restore position failed:', e);
        }
      }
      
      console.log(`[Widget] WinAPI init: size=${size.width}x${size.height}, pos=${pos.x},${pos.y}`);
      await invoke('resize_bottom_up_phys', {
        width: size.width,
        height: size.height,
        x: pos.x,
        y: pos.y
      });
      cachedWindowPos = { x: pos.x, y: pos.y };
    } catch (e) {
      console.error('[Widget] initPosition WinAPI failed:', e);
    }
  }

  let cachedWindowPos = { x: 0, y: 0 };

  // Следим за перемещением виджета и сохраняем его позицию с дебаунсом
  if (window.__TAURI__ && appWindow) {
    let widgetTimeout = null;
    appWindow.onMoved(() => {
      clearTimeout(widgetTimeout);
      widgetTimeout = setTimeout(async () => {
        try {
          const pos = await appWindow.outerPosition();
          cachedWindowPos = { x: pos.x, y: pos.y };
          localStorage.setItem('widget_pos', JSON.stringify({ x: pos.x, y: pos.y }));
        } catch (_) {}
      }, 200);
    });
  }

  const root = document.getElementById('tts-widget-root');
  
  // Рендерим общий UI
  if (window.renderTtsWidget) {
    window.renderTtsWidget(root, false);
    
    // Навешиваем обработчик перетаскивания на drag handle
    const dragHandle = root.querySelector('#tts-widget-drag');
    if (dragHandle && window.__TAURI__ && appWindow) {
      dragHandle.addEventListener('mousedown', (e) => {
        if (e.buttons === 1) {
          appWindow.startDragging();
        }
      });
    }
  }

  // Централизованное перетаскивание виджета за фон и элементы с data-tauri-drag-region
  const widgetContainer = document.getElementById('widget-container');
  if (widgetContainer && window.__TAURI__ && appWindow) {
    widgetContainer.addEventListener('mousedown', (e) => {
      const isDragTarget = e.target.hasAttribute('data-tauri-drag-region') || 
                           e.target === widgetContainer || 
                           e.target.closest('[data-tauri-drag-region]');
      if (isDragTarget) {
        if (!e.target.closest('button, select, input, a, .voice-item, .speed-item')) {
          if (e.buttons === 1) {
            appWindow.startDragging();
          }
        }
      }
    });
  }

  const btnExpand = document.getElementById('tts-btn-expand');
  const expandedRow = document.getElementById('expanded-row');
  const expandIcon = document.getElementById('tts-expand-icon');

  const WIN_WIDTH = 580;
  const WIN_HEIGHT_EXPANDED = 480;

  let isRowExpanded = false;
  let isDropdownOpen = false;
  let currentRegionState = 'hover_collapsed';

  async function updateWindowHeight() {
    // Физический размер окна постоянен для стабильности DWM
  }

  // ======================================================================
  // ОБРЕЗКА ОКНА ЧЕРЕЗ WIN32 REGION + КЛИКАБЕЛЬНОСТЬ СКВОЗЬ ТЕНЬ/СИЯНИЕ
  // ======================================================================

  async function updateClickRegion(state) {
    if (!window.__TAURI__) return;
    const { invoke } = window.__TAURI__.core;
    if (state) currentRegionState = state;

    try {
      const scaleFactor = window.devicePixelRatio || 1;
      const rects = [];

      // Базовый прямоугольник плашки + запас под визуальную тень (сама тень пропускает клики через set_ignore_cursor_events)
      const isHoverCollapsed = currentRegionState === 'hover_collapsed';
      const barW = isHoverCollapsed ? 180 : 564;
      const barH = (currentRegionState === 'expanded' || isRowExpanded) ? 145 : 98;
      rects.push({ x: 4, y: 0, width: barW, height: barH });

      // Если открыто выпадающее меню голоса или скорости — добавляем его точный прямоугольник с запасом под тень
      if (currentRegionState === 'dropdown' || isDropdownOpen) {
        const voiceMenu = root ? root.querySelector('#tts-voice-menu') : null;
        const speedMenu = root ? root.querySelector('#tts-speed-menu') : null;
        const openMenu = (voiceMenu && !voiceMenu.classList.contains('hidden')) ? voiceMenu
                       : ((speedMenu && !speedMenu.classList.contains('hidden')) ? speedMenu : null);
        if (openMenu) {
          const mr = openMenu.getBoundingClientRect();
          if (mr.width > 0 && mr.height > 0) {
            rects.push({
              x: Math.max(0, Math.floor(mr.left - 16)),
              y: Math.max(0, Math.floor(mr.top - 8)),
              width: Math.ceil(mr.width + 32),
              height: Math.ceil(mr.height + 28)
            });
          } else {
            rects[0].height = 420;
          }
        } else {
          rects[0].height = 420;
        }
      }

      await invoke('set_click_region', {
        rects,
        scaleFactor
      });
    } catch (e) {
      console.error('[Widget] Region err:', e);
    }
  }

  // Проверка: находится ли точка (в логических координатах окна) внутри реального тела виджета или открытого меню (а не в полупрозрачной тени вокруг него)
  function isPointInsideWidgetBody(clientX, clientY) {
    if (!widgetContainer) return false;
    const r = widgetContainer.getBoundingClientRect();
    if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
      return true;
    }
    if (root) {
      const voiceMenu = root.querySelector('#tts-voice-menu');
      if (voiceMenu && !voiceMenu.classList.contains('hidden')) {
        const vr = voiceMenu.getBoundingClientRect();
        if (clientX >= vr.left && clientX <= vr.right && clientY >= vr.top && clientY <= vr.bottom) {
          return true;
        }
      }
      const speedMenu = root.querySelector('#tts-speed-menu');
      if (speedMenu && !speedMenu.classList.contains('hidden')) {
        const sr = speedMenu.getBoundingClientRect();
        if (clientX >= sr.left && clientX <= sr.right && clientY >= sr.top && clientY <= sr.bottom) {
          return true;
        }
      }
    }
    return false;
  }

  // Пропускаем клики сквозь область тени/свечения вокруг виджета
  let isIgnoringShadowCursor = false;
  let shadowCursorTimer = null;

  async function setShadowIgnoreCursor(ignore) {
    if (!window.__TAURI__ || isIgnoringShadowCursor === ignore) return;
    isIgnoringShadowCursor = ignore;
    const { invoke } = window.__TAURI__.core;
    try {
      await invoke('set_ignore_cursor_events', { ignore });
    } catch (_) {}

    if (ignore) {
      if (!shadowCursorTimer) {
        shadowCursorTimer = setInterval(async () => {
          if (!isIgnoringShadowCursor) {
            clearInterval(shadowCursorTimer);
            shadowCursorTimer = null;
            return;
          }
          try {
            const [cx, cy] = await invoke('get_cursor_pos');
            const dpr = window.devicePixelRatio || 1;
            const lx = (cx - cachedWindowPos.x) / dpr;
            const ly = (cy - cachedWindowPos.y) / dpr;
            const outOfWindow = lx < 0 || ly < 0 || lx > WIN_WIDTH || ly > WIN_HEIGHT_EXPANDED;
            if (outOfWindow || isPointInsideWidgetBody(lx, ly)) {
              await setShadowIgnoreCursor(false);
            }
          } catch (_) {
            await setShadowIgnoreCursor(false);
          }
        }, 50);
      }
    } else if (shadowCursorTimer) {
      clearInterval(shadowCursorTimer);
      shadowCursorTimer = null;
    }
  }

  document.addEventListener('mousemove', (e) => {
    if (e.buttons !== 0) return;
    const inside = isPointInsideWidgetBody(e.clientX, e.clientY);
    if (!inside && !isIgnoringShadowCursor) {
      setShadowIgnoreCursor(true);
    } else if (inside && isIgnoringShadowCursor) {
      setShadowIgnoreCursor(false);
    }
  });

  if (widgetContainer) {
    widgetContainer.classList.add('hover-collapsed');
    
    const expandWidget = () => {
      if (widgetContainer.classList.contains('hover-collapsed')) {
        widgetContainer.classList.remove('hover-collapsed');
        updateClickRegion(isDropdownOpen ? 'dropdown' : (isRowExpanded ? 'expanded' : 'collapsed'));
      }
    };

    const collapseWidget = () => {
      if (!widgetContainer.classList.contains('hover-collapsed')) {
        if (root && typeof root.closeMenus === 'function') {
          root.closeMenus();
        }
        isDropdownOpen = false;

        if (expandedRow) {
          expandedRow.classList.remove('flex');
          expandedRow.classList.add('hidden');
        }
        if (expandIcon) {
          expandIcon.textContent = 'open_in_full';
        }
        isRowExpanded = false;

        widgetContainer.classList.add('hover-collapsed');
        
        setTimeout(() => {
          if (widgetContainer.classList.contains('hover-collapsed')) {
            updateClickRegion('hover_collapsed');
          }
        }, 350);
      }
    };

    const playStopWrapper = root.querySelector('#tts-play-stop-wrapper');
    const extraContent = root.querySelector('.tts-extra-content');
    const dragHandle = root.querySelector('#tts-widget-drag');

    if (playStopWrapper) {
      playStopWrapper.addEventListener('mouseenter', expandWidget);
    }
    if (extraContent) {
      extraContent.addEventListener('mouseenter', expandWidget);
    }

    if (dragHandle) {
      dragHandle.addEventListener('mouseenter', collapseWidget);
    }

    widgetContainer.addEventListener('mouseleave', collapseWidget);
  }

  // При старте — свернутый режим
  updateWindowHeight();
  updateClickRegion('hover_collapsed');

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
    setTimeout(() => {
      updateClickRegion(isDropdownOpen ? 'dropdown' : (isRowExpanded ? 'expanded' : 'collapsed'));
    }, 20);
  });

  function formatHotkeyHuman(spec) {
    if (!spec) return '';
    return spec
      .replace(/Control|Ctrl/gi, 'Ctrl')
      .replace(/Shift/gi, 'Shift')
      .replace(/Alt/gi, 'Alt')
      .replace(/Key([A-Z])/gi, '$1')
      .replace(/Digit([0-9])/gi, '$1')
      .replace(/Backquote/gi, '`')
      .replace(/Space/gi, 'Space')
      .replace(/Pause/gi, 'Pause')
      .replace(/\+/g, ' + ');
  }

  function applyWidgetHotkeyTooltips(cfg) {
    if (!cfg) return;
    const playBtn = root ? root.querySelector('#tts-widget-play') : null;
    if (playBtn && cfg.hotkey_tts_read) {
      playBtn.title = `Озвучить / Пауза (${formatHotkeyHuman(cfg.hotkey_tts_read)})`;
    }
    const trBtn = root ? root.querySelector('#tts-btn-translate') : null;
    if (trBtn && cfg.hotkey_tts_translate) {
      trBtn.title = `Переводить перед чтением (${formatHotkeyHuman(cfg.hotkey_tts_translate)})`;
    }
    if (expandedRow) {
      const btns = expandedRow.querySelectorAll('button');
      if (btns[0] && cfg.hotkey_ocr) {
        btns[0].title = `Распознавание текста OCR (${formatHotkeyHuman(cfg.hotkey_ocr)})`;
      }
    }
  }

  // Взаимодействие с Tauri (Отправка и прием)
  if (window.__TAURI__) {
    const { invoke } = window.__TAURI__.core;
    const { listen, emit } = window.__TAURI__.event;

    invoke('load_config').then(applyWidgetHotkeyTooltips).catch(() => {});
    listen('config-updated', (e) => {
      if (e.payload) applyWidgetHotkeyTooltips(e.payload);
    });

    // Сразу запрашиваем установленные голоса при загрузке
    invoke('get_installed_voices').then((voices) => {
      if (root && root.updateState) {
        root.updateState({ installedVoices: voices });
      }
    }).catch(()=>{});

    // При показе окна принудительно переприменяем регион кликов после завершения анимаций DWM
    listen('widget-shown', () => {
      emit('widget-mode-changed', 2);
      setTimeout(() => {
        const isRowVisible = expandedRow && !expandedRow.classList.contains('hidden');
        const isCollapsed = widgetContainer && widgetContainer.classList.contains('hover-collapsed');
        if (isCollapsed) {
          updateClickRegion('hover_collapsed');
        } else {
          updateClickRegion(isRowVisible ? 'expanded' : 'collapsed');
        }
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
        } else if (p.action === 'progress') {
          root.updateState({ percentBuffered: p.percentBuffered, percentPlayed: p.percentPlayed });
        } else if (p.action === 'settings' || p.action === 'setting') {
          root.updateState(p.settings || p);
        }
      }
    });

    // Инициализация тумблеров через WindowToggleManager (DRY)
    const togglesContainer = document.getElementById('widget-toggles-container');
    if (togglesContainer && window.WindowToggleManager) {
      togglesContainer.innerHTML = 
        WindowToggleManager.renderToggle('toggle-capsule-widget', 'mic', 'Капсула (ИИ-ввод):\n0: Выключено\n1: Только хоткеи\n2: Все включено') +
        WindowToggleManager.renderToggle('toggle-widget-widget', 'record_voice_over', 'Виджет озвучки:\n0: Выключено\n1: Только хоткеи\n2: Все включено') +
        WindowToggleManager.renderToggle('toggle-ocr-widget', 'screenshot_region', 'Перевод экрана OCR:\n0: Выключено\n1: Только хоткеи\n2: Все включено') +
        WindowToggleManager.renderToggle('toggle-layout-widget', 'keyboard', 'Смена раскладки клавиатуры:\n0: Выключено\n1: Только хоткеи\n2: Автозамена на лету');

      WindowToggleManager.initToggle('toggle-capsule-widget', 'capsule');
      WindowToggleManager.initToggle('toggle-widget-widget', 'widget');
      WindowToggleManager.initToggle('toggle-ocr-widget', 'ocr');
      WindowToggleManager.initToggle('toggle-layout-widget', 'layout');
    }
  }
});
