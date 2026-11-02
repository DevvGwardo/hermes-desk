import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifiedWebSocket } = require('./serve-auth.cjs')

/** An open socket without a network: only the frame parser is exercised. */
function openSocket() {
  const Socket = verifiedWebSocket(() => true)
  const socket = Object.create(Socket.prototype)
  EventEmitter.call(socket)
  Object.assign(socket, {
    readyState: 1, buffer: Buffer.alloc(0), chunks: [], chunkBytes: 0, needBytes: 0,
    fragments: [], fragmentBytes: 0, fragmentOpcode: 0,
  })
  const messages = []
  socket.on('message', ({ data }) => messages.push(data))
  return { socket, messages }
}

function textFrame(text, { final = true, opcode = 1 } = {}) {
  const payload = Buffer.from(text)
  const size = payload.length < 126 ? 2 : payload.length <= 65535 ? 4 : 10
  const header = Buffer.alloc(size)
  header[0] = (final ? 0x80 : 0) | opcode
  header[1] = size === 2 ? payload.length : size === 4 ? 126 : 127
  if (size === 4) header.writeUInt16BE(payload.length, 2)
  if (size === 10) header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, payload])
}

function feed(socket, bytes, chunkSize) {
  for (let at = 0; at < bytes.length; at += chunkSize) socket.receive(bytes.subarray(at, at + chunkSize))
}

describe('serve WebSocket frame reassembly', () => {
  it.each([1, 3, 7, 1024])('decodes frames split into %i-byte chunks', (chunkSize) => {
    const { socket, messages } = openSocket()
    const small = '{"fixture":1}'
    const medium = JSON.stringify({ fixture: 'm'.repeat(2_000) })
    const large = JSON.stringify({ fixture: 'l'.repeat(70_000) })
    feed(socket, Buffer.concat([textFrame(small), textFrame(medium), textFrame(large)]), chunkSize)
    expect(messages).toEqual([small, medium, large])
    expect(socket.buffer.length).toBe(0)
    expect(socket.chunks).toEqual([])
  })

  it('reassembles fragmented messages and keeps a trailing partial frame', () => {
    const { socket, messages } = openSocket()
    const next = textFrame('{"next":true}')
    feed(socket, Buffer.concat([textFrame('{"part":', { final: false }), textFrame('1}', { opcode: 0 }), next.subarray(0, 5)]), 4)
    expect(messages).toEqual(['{"part":1}'])
    socket.receive(next.subarray(5))
    expect(messages).toEqual(['{"part":1}', '{"next":true}'])
  })

  it('accepts the 4,284,253-byte history frame that previously reconnect-looped', () => {
    const { socket, messages } = openSocket()
    // Captured from the default profile's "Retry previous request" transcript:
    // 313 rows in the tip session plus compression ancestors, sent in 64 KiB TCP reads.
    const history = 'x'.repeat(4_284_253)
    feed(socket, textFrame(history), 65_536)
    expect(messages).toEqual([history])
    expect(socket.buffer.length).toBe(0)
  })

  it('waits for a large frame without re-joining every chunk', () => {
    const { socket, messages } = openSocket()
    const frame = textFrame(JSON.stringify({ fixture: 'x'.repeat(200_000) }))
    feed(socket, frame.subarray(0, frame.length - 1), 4096)
    expect(messages).toEqual([])
    // Only the header was joined; the body is still parked as chunks.
    expect(socket.buffer.length).toBeLessThan(8192)
    socket.receive(frame.subarray(frame.length - 1))
    expect(messages).toHaveLength(1)
  })
})
