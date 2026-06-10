import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-oxc';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: false,
    testTimeout: 10_000,
    setupFiles: ['./vitest.setup.ts'],
  },
});
