const { invoke } = window.__TAURI__.core;
const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;
const { PhysicalSize, PhysicalPosition } = window.__TAURI__.dpi;
const { emit, listen } = window.__TAURI__.event;

const appWindow = getCurrentWebviewWindow();

function logToBackend(message) {
  console.log(message);
  invoke('write_js_log', { log: message }).catch(() => {});
}

window.onerror = function (message, source, lineno, colno, error) {
  const errText = `JS Error: ${message} at ${source}:${lineno}:${colno}`;
  logToBackend(errText);
  return false;
};

window.onunhandledrejection = function (event) {
  const errText = `Unhandled Rejection: ${event.reason}`;
  logToBackend(errText);
};

const svgCanvas = document.getElementById('svg-canvas');
const wordsContainer = document.getElementById('words-container');
const tooltip = document.getElementById('tooltip');
const lensContainer = document.getElementById('lens-container');
const toolbar = document.getElementById('toolbar-island');
const selectionOverlay = document.getElementById('selection-overlay');
const selectionBox = document.getElementById('selection-box');
const translationContainer = document.getElementById('translation-container');

let currentOcrData = null;
let isSelecting = false;
let isMouseDown = false;
let startX = 0, startY = 0;
let isAltPressed = false;

// Хранение данных монитора для выделения области
let monitorLeft = 0;
let monitorTop = 0;
let monitorWidth = 0;
let monitorHeight = 0;
let scaleFactor = 1.0;

// Цвета для разных предложений
const sentenceColors = [
  '#00D7FF', '#FF0055', '#00FF66', '#FFD700', '#FF00FF', '#00FFFF', '#FF5500', '#A020F0'
];

// Управление окном
document.getElementById('btn-close').addEventListener('click', async () => {
  await appWindow.hide();
  await emit('ocr-visibility-changed', false);
  clearCanvas();
});

// Слушаем триггер запуска оверлея
listen('ocr-action-trigger', async () => {
  await startSelectionMode();
});

// Слушаем изменение видимости окна оверлея
listen('ocr-visibility-changed', async (event) => {
  logToBackend(`[OCR] ocr-visibility-changed event received: payload=${event.payload}`);
  if (event.payload === true) {
    await startSelectionMode();
  } else {
    // Если оверлей скрывается, сбрасываем состояние
    isAltPressed = false;
    document.body.classList.remove('alt-held');
    selectionOverlay.style.display = 'none';
    lensContainer.style.display = 'none';
    document.body.style.pointerEvents = 'none';
    clearCanvas();
    logToBackend(`[OCR] Overlay hidden, state cleared`);
  }
});

// Запуск режима выделения области (как "Ножницы")
async function startSelectionMode() {
  try {
    logToBackend(`[OCR] startSelectionMode called`);
    clearCanvas();
    isSelecting = true;
    isMouseDown = false;
    isAltPressed = false;
    document.body.classList.remove('alt-held');
    
    // Показываем полноэкранный темный фон и скрываем линзу
    selectionOverlay.style.display = 'block';
    selectionOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.4)'; // Затемнение экрана
    lensContainer.style.display = 'none';
    document.body.style.pointerEvents = 'auto';
    
    // Получаем информацию обо всех мониторах (виртуальный рабочий стол)
    const virtualDesktop = await invoke('get_virtual_desktop_rect');
    monitorLeft = virtualDesktop.x;
    monitorTop = virtualDesktop.y;
    monitorWidth = virtualDesktop.width;
    monitorHeight = virtualDesktop.height;
    
    // Даем ОС время применить новые размеры и обновить масштабы
    await new Promise(r => setTimeout(r, 100));
    scaleFactor = await appWindow.scaleFactor();
    
    logToBackend(`[OCR] Virtual Desktop: pos=${monitorLeft},${monitorTop} size=${monitorWidth}x${monitorHeight} scale=${scaleFactor}`);
    
    // В режиме выделения окно должно перехватывать все клики
    await invoke('set_ignore_cursor_events', { ignore: false });
    await invoke('set_click_region', { rects: [], scaleFactor: 1.0 }); // Сброс региона
  } catch (err) {
    logToBackend(`[OCR] Failed to start selection mode: ${err.message || err}`);
  }
}

// Рисование рамки выделения
selectionOverlay.addEventListener('mousedown', (e) => {
  if (e.buttons === 1 && isSelecting) {
    isMouseDown = true;
    startX = e.clientX;
    startY = e.clientY;
    selectionBox.style.left = startX + 'px';
    selectionBox.style.top = startY + 'px';
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.style.display = 'block';
  }
});

selectionOverlay.addEventListener('mousemove', (e) => {
  if (isMouseDown && isSelecting) {
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const w = Math.abs(currentX - startX);
    const h = Math.abs(currentY - startY);
    
    selectionBox.style.left = x + 'px';
    selectionBox.style.top = y + 'px';
    selectionBox.style.width = w + 'px';
    selectionBox.style.height = h + 'px';
  }
});

selectionOverlay.addEventListener('mouseup', async (e) => {
  if (isMouseDown && isSelecting) {
    isMouseDown = false;
    isSelecting = false;
    
    const currentX = e.clientX;
    const currentY = e.clientY;
    
    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const w = Math.abs(currentX - startX);
    const h = Math.abs(currentY - startY);
    
    selectionBox.style.display = 'none';
    selectionOverlay.style.display = 'none';
    document.body.style.pointerEvents = 'none'; // Клик сквозь тело обратно
    
    if (w < 20 || h < 20) {
      // Выделение слишком маленькое — отменяем запуск
      await appWindow.hide();
      await emit('ocr-visibility-changed', false);
      return;
    }
    
    try {
      // Рассчитываем физические координаты выделения на экране
      const phys_x = monitorLeft + Math.round(x * scaleFactor);
      const phys_y = monitorTop + Math.round(y * scaleFactor);
      const phys_w = Math.round(w * scaleFactor);
      const phys_h = Math.round(h * scaleFactor);
      
      logToBackend(`[OCR] MouseUp: x=${x}, y=${y}, w=${w}, h=${h}, scale=${scaleFactor}`);
      logToBackend(`[OCR] Target phys rect: x=${phys_x}, y=${phys_y}, w=${phys_w}, h=${phys_h}`);
      
      // Подстраиваем окно оверлея ровно под выделенную область через нативный Win32 API
      await invoke('resize_bottom_up_phys', {
        width: phys_w,
        height: phys_h,
        x: phys_x,
        y: phys_y
      });
      
      // Даем Tauri время применить геометрию и обновляем масштаб монитора
      await new Promise(r => setTimeout(r, 150));
      scaleFactor = await appWindow.scaleFactor();

      // Получаем точные внутренние координаты клиентской области окна после ресайза!
      const pos = await appWindow.innerPosition();
      const size = await appWindow.innerSize();
      logToBackend(`[OCR] Resized window client area: x=${pos.x}, y=${pos.y}, w=${size.width}, h=${size.height}`);

      // Показываем рамку оверлея
      lensContainer.style.display = 'block';

      // Запускаем ИИ-сканирование этой области, используя точные координаты клиентской области!
      await scanOcrArea(pos.x, pos.y, size.width, size.height);
    } catch (err) {
      logToBackend(`[OCR] Failed to resize window to selection: ${err.message || err}`);
      // Аварийное скрытие оверлея, чтобы не оставить экран заблокированным
      await appWindow.hide();
      await emit('ocr-visibility-changed', false);
    }
  }
});

// Сканирование области ИИ
async function scanOcrArea(x_phys, y_phys, w_phys, h_phys) {
  logToBackend(`[OCR] scanOcrArea starting async: x=${x_phys}, y=${y_phys}, w=${w_phys}, h=${h_phys}`);
  clearCanvas();
  startLoader();
  
  try {
    await invoke('start_ocr_scan_async', {
      x: x_phys,
      y: y_phys,
      width: w_phys,
      height: h_phys
    });
  } catch (e) {
    logToBackend(`[OCR] scanOcrArea launch failed: ${e.message || e}`);
    showTooltip("Ошибка распознавания", 20, 20);
    stopLoader();
  }
}

// Кнопка сканирования на тулбаре (пересканировать ту же область)
document.getElementById('btn-scan').addEventListener('click', async () => {
  if (isSelecting) return;
  try {
    const pos = await appWindow.innerPosition();
    const size = await appWindow.innerSize();
    logToBackend(`[OCR] Toolbar scan clicked. InnerPos: x=${pos.x}, y=${pos.y}, InnerSize: w=${size.width}, h=${size.height}`);
    await scanOcrArea(pos.x, pos.y, size.width, size.height);
  } catch (err) {
    logToBackend(`[OCR] Toolbar scan failed: ${err.message || err}`);
  }
});

// Взаимодействие с клавишей Alt (Passthrough режим) через глобальный хук Tauri
listen('alt-pressed', async () => {
  if (!isAltPressed && !isSelecting) {
    isAltPressed = true;
    document.body.classList.add('alt-held');
    await invoke('set_ignore_cursor_events', { ignore: true });
    logToBackend(`[OCR] Alt pressed: set_ignore_cursor_events=true`);
  }
});

listen('alt-released', async () => {
  if (isAltPressed) {
    isAltPressed = false;
    document.body.classList.remove('alt-held');
    await invoke('set_ignore_cursor_events', { ignore: false });
    logToBackend(`[OCR] Alt released: set_ignore_cursor_events=false`);
  }
});


// Docking logic
const dockClasses = ['dock-tl', 'dock-tr', 'dock-br', 'dock-bl'];
let currentDockIndex = 2; // dock-br by default
document.getElementById('btn-dock').addEventListener('click', () => {
  toolbar.classList.remove(dockClasses[currentDockIndex]);
  currentDockIndex = (currentDockIndex + 1) % dockClasses.length;
  toolbar.classList.add(dockClasses[currentDockIndex]);
});

// Перетаскивание за любую свободную область оверлея
lensContainer.addEventListener('mousedown', (e) => {
  if (e.buttons === 1 && !e.target.closest('button') && !e.target.closest('.resize-handle') && !e.target.closest('.hover-word') && !isSelecting) {
    appWindow.startDragging();
  }
});

// Инициализация ресайз-ручек
const handleMap = {
  'res-n': 'North',
  'res-s': 'South',
  'res-e': 'East',
  'res-w': 'West',
  'res-nw': 'NorthWest',
  'res-ne': 'NorthEast',
  'res-sw': 'SouthWest',
  'res-se': 'SouthEast'
};

Object.keys(handleMap).forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.buttons === 1) {
        appWindow.startResize(handleMap[id]);
      }
    });
  }
});

function clearCanvas() {
  svgCanvas.innerHTML = '';
  wordsContainer.innerHTML = '';
  translationContainer.innerHTML = '';
  tooltip.style.opacity = 0;
  const modelStatus = document.getElementById('model-status');
  if (modelStatus) {
    modelStatus.style.display = 'none';
    modelStatus.innerText = '';
  }
}

function showTooltip(text, x, y) {
  tooltip.innerText = text;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
  tooltip.style.opacity = 1;
  setTimeout(() => { tooltip.style.opacity = 0; }, 2000);
}

// Отрисовка результатов сканирования
async function renderOcrData(sentences) {
  scaleFactor = await appWindow.scaleFactor();
  const pos = await appWindow.innerPosition();
  logToBackend(`[OCR] renderOcrData. InnerPos: x=${pos.x}, y=${pos.y}, scaleFactor=${scaleFactor}`);
  clearCanvas();
  
  // Создаем defs для масок и стрелок, если его нет
  let defs = svgCanvas.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svgCanvas.appendChild(defs);
  }
  
  sentences.forEach((sentence, sIdx) => {
    const color = sentenceColors[sIdx % sentenceColors.length];
    const sentenceText = sentence.text;
    
    // Переводим абсолютные физические координаты слова в локальные логические
    const words = sentence.words.map(w => ({
      ...w,
      text: w.text,
      x: (w.x - pos.x) / scaleFactor,
      y: (w.y - pos.y) / scaleFactor,
      w: w.w / scaleFactor,
      h: w.h / scaleFactor
    }));
    
    if (!words || words.length === 0) return;

    // Группируем слова предложения по строкам
    const lines = [];
    const sortedWords = [...words].sort((a, b) => (a.y + a.h/2) - (b.y + b.h/2));

    sortedWords.forEach(word => {
      const cy = word.y + word.h / 2;
      let added = false;
      for (const line of lines) {
        const lineCy = line.reduce((sum, w) => sum + (w.y + w.h/2), 0) / line.length;
        const lineH = line.reduce((sum, w) => sum + w.h, 0) / line.length;
        if (Math.abs(cy - lineCy) < Math.max(word.h, lineH) * 1.3) {
          line.push(word);
          added = true;
          break;
        }
      }
      if (!added) {
        lines.push([word]);
      }
    });

    // Сортируем слова внутри каждой строки слева направо
    lines.forEach(line => {
      line.sort((a, b) => a.x - b.x);
    });

    // Сортируем строки сверху вниз
    lines.sort((a, b) => {
      const ay = a.reduce((sum, w) => sum + (w.y + w.h/2), 0) / a.length;
      const by = b.reduce((sum, w) => sum + (w.y + w.h/2), 0) / b.length;
      return ay - by;
    });

    // Выравниваем Y-координаты слов внутри каждой строки для идеального горизонтального отображения
    lines.forEach(line => {
      const avgY = line.reduce((sum, w) => sum + w.y, 0) / line.length;
      const avgH = line.reduce((sum, w) => sum + w.h, 0) / line.length;
      line.forEach(w => {
        w.y = avgY;
        w.h = avgH;
      });
    });

    // Собираем прямоугольники слов для маски
    const maskRects = [];
    lines.forEach(line => {
      line.forEach(w => {
        maskRects.push({
          x: w.x + 1, // нахлест 1px на первую букву (нить Безье зайдет на слово)
          y: w.y - 2, 
          w: w.w - 2, // на 2px уже самого слова
          h: w.h + 4  
        });
      });
    });

    // Создаем маску для предложения
    const mask = document.createElementNS('http://www.w3.org/2000/svg', 'mask');
    mask.setAttribute('id', `mask-${sIdx}`);

    const bgRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    bgRect.setAttribute('x', '0');
    bgRect.setAttribute('y', '0');
    bgRect.setAttribute('width', '100%');
    bgRect.setAttribute('height', '100%');
    bgRect.setAttribute('fill', 'white');
    mask.appendChild(bgRect);

    maskRects.forEach(r => {
      const wRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      wRect.setAttribute('x', r.x);
      wRect.setAttribute('y', r.y);
      wRect.setAttribute('width', r.w);
      wRect.setAttribute('height', r.h);
      wRect.setAttribute('fill', 'black');
      mask.appendChild(wRect);
    });
    defs.appendChild(mask);

    // Строим путь SVG с S-образными переходами
    const pathId = `path-${sIdx}`;
    let d = '';

    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const lineWords = lines[lIdx];
      if (lineWords.length === 0) continue;

      const firstWord = lineWords[0];
      const lastWord = lineWords[lineWords.length - 1];

      if (lIdx === 0) {
        const barX = firstWord.x - 2;
        const barY1 = firstWord.y;
        const barY2 = firstWord.y + firstWord.h;
        
        // Рисуем вертикальную засечку |
        d += `M ${barX} ${barY1} L ${barX} ${barY2} `;
        // Начинаем нить от центра засечки
        d += `M ${barX} ${(barY1 + barY2)/2} `;
      }

      const points = lineWords.map(w => ({
        x: w.x + w.w / 2,
        y: w.y + w.h / 2,
        h: w.h
      }));

      // Соединение с началом строки
      if (lIdx === 0) {
        d += `L ${points[0].x} ${points[0].y} `;
      }

      if (lineWords.length === 1) {
        const w = lineWords[0];
        const cy = w.y + w.h / 2;
        if (lIdx > 0) {
          d += `L ${w.x + w.w/2} ${cy} `;
        }
      } else {
        // Несколько слов в строке — соединяем их с провисанием
        for (let i = 0; i < points.length - 1; i++) {
          const p1 = points[i];
          const p2 = points[i + 1];
          const gapX = p2.x - p1.x;
          
          const cp1x = p1.x + gapX * 0.25;
          const cp1y = p1.y + p1.h * 0.25;
          const cp2x = p1.x + gapX * 0.75;
          const cp2y = p2.y + p2.h * 0.25;
          
          d += `C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y} `;
        }
      }

      // Переход на следующую строку (S-образный переход)
      if (lIdx < lines.length - 1) {
        const nextLineWords = lines[lIdx + 1];
        const nextFirstWord = nextLineWords[0];

        const pOut = {
          x: lastWord.x + lastWord.w / 2,
          y: lastWord.y + lastWord.h / 2
        };
        const pIn = {
          x: nextFirstWord.x + nextFirstWord.w / 2,
          y: nextFirstWord.y + nextFirstWord.h / 2
        };

        const yMid = (lastWord.y + lastWord.h + nextFirstWord.y) / 2;
        
        const xRight = Math.max(lastWord.x + lastWord.w, nextFirstWord.x + nextFirstWord.w) + 15;
        const xLeft = Math.min(lastWord.x, nextFirstWord.x) - 15;

        // 1. Из центра последнего слова текущей строки вправо и вниз до середины межстрочного интервала
        const cp1x = pOut.x + (xRight - pOut.x) * 0.5;
        const cp1y = pOut.y;
        const cp2x = xRight;
        const cp2y = pOut.y + (yMid - pOut.y) * 0.5;
        d += `C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${xRight} ${yMid} `;

        // 2. Линия справа налево посередине межстрочного интервала
        d += `L ${xLeft} ${yMid} `;

        // 3. Из левой петли плавно заходим в первое слово следующей строки слева
        const cp3x = xLeft;
        const cp3y = yMid + (pIn.y - yMid) * 0.5;
        const cp4x = pIn.x - (pIn.x - xLeft) * 0.5;
        const cp4y = pIn.y;
        d += `C ${cp3x} ${cp3y}, ${cp4x} ${cp4y}, ${pIn.x} ${pIn.y} `;
      } else {
        // Самый конец предложения: ведем нить вплотную к стрелочке
        const endX = lastWord.x + lastWord.w + 3;
        const endY = lastWord.y + lastWord.h / 2;
        d += `L ${endX} ${endY} `;
      }
    }

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('id', pathId);
    path.setAttribute('d', d.trim());
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1.8');
    path.setAttribute('class', 'thread-path');
    path.setAttribute('mask', `url(#mask-${sIdx})`);
    svgCanvas.appendChild(path);

    // Рисуем стрелочку в конце предложения как отдельный path (чтобы маска её не скрывала)
    const lastLine = lines[lines.length - 1];
    const lastWord = lastLine[lastLine.length - 1];
    const endX = lastWord.x + lastWord.w + 3;
    const endY = lastWord.y + lastWord.h / 2;

    const arrowPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const arrowD = `M ${endX - 2.5} ${endY - 2} L ${endX} ${endY} L ${endX - 2.5} ${endY + 2}`;
    arrowPath.setAttribute('d', arrowD);
    arrowPath.setAttribute('fill', 'none');
    arrowPath.setAttribute('stroke', color);
    arrowPath.setAttribute('stroke-width', '1.0');
    arrowPath.setAttribute('stroke-linecap', 'round');
    arrowPath.setAttribute('stroke-linejoin', 'round');
    arrowPath.setAttribute('class', 'thread-arrow');
    svgCanvas.appendChild(arrowPath);

    // Вычисляем Bounding Box всего предложения для плашки перевода
    const minX = Math.min(...words.map(w => w.x));
    const maxX = Math.max(...words.map(w => w.x + w.w));
    const minY = Math.min(...words.map(w => w.y));
    const maxY = Math.max(...words.map(w => w.y + w.h));
    const centerX_orig = (minX + maxX) / 2;
    const centerY_orig = (minY + maxY) / 2;

    // Создаем плавающую плашку перевода
    const badge = document.createElement('div');
    badge.id = `badge-${sIdx}`;
    badge.className = 'translation-badge';
    translationContainer.appendChild(badge);

    let isTranslated = false;
    let translatedText = '';

    // Интерактивные слова (бусины)
    words.forEach((word) => {
      const div = document.createElement('div');
      div.className = 'hover-word';
      div.style.left = word.x + 'px';
      div.style.top = word.y + 'px';
      div.style.width = word.w + 'px';
      div.style.height = word.h + 'px';
      
      div.addEventListener('mouseenter', async () => {
        // Подсвечиваем нить Безье
        const p = document.getElementById(pathId);
        if (p) {
          p.style.opacity = '1.0';
          p.style.strokeWidth = '3';
          p.style.filter = `drop-shadow(0px 0px 6px ${color})`;
        }

        // Позиционируем плашку перевода
        let badgeY = maxY + 20; // по умолчанию снизу
        let isTop = false;
        
        // Замеряем высоту плашки (оценочно)
        const estBadgeHeight = 60; 
        if (badgeY + estBadgeHeight > window.innerHeight) {
          badgeY = minY - 50; // если снизу нет места, кидаем наверх
          isTop = true;
        }

        // Центрируем плашку по горизонтали с ограничением краев экрана
        let badgeX = Math.max(160, Math.min(window.innerWidth - 160, centerX_orig));
        
        badge.style.left = `${badgeX}px`;
        badge.style.top = `${badgeY}px`;
        badge.classList.add('active');

        // Рисуем нить-указатель от предложения к плашке
        const indicatorPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        indicatorPath.setAttribute('id', `indicator-${sIdx}`);
        
        const targetY = isTop ? (badgeY + 32) : badgeY; // стыкуем с краем плашки
        const midY = (centerY_orig + targetY) / 2;
        const d_ind = `M ${centerX_orig} ${centerY_orig} C ${centerX_orig} ${midY}, ${badgeX} ${midY}, ${badgeX} ${targetY}`;
        
        indicatorPath.setAttribute('d', d_ind);
        indicatorPath.setAttribute('fill', 'none');
        indicatorPath.setAttribute('stroke', color);
        indicatorPath.setAttribute('stroke-width', '2');
        indicatorPath.setAttribute('stroke-dasharray', '3, 3');
        indicatorPath.style.transition = 'opacity 0.2s';
        svgCanvas.appendChild(indicatorPath);

        if (!isTranslated) {
          badge.innerText = `⏳ Перевожу...\n${sentenceText}`;
          try {
            const res = await invoke('translate_hybrid', { text: sentenceText, targetLang: 'ru' });
            translatedText = res;
            badge.innerText = res;
            isTranslated = true;
          } catch (err) {
            badge.innerText = "Ошибка перевода";
          }
        } else {
          badge.innerText = translatedText;
        }
      });

      div.addEventListener('mouseleave', () => {
        badge.classList.remove('active');
        
        // Убираем подсветку нити
        const p = document.getElementById(pathId);
        if (p) {
          p.style.opacity = '0.7';
          p.style.strokeWidth = '1.8';
          p.style.filter = 'none';
        }

        // Удаляем нить-указатель
        const ind = document.getElementById(`indicator-${sIdx}`);
        if (ind) {
          ind.remove();
        }
      });

      div.addEventListener('click', async () => {
        // Загружаем предложение в TTS
        await emit('tts-state-sync', { action: 'load', text: sentenceText });
        await emit('tts-state-sync', { action: 'play' });
      });

      wordsContainer.appendChild(div);
    });
  });
}

// Озвучка всего текста
const btnPlayAll = document.getElementById('btn-play-all');
if (btnPlayAll) {
  btnPlayAll.addEventListener('click', async () => {
    if (!currentOcrData || currentOcrData.length === 0) return;
    const fullText = currentOcrData.map(s => s.text).join(' ');
    await emit('tts-state-sync', { action: 'load', text: fullText });
    await emit('tts-state-sync', { action: 'play' });
  });
}

// ─── Вспомогательные функции для трехфазного асинхронного OCR ────────────────

let progressInterval = null;

function startLoader() {
  const loader = document.getElementById('scan-loader');
  const laser = document.getElementById('laser-line');
  const loaderProgress = document.getElementById('loader-progress');
  const loaderPercent = document.getElementById('loader-percent');

  if (loader) loader.style.display = 'flex';
  if (laser) laser.style.display = 'block';
  if (loaderProgress) loaderProgress.style.width = '0%';
  if (loaderPercent) loaderPercent.innerText = '0%';

  document.getElementById('btn-scan').classList.add('animate-pulse');

  if (progressInterval) clearInterval(progressInterval);
  
  let progress = 0;
  progressInterval = setInterval(() => {
    if (progress < 40) {
      progress += Math.random() * 10 + 5;
    } else if (progress < 70) {
      progress += Math.random() * 5 + 2;
    } else if (progress < 90) {
      progress += Math.random() * 2 + 1;
    } else if (progress < 98) {
      progress += 0.5;
    }
    progress = Math.min(progress, 98);
    const pStr = Math.round(progress) + '%';
    if (loaderProgress) loaderProgress.style.width = pStr;
    if (loaderPercent) loaderPercent.innerText = pStr;
  }, 100);
}

function stopLoader() {
  const loader = document.getElementById('scan-loader');
  const laser = document.getElementById('laser-line');
  const loaderProgress = document.getElementById('loader-progress');
  const loaderPercent = document.getElementById('loader-percent');

  if (progressInterval) {
    clearInterval(progressInterval);
    progressInterval = null;
  }

  if (loaderProgress) loaderProgress.style.width = '100%';
  if (loaderPercent) loaderPercent.innerText = '100%';
  document.getElementById('btn-scan').classList.remove('animate-pulse');
  
  setTimeout(() => {
    if (loader) loader.style.display = 'none';
    if (laser) laser.style.display = 'none';
  }, 300);
}

async function renderRawWords(words) {
  scaleFactor = await appWindow.scaleFactor();
  const pos = await appWindow.innerPosition();
  clearCanvas();

  words.forEach(w => {
    const x = (w.x - pos.x) / scaleFactor;
    const y = (w.y - pos.y) / scaleFactor;
    const width = w.w / scaleFactor;
    const height = w.h / scaleFactor;

    const div = document.createElement('div');
    div.className = 'raw-word';
    div.style.left = x + 'px';
    div.style.top = y + 'px';
    div.style.width = width + 'px';
    div.style.height = height + 'px';
    wordsContainer.appendChild(div);
  });
}

// Подписки на события Tauri

listen('ocr-words-ready', (event) => {
  const words = event.payload;
  logToBackend(`[OCR] Event ocr-words-ready: ${words.length} words`);
  renderRawWords(words);
});

listen('ocr-sentences-ready', (event) => {
  const sentences = event.payload.sentences;
  logToBackend(`[OCR] Event ocr-sentences-ready: ${sentences.length} sentences`);
  currentOcrData = sentences;
  renderOcrData(currentOcrData);
  
  const modelStatus = document.getElementById('model-status');
  if (modelStatus) {
    if (event.payload.model) {
      modelStatus.innerText = event.payload.model;
      modelStatus.style.display = 'inline-block';
      if (event.payload.model.toLowerCase().includes('fallback') || event.payload.model.toLowerCase().includes('локальный')) {
        modelStatus.style.color = '#FFAA00'; // оранжевый для fallback
      } else {
        modelStatus.style.color = '#00FF66'; // зеленый для успешного ИИ
      }
    } else {
      modelStatus.style.display = 'none';
    }
  }

  if (event.payload.error) {
    logToBackend(`[OCR] Warning from backend: ${event.payload.error}`);
    showTooltip(event.payload.error, 20, 20);
  }
});

listen('ocr-extra-data-ready', (event) => {
  const extraSentences = event.payload.sentences;
  logToBackend(`[OCR] Event ocr-extra-data-ready: ${extraSentences.length} sentences`);
  currentOcrData = extraSentences;
  renderOcrData(currentOcrData);
});

listen('ocr-status-update', (event) => {
  const statusEl = document.getElementById('loader-status');
  if (statusEl) {
    statusEl.innerText = event.payload;
  }
});

listen('ocr-scan-finished', () => {
  logToBackend(`[OCR] Event ocr-scan-finished`);
  stopLoader();
});
