import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Many tests plan whole towns. A generous limit, set once here, means slow hardware cannot fail a correct
    // build; what a test costs is checked where it matters, against a yardstick (packages/core/test/cost.ts).
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
