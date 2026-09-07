import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Every test file spins up its own in-process PostgreSQL (PGlite). Running
    // files in separate forks keeps those instances isolated from each other.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
