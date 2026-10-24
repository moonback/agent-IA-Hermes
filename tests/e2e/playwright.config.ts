import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [['list']],
  outputDir: '../../test-results/e2e',
  use: {
    baseURL: 'http://127.0.0.1:1421',
    headless: true,
    trace: 'retain-on-failure',
    // Simulated microphone (Chromium's built-in fake device) for the voice assistant tests.
    permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  },
  webServer: {
    command: 'node ../../node_modules/tsx/dist/cli.mjs stack.ts',
    url: 'http://127.0.0.1:1421',
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
  },
});
