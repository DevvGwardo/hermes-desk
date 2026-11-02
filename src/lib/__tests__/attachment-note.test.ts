import { describe, expect, it } from 'vitest'
import { attachmentKind, attachmentName, splitAttachmentNote, withAttachmentNote } from '../attachment-note'
import { displayUserPrompt } from '../peer-roster'

describe('attachment note', () => {
  const paths = ['/opt/data/workspace/image (82).png', '/opt/data/workspace/logo [v2].svg']

  it('appends the paths for the agent and round-trips, names with brackets included', () => {
    const noted = withAttachmentNote('here is my art', paths)
    expect(noted).toBe(
      'here is my art\n\nAttached files (saved on your computer):\n• /opt/data/workspace/image (82).png\n• /opt/data/workspace/logo [v2].svg',
    )
    expect(splitAttachmentNote(noted)).toEqual({ text: 'here is my art', paths })
    // A files-only message is just the note.
    expect(splitAttachmentNote(withAttachmentNote('', paths))).toEqual({ text: '', paths })
    expect(withAttachmentNote('hi', [])).toBe('hi')
  })

  it('never strips the phrase from the middle of what the user wrote', () => {
    const raw = 'my notes say Attached files (saved on your computer): see below'
    expect(splitAttachmentNote(raw)).toEqual({ text: raw, paths: [] })
    expect(splitAttachmentNote('x\n\nAttached files (saved on your computer):\nnot a bullet')).toEqual({
      text: 'x\n\nAttached files (saved on your computer):\nnot a bullet',
      paths: [],
    })
  })

  it('the bubble never shows the note', () => {
    expect(displayUserPrompt(withAttachmentNote('here is my art', paths))).toBe('here is my art')
  })

  it('names and kinds for chips', () => {
    expect(attachmentName(paths[0]!)).toBe('image (82).png')
    expect(attachmentKind(paths[0]!)).toBe('image')
    expect(attachmentKind('/opt/data/workspace/brief.pdf')).toBe('file')
  })
})
