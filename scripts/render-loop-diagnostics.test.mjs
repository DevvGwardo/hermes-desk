import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { diagnostic } = require('../tests/e2e/render-loop-diagnostics.cjs')

describe('first React render-loop diagnostics', () => {
  it('retains ordered React component frames and setter stack without token-bearing URL queries', () => {
    const entry = diagnostic({
      args: [
        { value: 'Maximum update depth exceeded' },
        { value: '\n    at TranscriptRow (http://127.0.0.1:5173/src/row.tsx?token=obviously-fake:1)\n    at ChatPanel' },
      ],
      stackTrace: { callFrames: [{ functionName: 'setActiveDate', url: 'http://127.0.0.1:5173/src/chat.tsx?token=obviously-fake',
        lineNumber: 12, columnNumber: 4 }] },
    })
    expect(entry.componentFrames).toEqual(['    at TranscriptRow (/src/row.tsx)', '    at ChatPanel'])
    expect(entry.frames).toEqual([{ function: 'setActiveDate', source: '/src/chat.tsx', line: 13, column: 5 }])
    expect(JSON.stringify(entry)).not.toContain('token=')
  })
  it('recognizes caught Error objects and production error 185, not unrelated console output', () => {
    expect(diagnostic({ args: [{ subtype: 'error', description: 'Error: Minified React error #185' }] })).not.toBeNull()
    expect(diagnostic({ args: [{ value: 'Ordinary unrelated console output' }] })).toBeNull()
  })
  it('bounds diagnostic text and frame counts', () => {
    const entry = diagnostic({ args: [{ value: 'Maximum update depth\n' + '    at ChatPanel\n'.repeat(2000) }],
      stackTrace: { callFrames: Array.from({ length: 200 }, () => ({ functionName: 'setState', url: '', lineNumber: 0, columnNumber: 0 })) } })
    expect(entry.warning.length).toBeLessThanOrEqual(16000)
    expect(entry.componentFrames).toHaveLength(60)
    expect(entry.frames).toHaveLength(60)
  })
})
