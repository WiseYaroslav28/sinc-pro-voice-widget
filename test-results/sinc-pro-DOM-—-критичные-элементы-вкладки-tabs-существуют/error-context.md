# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: sinc-pro.spec.js >> DOM — критичные элементы >> вкладки tabs существуют
- Location: tests\sinc-pro.spec.js:24:3

# Error details

```
Test timeout of 15000ms exceeded while running "beforeEach" hook.
```

```
Error: page.goto: Test timeout of 15000ms exceeded.
Call log:
  - navigating to "http://localhost:9999/", waiting until "load"

```

# Page snapshot

```yaml
- generic [ref=e2]:
  - complementary [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]:
        - heading "SINC PRO" [level=1] [ref=e7]
        - paragraph [ref=e8]: Audio Intelligence
      - button "keyboard_double_arrow_left" [ref=e9] [cursor=pointer]
    - button "add Новая запись" [ref=e10] [cursor=pointer]:
      - generic [ref=e11]: add
      - generic [ref=e12]: Новая запись
    - generic [ref=e13]:
      - button "home Главная" [ref=e14] [cursor=pointer]:
        - generic [ref=e15]: home
        - generic [ref=e16]: Главная
      - button "screenshot_region Перевод экрана" [ref=e17] [cursor=pointer]:
        - generic [ref=e18]: screenshot_region
        - generic [ref=e19]: Перевод экрана
      - button "history История записей" [ref=e20] [cursor=pointer]:
        - generic [ref=e21]: history
        - generic [ref=e22]: История записей
      - button "settings Настройки" [ref=e24] [cursor=pointer]:
        - generic [ref=e25]: settings
        - generic [ref=e26]: Настройки
  - main [ref=e27]:
    - generic [ref=e28]:
      - button "minimize" [ref=e29] [cursor=pointer]
      - button "square" [ref=e30] [cursor=pointer]
      - button "close" [ref=e31] [cursor=pointer]
    - generic [ref=e32]:
      - generic [ref=e33]:
        - heading "Привет, Ярослав" [level=2] [ref=e34]
        - generic [ref=e37]: Все системы онлайн
      - generic [ref=e38]:
        - button "notifications" [ref=e39] [cursor=pointer]
        - generic [ref=e42]: account_circle
    - generic [ref=e44]:
      - generic [ref=e45]:
        - generic [ref=e46]:
          - generic [ref=e47]: Хоткеи
          - 'generic "Диктовка: Ctrl+Win" [ref=e48]':
            - generic [ref=e49]: mic
            - generic [ref=e50]: Ctrl+Win
          - 'generic "Отправить: Ctrl+Alt" [ref=e51]':
            - generic [ref=e52]: send
            - generic [ref=e53]: Ctrl+Alt
        - generic [ref=e54]:
          - generic [ref=e55]: Окна
          - generic [ref=e56] [cursor=pointer]:
            - generic [ref=e57]: Капсула
            - generic [ref=e58]:
              - checkbox "Капсула" [checked]
          - generic [ref=e60] [cursor=pointer]:
            - generic [ref=e61]: Виджет
            - generic [ref=e62]:
              - checkbox "Виджет"
        - generic [ref=e64]:
          - generic [ref=e65]: Сервисы
          - generic [ref=e66]:
            - generic [ref=e67]: Gemini AI
            - generic [ref=e68]: —
          - generic [ref=e70]:
            - generic [ref=e71]: Микрофон
            - generic [ref=e72]: Готов
      - generic [ref=e74]:
        - generic [ref=e75]:
          - generic [ref=e76]:
            - generic [ref=e77]: graphic_eq
            - generic [ref=e78]:
              - heading "Последняя активность" [level=3] [ref=e79]
              - generic [ref=e80]:
                - generic [ref=e81]: Gemini 2.0 Flash
                - generic [ref=e82]:
                  - generic [ref=e83]: schedule
                  - generic [ref=e84]: —
          - combobox [ref=e85]:
            - option "📝 Транскрипция" [selected]
          - button "volume_up" [ref=e86] [cursor=pointer]:
            - generic [ref=e87]: volume_up
          - button "add_circle" [ref=e88] [cursor=pointer]:
            - generic [ref=e89]: add_circle
          - button "content_copy" [ref=e90] [cursor=pointer]
          - button "delete" [ref=e91] [cursor=pointer]
        - paragraph [ref=e94]: Нет данных. Создайте первую запись через капсулу (Ctrl+Win).
        - generic [ref=e96]:
          - button "play_arrow" [ref=e97] [cursor=pointer]
          - generic [ref=e99]: 0:00
    - generic [ref=e100]:
      - generic [ref=e101]: "© 2026 SINC PRO. API: Gemini Connected."
      - generic [ref=e102]:
        - link "Статус систем" [ref=e103] [cursor=pointer]:
          - /url: "#"
        - link "Помощь" [ref=e104] [cursor=pointer]:
          - /url: "#"
        - link "Конфиденциальность" [ref=e105] [cursor=pointer]:
          - /url: "#"
```

# Test source

```ts
  1   | // @ts-check
  2   | import { test, expect } from '@playwright/test';
  3   | 
  4   | /**
  5   |  * SINC PRO — E2E DOM/JS тесты
  6   |  * Запускаются против статического сервера из src/ (порт 9999)
  7   |  * Команда: npm test
  8   |  *
  9   |  * Проверяет: DOM-структуру, навигацию, отсутствие JS-ошибок.
  10  |  * Tauri-специфичные функции (окна, хоткеи) пропускаются — они тестируются
  11  |  * встроенным self-test при запуске реального приложения.
  12  |  */
  13  | 
  14  | // ──────────────────────────────────────────────────────────────────────────────
  15  | // 1. DOM: критичные элементы существуют
  16  | // ──────────────────────────────────────────────────────────────────────────────
  17  | test.describe('DOM — критичные элементы', () => {
  18  |   test.beforeEach(async ({ page }) => {
> 19  |     await page.goto('/');
      |                ^ Error: page.goto: Test timeout of 15000ms exceeded.
  20  |     await page.waitForLoadState('domcontentloaded');
  21  |     await page.waitForTimeout(600); // ждём DOMContentLoaded + setTimeout(runSelfTest, 500)
  22  |   });
  23  | 
  24  |   test('вкладки tabs существуют', async ({ page }) => {
  25  |     const tabs = ['tab-home', 'tab-history', 'tab-ocr', 'tab-settings'];
  26  |     for (const id of tabs) {
  27  |       const count = await page.locator(`#${id}`).count();
  28  |       expect(count, `Вкладка #${id} должна быть в DOM`).toBeGreaterThan(0);
  29  |     }
  30  |   });
  31  | 
  32  |   test('элементы главной карточки', async ({ page }) => {
  33  |     const ids = ['summary-text', 'activity-time', 'dashboard-view-combo', 'player-play'];
  34  |     for (const id of ids) {
  35  |       const count = await page.locator(`#${id}`).count();
  36  |       expect(count, `#${id} должен быть в DOM`).toBeGreaterThan(0);
  37  |     }
  38  |   });
  39  | 
  40  |   test('элементы истории', async ({ page }) => {
  41  |     expect(await page.locator('#history-list').count()).toBeGreaterThan(0);
  42  |   });
  43  | 
  44  |   test('элементы настроек', async ({ page }) => {
  45  |     const ids = ['setting-api-key', 'setting-ai-model'];
  46  |     for (const id of ids) {
  47  |       const count = await page.locator(`#${id}`).count();
  48  |       expect(count, `#${id} должен быть в DOM`).toBeGreaterThan(0);
  49  |     }
  50  |   });
  51  | 
  52  |   test('кнопки управления окном', async ({ page }) => {
  53  |     const ids = ['win-close', 'win-minimize', 'win-maximize'];
  54  |     for (const id of ids) {
  55  |       const count = await page.locator(`#${id}`).count();
  56  |       expect(count, `#${id} должен быть в DOM`).toBeGreaterThan(0);
  57  |     }
  58  |   });
  59  | 
  60  |   test('sidebar-toggle существует', async ({ page }) => {
  61  |     expect(await page.locator('#sidebar-toggle').count()).toBeGreaterThan(0);
  62  |   });
  63  | });
  64  | 
  65  | // ──────────────────────────────────────────────────────────────────────────────
  66  | // 2. Навигация: переключение вкладок
  67  | // ──────────────────────────────────────────────────────────────────────────────
  68  | test.describe('Навигация', () => {
  69  |   test.beforeEach(async ({ page }) => {
  70  |     await page.goto('/');
  71  |     await page.waitForLoadState('domcontentloaded');
  72  |   });
  73  | 
  74  |   test('sidebar-items существуют для всех вкладок', async ({ page }) => {
  75  |     const tabs = ['tab-home', 'tab-history', 'tab-ocr', 'tab-settings'];
  76  |     for (const tab of tabs) {
  77  |       const count = await page.locator(`.sidebar-item[data-tab="${tab}"]`).count();
  78  |       expect(count, `sidebar-item[data-tab="${tab}"] должен быть в DOM`).toBeGreaterThan(0);
  79  |     }
  80  |   });
  81  | 
  82  |   test('клик по История показывает tab-history', async ({ page }) => {
  83  |     await page.waitForSelector('.sidebar-item[data-tab="tab-history"]');
  84  |     await page.locator('.sidebar-item[data-tab="tab-history"]').click();
  85  |     await page.waitForFunction(() => {
  86  |       const el = document.getElementById('tab-history');
  87  |       return el && el.style.display !== 'none' && el.style.display !== '';
  88  |     }, { timeout: 5000 });
  89  |   });
  90  | 
  91  |   test('клик по Настройки показывает tab-settings', async ({ page }) => {
  92  |     await page.waitForSelector('.sidebar-item[data-tab="tab-settings"]');
  93  |     await page.locator('.sidebar-item[data-tab="tab-settings"]').click();
  94  |     await page.waitForFunction(() => {
  95  |       const el = document.getElementById('tab-settings');
  96  |       return el && el.style.display !== 'none' && el.style.display !== '';
  97  |     }, { timeout: 5000 });
  98  |   });
  99  | 
  100 |   test('клик по Главная показывает tab-home', async ({ page }) => {
  101 |     await page.waitForSelector('.sidebar-item[data-tab="tab-history"]');
  102 |     await page.locator('.sidebar-item[data-tab="tab-history"]').click();
  103 |     await page.waitForFunction(() => {
  104 |       const el = document.getElementById('tab-history');
  105 |       return el && el.style.display !== 'none' && el.style.display !== '';
  106 |     }, { timeout: 3000 });
  107 |     await page.locator('.sidebar-item[data-tab="tab-home"]').click();
  108 |     await page.waitForFunction(() => {
  109 |       const el = document.getElementById('tab-home');
  110 |       return el && el.style.display !== 'none' && el.style.display !== '';
  111 |     }, { timeout: 5000 });
  112 |   });
  113 | 
  114 | 
  115 |   test('активный nav-item подсвечивается', async ({ page }) => {
  116 |     await page.locator('.sidebar-item[data-tab="tab-history"]').click();
  117 |     await page.waitForTimeout(300);
  118 |     // Проверяем: либо класс active, либо border-right-color, либо цвет текста изменился
  119 |     const hasActive = await page.locator('.sidebar-item[data-tab="tab-history"]').evaluate(el => {
```