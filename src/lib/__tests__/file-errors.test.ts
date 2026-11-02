import { describe, expect, it } from 'vitest'
import { friendlyFileError } from '../file-errors'

describe('friendlyFileError', () => {
  it('turns platform and bridge errors into plain words', () => {
    expect(friendlyFileError(new Error('fs list failed (502)'))).toMatch(/asleep or restarting/)
    expect(friendlyFileError(new Error('Instance has no SSH address'))).toMatch(/asleep or restarting/)
    expect(friendlyFileError(new Error('Files request failed'))).toMatch(/asleep or restarting/)
    expect(friendlyFileError(new Error('timed out'))).toMatch(/taking too long/)
    expect(friendlyFileError(new TypeError('Failed to fetch'))).toMatch(/offline/)
    expect(friendlyFileError(new Error('File not found'))).toMatch(/isn't there anymore/)
    expect(friendlyFileError(new Error("ENOENT: no such file or directory, open '/opt/data/x'"))).toMatch(/isn't there anymore/)
    expect(friendlyFileError(new Error('File too large to preview'))).toMatch(/too big/)
    expect(friendlyFileError(new Error('fs read failed (401)'))).toMatch(/Link it again/)
    expect(friendlyFileError(new Error('subscription_required'))).toMatch(/plan has ended/)
    expect(friendlyFileError(new Error('Path is a directory'))).toMatch(/folder, not a file/)
  })

  it('never shows raw paths, codes or JSON', () => {
    for (const raw of ['fs list failed (500)', '{"error":"boom"}', "EBADF /opt/data/workspace/a", undefined]) {
      const text = friendlyFileError(raw === undefined ? raw : new Error(raw))
      expect(text).not.toMatch(/\/opt\/data|\(\d{3}\)|[{}]|E[A-Z]{3,}/)
    }
  })
})
