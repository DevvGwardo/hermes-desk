/**
 * Clean up text pasted into the chat composer.
 *
 * Copies from terminals, editors and web pages usually carry a trailing
 * newline (often several) and sometimes leading blank lines. Pasted as-is,
 * those land as empty lines under the text and the auto-growing composer
 * opens a tall blank area with the caret parked at the bottom.
 *
 * `before` / `after` are the draft on either side of the selection. A run of
 * edge line breaks is dropped where it would only add blank space (at the
 * start or end of the draft, or next to an existing line break) and
 * collapsed to one break where it separates a multi-line paste from text on
 * the same line, so a block pasted mid-line doesn't glue onto its neighbours.
 * Indentation on the first real line is kept (pasted code stays aligned);
 * newlines inside the text are untouched apart from CRLF → LF.
 */
export function tidyPastedText(raw: string, before = '', after = ''): string {
  const text = raw.replace(/\r\n?/g, '\n')
  const hadLead = /^[ \t]*\n/.test(text)
  // trimEnd strips the same characters as /\s+$/ without the regex's
  // quadratic backtracking on long whitespace runs inside the paste.
  const tailWs = text.slice(text.trimEnd().length)
  const core = text.replace(/^(?:[ \t]*\n)+/, '').trimEnd()
  if (!core) return ''
  // A separating break only survives around a multi-line block; a single
  // line copied by triple-click (which grabs its newline) pastes inline.
  const block = core.includes('\n')
  const lead = block && hadLead && before !== '' && !before.endsWith('\n') ? '\n' : ''
  // Mid-line, trailing spaces are kept ("a " + "word " + "b" stays spaced);
  // only a run of line breaks is shortened.
  let trail = ''
  if (after !== '') {
    if (!tailWs.includes('\n')) trail = tailWs
    else if (block && !after.startsWith('\n')) trail = '\n'
  }
  return lead + core + trail
}
