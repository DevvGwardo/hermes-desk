/** Line diff for reviewing plugin edits: LCS with trimmed common ends. */
export type DiffLine =
  | { kind: 'same' | 'add' | 'remove'; text: string; oldLine: number | null; newLine: number | null }
  | { kind: 'skip'; count: number }

/** Above this many compared cells the review shows full source instead. */
const MAX_CELLS = 4_000_000

/** Null when the files are too large to compare quickly. */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] | null {
  const a = before.split('\n')
  const b = after.split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const n = endA - start
  const m = endB - start
  if (n * m > MAX_CELLS) return null
  // lengths[i][j] = LCS of a[start+i..endA) and b[start+j..endB).
  const width = m + 1
  const lengths = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = a[start + i] === b[start + j]
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1])
    }
  }
  const all: Exclude<DiffLine, { kind: 'skip' }>[] = []
  for (let k = 0; k < start; k++) all.push({ kind: 'same', text: a[k], oldLine: k + 1, newLine: k + 1 })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      all.push({ kind: 'same', text: a[start + i], oldLine: start + i + 1, newLine: start + j + 1 }); i++; j++
    } else if (i < n && (j === m || lengths[(i + 1) * width + j] >= lengths[i * width + j + 1])) {
      // Ties remove first, so an edited line reads old-then-new.
      all.push({ kind: 'remove', text: a[start + i], oldLine: start + i + 1, newLine: null }); i++
    } else {
      all.push({ kind: 'add', text: b[start + j], oldLine: null, newLine: start + j + 1 }); j++
    }
  }
  for (let k = 0; k < a.length - endA; k++) {
    all.push({ kind: 'same', text: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 })
  }
  // Keep `context` unchanged lines around each change; fold the rest.
  const keep = new Uint8Array(all.length)
  all.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, index - context); k <= Math.min(all.length - 1, index + context); k++) keep[k] = 1
  })
  const out: DiffLine[] = []
  let skipped = 0
  all.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) { out.push({ kind: 'skip', count: skipped }); skipped = 0 }
      out.push(line)
    } else skipped++
  })
  if (skipped) out.push({ kind: 'skip', count: skipped })
  return out
}
