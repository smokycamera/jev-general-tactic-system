import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  use: {
    ...(process.env.JEV_BROWSER
      ? { launchOptions: { executablePath: process.env.JEV_BROWSER } }
      : {}),
    baseURL: 'http://127.0.0.1:4318',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:4318/api/meta',
    env: { PORT: '4318', JEV_DATA_DIR: '.data/e2e', TYPESAFE_API_KEY: '', JEV_SERVICE_TOKEN: '' },
    reuseExistingServer: false,
  },
  reporter: [['list'], ['html', { open: 'never' }]],
});
