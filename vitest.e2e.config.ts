import { defineConfig } from 'vitest/config'

// End-to-end suite: launches the built Electron app and drives its UI.
// Separate from vitest.config.ts so `pnpm test` stays a fast, headless unit run —
// these need a build, open a real window, and take minutes.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.test.ts'],
    // One app instance is shared per file and the cases are ordered, so nothing
    // here may run in parallel.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000
  }
})
