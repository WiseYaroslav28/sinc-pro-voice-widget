const { invoke } = window.__TAURI__.core;
const { getCurrentWebviewWindow } = window.__TAURI__.webviewWindow;
const { PhysicalSize, PhysicalPosition } = window.__TAURI__.dpi;
const { emit, listen } = window.__TAURI__.event;

const appWindow = getCurrentWebviewWindow();

const svgCanvas = document.getElementById('svg-canvas');
const wordsContainer = document.getElementById('words-container');
const tooltip = document.getElementById('tooltip');
const lensContainer = document.getElementById('lens-container');
const toolbar = document.getElementById('toolbar-island');

let currentOcrData = null;

// Цвета для разных предложений
const sentenceColors = [
  '#00D7FF', '#FF0055', '#00FF66', '#FFD700', '#FF00FF', '#00FFFF', '#FF5500', '#A020F0'
];

// Управление окном
document.getElementById('btn-close').addEventListener('click', () => {
  appWindow.hide();
  clearCanvas();
});

listen('ocr-action-trigger', async () => {
  await appWindow.show();
  await appWindow.setFocus();
});

// Docking logic
const dockClasses = ['dock-tl', 'dock-tr', 'dock-br', 'dock-bl'];
let currentDockIndex = 2; // dock-br by default
document.getElementById('btn-dock').addEventListener('click', () => {
  toolbar.classList.remove(dockClasses[currentDockIndex]);
  currentDockIndex = (currentDockIndex + 1) % dockClasses.length;
  toolbar.classList.add(dockClasses[currentDockIndex]);
});

// Resizing & Dragging logic
lensContainer.addEventListener('mousedown', (e) => {
  if (e.buttons === 1 && !e.target.closest('button') && !e.target.closest('.resize-handle') && !e.target.closest('.hover-word')) {
    appWindow.startDragging();
  }
});

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

// ИИ Сканирование
document.getElementById('btn-scan').addEventListener('click', async () => {
  document.getElementById('btn-scan').classList.add('animate-pulse');
  clearCanvas();
  try {
    const size = await appWindow.outerSize();
    const pos = await appWindow.outerPosition();
    const scale = await appWindow.scaleFactor();

    // Отправляем скриншот в бэкенд
    const result = await invoke('process_ocr_vision', {
      x: Math.round(pos.x / scale),
      y: Math.round(pos.y / scale),
      width: Math.round(size.width / scale),
      height: Math.round(size.height / scale)
    });

    if (result && result.sentences) {
      currentOcrData = result.sentences;
      renderOcrData(currentOcrData);
    } else {
      showTooltip("Ничего не найдено", size.width/2, size.height/2);
    }
  } catch (e) {
    console.error("OCR Failed:", e);
    showTooltip("Ошибка распознавания", 50, 50);
  } finally {
    document.getElementById('btn-scan').classList.remove('animate-pulse');
  }
});

function clearCanvas() {
  svgCanvas.innerHTML = '';
  wordsContainer.innerHTML = '';
  tooltip.style.opacity = 0;
}

function showTooltip(text, x, y) {
  tooltip.innerText = text;
  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
  tooltip.style.opacity = 1;
  setTimeout(() => { tooltip.style.opacity = 0; }, 2000);
}

function renderOcrData(sentences) {
  clearCanvas();
  
  sentences.forEach((sentence, sIdx) => {
    const color = sentenceColors[sIdx % sentenceColors.length];
    const sentenceText = sentence.text;
    const words = sentence.words;
    
    if (!words || words.length === 0) return;

    // Рисуем нить
    const pathId = `path-${sIdx}`;
    let d = '';
    words.forEach((word, wIdx) => {
      const cx = word.x + word.w / 2;
      const cy = word.y + word.h / 2;
      if (wIdx === 0) d += `M ${cx} ${cy} `;
      else d += `L ${cx} ${cy} `;
    });

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('id', pathId);
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    path.style.opacity = '0.4';
    path.style.transition = 'all 0.2s';
    svgCanvas.appendChild(path);

    // Рисуем интерактивные слова (бусины)
    words.forEach((word) => {
      const div = document.createElement('div');
      div.className = 'hover-word';
      div.style.left = word.x + 'px';
      div.style.top = word.y + 'px';
      div.style.width = word.w + 'px';
      div.style.height = word.h + 'px';
      
      div.addEventListener('mouseenter', async () => {
        const p = document.getElementById(pathId);
        if(p) {
          p.style.opacity = '1.0';
          p.style.strokeWidth = '3';
          p.style.filter = `drop-shadow(0px 0px 6px ${color})`;
        }

        tooltip.style.opacity = 1;
        const tipY = (word.y + word.h + 10);
        tooltip.style.left = word.x + 'px';
        tooltip.style.top = tipY + 'px';
        tooltip.innerText = `⏳ Перевожу...\n${sentenceText}`;
        
        try {
          const res = await invoke('translate_hybrid', { text: sentenceText, targetLang: 'ru' });
          tooltip.innerText = res;
        } catch(err) {
          tooltip.innerText = "Ошибка перевода";
        }
      });

      div.addEventListener('mouseleave', () => {
        tooltip.style.opacity = 0;
        const p = document.getElementById(pathId);
        if(p) {
          p.style.opacity = '0.4';
          p.style.strokeWidth = '1.5';
          p.style.filter = 'none';
        }
      });

      div.addEventListener('click', async () => {
        // Загружаем предложение в TTS
        await emit('tts-state-sync', { action: 'load', text: sentenceText });
        await emit('tts-state-sync', { action: 'play' });
        // Показываем виджет TTS
        await invoke('show_widget_window');
        appWindow.hide();
      });

      wordsContainer.appendChild(div);
    });
  });
}
