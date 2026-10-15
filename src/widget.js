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
        if (config && config.widget_scale !== undefined) {
          applyWidgetScale(config.widget_scale);
        }
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

  const PAD_LEFT = 44;
  const PAD_TOP = 22;
  let widgetScale = 1.0;
  let cachedWindowPos = { x: 0, y: 0 };

  const root = document.getElementById('tts-widget-root');
  const widgetContainer = document.getElementById('widget-container');
  const expandedRow = document.getElementById('expanded-row');
  let btnExpand = null;
  let expandIcon = null;

  let isRowExpanded = false;
  let isDropdownOpen = false;
  let currentRegionState = 'hover_collapsed';
  let hoveredPlayWhileCollapsed = false;
  let playHoverStartX = null;

  async function applyWidgetScale(scale) {
    const clamped = Math.max(0.7, Math.min(1.5, parseFloat(scale) || 1.0));
    widgetScale = clamped;
    if (widgetContainer) {
      widgetContainer.style.transform = clamped === 1 ? '' : `scale(${clamped})`;
    }
    if (window.__TAURI__) {
      const { invoke } = window.__TAURI__.core;
      const dpr = window.devicePixelRatio || 1;
      const winW = Math.round((520 * widgetScale + 88) * dpr);
      const winH = Math.round((440 * widgetScale + 60) * dpr);
      try {
        await invoke('resize_window', { width: winW, height: winH });
      } catch (_) {}
      setTimeout(() => updateClickRegion(), 40);
    }
  }

  // Принудительная инициализация WinAPI SetWindowPos для обхода бага с системной рамкой DWM
  async function initPosition() {
    if (!window.__TAURI__ || !appWindow) return;
    const { invoke } = window.__TAURI__.core;
    try {
      await new Promise(r => setTimeout(r, 80));
      const dpr = window.devicePixelRatio || 1;
      const winW = Math.round((520 * widgetScale + 88) * dpr);
      const winH = Math.round((440 * widgetScale + 60) * dpr);
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
              if (parsed.x >= mx - 80 && parsed.x < mx + mw && parsed.y >= my - 80 && parsed.y < my + mh) {
                isInsideAnyMonitor = true;
                break;
              }
            }
            if (isInsideAnyMonitor) {
              pos = { x: parsed.x, y: parsed.y };
            }
          }
        } catch (e) {
          console.error('[Widget] Restore position failed:', e);
        }
      }

      await invoke('resize_bottom_up_phys', {
        width: winW,
        height: winH,
        x: pos.x,
        y: pos.y
      });
      cachedWindowPos = { x: pos.x, y: pos.y };
      updateClickRegion();
    } catch (e) {
      console.error('[Widget] initPosition WinAPI failed:', e);
    }
  }

  function startWidgetDrag() {
    if (!window.__TAURI__) return;
    const { invoke } = window.__TAURI__.core;
    const dpr = window.devicePixelRatio || 1;
    // Позволяем поднимать окно на 22 логических пикселя выше верхней границы экрана,
    // чтобы видимая капсула (#widget-container) примагничивалась ровно к 0px от верха экрана,
    // а при отступе от верха сохранялось полное свечение кнопки Play (.play-pulse)
    const topGlowOffsetPhys = Math.round(PAD_TOP * dpr);
    invoke('start_custom_drag', { topGlowOffsetPhys }).catch(console.error);
  }

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

  // Рендерим общий UI
  if (window.renderTtsWidget) {
    window.renderTtsWidget(root, false);
    btnExpand = document.getElementById('tts-btn-expand');
    expandIcon = document.getElementById('tts-expand-icon');
    
    // Навешиваем обработчик перетаскивания на drag handle
    const dragHandle = root.querySelector('#tts-widget-drag');
    if (dragHandle && window.__TAURI__ && appWindow) {
      dragHandle.addEventListener('mousedown', (e) => {
        if (e.buttons === 1) {
          e.preventDefault();
          startWidgetDrag();
        }
      });
    }
  }

  // Централизованное перетаскивание виджета за фон и элементы с data-tauri-drag-region
  if (widgetContainer && window.__TAURI__ && appWindow) {
    widgetContainer.addEventListener('mousedown', (e) => {
      const isDragTarget = e.target.hasAttribute('data-tauri-drag-region') || 
                           e.target === widgetContainer || 
                           e.target.closest('[data-tauri-drag-region]');
      if (isDragTarget) {
        if (!e.target.closest('button, select, input, a, .voice-item, .speed-item, .volume-item')) {
          if (e.buttons === 1) {
            e.preventDefault();
            startWidgetDrag();
          }
        }
      }
    });
  }

  async function updateWindowHeight() {
    // Физический размер окна управляется через applyWidgetScale
  }

  // ======================================================================
  // ТОЧНЫЙ РАСЧЕТ ИНТЕРАКТИВНОЙ ОБЛАСТИ (БЕЗ ТЕНЕЙ И СИЯНИЯ) ДЛЯ NATIVE HIT-TEST
  // ======================================================================

  async function updateClickRegion(state) {
    if (!window.__TAURI__) return;
    const { invoke } = window.__TAURI__.core;
    if (state) currentRegionState = state;

    try {
      const scaleFactor = window.devicePixelRatio || 1;
      const rects = [];

      // Передаем ТОЛЬКО саму капсулу виджета (со скруглением 24px), без области тени вокруг неё!
      // Вся область тени (слева, справа, сверху, снизу) остается на 100% прозрачной для кликов мыши.
      const domRect = widgetContainer ? widgetContainer.getBoundingClientRect() : null;
      const pillX = domRect && domRect.left > 0 ? Math.round(domRect.left) : PAD_LEFT;
      const pillY = domRect && domRect.top > 0 ? Math.round(domRect.top) : PAD_TOP;

      const isHoverCollapsed = currentRegionState === 'hover_collapsed';
      const isStopPeek = isHoverCollapsed && widgetContainer && widgetContainer.classList.contains('stop-peek');
      const baseW = isHoverCollapsed ? (isStopPeek ? 148 : 114) : 500;
      const pillW = Math.round(baseW * widgetScale);
      const basePillH = (currentRegionState === 'expanded' || isRowExpanded) ? 100 : 54;
      const pillH = Math.round(Math.max(basePillH * widgetScale, domRect ? domRect.height : 0));

      const pad = isHoverCollapsed ? 0 : 4;
      rects.push({
        x: Math.max(0, pillX - pad),
        y: Math.max(0, pillY - pad),
        width: pillW + pad * 2,
        height: pillH + pad * 2,
        radius: Math.round(24 * widgetScale)
      });

      // Если открыто выпадающее меню голоса, скорости или громкости — добавляем его точный прямоугольник
      // и соединяем зазор между капсулой и меню, чтобы курсор не терял фокус при переходе в список
      if (currentRegionState === 'dropdown' || isDropdownOpen) {
        const voiceMenu = root ? root.querySelector('#tts-voice-menu') : null;
        const speedMenu = root ? root.querySelector('#tts-speed-menu') : null;
        const volumeMenu = root ? root.querySelector('#tts-volume-menu') : null;
        const openMenu = (voiceMenu && !voiceMenu.classList.contains('hidden')) ? voiceMenu
                       : ((speedMenu && !speedMenu.classList.contains('hidden')) ? speedMenu
                       : ((volumeMenu && !volumeMenu.classList.contains('hidden')) ? volumeMenu : null));
        if (openMenu) {
          const mr = openMenu.getBoundingClientRect();
          if (mr.width > 0 && mr.height > 0) {
            const topY = Math.min(Math.floor(mr.top), pillY + pillH - 2);
            rects.push({
              x: Math.floor(mr.left) - 4,
              y: topY,
              width: Math.ceil(mr.width) + 8,
              height: Math.ceil(mr.bottom - topY) + 4,
              radius: Math.round(14 * widgetScale)
            });
          }
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

  let collapseDebounceTimer = null;

  const expandWidget = () => {
    if (collapseDebounceTimer) {
      clearTimeout(collapseDebounceTimer);
      collapseDebounceTimer = null;
    }
    if (widgetContainer && widgetContainer.classList.contains('hover-collapsed')) {
      widgetContainer.classList.remove('stop-peek');
      widgetContainer.classList.remove('hover-collapsed');
      updateClickRegion(isDropdownOpen ? 'dropdown' : (isRowExpanded ? 'expanded' : 'collapsed'));
    }
  };

  const collapseWidget = () => {
    if (collapseDebounceTimer) {
      clearTimeout(collapseDebounceTimer);
      collapseDebounceTimer = null;
    }
    hoveredPlayWhileCollapsed = false;
    playHoverStartX = null;

    if (widgetContainer) {
      const wasPeek = widgetContainer.classList.contains('stop-peek');
      widgetContainer.classList.remove('stop-peek');

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
        updateClickRegion('hover_collapsed');
      } else if (wasPeek) {
        updateClickRegion('hover_collapsed');
      }
    }
  };

  if (widgetContainer) {
    widgetContainer.classList.add('hover-collapsed');

    const playStopWrapper = root ? root.querySelector('#tts-play-stop-wrapper') : null;
    const playBtn = root ? root.querySelector('#tts-widget-play') : null;
    const stopBtnContainer = root ? root.querySelector('.stop-btn-container') : null;
    const extraContent = root ? root.querySelector('.tts-extra-content') : null;

    // Любое движение мыши внутри контейнера отменяет таймер сворачивания
    widgetContainer.addEventListener('mousemove', (e) => {
      if (collapseDebounceTimer) {
        clearTimeout(collapseDebounceTimer);
        collapseDebounceTimer = null;
      }
      if (!widgetContainer.classList.contains('hover-collapsed')) {
        return;
      }
      if (playBtn) {
        const pr = playBtn.getBoundingClientRect();
        // Наведение на саму кнопку Play НЕ раскрывает всю панель сразу,
        // а только показывает кнопку Стоп сбоку (если идет озвучка/пауза).
        if (e.clientX >= pr.left && e.clientX <= pr.right - 3) {
          hoveredPlayWhileCollapsed = true;
          if (playHoverStartX === null) {
            playHoverStartX = e.clientX;
          }
          if (playStopWrapper && playStopWrapper.classList.contains('can-stop') && !widgetContainer.classList.contains('stop-peek')) {
            widgetContainer.classList.add('stop-peek');
            updateClickRegion('hover_collapsed');
          }
        } else if (hoveredPlayWhileCollapsed && e.clientX > pr.right - 3 && (playHoverStartX === null || e.clientX >= playHoverStartX + 3)) {
          // Когда пользователь уводит мышку от кнопки Play вправо (в сторону кнопки Стоп) — панель разъезжается!
          expandWidget();
        }
      }
    });

    if (playBtn) {
      playBtn.addEventListener('mouseenter', (e) => {
        if (collapseDebounceTimer) {
          clearTimeout(collapseDebounceTimer);
          collapseDebounceTimer = null;
        }
        if (widgetContainer.classList.contains('hover-collapsed')) {
          hoveredPlayWhileCollapsed = true;
          playHoverStartX = e.clientX;
          if (playStopWrapper && playStopWrapper.classList.contains('can-stop') && !widgetContainer.classList.contains('stop-peek')) {
            widgetContainer.classList.add('stop-peek');
            updateClickRegion('hover_collapsed');
          }
        }
      });
    }

    if (stopBtnContainer) {
      stopBtnContainer.addEventListener('mouseenter', () => {
        if (hoveredPlayWhileCollapsed) {
          expandWidget();
        }
      });
    }

    if (extraContent) {
      extraContent.addEventListener('mouseenter', () => {
        if (hoveredPlayWhileCollapsed) {
          expandWidget();
        }
      });
    }
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
        setTimeout(() => {
          updateClickRegion(isDropdownOpen ? 'dropdown' : 'expanded');
        }, 20);
      } else {
        expandedRow.classList.remove('flex');
        expandedRow.classList.add('hidden');
        expandIcon.textContent = 'open_in_full';
        isRowExpanded = false;
        updateWindowHeight();
        setTimeout(() => {
          updateClickRegion(isDropdownOpen ? 'dropdown' : 'collapsed');
        }, 20);
      }
    });
  }

  root.addEventListener('tts-menu-toggled', (e) => {
    isDropdownOpen = e.detail.expanded;
    updateWindowHeight();
    setTimeout(() => {
      updateClickRegion(isDropdownOpen ? 'dropdown' : (isRowExpanded ? 'expanded' : 'collapsed'));
    }, 25);
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

  function applyWidgetConfig(cfg) {
    if (!cfg) return;
    if (cfg.widget_scale !== undefined) {
      applyWidgetScale(cfg.widget_scale);
    }
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

    invoke('load_config').then(applyWidgetConfig).catch(() => {});
    listen('config-updated', (e) => {
      if (e.payload) applyWidgetConfig(e.payload);
    });

    listen('custom-drag-ended', (e) => {
      if (e.payload && typeof e.payload.x === 'number' && typeof e.payload.y === 'number') {
        cachedWindowPos = { x: e.payload.x, y: e.payload.y };
        localStorage.setItem('widget_pos', JSON.stringify(cachedWindowPos));
      }
    });

    // Нативные события входа/выхода курсора из интерактивной капсулы (от потока hit-test в Rust)
    listen('cursor-entered-region', () => {
      if (collapseDebounceTimer) {
        clearTimeout(collapseDebounceTimer);
        collapseDebounceTimer = null;
      }
    });

    listen('cursor-left-region', () => {
      if (collapseDebounceTimer) clearTimeout(collapseDebounceTimer);
      collapseDebounceTimer = setTimeout(() => {
        collapseWidget();
      }, 120);
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
          if (widgetContainer && widgetContainer.classList.contains('hover-collapsed') && hoveredPlayWhileCollapsed) {
            widgetContainer.classList.add('stop-peek');
            updateClickRegion('hover_collapsed');
          }
        } else if (p.action === 'pause') {
          root.updateState({ isPlaying: false, isPaused: true });
          if (widgetContainer && widgetContainer.classList.contains('hover-collapsed') && hoveredPlayWhileCollapsed) {
            widgetContainer.classList.add('stop-peek');
            updateClickRegion('hover_collapsed');
          }
        } else if (p.action === 'stop') {
          root.updateState({ isPlaying: false, isPaused: false });
          if (widgetContainer && widgetContainer.classList.contains('stop-peek')) {
            widgetContainer.classList.remove('stop-peek');
            updateClickRegion('hover_collapsed');
          }
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
