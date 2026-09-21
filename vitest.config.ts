import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: Object.fromEntries(
      ['core', 'demo', 'providers'].map((p) => [
        `@jev/${p}`,
        fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url)),
      ]),
    ),
  },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 15000, restoreMocks: true },
});
