
      // Tauri Core Invoke
      const invoke = window.__TAURI__ ? window.__TAURI__.core.invoke : null;

      // Глобальные состояния
      let currentHistory = [];
      let currentActiveEntry = null;
      let audioPlayerElement = null;
      let isPlaying = false;

      // Логика переключения вкладок
      const menuItems = document.querySelectorAll('.sidebar-item');
      const tabContents = document.querySelectorAll('.tab-content');

      function switchTab(tabId) {
        menuItems.forEach(el => {
          el.classList.remove('active', 'text-[#d2bbff]', 'font-bold', 'border-r-2', 'border-[#d2bbff]', 'bg-[#1f1f24]');
          el.classList.add('text-[#ccc3d8]');
        });
        tabContents.forEach(el => el.style.display = 'none');
        
        const targetItem = document.querySelector(`.sidebar-item[data-tab="${tabId}"]`);
        if (targetItem) {
          targetItem.classList.add('active', 'text-[#d2bbff]', 'font-bold', 'border-r-2', 'border-[#d2bbff]', 'bg-[#1f1f24]');
          targetItem.classList.remove('text-[#ccc3d8]');
        }
        const targetTab = document.getElementById(tabId);
        if (targetTab) {
          targetTab.style.display = 'flex';
        }
        
        if (window.updateDashboardWidget) {
            window.updateDashboardWidget();
        }
      }

      menuItems.forEach(item => {
        item.addEventListener('click', () => {
          const activeTab = item.getAttribute('data-tab');
          switchTab(activeTab);
        });
      });

      // Логика сворачивания сайдбара
      const sidebar = document.getElementById('sidebar');
      const toggleBtn = document.getElementById('sidebar-toggle');
      const toggleIcon = document.getElementById('toggle-icon');

      toggleBtn.addEventListener('click', () => {
        const isCollapsed = sidebar.classList.contains('collapsed');
        sidebar.classList.toggle('collapsed');
        sidebar.classList.toggle('w-[200px]');
        sidebar.classList.toggle('w-[56px]');
        
        const itemsText = document.querySelectorAll('.sidebar-item-text');
        const logo = document.querySelector('.sidebar-logo');
        const subtext = document.querySelector('.sidebar-subtext');
        
        if (!isCollapsed) {
          // сворачиваем
          toggleIcon.textContent = 'keyboard_double_arrow_right';
          toggleBtn.title = "Развернуть панель";
          itemsText.forEach(el => el.style.display = 'none');
          if (logo) logo.style.display = 'none';
          if (subtext) subtext.style.display = 'none';
        } else {
          // разворачиваем
          toggleIcon.textContent = 'keyboard_double_arrow_left';
          toggleBtn.title = "Свернуть панель";
          itemsText.forEach(el => el.style.display = 'inline');
          if (logo) logo.style.display = 'block';
          if (subtext) subtext.style.display = 'block';
        }
      });

      // Спойлер стенограммы — элемент больше не используется (заменён Combo Box)
      // Оставляем пустые переменные для обратной совместимости
      const spoilerContent = document.getElementById('spoiler-content');
      const spoilerToggle = null; // удалён, не падаем с ошибкой

      // Тестовый «танец окна» по клику на логотип
      const logo = document.querySelector('.sidebar-logo');
      if (logo) {
        logo.style.cursor = 'pointer';
        logo.title = "Кликните для авто-теста перемещения окна";
        logo.addEventListener('click', async () => {
          if (window.__TAURI__) {
            try {
              const appWindow = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
              const PhysicalPosition = window.__TAURI__.dpi.PhysicalPosition;
              const startPos = await appWindow.outerPosition();
              
              let startTime = null;
              const duration = 2000; // 2 секунды танца
              
              function animate(timestamp) {
                if (!startTime) startTime = timestamp;
                const elapsed = timestamp - startTime;
                const progress = Math.min(elapsed / duration, 1);
                const angle = progress * Math.PI * 4;
                const ease = Math.sin(progress * Math.PI);
                const dx = Math.sin(angle) * 80 * ease;
                const dy = (1 - Math.cos(angle)) * 40 * ease;
                
                appWindow.setPosition(new PhysicalPosition(
                  Math.round(startPos.x + dx),
                  Math.round(startPos.y + dy)
                ));
                
                if (progress < 1) {
                  requestAnimationFrame(animate);
                } else {
                  appWindow.setPosition(new PhysicalPosition(startPos.x, startPos.y));
                }
              }
              requestAnimationFrame(animate);
            } catch (err) {
              console.error('Ошибка авто-теста перемещения:', err);
            }
          } else {
            console.log('[Tauri Mock] Запуск авто-теста движения окна');
            let angle = 0;
            const container = document.querySelector('.dashboard-container');
            if (container) {
              const interval = setInterval(() => {
                angle += 0.2;
                const dx = Math.sin(angle) * 20;
                const dy = Math.cos(angle) * 10;
                container.style.transform = `translate(${dx}px, ${dy}px)`;
                if (angle > Math.PI * 4) {
                  clearInterval(interval);
                  container.style.transform = 'none';
                }
              }, 30);
            }
          }
        });
      }

      // Кнопка запуска оверлея из вкладки OCR
      const btnTriggerOcr = document.getElementById('btn-trigger-ocr');
      if (btnTriggerOcr) {
        btnTriggerOcr.addEventListener('click', () => {
          if (window.__TAURI__) {
            const ocrWin = window.__TAURI__.webviewWindow.WebviewWindow.getByLabel('ocr');
            if (ocrWin) {
              ocrWin.show();
            }
          } else {
            console.log('[Tauri Mock] Запуск оверлея OCR (окно "ocr")');
          }
        });
      }
      
      // Глобальный хоткей из Rust (Alt + Q)
      if (window.__TAURI__) {
        window.__TAURI__.event.listen('ocr-action-trigger', () => {
          const ocrWin = window.__TAURI__.webviewWindow.WebviewWindow.getByLabel('ocr');
          if (ocrWin) {
            ocrWin.show();
          }
        });
      }

      // ==========================================================================
      // ЛОГИКА НАСТРОЕК (КОНФИГ)
      // ==========================================================================
      async function loadConfig() {
        if (invoke) {
          try {
            const config = await invoke('load_config');
            document.getElementById('setting-ui-lang').value = config.ui_lang || 'ru';
            document.getElementById('setting-dictation-lang').value = config.dictation_lang || 'auto';
            document.getElementById('setting-api-key').value = config.api_key || '';
            document.getElementById('setting-yandex-api-key').value = config.yandex_api_key || '';
            // Сначала грузим модели, потом восстанавливаем выбор
            await fetchAndPopulateModels(config.api_key, config.ai_model);
            updateApiStatus(config.api_key);
          } catch (err) {
            console.error('Ошибка загрузки настроек:', err);
          }
        } else {
          // Dev/mock режим — пробуем реальный ключ если есть
          const mockKey = '';
          document.getElementById('setting-api-key').value = mockKey;
          updateApiStatus(mockKey);
        }
      }

      async function saveConfig() {
        if (invoke) {
          const config = {
            ui_lang: document.getElementById('setting-ui-lang').value,
            dictation_lang: document.getElementById('setting-dictation-lang').value,
            api_key: document.getElementById('setting-api-key').value,
            yandex_api_key: document.getElementById('setting-yandex-api-key').value,
            ai_model: document.getElementById('setting-ai-model').value
          };
          try {
            await invoke('save_config', { config });
            updateApiStatus(config.api_key);
            console.log("Настройки сохранены:", config);
          } catch (err) {
            console.error("Ошибка сохранения настроек:", err);
          }
        }
      }

      function updateApiStatus(apiKey) {
        const statusText = document.getElementById('api-status-text');
        const statusDot = document.getElementById('api-status-dot');
        if (statusText && statusDot) {
          if (apiKey && apiKey.trim().length > 0) {
            statusText.textContent = 'Подключено';
            statusText.className = 'text-[10px] text-[#7bd6d1] font-semibold';
            statusDot.className = 'w-2 h-2 rounded-full bg-[#7bd6d1]';
            statusDot.style.boxShadow = '0 0 6px rgba(123,214,209,0.6)';
          } else {
            statusText.textContent = 'Нет ключа';
            statusText.className = 'text-[10px] text-[#ffb4ab] font-semibold';
            statusDot.className = 'w-2 h-2 rounded-full bg-[#ffb4ab]';
            statusDot.style.boxShadow = '0 0 6px rgba(255,180,171,0.6)';
          }
        }
      }

      // Известные лимиты Free Tier (обновляется из документации)
      const MODEL_LIMITS_KNOWN = {
        'gemini-2.5-pro':         { rpm: 5,   rpd: 25,   tpm: 1000000, note: 'Самая мощная, лимиты Free Tier' },
        'gemini-2.5-flash':       { rpm: 10,  rpd: 500,  tpm: 1000000, note: 'Баланс скорость/качество ✓' },
        'gemini-2.5-flash-lite':  { rpm: 30,  rpd: 1500, tpm: 1000000, note: 'Макс. скорость, Free Tier' },
        'gemini-2.0-flash':       { rpm: 15,  rpd: 1500, tpm: 1000000, note: 'Стабильная, рекомендуется' },
        'gemini-2.0-flash-lite':  { rpm: 30,  rpd: 1500, tpm: 1000000, note: 'Быстрая и экономная' },
        'gemini-1.5-flash':       { rpm: 15,  rpd: 1500, tpm: 1000000, note: 'Проверенная модель' },
        'gemini-1.5-pro':         { rpm: 2,   rpd: 50,   tpm: 32000,   note: 'Сложные задачи, малый лимит' },
      };

      async function fetchAndPopulateModels(apiKey, savedModel) {
        if (!apiKey || apiKey.trim().length < 10) return;

        const select = document.getElementById('setting-ai-model');
        const loadingBadge = document.getElementById('models-loading-badge');
        const refreshBtn = document.getElementById('btn-refresh-models');
        const infoBox = document.getElementById('model-info-box');

        // Показываем индикатор загрузки
        loadingBadge.classList.remove('hidden');
        refreshBtn.classList.add('hidden');
        select.disabled = true;

        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}&pageSize=100`
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();

          // Фильтруем только generateContent модели
          const models = (data.models || []).filter(m =>
            m.supportedGenerationMethods?.includes('generateContent') &&
            !m.name.includes('embedding') &&
            !m.name.includes('aqa')
          );

          // Сортируем: сначала новее
          models.sort((a, b) => b.name.localeCompare(a.name));

          select.innerHTML = '';
          models.forEach(m => {
            const id = m.name.replace('models/', '');
            const display = m.displayName || id;
            const limits = MODEL_LIMITS_KNOWN[id];
            let label = display;
            if (limits) label += ` — ${limits.rpd} зап/день, ${limits.rpm} RPM`;
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = label;
            select.appendChild(opt);
          });

          // Восстанавливаем сохранённую модель
          if (savedModel && select.querySelector(`option[value="${savedModel}"]`)) {
            select.value = savedModel;
          } else if (select.options.length > 0) {
            // Автовыбор: предпочитаем gemini-3.5-flash
            const preferred = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-3.1-flash-lite', 'gemini-2.0-flash'];
            for (const p of preferred) {
              if (select.querySelector(`option[value="${p}"]`)) { select.value = p; break; }
            }
          }

          // Обновляем инфо-блок под селектором
          updateModelInfo(select.value);
          loadingBadge.classList.add('hidden');
          refreshBtn.classList.remove('hidden');

          // Статус API → Активен
          const statusText = document.getElementById('api-status-text');
          const statusDot = document.getElementById('api-status-dot');
          if (statusText) {
            statusText.textContent = 'Активен';
            statusText.className = 'text-[10px] text-[#7bd6d1] font-semibold';
            statusDot.className = 'w-2 h-2 rounded-full bg-[#7bd6d1]';
            statusDot.style.boxShadow = '0 0 6px rgba(123,214,209,0.6)';
          }

        } catch (err) {
          select.innerHTML = '<option value="gemini-2.0-flash">gemini-2.0-flash (офлайн-фолбек)</option>';
          loadingBadge.classList.add('hidden');
          refreshBtn.classList.remove('hidden');
          const statusText = document.getElementById('api-status-text');
          if (statusText) {
            statusText.textContent = 'Ошибка ключа';
            statusText.className = 'text-[10px] text-[#ffb4ab] font-semibold';
          }
          console.error('[Models] Ошибка загрузки моделей:', err);
        } finally {
          select.disabled = false;
        }
      }

      function updateModelInfo(modelId) {
        const infoBox = document.getElementById('model-info-box');
        if (!infoBox) return;
        const limits = MODEL_LIMITS_KNOWN[modelId];
        if (limits) {
          infoBox.innerHTML = `
            <div class="flex flex-wrap gap-2">
              <span class="bg-[#2a292f] px-2 py-0.5 rounded text-[10px] border border-[#4a4455]/30">
                <span class="text-[#d2bbff] font-semibold">${limits.rpm}</span> запросов/мин
              </span>
              <span class="bg-[#2a292f] px-2 py-0.5 rounded text-[10px] border border-[#4a4455]/30">
                <span class="text-[#d2bbff] font-semibold">${limits.rpd}</span> запросов/день
              </span>
              <span class="bg-[#2a292f] px-2 py-0.5 rounded text-[10px] border border-[#4a4455]/30">
                <span class="text-[#7bd6d1] font-semibold">${(limits.tpm/1000).toFixed(0)}K</span> токенов/мин
              </span>
            </div>
            <p class="text-[10px] text-[#ccc3d8] mt-1">${limits.note}</p>
          `;
          infoBox.classList.remove('hidden');
        } else {
          infoBox.classList.add('hidden');
        }
      }

      // Привязываем автосохранение настроек
      document.getElementById('setting-ui-lang').addEventListener('change', saveConfig);
      document.getElementById('setting-dictation-lang').addEventListener('change', saveConfig);
      document.getElementById('setting-api-key').addEventListener('input', debounce(async () => {
        const key = document.getElementById('setting-api-key').value;
        const currentModel = document.getElementById('setting-ai-model').value;
        await fetchAndPopulateModels(key, currentModel);
        saveConfig();
      }, 1200));
      document.getElementById('setting-yandex-api-key').addEventListener('input', debounce(() => {
        saveConfig();
      }, 1000));
      document.getElementById('setting-ai-model').addEventListener('change', () => {
        updateModelInfo(document.getElementById('setting-ai-model').value);
        saveConfig();
      });
      // Кнопка ручного обновления списка моделей
      document.getElementById('btn-refresh-models').addEventListener('click', () => {
        const key = document.getElementById('setting-api-key').value;
        const currentModel = document.getElementById('setting-ai-model').value;
        fetchAndPopulateModels(key, currentModel);
      });

      function debounce(func, wait) {
        let timeout;
        return function(...args) {
          clearTimeout(timeout);
          timeout = setTimeout(() => func.apply(this, args), wait);
        };
      }

      // ==========================================================================
      // ЛОГИКА АУДИОПЛЕЕРА ДАШБОРДА
      // ==========================================================================
      function setupAudioPlayer() {
        audioPlayerElement = document.createElement('audio');
        audioPlayerElement.id = 'dashboard-audio-element';
        document.body.appendChild(audioPlayerElement);
        
        const playBtn = document.getElementById('player-play');
        const playIcon = document.getElementById('player-play-icon');
        const progressBar = document.getElementById('player-progress');
        const playerTime = document.getElementById('player-time');
        const scrubberContainer = document.getElementById('player-scrubber-container');
        
        playBtn.addEventListener('click', () => {
          if (!audioPlayerElement.src) return;
          
          if (isPlaying) {
            audioPlayerElement.pause();
          } else {
            audioPlayerElement.play().catch(err => console.error("Ошибка запуска аудио:", err));
          }
        });
        
        audioPlayerElement.addEventListener('play', () => {
          isPlaying = true;
          playIcon.textContent = 'pause';
          playBtn.title = "Пауза";
        });
        
        audioPlayerElement.addEventListener('pause', () => {
          isPlaying = false;
          playIcon.textContent = 'play_arrow';
          playBtn.title = "Воспроизвести";
        });
        
        audioPlayerElement.addEventListener('timeupdate', () => {
          if (audioPlayerElement.duration) {
            const progress = (audioPlayerElement.currentTime / audioPlayerElement.duration) * 100;
            progressBar.style.width = `${progress}%`;
            
            const curMins = Math.floor(audioPlayerElement.currentTime / 60);
            const curSecs = Math.floor(audioPlayerElement.currentTime % 60).toString().padStart(2, '0');
            playerTime.textContent = `${curMins}:${curSecs}`;
          }
        });
        
        audioPlayerElement.addEventListener('ended', () => {
          isPlaying = false;
          playIcon.textContent = 'play_arrow';
          progressBar.style.width = "0%";
          if (currentActiveEntry) {
            const mins = Math.floor(currentActiveEntry.duration_secs / 60);
            const secs = currentActiveEntry.duration_secs % 60;
            playerTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
          }
        });

        // Перемотка
        scrubberContainer.addEventListener('click', (e) => {
          if (!audioPlayerElement.src || !audioPlayerElement.duration) return;
          const rect = scrubberContainer.getBoundingClientRect();
          const clickX = e.clientX - rect.left;
          const width = rect.width;
          const percentage = clickX / width;
          audioPlayerElement.currentTime = percentage * audioPlayerElement.duration;
        });
      }

      // ==========================================================================
      // ЛОГИКА ИСТОРИИ И АКТИВНОСТИ
      // ==========================================================================
      async function refreshHistory() {
        if (invoke) {
          try {
            currentHistory = await invoke('load_history');
            renderHistory();
            if (currentHistory.length > 0) {
              renderActiveCard(currentHistory[0]);
            } else {
              renderActiveCard(null);
            }
          } catch (err) {
            console.error("Ошибка загрузки истории:", err);
          }
        } else {
          // Mock данные для браузера
          currentHistory = [
            {
              id: "rec_1",
              timestamp: "02.06.2026 • 02:30",
              duration_secs: 42,
              preset: "summary",
              preset_label: "Собрать суть",
              transcript: "Пользователь предложил реализовать архитектуру оверлея экранного переводчика на базе прерывистых SVG-линий, проходящих через центр слов. Это решает проблему наложения текста и сохраняет полную читаемость исходных шрифтов. В компактном виджете голосового чтения убран фиксированный переключатель языковых пар, заменен на контекстную кнопку перевода, а кнопка выбора голоса дополнена иконкой динамика для ясности назначения.",
              audio_path: "C:\\Users\\wisey\\AppData\\Local\\tauri-app\\records\\rec_1.webm"
            },
            {
              id: "rec_2",
              timestamp: "01.06.2026 • 22:45",
              duration_secs: 72,
              preset: "tasks",
              preset_label: "Задачи",
              transcript: "- Настроить дизайн оверлея на Tailwind CSS.\n- Интегрировать MediaRecorder для записи в формате WebM.\n- Подключить локальный OCR для Bezier-нитей.",
              audio_path: "C:\\Users\\wisey\\AppData\\Local\\tauri-app\\records\\rec_2.webm"
            }
          ];
          renderHistory();
          renderActiveCard(currentHistory[0]);
        }
      }

      function getPresetIcon(preset) {
        const icons = {
          summary: 'auto_awesome',
          tasks: 'task_alt',
          email: 'mail',
          transcript: 'transcribe',
          custom: 'tune',
          cancelled: 'cancel',
          error: 'error'
        };
        return icons[preset] || 'mic';
      }

      function getPresetColor(preset) {
        const colors = {
          summary: '#d2bbff',
          tasks: '#7bd6d1',
          email: '#a8c7fa',
          transcript: '#ffd966',
          custom: '#8e52ff',
          cancelled: '#888',
          error: '#f05454'
        };
        return colors[preset] || '#ccc3d8';
      }

      // Текущая развёрнутая карточка в истории
      let expandedHistoryId = null;
      // Активный плеер в истории
      let historyAudio = null;
      let historyPlayingId = null;

      function renderHistory() {
        const historyList = document.getElementById('history-list');
        const historyCount = document.getElementById('history-count');
        if (!historyList) return;

        if (historyCount) {
          historyCount.textContent = currentHistory.length > 0
            ? `${currentHistory.length} записей`
            : '';
        }

        if (currentHistory.length === 0) {
          historyList.innerHTML = `
            <div class="text-center py-12 flex flex-col items-center gap-3">
              <span class="material-symbols-outlined text-[40px] text-[#4a4455]">mic_off</span>
              <p class="text-[13px] text-[#ccc3d8]/60">История пуста. Начните запись через капсулу (Ctrl+Win).</p>
            </div>
          `;
          return;
        }

        historyList.innerHTML = currentHistory.map(entry => {
          const mins = Math.floor(entry.duration_secs / 60);
          const secs = entry.duration_secs % 60;
          const durationStr = mins > 0 ? `${mins}м ${secs}с` : `${secs} сек`;
          
          const isExpanded = expandedHistoryId === entry.id;
          const firstAi = entry.ai_results && entry.ai_results.length > 0 ? entry.ai_results[0] : null;
          // Обратная совместимость: старые записи используют transcript + preset + preset_label
          const baseText = entry.raw_transcript || entry.transcript || '';
          const textPreview = (firstAi ? firstAi.text : baseText).substring(0, 120);
          const entryPresetLabel = firstAi ? firstAi.preset_label : (entry.preset_label || (baseText ? 'Запись' : 'Отменено'));
          const entryPreset = firstAi ? firstAi.preset : (entry.preset || (baseText ? 'transcript' : 'cancelled'));
          const isError = entryPreset === 'error';


          return `
            <div class="rounded-xl border transition-all duration-200 overflow-hidden"
                 style="background: ${isError ? 'rgba(240,84,84,0.05)' : isExpanded ? '#1a1a22' : '#141419'};
                        border-color: ${isExpanded ? getPresetColor(entryPreset) + '40' : 'rgba(74,68,85,0.25)'};"
                 id="hcard-${entry.id}">
              <div class="flex items-start gap-3 p-3 cursor-pointer" onclick="toggleHistoryCard('${entry.id}')">
                <div class="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center mt-0.5"
                     style="background: ${getPresetColor(entryPreset)}18;">
                  <span class="material-symbols-outlined text-[16px]" style="color: ${getPresetColor(entryPreset)}; font-variation-settings: 'FILL' 1;">${getPresetIcon(entryPreset)}</span>
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-0.5">
                    <span class="text-[12px] font-semibold" style="color: ${getPresetColor(entryPreset)};">${entryPresetLabel}</span>
                    <span class="text-[10px] text-[#888]">${entry.timestamp} • ${durationStr}</span>
                  </div>
                  <p class="text-[12px] text-[#ccc3d8] leading-[1.4] ${isExpanded ? 'hidden' : ''}">${textPreview}</p>
                </div>
                <div class="flex items-center gap-1 flex-shrink-0">
                  <button class="p-1.5 rounded text-[#ccc3d8] hover:text-[#d2bbff] hover:bg-[#2a292f] transition-all"
                          onclick="event.stopPropagation(); openFolder('${entry.audio_path.replace(/\\/g, '\\\\')}')">
                    <span class="material-symbols-outlined text-[15px]">folder_open</span>
                  </button>
                  <button class="p-1.5 rounded text-[#ccc3d8] hover:text-[#ffb4ab] hover:bg-[#2a292f] transition-all"
                          onclick="event.stopPropagation(); deleteEntry('${entry.id}')">
                    <span class="material-symbols-outlined text-[15px]">delete</span>
                  </button>
                </div>
              </div>

              <div class="${isExpanded ? '' : 'hidden'}" id="hcard-body-${entry.id}">
                <div class="px-3 pb-3">
                  <select class="bg-[#0e0e13] border border-[#4a4455]/30 text-[#e4e1e9] rounded-lg px-2 py-1 text-[11px] mb-2 w-full focus:outline-none"
                          id="hcard-view-${entry.id}"
                          onchange="switchHistoryView('${entry.id}')">
                    <option value="transcript">📝 Транскрипция</option>
                    ${(entry.ai_results || []).map((r, i) =>
                      `<option value="ai_${i}">✨ Результат ${i+1} (${r.preset_label})</option>`
                    ).join('')}
                  </select>
                  <div class="bg-[#0e0e13] rounded-lg p-3 mb-2 text-[13px] leading-[1.7] text-[#ccc3d8] max-h-56 overflow-y-auto"
                       id="hcard-text-${entry.id}">
                    ${(firstAi ? firstAi.text : entry.raw_transcript) || '—'}
                  </div>
                  <div class="flex items-center gap-2 bg-[#1f1f24] rounded-lg px-3 py-2">
                    <button class="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center transition-all"
                            onclick="toggleHistoryPlay('${entry.id}', '${entry.audio_path.replace(/\\/g, '\\\\')}')" 
                            id="hplay-btn-${entry.id}">
                      <span class="material-symbols-outlined text-[16px]" style="color: ${getPresetColor(entryPreset)};" id="hplay-icon-${entry.id}">${historyPlayingId === entry.id ? 'pause' : 'play_arrow'}</span>
                    </button>
                    <div class="flex-1 h-1 bg-[#35343a] rounded-full overflow-hidden" id="hprogress-bar-${entry.id}">
                      <div class="h-full rounded-full transition-all" style="width: 0%; background: ${getPresetColor(entryPreset)};" id="hprogress-${entry.id}"></div>
                    </div>
                    <span class="text-[10px] text-[#888] font-mono w-12 text-right" id="htime-${entry.id}">0:00</span>
                    <button class="p-1 rounded text-[#ccc3d8] hover:text-[#d2bbff]" onclick="copyHistoryText('${entry.id}')" title="Копировать">
                      <span class="material-symbols-outlined text-[14px]">content_copy</span>
                    </button>
                    <button class="p-1 rounded text-[#ccc3d8] hover:text-[#7bd6d1]" onclick="editHistoryCard('${entry.id}')" title="Редактировать" id="hbtn-edit-${entry.id}">
                      <span class="material-symbols-outlined text-[14px]">edit</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('');
      }

      const lastViewMode = {};
      function switchHistoryView(entryId) {
        const entry = currentHistory.find(e => e.id === entryId);
        if (!entry) return;
        const sel = document.getElementById(`hcard-view-${entryId}`);
        const textEl = document.getElementById(`hcard-text-${entryId}`);
        if (!sel || !textEl) return;
        const val = sel.value;
        lastViewMode[entryId] = val;
        textEl.textContent = getDisplayText(entry, val) || '—';
      }

      function editHistoryCard(entryId) {
        const textEl = document.getElementById(`hcard-text-${entryId}`);
        const editBtn = document.getElementById(`hbtn-edit-${entryId}`);
        if (!textEl || textEl.tagName === 'TEXTAREA') return; // уже в режиме редактирования

        const originalText = textEl.textContent.trim();

        // Заменяем div на textarea
        const ta = document.createElement('textarea');
        ta.value = originalText;
        ta.id = `hcard-text-${entryId}`;
        ta.className = 'bg-[#0e0e13] rounded-lg p-3 mb-2 text-[13px] leading-[1.7] text-[#e4e1e9] w-full resize-none border border-[#7bd6d1]/40 focus:outline-none focus:border-[#7bd6d1]';
        ta.rows = 6;
        ta.style.cssText = 'font-family: inherit; max-height: 224px; overflow-y: auto;';
        textEl.replaceWith(ta);
        ta.focus();

        // Добавляем кнопки Сохранить / Отмена
        const btnRow = document.createElement('div');
        btnRow.id = `hcard-edit-btns-${entryId}`;
        btnRow.className = 'flex gap-2 mb-2';
        btnRow.innerHTML = `
          <button onclick="saveHistoryEdit('${entryId}')"
                  class="flex-1 bg-[#7bd6d1]/20 border border-[#7bd6d1]/40 text-[#7bd6d1] rounded-lg px-3 py-1.5 text-[11px] font-semibold hover:bg-[#7bd6d1]/30 transition-all">
            ✓ Сохранить
          </button>
          <button onclick="cancelHistoryEdit('${entryId}', ${JSON.stringify(originalText)})"
                  class="bg-[#2a292f] border border-[#4a4455]/40 text-[#ccc3d8] rounded-lg px-3 py-1.5 text-[11px] font-semibold hover:bg-[#35343a] transition-all">
            Отмена
          </button>
        `;
        ta.after(btnRow);

        if (editBtn) editBtn.querySelector('span').textContent = 'edit_off';
      }

      function saveHistoryEdit(entryId) {
        const ta = document.getElementById(`hcard-text-${entryId}`);
        if (!ta) return;
        const newText = ta.value.trim();

        // Обновляем данные в памяти
        const entry = currentHistory.find(e => e.id === entryId);
        if (entry) {
          const sel = document.getElementById(`hcard-view-${entryId}`);
          const viewVal = sel ? sel.value : 'transcript';
          if (viewVal === 'transcript') {
            if (entry.raw_transcript !== undefined) entry.raw_transcript = newText;
            else entry.transcript = newText;
          } else if (viewVal.startsWith('ai_')) {
            const idx = parseInt(viewVal.replace('ai_', ''));
            if (entry.ai_results && entry.ai_results[idx]) {
              entry.ai_results[idx].text = newText;
            }
          }
        }

        cancelHistoryEdit(entryId, newText); // восстанавливаем div с новым текстом
      }

      function cancelHistoryEdit(entryId, text) {
        const ta = document.getElementById(`hcard-text-${entryId}`);
        const btnRow = document.getElementById(`hcard-edit-btns-${entryId}`);
        const editBtn = document.getElementById(`hbtn-edit-${entryId}`);
        if (!ta) return;

        const div = document.createElement('div');
        div.id = `hcard-text-${entryId}`;
        div.className = 'bg-[#0e0e13] rounded-lg p-3 mb-2 text-[13px] leading-[1.7] text-[#ccc3d8] max-h-56 overflow-y-auto';
        div.style.userSelect = 'text';
        div.textContent = text;
        ta.replaceWith(div);
        if (btnRow) btnRow.remove();
        if (editBtn) editBtn.querySelector('span').textContent = 'edit';
      }

      function toggleHistoryCard(id) {
        expandedHistoryId = (expandedHistoryId === id) ? null : id;
        renderHistory();
        if (expandedHistoryId) {
            const sel = document.getElementById(`hcard-view-${id}`);
            if (sel && lastViewMode[id]) sel.value = lastViewMode[id];
        }
      }

      function toggleHistoryPlay(id, audioPath) {
        if (historyPlayingId === id && historyAudio) {
          historyAudio.pause();
          historyPlayingId = null;
          document.getElementById(`hplay-icon-${id}`).textContent = 'play_arrow';
          return;
        }
        if (historyAudio) historyAudio.pause();
        historyAudio = new Audio(audioPath);
        historyPlayingId = id;
        document.getElementById(`hplay-icon-${id}`).textContent = 'pause';
        
        historyAudio.addEventListener('timeupdate', () => {
          if (historyAudio.duration) {
            const pct = (historyAudio.currentTime / historyAudio.duration) * 100;
            document.getElementById(`hprogress-${id}`).style.width = `${pct}%`;
          }
        });
        historyAudio.addEventListener('ended', () => {
          historyPlayingId = null;
          document.getElementById(`hplay-icon-${id}`).textContent = 'play_arrow';
        });
        historyAudio.play().catch(e => console.error('Аудио ошибка:', e));
      }

      function copyHistoryText(entryId) {
        const entry = currentHistory.find(e => e.id === entryId);
        if (!entry) return;
        const sel = document.getElementById(`hcard-view-${entryId}`);
        const viewMode = sel ? sel.value : 'ai_0';
        const text = getDisplayText(entry, viewMode);
        navigator.clipboard.writeText(text || '').then(() => {
          showToast('Текст скопирован', false);
        });
      }



      // Утилита: получить текущий текст для активной карточки
      // Поддерживает обе структуры: старую (transcript) и новую (raw_transcript + ai_results)
      function getDisplayText(entry, viewMode) {
        if (!entry) return '';
        // Определяем базовый текст: новый raw_transcript или старый transcript
        const baseText = entry.raw_transcript || entry.transcript || '';
        if (!viewMode || viewMode === 'transcript') return baseText;
        if (viewMode === 'ai_0' && (!entry.ai_results || entry.ai_results.length === 0)) {
          // Старая структура: transcript содержит уже AI-результат
          return baseText;
        }
        const idx = parseInt(viewMode.replace('ai_', ''));
        const ai = entry.ai_results && entry.ai_results[idx];
        return ai ? ai.text : baseText;

      }

      let dashboardViewMode = localStorage.getItem('dashboardViewMode') || 'ai_0';

      function onDashboardViewChange() {
        const combo = document.getElementById('dashboard-view-combo');
        if (!combo) return;
        dashboardViewMode = combo.value;
        localStorage.setItem('dashboardViewMode', dashboardViewMode);
        if (!currentActiveEntry) return;
        const summaryText = document.getElementById('summary-text');
        const displayText = getDisplayText(currentActiveEntry, dashboardViewMode);
        if (summaryText) summaryText.innerHTML = (displayText || '—').replace(/\n/g, '<br>');
      }

      // Озвучить — отправляем текст в локальный VoiceCore через tts-state-sync
      const btnSpeakText = document.getElementById('btn-speak-text');
      let dashboardTtsPlaying = false;

      if (btnSpeakText) {
        btnSpeakText.addEventListener('click', async () => {
          if (dashboardTtsPlaying) {
            // Если играет, отправляем паузу
            if (window.__TAURI__) {
              await window.__TAURI__.event.emit('tts-state-sync', { action: 'pause' });
            }
          } else {
            // Если на паузе или остановлено, загружаем и играем
            if (!currentActiveEntry) return;
            const text = getDisplayText(currentActiveEntry, dashboardViewMode);
            if (!text) return;

            if (window.__TAURI__) {
              await window.__TAURI__.event.emit('tts-state-sync', { action: 'load', text });
              await window.__TAURI__.event.emit('tts-state-sync', { action: 'play' });
            } else {
              // Фоллбэк
              if ('speechSynthesis' in window) {
                window.speechSynthesis.cancel();
                const utt = new SpeechSynthesisUtterance(text);
                utt.lang = 'ru-RU';
                window.speechSynthesis.speak(utt);
              }
              showToast('Озвучивание...', false);
            }
          }
        });

        // Слушаем tts-state-sync для синхронизации иконки
        if (window.__TAURI__) {
      function renderActiveCard(entry) {
        currentActiveEntry = entry;
        const summaryText = document.getElementById('summary-text');
        const activityTime = document.getElementById('activity-time');
        const activityModel = document.getElementById('activity-model');
        const spoilerContent = document.getElementById('spoiler-content');
        const spoilerToggle = document.getElementById('spoiler-toggle');

        if (!entry) {
          if (summaryText) summaryText.textContent = 'Нет данных. Создайте первую запись через капсулу (Ctrl+Win).';
          if (activityTime) activityTime.textContent = '—';
          return;
        }

        // Обновляем Combo Box главной карточки
        const dashCombo = document.getElementById('dashboard-view-combo');
        if (dashCombo) {
          dashCombo.innerHTML = `<option value="transcript">📝 Транскрипция</option>`
            + (entry.ai_results || []).map((r, i) =>
              `<option value="ai_${i}">✨ ${entry.ai_results.length > 1 ? 'Результат ' + (i+1) + ' — ' : ''}${r.preset_label}</option>`
            ).join('');
          // Восстанавливаем последний выбранный вид
          const saved = localStorage.getItem('dashboardViewMode') || 'ai_0';
          if (dashCombo.querySelector(`option[value="${saved}"]`)) {
            dashCombo.value = saved;
            dashboardViewMode = saved;
          } else {
            dashCombo.value = entry.ai_results && entry.ai_results.length > 0 ? 'ai_0' : 'transcript';
            dashboardViewMode = dashCombo.value;
          }
        }

        // Отображаем текст
        const displayText = getDisplayText(entry, dashboardViewMode);
        if (summaryText) summaryText.innerHTML = (displayText || '—').replace(/\n/g, '<br>');
        if (spoilerContent) spoilerContent.textContent = entry.raw_transcript || '—';
        if (activityTime) activityTime.textContent = entry.timestamp || '—';
        if (activityModel) {
          const firstAi = entry.ai_results && entry.ai_results[0];
          activityModel.textContent = firstAi ? firstAi.preset_label : 'Транскрипция';
        }
        
        if (window.__TAURI__) {
          try {
            const audioUrl = window.__TAURI__.core.convertFileSrc(entry.audio_path);
            audioPlayerElement.src = audioUrl;
            audioPlayerElement.load();
          } catch (e) {
            console.error("Ошибка конвертации локального пути аудио:", e);
          }
        } else {
          audioPlayerElement.src = ""; 
        }
        
        const mins = Math.floor(entry.duration_secs / 60);
        const secs = entry.duration_secs % 60;
        document.getElementById('player-time').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        document.getElementById('player-progress').style.width = "0%";

        // Обновляем иконку типа записи
        const typeIcon = document.getElementById('activity-type-icon');
        if (typeIcon) {
          // Если preset === 'transcript' или запись от микрофона → микрофон; текст → текстовая иконка
          typeIcon.textContent = (entry.preset === 'text_input') ? 'text_fields' : 'mic';
        }
        // Скрываем плеер при смене записи
        const playerPanel = document.getElementById('player-panel');
        if (playerPanel) { playerPanel.classList.add('hidden'); playerPanel.classList.remove('flex'); }
      }

      // Тогол плеера — клик на иконку записи
      const btnTogglePlayer = document.getElementById('btn-toggle-player');
      if (btnTogglePlayer) {
        btnTogglePlayer.addEventListener('click', () => {
          const panel = document.getElementById('player-panel');
          if (!panel) return;
          const isHidden = panel.classList.contains('hidden');
          panel.classList.toggle('hidden', !isHidden);
          panel.classList.toggle('flex', isHidden);
        });
      }


      // Настройка Магнита капсулы — сохраняем + передаём в капсулу
      const magnetToggle = document.getElementById('setting-capsule-magnet');
      const magnetTrack  = document.getElementById('magnet-toggle-track');
      const magnetThumb  = document.getElementById('magnet-toggle-thumb');

      function syncMagnetToggleUI(isChecked) {
        if (!magnetTrack || !magnetThumb) return;
        magnetTrack.style.background = isChecked ? '#8e52ff' : '#35343a';
        magnetThumb.style.left = isChecked ? '20px' : '2px';
      }

      if (magnetToggle) {
        // Восстанавливаем сохранённое значение (null = по умолчанию true)
        const saved = localStorage.getItem('capsuleMagnet');
        magnetToggle.checked = saved === null ? true : saved === 'true';
        syncMagnetToggleUI(magnetToggle.checked);

        magnetToggle.addEventListener('change', () => {
          localStorage.setItem('capsuleMagnet', magnetToggle.checked);
          syncMagnetToggleUI(magnetToggle.checked);
          if (window.__TAURI__) {
            window.__TAURI__.event.emit('capsule-magnet-changed', magnetToggle.checked).catch(() => {});
          }
        });
      }

      window.selectHistoryEntry = function(id) {
        const entry = currentHistory.find(e => e.id === id);
        if (entry) {
          renderActiveCard(entry);
          switchTab('tab-home');
        }
      };

      window.openFolder = async function(path) {
        if (invoke) {
          try {
            await invoke('open_audio_folder', { path });
          } catch (err) {
            console.error(err);
            showToast('Не удалось открыть файл: ' + err, true);
          }
        } else {
          console.log('[Tauri Mock] Открытие папки для:', path);
        }
      };

      window.deleteEntry = async function(id) {
        if (confirm('Вы уверены, что хотите удалить эту запись?')) {
          if (invoke) {
            try {
              currentHistory = await invoke('delete_history_entry', { id });
              renderHistory();
              if (currentActiveEntry && currentActiveEntry.id === id) {
                renderActiveCard(currentHistory[0] || null);
              }
              showToast('Запись удалена', false);
            } catch (err) {
              console.error(err);
              showToast('Ошибка при удалении: ' + err, true);
            }
          } else {
            currentHistory = currentHistory.filter(e => e.id !== id);
            renderHistory();
            if (currentActiveEntry && currentActiveEntry.id === id) {
              renderActiveCard(currentHistory[0] || null);
            }
            showToast('Запись удалена (Mock)', false);
          }
        }
      };

      // ================================================================
      // КНОПКИ ДЕЙСТВИЙ НА ГЛАВНОЙ КАРТОЧКЕ
      // ================================================================

      // Копировать
      const activeCardCopyBtn = document.getElementById('btn-copy-active');
      if (activeCardCopyBtn) {
        activeCardCopyBtn.addEventListener('click', async () => {
          if (!currentActiveEntry) return showToast('Нет активной записи', true);
          const text = getDisplayText(currentActiveEntry, dashboardViewMode);
          try {
            if (window.__TAURI__ && window.__TAURI__.clipboardManager) {
              await window.__TAURI__.clipboardManager.writeText(text);
            } else {
              await navigator.clipboard.writeText(text);
            }
            showToast('Скопировано в буфер обмена!', false);
          } catch (err) {
            console.error(err);
            showToast('Ошибка при копировании', true);
          }
        });
      }

      // Удалить
      const activeCardDeleteBtn = document.getElementById('btn-delete-active');
      if (activeCardDeleteBtn) {
        activeCardDeleteBtn.addEventListener('click', () => {
          if (currentActiveEntry) deleteEntry(currentActiveEntry.id);
        });
      }


      // Тоггл: Капсула
      const toggleCapsule = document.getElementById('toggle-capsule');
      if (toggleCapsule) {
        toggleCapsule.addEventListener('change', async () => {
          if (!invoke) return;
          try {
            if (toggleCapsule.checked) {
              await invoke('show_capsule_window');
            } else {
              await invoke('hide_capsule_window');
            }
          } catch (err) {
            console.error('Ошибка управления капсулой:', err);
          }
        });
      }

      // Тоггл: Виджет
      const toggleWidget = document.getElementById('toggle-widget');
      if (toggleWidget) {
        toggleWidget.addEventListener('change', async () => {
          if (!invoke) return;
          try {
            if (toggleWidget.checked) {
              await invoke('show_widget_window').catch(() => {});
            } else {
              await invoke('hide_widget_window').catch(() => {});
            }
          } catch (err) {
            console.error('Ошибка управления виджетом:', err);
          }
        });
      }


      // Функция показа тостов (уведомлений)
      function showToast(message, isError = false) {
        const toast = document.getElementById('dashboard-toast');
        const toastMsg = document.getElementById('dashboard-toast-message');
        const toastIcon = toast ? toast.querySelector('span.material-symbols-outlined') : null;
        
        if (!toast || !toastMsg) return;
        
        toastMsg.textContent = message;
        if (isError) {
          toast.style.backgroundColor = '#93000a';
          toast.style.borderColor = 'rgba(240, 84, 84, 0.4)';
          if (toastIcon) {
            toastIcon.textContent = 'error';
            toastIcon.style.color = '#ffb4ab';
          }
        } else {
          toast.style.backgroundColor = '#1f1f24';
          toast.style.borderColor = 'rgba(142, 82, 255, 0.3)';
          if (toastIcon) {
            toastIcon.textContent = 'info';
            toastIcon.style.color = '#8e52ff';
          }
        }
        
        toast.classList.remove('opacity-0', 'pointer-events-none');
        toast.classList.add('opacity-100');
        
        setTimeout(() => {
          toast.classList.remove('opacity-100');
          toast.classList.add('opacity-0', 'pointer-events-none');
        }, 4000);
      }

      // Инициализация при загрузке
      document.addEventListener('DOMContentLoaded', async () => {
        setupAudioPlayer();
        await loadConfig();
        await refreshHistory();
        // Запускаем self-test через 500мс после загрузки
        setTimeout(runSelfTest, 500);
      });

      // ==========================================================================
      // ВСТРОЕННЫЙ SELF-TEST
      // ==========================================================================
      function runSelfTest() {
        const results = [];
        const PASS = '✅';
        const FAIL = '❌';

        function check(name, fn) {
          try {
            const ok = fn();
            results.push({ name, ok: !!ok, error: null });
          } catch (e) {
            results.push({ name, ok: false, error: e.message });
          }
        }

        // --- DOM элементы ---
        const REQUIRED_IDS = [
          'tab-home', 'tab-history', 'tab-ocr', 'tab-settings',
          'history-list', 'setting-api-key', 'setting-ai-model',
          'dashboard-view-combo', 'summary-text', 'activity-time',
          'win-minimize', 'win-maximize', 'win-close',
          'sidebar-toggle', 'player-play', 'player-progress',
          'api-status-text', 'api-status-dot',
        ];
        REQUIRED_IDS.forEach(id => {
          check(`DOM: #${id} существует`, () => !!document.getElementById(id));
        });

        // --- Навигация ---
        const navTabs = ['tab-home', 'tab-ocr', 'tab-history', 'tab-settings'];
        navTabs.forEach(tabId => {
          check(`NAV: sidebar-item[data-tab="${tabId}"] кликабелен`, () => {
            const btn = document.querySelector(`.sidebar-item[data-tab="${tabId}"]`);
            return btn && btn.tagName === 'BUTTON';
          });
        });

        check('NAV: switchTab переключает вкладку', () => {
          switchTab('tab-history');
          const historyTab = document.getElementById('tab-history');
          const visible = historyTab && historyTab.style.display !== 'none';
          switchTab('tab-home'); // возвращаем назад
          return visible;
        });

        // --- Sidebar toggle ---
        check('UI: sidebar-toggle существует и кликабелен', () => {
          const btn = document.getElementById('sidebar-toggle');
          return btn && typeof btn.click === 'function';
        });

        // --- Combo Box ---
        check('UI: dashboard-view-combo имеет опции', () => {
          const combo = document.getElementById('dashboard-view-combo');
          return combo && combo.options.length >= 1;
        });

        // --- API статус ---
        check('API: api-status-text не пустой', () => {
          const el = document.getElementById('api-status-text');
          return el && el.textContent.trim().length > 0;
        });

        // --- History list ---
        check('DATA: history-list существует', () => {
          return !!document.getElementById('history-list');
        });

        // --- Вывод результатов ---
        const passed = results.filter(r => r.ok).length;
        const failed = results.filter(r => !r.ok).length;
        const total = results.length;

        console.group(`%c🧪 SINC PRO Self-Test: ${passed}/${total} passed`, 
          `color: ${failed === 0 ? '#7bd6d1' : '#ffb4ab'}; font-weight: bold; font-size: 14px;`);
        results.forEach(r => {
          if (r.ok) {
            console.log(`%c${PASS} ${r.name}`, 'color: #7bd6d1');
          } else {
            console.warn(`%c${FAIL} ${r.name}${r.error ? ': ' + r.error : ''}`, 'color: #ffb4ab; font-weight: bold');
          }
        });
        if (failed === 0) {
          console.log('%c✨ Все проверки пройдены!', 'color: #d2bbff; font-weight: bold');
        } else {
          console.error(`%c⚠️ ${failed} проверок провалено — нужна доработка`, 'color: #ff6b6b; font-weight: bold');
        }
        console.groupEnd();

        // Сохраняем результат глобально для Playwright
        window.__SINC_TEST_RESULTS__ = { passed, failed, total, results };
      }

      // ==========================================================================
      // ТАУРИ ВЗАИМОДЕЙСТВИЕ И СОБЫТИЯ
      // ==========================================================================
      if (window.__TAURI__) {
        const appWindow = window.__TAURI__.webviewWindow.getCurrentWebviewWindow();
        const WebviewWindow = window.__TAURI__.webviewWindow.WebviewWindow;
        
        const dragRegion = document.getElementById('drag-region');
        if (dragRegion) {
          dragRegion.addEventListener('mousedown', (e) => {
            if (e.buttons === 1) {
              appWindow.startDragging();
            }
          });
        }
        
        document.getElementById('win-minimize').addEventListener('click', () => appWindow.minimize());
        document.getElementById('win-maximize').addEventListener('click', async () => {
          if (await appWindow.isMaximized()) {
            appWindow.unmaximize();
          } else {
            appWindow.maximize();
          }
        });
        document.getElementById('win-close').addEventListener('click', () => appWindow.close());

        // Управление видимостью окон через тумблеры на панели
        const toggleCapsule = document.getElementById('toggle-capsule');
        const toggleWidget = document.getElementById('toggle-widget');

        if (toggleCapsule) {
          toggleCapsule.addEventListener('change', async (e) => {
            const win = WebviewWindow.getByLabel('capsule');
            if (win) {
              if (e.target.checked) {
                await win.show();
              } else {
                await win.hide();
              }
            }
          });
        }

        // Тогглы окон (Tauri-блок) — слушаем только обратные события видимости

        // Слушаем события
        window.__TAURI__.event.listen('open-settings', () => {
          appWindow.show();
          appWindow.setFocus();
          switchTab('tab-settings');
        });

        window.__TAURI__.event.listen('open-history', () => {
          appWindow.show();
          appWindow.setFocus();
          switchTab('tab-history');
        });

        window.__TAURI__.event.listen('capsule-visibility-changed', (event) => {
          if (toggleCapsule) {
            toggleCapsule.checked = event.payload;
          }
        });

        window.__TAURI__.event.listen('widget-visibility-changed', (event) => {
          if (toggleWidget) {
            toggleWidget.checked = event.payload;
          }
        });

        // Слушаем событие обновления истории от капсулы
        window.__TAURI__.event.listen('history-updated', () => {
          refreshHistory();
        });
      }
    
  }
});
