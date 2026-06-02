import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    // Playwright поднимает встроенный HTTP-сервер из папки src/
    baseURL: 'http://localhost:9999',
    headless: true,    // headless для CI — быстро и без окна
    viewport: { width: 1280, height: 800 },
  },
  timeout: 15000,
  // Поднимаем статический сервер из src/ перед тестами
  webServer: {
    command: 'npx serve src -p 9999 --no-clipboard -s',
    url: 'http://localhost:9999',
    reuseExistingServer: true,
    timeout: 10000,
  },
});
