import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        'app/**/*.d.ts',
        'app/**/*.stories.{ts,tsx}',
        'app/**/*.test.{ts,tsx}',
        'app/test/**',
      ],
      include: ['app/**/*.{ts,tsx}'],
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
    },
    environment: 'jsdom',
    include: ['app/**/*.test.{ts,tsx}'],
    setupFiles: ['./app/test/setup.ts'],
  },
});
