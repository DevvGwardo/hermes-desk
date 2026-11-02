import { beforeEach, describe, expect, it } from 'vitest'
import {
  AUDIT_CAP,
  appendAuditRows,
  auditRowsFromTransportEvent,
  auditStatusLabel,
  capAuditRows,
  clearAuditLog,
  readAuditRows,
  summarizeAuditTarget,
  type AuditRow,
} from '../audit-log'

/** Fresh in-memory storage per test — no window leakage. */
function memoryStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void; removeItem: (k: string) => void } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  }
}

function row(partial: Partial<AuditRow>): AuditRow {
  return {
    ts: '2026-08-22T12:00:00.000Z',
    conversationId: 'c1',
    verb: 'tool',
    target: 'WebSearch',
    outcome: 'completed',
    origin: 'vm',
    ...partial,
  }
}

beforeEach(() => {
  clearAuditLog(memoryStorage())
})

describe('capAuditRows', () => {
  it('enforces the ring buffer by keeping the newest rows', () => {
    const many: AuditRow[] = Array.from({ length: AUDIT_CAP + 25 }, (_, i) =>
      row({ ts: `2026-08-22T12:${String(i % 60).padStart(2, '0')}:00Z`, target: `t${i}` }),
    )
    const capped = capAuditRows(many)
    expect(capped).toHaveLength(AUDIT_CAP)
    // Oldest dropped, newest kept.
    expect(capped[0]!.target).toBe('t25')
    expect(capped[capped.length - 1]!.target).toBe(`t${AUDIT_CAP + 24}`)
  })
})

describe('appendAuditRows / persistence', () => {
  it('persists across a "restart" (new storage reads what was saved)', () => {
    const disk = memoryStorage()
    appendAuditRows([row({ target: 'bashToolCall', outcome: 'running' })], disk)
    appendAuditRows(
      [row({ target: 'bashToolCall', outcome: 'completed' })],
      disk,
    )
    expect(readAuditRows(disk)).toHaveLength(2)
  })

  it('upserts by key instead of duplicating tool progress rows', () => {
    const disk = memoryStorage()
    const base = { key: 'c1:m1:bashToolCall:0', target: 'bashToolCall' }
    appendAuditRows([row({ ...base, outcome: 'running' })], disk)
    appendAuditRows([row({ ...base, outcome: 'completed' })], disk)
    const rows = readAuditRows(disk)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.outcome).toBe('completed')
  })

  it('caps past the limit on the real storage path', () => {
    const disk = memoryStorage()
    const many = Array.from({ length: AUDIT_CAP + 10 }, (_, i) =>
      row({ target: `n${i}`, ts: new Date(Date.now() + i).toISOString() }),
    )
    const stored = appendAuditRows(many, disk)
    expect(stored).toHaveLength(AUDIT_CAP)
    expect(stored[0]!.target).toBe('n10')
    expect(JSON.parse(disk.getItem('maia:audit-log:v1')!).value).toHaveLength(AUDIT_CAP)
  })
})

describe('auditRowsFromTransportEvent', () => {
  it('drops message toolEvents — tool rows are hidden from the timeline', () => {
    const rows = auditRowsFromTransportEvent(
      {
        type: 'message',
        conversationId: 'conv_9',
        message: {
          id: 'm1',
          toolEvents: [
            { tool: 'web_search', label: 'web_search', status: 'completed', summary: 'found 3 results' },
            { tool: 'bashToolCall', status: 'failed' },
          ],
        },
      },
      'mac',
    )
    expect(rows).toEqual([])
  })

  it('maps subagent runs and approval asks; skips permission clears', () => {
    const run = auditRowsFromTransportEvent(
      { type: 'subagent', run: { id: 'r1', kind: 'executor', label: 'Scout', status: 'running' } },
      'vm',
    )
    expect(run[0]).toMatchObject({ verb: 'subagent', target: 'Scout', outcome: 'running', origin: 'vm' })

    const ask = auditRowsFromTransportEvent(
      { type: 'permission', conversationId: 'c2', ask: { command: 'rm -rf build' } },
      'vm',
    )
    expect(ask[0]).toMatchObject({ verb: 'permission', target: 'rm -rf build', outcome: 'pending' })

    const clear = auditRowsFromTransportEvent(
      { type: 'permission', conversationId: 'c2', ask: null },
      'vm',
    )
    expect(clear).toEqual([])
  })

  it('collapses shell pipelines into plain-English summaries', () => {
    expect(
      summarizeAuditTarget(
        'tool',
        'cd /opt/data/workspace/maiavm-desktop-work/repo && git remote get-url origin | sed -E \'s|https://([^@]+)@|\\1|\'',
      ),
    ).toBe('Checked the git remote')
    expect(
      summarizeAuditTarget(
        'tool',
        'TOKEN=*** -C /opt/data/workspace/hermes-deploy remote get-url origin | sed -E \'s|https://([^@]+)@|\\1|\' | cat > /tmp/merge_body.json < EOF {"commit_title": "fix(artifacts): close red-team H1/H7/H6/H4/H8/H9 findings + regression tests (#108)", "merge_method": "squash"} EOF curl -s -X PUT -H "Authorization: token ***" https://api.github.com/repos/Maia-VM/hermes-deploy/pulls/108/merge -o /tmp/merge_result.json python3 -c \'import json\'',
      ),
    ).toBe('Merged a pull request')
    expect(summarizeAuditTarget('tool', 'web_search')).toBe('web_search')
    // Permission asks never show raw shell as the row title.
    expect(
      summarizeAuditTarget(
        'permission',
        'cd /opt/data/workspace/maiavm-desktop-work/repo && git remote get-url origin | head -c 8',
      ),
    ).toBe('Checking where your work is saved')
    expect(
      summarizeAuditTarget(
        'permission',
        'TOKEN=*** -C /opt/data/workspace/hermes-deploy remote get-url origin | head',
      ),
    ).toBe('Checking where your work is saved')
    // Short human asks pass through untouched.
    expect(summarizeAuditTarget('permission', 'rm -rf build')).toBe('rm -rf build')
    expect(auditStatusLabel('permission', 'pending')).toBe('Waiting for you')
    expect(auditStatusLabel('tool', 'running')).toBe('Running…')
    expect(auditStatusLabel('tool', 'completed')).toBe('Done')
  })
})
