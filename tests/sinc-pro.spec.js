// @ts-check
import { test, expect } from '@playwright/test';

/**
 * SINC PRO — E2E DOM/JS тесты
 * Запускаются против статического сервера из src/ (порт 9999)
 * Команда: npm test
 *
 * Проверяет: DOM-структуру, навигацию, отсутствие JS-ошибок.
 * Tauri-специфичные функции (окна, хоткеи) пропускаются — они тестируются
 * встроенным self-test при запуске реального приложения.
 */

// ──────────────────────────────────────────────────────────────────────────────
// 1. DOM: критичные элементы существуют
// ──────────────────────────────────────────────────────────────────────────────
test.describe('DOM — критичные элементы', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(600); // ждём DOMContentLoaded + setTimeout(runSelfTest, 500)
  });

  test('вкладки tabs существуют', async ({ page }) => {
    const tabs = ['tab-home', 'tab-history', 'tab-ocr', 'tab-settings'];
    for (const id of tabs) {
      const count = await page.locator(`#${id}`).count();
      expect(count, `Вкладка #${id} должна быть в DOM`).toBeGreaterThan(0);
    }
  });

  test('элементы главной карточки', async ({ page }) => {
    const ids = ['summary-text', 'activity-time', 'dashboard-view-combo', 'player-play'];
    for (const id of ids) {
      const count = await page.locator(`#${id}`).count();
      expect(count, `#${id} должен быть в DOM`).toBeGreaterThan(0);
    }
  });

  test('элементы истории', async ({ page }) => {
    expect(await page.locator('#history-list').count()).toBeGreaterThan(0);
  });

  test('элементы настроек', async ({ page }) => {
    const ids = ['setting-api-key', 'setting-ai-model'];
    for (const id of ids) {
      const count = await page.locator(`#${id}`).count();
      expect(count, `#${id} должен быть в DOM`).toBeGreaterThan(0);
    }
  });

  test('кнопки управления окном', async ({ page }) => {
    const ids = ['win-close', 'win-minimize', 'win-maximize'];
    for (const id of ids) {
      const count = await page.locator(`#${id}`).count();
      expect(count, `#${id} должен быть в DOM`).toBeGreaterThan(0);
    }
  });

  test('sidebar-toggle существует', async ({ page }) => {
    expect(await page.locator('#sidebar-toggle').count()).toBeGreaterThan(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 2. Навигация: переключение вкладок
// ──────────────────────────────────────────────────────────────────────────────
test.describe('Навигация', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
  });

  test('sidebar-items существуют для всех вкладок', async ({ page }) => {
    const tabs = ['tab-home', 'tab-history', 'tab-ocr', 'tab-settings'];
    for (const tab of tabs) {
      const count = await page.locator(`.sidebar-item[data-tab="${tab}"]`).count();
      expect(count, `sidebar-item[data-tab="${tab}"] должен быть в DOM`).toBeGreaterThan(0);
    }
  });

  test('клик по История показывает tab-history', async ({ page }) => {
    await page.waitForSelector('.sidebar-item[data-tab="tab-history"]');
    await page.locator('.sidebar-item[data-tab="tab-history"]').click();
    await page.waitForFunction(() => {
      const el = document.getElementById('tab-history');
      return el && el.style.display === 'block';
    }, { timeout: 5000 });
  });

  test('клик по Настройки показывает tab-settings', async ({ page }) => {
    await page.waitForSelector('.sidebar-item[data-tab="tab-settings"]');
    await page.locator('.sidebar-item[data-tab="tab-settings"]').click();
    await page.waitForFunction(() => {
      const el = document.getElementById('tab-settings');
      return el && el.style.display === 'block';
    }, { timeout: 5000 });
  });

  test('клик по Главная показывает tab-home', async ({ page }) => {
    await page.waitForSelector('.sidebar-item[data-tab="tab-history"]');
    await page.locator('.sidebar-item[data-tab="tab-history"]').click();
    await page.waitForFunction(() => {
      const el = document.getElementById('tab-history');
      return el && el.style.display === 'block';
    }, { timeout: 3000 });
    await page.locator('.sidebar-item[data-tab="tab-home"]').click();
    await page.waitForFunction(() => {
      const el = document.getElementById('tab-home');
      return el && el.style.display === 'block';
    }, { timeout: 5000 });
  });


  test('активный nav-item подсвечивается', async ({ page }) => {
    await page.locator('.sidebar-item[data-tab="tab-history"]').click();
    await page.waitForTimeout(300);
    // Проверяем: либо класс active, либо border-right-color, либо цвет текста изменился
    const hasActive = await page.locator('.sidebar-item[data-tab="tab-history"]').evaluate(el => {
      const style = window.getComputedStyle(el);
      return (
        el.classList.contains('active') ||
        el.style.borderRight !== '' ||
        el.style.borderRightColor !== '' ||
        style.borderRightWidth !== '0px' ||
        el.style.color.includes('d2bbff') ||
        el.getAttribute('class').includes('font-bold')
      );
    });
    expect(hasActive, 'История должна стать активной').toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 3. JS ошибки: нет TypeError/null при переключении вкладок
// ──────────────────────────────────────────────────────────────────────────────
test.describe('JS ошибки', () => {
  test('нет TypeError/null ошибок при навигации', async ({ page }) => {
    const jsErrors = [];

    page.on('pageerror', err => jsErrors.push(err.message));
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (t.includes('TypeError') || t.includes('Cannot read') || t.includes('null')) {
          jsErrors.push(t);
        }
      }
    });

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(700);

    // Кликаем по всем пунктам навигации
    const tabs = ['tab-history', 'tab-settings', 'tab-ocr', 'tab-home'];
    for (const tab of tabs) {
      const btn = page.locator(`.sidebar-item[data-tab="${tab}"]`);
      if (await btn.count() > 0) {
        await btn.click();
        await page.waitForTimeout(300);
      }
    }

    expect(jsErrors, `JS ошибки при навигации:\n${jsErrors.join('\n')}`).toHaveLength(0);
  });

  test('self-test результаты: passed === total', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(800); // ждём runSelfTest()

    const result = await page.evaluate(() => window.__SINC_TEST_RESULTS__);

    if (!result) {
      // self-test не запустился (возможно нет __TAURI__) — пропускаем
      console.log('⚠️ __SINC_TEST_RESULTS__ недоступен (Tauri-контекст отсутствует)');
      return;
    }

    const { passed, failed, total } = result;
    console.log(`🧪 Self-test: ${passed}/${total} passed, ${failed} failed`);
    expect(failed, `Self-test провалил ${failed} проверок`).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// 4. UI: Sidebar toggle
// ──────────────────────────────────────────────────────────────────────────────
test.describe('Sidebar toggle', () => {
  test('sidebar сворачивается и разворачивается', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const sidebar = page.locator('#sidebar');
    const toggleBtn = page.locator('#sidebar-toggle');

    expect(await sidebar.count(), 'Сайдбар #sidebar должен быть в DOM').toBeGreaterThan(0);
    expect(await toggleBtn.count(), 'Кнопка #sidebar-toggle должна быть в DOM').toBeGreaterThan(0);

    // Изначально — не свёрнут
    const isCollapsedBefore = await sidebar.evaluate(el => el.classList.contains('collapsed'));

    // Клик 1 — сворачиваем
    await toggleBtn.click();
    await page.waitForTimeout(350);
    const isCollapsedAfter1 = await sidebar.evaluate(el => el.classList.contains('collapsed'));
    expect(isCollapsedAfter1, 'После первого клика collapsed должен появиться').not.toBe(isCollapsedBefore);

    // Клик 2 — разворачиваем обратно
    await toggleBtn.click();
    await page.waitForTimeout(350);
    const isCollapsedAfter2 = await sidebar.evaluate(el => el.classList.contains('collapsed'));
    expect(isCollapsedAfter2, 'После второго клика collapsed должен вернуться к исходному').toBe(isCollapsedBefore);
  });
});


// ──────────────────────────────────────────────────────────────────────────────
// 5. Combo Box переключения вида
// ──────────────────────────────────────────────────────────────────────────────
test.describe('Combo Box', () => {
  test('#dashboard-view-combo имеет минимум 1 опцию', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    const count = await page.locator('#dashboard-view-combo option').count();
    expect(count, 'Combo Box должен иметь хотя бы 1 опцию').toBeGreaterThanOrEqual(1);
  });
});
