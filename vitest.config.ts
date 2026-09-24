import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['apps/**/*.test.ts', 'apps/**/*.test.tsx'], testTimeout: 15000 },
});
