import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 1,
  fullyParallel: true,
  reporter: [['html', { open: 'never' }], ['list']],
  
  use: {
    baseURL: 'http://localhost:8275',
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
