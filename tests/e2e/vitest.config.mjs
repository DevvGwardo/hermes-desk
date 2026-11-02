import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node', include: ['tests/e2e/*.test.mjs', 'tests/fake-model/*.test.mjs'],
    testTimeout: 180000, hookTimeout: 180000, fileParallelism: false,
  },
})
