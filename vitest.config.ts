import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/__tests__/**/*.ts'],
    environment: 'node',
  },
});
