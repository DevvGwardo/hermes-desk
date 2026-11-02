import { describe, expect, it } from 'vitest'
import {
  attachmentCount,
  normalizeAttachments,
  normalizeTasks,
  type KanbanTask,
} from '../kanban'

describe('normalizeTasks', () => {
  it('passes through a plain array', () => {
    const tasks = [{ id: 't1', title: 'A', status: 'todo' }]
    expect(normalizeTasks(tasks)).toEqual(tasks)
  })

  it('unwraps {tasks:[]}, {items:[]}, {cards:[]} and {results:[]}', () => {
    const tasks = [{ id: 't1', title: 'A', status: 'done' }]
    for (const key of ['tasks', 'items', 'cards', 'results']) {
      expect(normalizeTasks({ [key]: tasks })).toEqual(tasks)
    }
  })

  it('returns [] for null, primitives, objects with no array fields', () => {
    expect(normalizeTasks(null)).toEqual([])
    expect(normalizeTasks(42)).toEqual([])
    expect(normalizeTasks({ tasks: 'not-an-array' })).toEqual([])
    expect(normalizeTasks({})).toEqual([])
  })
})

describe('normalizeAttachments', () => {
  it('passes through a plain array', () => {
    const atts = [{ id: 1, filename: 'a.png' }]
    expect(normalizeAttachments(atts)).toEqual(atts)
  })

  it('unwraps {attachments:[]} and {items:[]}', () => {
    const atts = [{ id: 'x' }]
    expect(normalizeAttachments({ attachments: atts })).toEqual(atts)
    expect(normalizeAttachments({ items: atts })).toEqual(atts)
  })

  it('returns [] for junk input', () => {
    expect(normalizeAttachments(undefined)).toEqual([])
    expect(normalizeAttachments('nope')).toEqual([])
  })
})

describe('attachmentCount', () => {
  const task = (extra: Partial<KanbanTask>): KanbanTask => ({
    id: 't1',
    title: 'A',
    status: 'todo',
    ...extra,
  })

  it('reads the first finite positive count across known fields', () => {
    expect(attachmentCount(task({ attachmentsCount: 3 }))).toBe(3)
    expect(attachmentCount(task({ num_attachments: 2 }))).toBe(2)
    expect(attachmentCount(task({ attachmentCount: 1 }))).toBe(1)
    expect(attachmentCount(task({ attachments_count: 5 }))).toBe(5)
  })

  it('prefers attachmentsCount over the snake_case fallbacks', () => {
    expect(
      attachmentCount(task({ attachmentsCount: 1, num_attachments: 9 })),
    ).toBe(1)
  })

  it('returns undefined when absent, zero, negative or non-numeric', () => {
    expect(attachmentCount(task({}))).toBeUndefined()
    expect(attachmentCount(task({ attachmentsCount: 0 }))).toBeUndefined()
    expect(attachmentCount(task({ num_attachments: -1 }))).toBeUndefined()
    expect(
      attachmentCount(task({ attachmentCount: Number.NaN })),
    ).toBeUndefined()
  })
})
