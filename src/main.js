// Безопасный импорт Tauri API для поддержки работы в обычном браузере
const invoke = window.__TAURI__ 
  ? window.__TAURI__.core.invoke 
  : async (cmd, args) => {
      console.log(`[Tauri Mock] Вызов команды "${cmd}" с параметрами:`, args);
      if (cmd === "greet") return `Привет, ${args.name}! (Эмуляция без Tauri)`;
      return null;
    };

let greetInputEl;
let greetMsgEl;

async function greet() {
  greetMsgEl.textContent = await invoke("greet", { name: greetInputEl.value });
}

window.addEventListener("DOMContentLoaded", () => {
  greetInputEl = document.querySelector("#greet-input");
  greetMsgEl = document.querySelector("#greet-msg");
  if (document.querySelector("#greet-form")) {
    document.querySelector("#greet-form").addEventListener("submit", (e) => {
      e.preventDefault();
      greet();
    });
  }
});
