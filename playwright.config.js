import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://localhost:9999',
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  timeout: 15000,
});
