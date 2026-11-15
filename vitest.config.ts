import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['./tests/global-setup.ts'],
    // Dashboard totals are global aggregates. Running files one at a time keeps
    // those assertions deterministic while other suites create and delete rows.
    fileParallelism: false,
  },
});
