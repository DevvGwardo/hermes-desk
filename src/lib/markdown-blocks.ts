/**
 * Block-stable markdown splitting for chat bubbles.
 *
 * A reply used to render as one plain `pre-wrap` paragraph while it streamed
 * and flip to parsed markdown when it settled. That flip reflowed the whole
 * bubble (headings, lists, code blocks and tables appear at once), so the
 * transcript visibly jumped on the frame the reply finished — and again on
 * every long settled row that upgraded after mount.
 *
 * Instead, the body is cut into top-level markdown blocks and the blocks are
 * grouped into prefix-stable chunks. Each chunk is parsed once and memoized
 * by its text; while streaming only the still-growing tail block re-parses on
 * a token. Streamed and settled bodies split identically, so settling only
 * re-parses the last chunk — the DOM for everything above it is untouched.
 *
 * Chunk boundaries depend only on the text BEFORE them (greedy grouping from
 * the start), so appending text never re-cuts an earlier chunk.
 */

/** A chunk closes once it holds at least this many characters. */
export const MD_CHUNK_TARGET = 1500

export interface MarkdownBlocks {
  /** Complete, prefix-stable chunks (each parsed independently). */
  chunks: string[]
  /** Streaming only: the still-growing last block (may be ''). */
  tail: string
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:\s|$)/
/** Link reference / footnote definitions resolve across the whole document;
 *  splitting would orphan them, so those bodies parse as one piece. */
const CROSS_BLOCK_DEF = /^ {0,3}\[(?:\^[^\]]+|[^\]]+)\]:\s*\S/m

function isBlank(line: string): boolean {
  return line.trim() === ''
}

/**
 * Offsets where a new top-level block may start. A boundary is a blank line
 * outside a fenced code block whose next non-blank line starts a fresh block:
 * not indented (list/paragraph continuation, indented code) and not a list
 * item (a blank line between items makes one loose list, not two lists).
 * Also returns the fence left open at the end of the text, if any.
 */
function scan(text: string): { starts: number[]; openFence: string | null } {
  const starts: number[] = [0]
  let fence: { ch: string; len: number } | null = null
  let pos = 0
  let sawBlank = false
  while (pos < text.length) {
    const nl = text.indexOf('\n', pos)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(pos, end)
    if (fence) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null
    } else if (isBlank(line)) {
      sawBlank = true
    } else {
      if (sawBlank && pos > 0 && !/^[ \t]/.test(line) && !LIST_ITEM.test(line)) {
        starts.push(pos)
      }
      sawBlank = false
      const m = FENCE_OPEN.exec(line)
      if (m) fence = { ch: m[1][0], len: m[1].length }
    }
    pos = end + 1
  }
  return { starts, openFence: fence ? fence.ch.repeat(fence.len) : null }
}

/** Close a fence the stream has not closed yet, so a code block renders as a
 *  code block while it streams instead of flashing as text. */
export function closeOpenFence(text: string): string {
  const { openFence } = scan(text)
  if (!openFence) return text
  return `${text}${text.endsWith('\n') ? '' : '\n'}${openFence}`
}

export function splitMarkdownBlocks(text: string, streaming: boolean): MarkdownBlocks {
  if (CROSS_BLOCK_DEF.test(text)) {
    return streaming ? { chunks: [], tail: text } : { chunks: [text], tail: '' }
  }
  const { starts } = scan(text)
  // While streaming the last block is still growing: it is the tail, never
  // part of a memoized chunk (its boundary only exists once text follows it).
  const lastStart = starts[starts.length - 1]
  const completeEnd = streaming ? lastStart : text.length
  const chunks: string[] = []
  let chunkStart = 0
  for (let i = 1; i < starts.length; i++) {
    const s = starts[i]
    if (s > completeEnd) break
    if (s - chunkStart >= MD_CHUNK_TARGET) {
      chunks.push(text.slice(chunkStart, s))
      chunkStart = s
    }
  }
  if (completeEnd > chunkStart) chunks.push(text.slice(chunkStart, completeEnd))
  return { chunks, tail: streaming ? text.slice(lastStart) : '' }
}

/**
 * The streaming tail is exactly one fenced code block (open, or closed on its
 * last line): its rendering needs no markdown parse — the info string's first
 * word is the language and the lines between the fences are the code. Long
 * code blocks are the common big tail, and re-running the parser over them on
 * a timer was the main source of long tasks while a reply streamed. Null for
 * anything else (indented fences, text after the closing fence, …).
 */
export function fencedCodeTail(tail: string): { lang: string; code: string } | null {
  const open = /^(`{3,}|~{3,})([^\n]*)\n?/.exec(tail)
  if (!open) return null
  const marker = open[1]
  const info = open[2]
  // A backtick fence's info string may not contain backticks (it would be
  // inline code, not a fence).
  if (marker[0] === '`' && info.includes('`')) return null
  const lines = tail.slice(open[0].length).split('\n')
  let end = lines.length
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(lines[i])
    if (m && m[1][0] === marker[0] && m[1].length >= marker.length) {
      // Closed: only whitespace may follow, or this is not a lone block.
      if (lines.slice(i + 1).some((l) => l.trim() !== '')) return null
      end = i
      break
    }
  }
  const lang = /^[\w+-]+/.exec(info.trim().split(/\s+/)[0] ?? '')?.[0] ?? ''
  return { lang, code: lines.slice(0, end).join('\n') }
}
