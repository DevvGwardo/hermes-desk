import { createRequire } from 'node:module'
import { mkdtemp, realpath, writeFile, symlink, open, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { createMediaProtocol, byteRange } = createRequire(import.meta.url)('./media-protocol.cjs')
let root, media, file
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'hd-media-')))
  media = createMediaProtocol({ roots: () => [root] })
  file = path.join(root, 'my clip.mp4')
  await writeFile(file, Buffer.from('0123456789'))
})
afterEach(async () => { media.clear(); await rm(root, { recursive: true, force: true }) })
const request = (url, range, method = 'GET') => new Request(url, { method, headers: range ? { Range: range } : {} })

describe('guarded media capabilities', () => {
  it('issues opaque URLs, serves MIME/length/HEAD, and never exposes a filesystem URL', async () => {
    const url = await media.open(file, 1)
    expect(url).toMatch(/^hd-media:\/\/[a-f0-9]{48}\/media$/)
    expect(url).not.toContain(root)
    const response = await media.response(request(url))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('video/mp4')
    expect(response.headers.get('Accept-Ranges')).toBe('bytes')
    expect(response.headers.get('Content-Length')).toBe('10')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.text()).toBe('0123456789')
    const head = await media.response(request(url, undefined, 'HEAD'))
    expect(head.headers.get('Content-Length')).toBe('10')
    expect(await head.text()).toBe('')
  })
  it.each([
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-3', '789', 'bytes 7-9/10'],
    ['bytes=-99', '0123456789', 'bytes 0-9/10'],
    ['bytes=8-100', '89', 'bytes 8-9/10'],
  ])('serves seek range %s without reading the whole file', async (range, body, contentRange) => {
    const response = await media.response(request(await media.open(file, 1), range))
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(contentRange)
    expect(await response.text()).toBe(body)
  })
  it.each(['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'items=0-2', 'bytes=9007199254740992-'])(
    'rejects malformed or unsatisfiable range %s', async range => {
      const response = await media.response(request(await media.open(file, 1), range))
      expect(response.status).toBe(416)
      expect(response.headers.get('Content-Range')).toBe('bytes */10')
      expect(await response.text()).toBe('')
    })
  it('streams a file beyond the generic 10 MiB read limit', async () => {
    const handle = await open(file, 'r+')
    const size = 12 * 1024 * 1024
    await handle.truncate(size)
    await handle.write(Buffer.from('END'), 0, 3, size - 3)
    await handle.close()
    const response = await media.response(request(await media.open(file, 1), 'bytes=-3'))
    expect(response.status).toBe(206)
    expect(response.headers.get('Content-Range')).toBe(`bytes ${size - 3}-${size - 1}/${size}`)
    expect(await response.text()).toBe('END')
  })
  it('rejects paths outside roots, traversal, non-media, directories and escaping symlinks', async () => {
    await symlink('/etc/hosts', path.join(root, 'escape.mp4'))
    await symlink('/dev/zero', path.join(root, 'device.mp4'))
    await writeFile(path.join(root, '.env.mp4'), 'private fixture')
    await writeFile(path.join(root, 'not-media.txt'), 'fixture')
    for (const candidate of ['/etc/hosts', path.join(root, '../escape.mp4'), root,
      path.join(root, 'escape.mp4'), path.join(root, 'device.mp4'),
      path.join(root, '.env.mp4'), path.join(root, 'not-media.txt')]) {
      await expect(media.open(candidate, 1)).rejects.toThrow()
    }
  })
  it('rechecks containment when a granted file is replaced with a symlink', async () => {
    const url = await media.open(file, 1)
    await rm(file)
    await symlink('/etc/hosts', file)
    expect((await media.response(request(url))).status).toBe(404)
  })
  it('rejects invented, modified, revoked and cross-owner capabilities and non-read methods', async () => {
    const url = await media.open(file, 1)
    for (const invalid of ['file:///etc/hosts', 'hd-media://file/media', url + '?path=/etc/hosts', url + '#ignored']) {
      expect((await media.response(request(invalid))).status).toBe(404)
    }
    expect((await media.response(new Request(url, { method: 'POST' }))).status).toBe(405)
    media.release(url, 2)
    expect(await (await media.response(request(url))).text()).toBe('0123456789')
    media.release(url, 1)
    expect((await media.response(request(url))).status).toBe(404)
  })
  it('revokes one owner without revoking another and clears all remaining grants', async () => {
    const first = await media.open(file, 1), second = await media.open(file, 2)
    media.releaseOwner(1)
    expect((await media.response(request(first))).status).toBe(404)
    expect(await (await media.response(request(second))).text()).toBe('0123456789')
    media.clear()
    expect((await media.response(request(second))).status).toBe(404)
  })
  it('caps concurrent grants, including simultaneous requests, and can reopen after release', async () => {
    const results = await Promise.allSettled(Array.from({ length: 70 }, () => media.open(file, 1)))
    const grants = results.filter(result => result.status === 'fulfilled')
    expect(grants).toHaveLength(64)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(6)
    media.release(grants[0].value, 1)
    expect(await media.open(file, 1)).toMatch(/^hd-media:/)
  })
  it('treats a range on an empty file as unsatisfiable', () => {
    expect(byteRange('bytes=0-', 0)).toBe(false)
    expect(byteRange(null, 0)).toBeNull()
  })
  it('bounds active streams and frees capacity when their reader cancels', async () => {
    const handle = await open(file, 'r+')
    await handle.truncate(32 * 1024 * 1024)
    await handle.close()
    const url = await media.open(file, 1)
    const responses = await Promise.all(Array.from({ length: 16 }, () => media.response(request(url))))
    expect(responses.every(response => response.status === 200)).toBe(true)
    expect((await media.response(request(url))).status).toBe(503)
    await Promise.all(responses.map(response => response.body.cancel()))
    const next = await media.response(request(url, 'bytes=0-2'))
    expect(next.status).toBe(206)
    expect(await next.text()).toBe('012')
  })
  it('destroys active streams when a capability is revoked', async () => {
    const handle = await open(file, 'r+')
    await handle.truncate(32 * 1024 * 1024)
    await handle.close()
    const url = await media.open(file, 1)
    const reader = (await media.response(request(url))).body.getReader()
    expect((await reader.read()).value.byteLength).toBeLessThanOrEqual(64 * 1024)
    media.release(url, 1)
    // The adapter can yield an already-buffered chunk before signaling cancellation.
    let stopped = false
    for (let n = 0; n < 8 && !stopped; n++) {
      try { stopped = (await reader.read()).done } catch { stopped = true }
    }
    expect(stopped).toBe(true)
    expect((await media.response(request(url))).status).toBe(404)
  })
  it.each(['releaseOwner', 'clear'])('cancels in-flight grants on %s rather than leaking them into the next renderer', async method => {
    const pending = media.open(file, 1)
    media[method](1)
    await expect(pending).rejects.toThrow('Media player closed')
    expect(await media.open(file, 1)).toMatch(/^hd-media:/)
  })
})
