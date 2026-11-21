import { defineConfig } from 'vitest/config';

/**
 * The viewer's tests: the real viewer in a headless browser, against a real
 * server. They need a browser (`npx playwright install chromium`), so they
 * are run on their own with `npm run test:viewer`, not by `npm run check`.
 */
export default defineConfig({
  test: {
    include: ['packages/client/e2e/**/*.e2e.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
