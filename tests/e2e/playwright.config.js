// @ts-check
const { defineConfig } = require('@playwright/test');

const BASE_URL = process.env.RDLOOP_GUI_URL || 'http://localhost:17333';

module.exports = defineConfig({
  testDir: '.',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: BASE_URL,
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
});
