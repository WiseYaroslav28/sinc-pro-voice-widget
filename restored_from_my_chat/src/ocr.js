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
let currentDockIndex = 0;
document.getElementById('btn-dock').addEventListener('click', () => {
  toolbar.classList.remove(dockClasses[currentDockIndex]);
  currentDockIndex = (currentDockIndex + 1) % dockClasses.length;
  toolbar.classList.add(dockClasses[currentDockIndex]);
});

document.getElementById('btn-scan').addEventListener('click',




































































































































































































































































































































      const div = document.createElement('div');
      div.className = 'hover-word';
      div.style.left = word.x + 'px';
      div.style.top = word.y + 'px';
      div.style.width = word.w + 'px';
      div.style.height = word.h + 'px';
      
      div.addEventListener('mouseenter', async () => {
        // Подсвечиваем нить!
        const p = document.getElementById(pathId);
        if(p) {
          p.style.opacity = '1.0';
          p.style.strokeWidth = '3';
          p.style.filter = `drop-shadow(0px 0px 6px ${color})`;
        }

        tooltip.style.opacity = 1;
        // позиционируем тултип под предложением (в пределах экрана)
        const tipY = (word.y + word.h + 10);
        tooltip.style.left = word.x + 'px';
        tooltip.style.top = tipY + 'px';
        tooltip.innerText = `⏳ Перевожу...\n${sentenceText}`;
        
        try {
          const res = await invoke('translate_text', { text: sentenceText, targetLang: 'ru' });
          tooltip.innerText = res;
        } catch(err) {
          tooltip.innerText = "Ошибка перевода";
        }
      });

      div.addEventListener('mouseleave', () => {
        tooltip.style.opacity = 0;
        // Возвращаем тусклую нить
        const p = document.getElementById(pathId);
        if(p) {
          p.style.opacity = '0.4';
          p.style.strokeWidth = '1.5';
          p.style.filter = 'none';
        }
      });

      div.addEventListener('click', () => {
        emit('send-to-tts', { text: sentenceText });
      });

      wordsContainer.appendChild(div);
    });
  });
}

