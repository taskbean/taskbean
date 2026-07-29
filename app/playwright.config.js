import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.TASKBEAN_BASE_URL || 'https://taskbean.localhost';
const normalizedBaseURL = baseURL.replace(/\/$/, '');
const defaultWebServerCommand = normalizedBaseURL === 'https://taskbean.localhost'
  ? 'npm run dev'
  : 'python agent/main.py';
const webServerCommand = process.env.TASKBEAN_WEBSERVER_COMMAND || defaultWebServerCommand;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  fullyParallel: true,
  reporter: [['html', { open: 'never' }], ['list']],
  globalSetup: './scripts/playwright-global-setup.js',
  webServer: process.env.TASKBEAN_SKIP_WEBSERVER === '1' ? undefined : {
    command: webServerCommand,
    url: `${normalizedBaseURL}/api/health`,
    reuseExistingServer: true,
    timeout: 6 * 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  
  use: {
    baseURL,
    headless: false,
    channel: 'msedge',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'smoke',
      testMatch: /smoke\.spec\.js/,
      use: { ...devices['Desktop Edge'] },
    },
    {
      name: 'features',
      testMatch: /^(?!.*model-(switch|lifecycle)).*\.spec\.js$/,
      testIgnore: /smoke\.spec\.js/,
      use: { ...devices['Desktop Edge'] },
      dependencies: ['smoke'],
    },
    {
      name: 'model-tests',
      testMatch: /model-(switch|picker)\.spec\.js/,
      use: { ...devices['Desktop Edge'] },
      dependencies: ['smoke'],
    },
  ],
});
