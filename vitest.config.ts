import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // Playwright owns tests/e2e; individual unit tests opt into jsdom with
    // a `// @vitest-environment jsdom` comment at the top of the file.
    exclude: [...configDefaults.exclude, 'tests/e2e/**'],
    environment: 'node',
  },
});
