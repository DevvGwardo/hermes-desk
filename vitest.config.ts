import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Preflight: ELECTRON_SKIP exists so CI shards / low-mem runners can skip
// the Electron+scripts project — but a bare `vitest run` with the skip set
// would silently run a REDUCED suite and report green. Fail loudly unless
// the invocation explicitly scopes to the unit project.
const ELECTRON_SKIP =
  process.env.ELECTRON_SKIP === '1' || process.env.ELECTRON_SKIP === 'true'
function argvScopesUnitProject(): boolean {
  const argv = process.argv
  const idx = argv.indexOf('--project')
  if (idx !== -1 && argv[idx + 1] === 'unit') return true
  if (argv.includes('--project=unit')) return true
  // Only the exact `--project unit` shapes count — anything else is not an
  // explicit scope.
  return false
}
if (ELECTRON_SKIP && !argvScopesUnitProject()) {
  throw new Error(
    'ELECTRON_SKIP is set but vitest was not scoped with --project unit. ' +
      'Run `npm run test:unit` (or add --project unit) so the reduced suite is explicit.',
  )
}

// ELECTRON_SKIP drops the node project entirely; without the skip both
// projects run. The old ELECTRON_SKIP_BINARY_DOWNLOAD include toggle is
// subsumed: skipping the whole project is the only supported reduction.
const projects: Array<Record<string, unknown>> = [
  {
    test: {
      name: 'unit',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
      setupFiles: ['src/test-setup.ts'],
    },
  },
  ...(ELECTRON_SKIP
    ? []
    : [
        {
          test: {
            name: 'electron',
            environment: 'node',
            include: ['electron/**/*.test.mjs', 'scripts/**/*.test.mjs'],
          },
        },
      ]),
]

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  test: {
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    // 10s per test: the hermes request-timeout test and android transform
    // checks are slow by design; anything slower is a hang, not a test.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Pin the measured surface: otherwise the percentage moves with the
      // number of test files rather than with the code under test.
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/__tests__/**', '**/*.test.*', '**/mock-data.ts'],
      // Floor, not aspiration: fail --coverage runs that drop below it.
      thresholds: {
        lines: 70,
        branches: 60,
      },
    },
    projects,
  },
})
