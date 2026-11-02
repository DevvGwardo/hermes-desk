import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CommandPalette } from '../CommandPalette'
import { hostMachinePhrase } from '../../lib/host-label'

beforeEach(() => {
  cleanup()
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
})
import type { Agent, ChatMessage, Conversation, Group } from '../../lib/agents'

const qa: Agent = {
  id: 'qa',
  name: 'QA Engineer',
  status: 'running',
  region: 'fsn1',
  createdAt: '2026-08-14T00:00:00Z',
  summary: 'Clicks through every new GitHub deploy.',
  persona: { title: 'QA', description: 'Clicks through every new GitHub deploy and reports what breaks.' },
}

const re: Agent = {
  id: 're',
  name: 'Reverse Engineer',
  status: 'running',
  region: 'fsn1',
  createdAt: '2026-08-14T00:00:00Z',
  summary: 'Architecture.',
  persona: { title: 'Reverse engineer', description: 'Reverse-engineer Grok Bot into a product.' },
}

const group: Group = {
  id: 'grp',
  name: 'Ops Desk',
  memberAgentIds: ['qa', 're'],
  primaryAgentId: 'qa',
  createdAt: '2026-08-14T00:00:00Z',
  summary: 'Shared room',
}

const conv: Conversation = {
  id: 'c1',
  title: 'Deploy check',
  target: { type: 'agent', agentId: 'qa' },
  createdAt: '2026-08-14T00:00:00Z',
  lastUsedAt: '2026-08-14T00:00:00Z',
}

const msg: ChatMessage = {
  id: 'm1',
  threadId: 'c1',
  role: 'agent',
  content: 'Happy eyes at 28/40 are a pass now. See https://example.com/pr.',
  createdAt: '2026-08-14T00:00:00Z',
  toolEvents: [
    {
      tool: 'write_file',
      status: 'completed',
      args: '{"file_path":"/opt/data/workspace/app/src/App.tsx"}',
    },
  ],
}

/** Walk src/ for .tsx files (excluding tests) so the scan can't go stale. */
function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue
      out.push(...tsxFiles(p))
    } else if (entry.endsWith('.tsx')) {
      out.push(p)
    }
  }
  return out
}

describe('CommandPalette files tab', () => {
  it('jumps to a workspace file from the Files tab', () => {
    const onOpenFile = vi.fn()
    const onClose = vi.fn()
    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={[]}
        agents={[]}
        onJumpToAgent={() => {}}
        files={[{ path: '/opt/data/workspace/app/src/App.tsx', label: 'App.tsx' }]}
        onOpenFile={onOpenFile}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    fireEvent.click(screen.getByText('App.tsx'))
    expect(onOpenFile).toHaveBeenCalledWith('/opt/data/workspace/app/src/App.tsx')
    expect(onClose).toHaveBeenCalled()
  })
})

describe('CommandPalette grok search', () => {
  it('shows every tab', () => {
    render(
      <CommandPalette open onClose={() => {}} commands={[]} agents={[qa]} onJumpToAgent={() => {}} />,
    )
    for (const name of ['All', 'Messages', 'Agents', 'Groups', 'Files', 'Links', 'Routines', 'Actions']) {
      expect(screen.getByRole('tab', { name })).toBeTruthy()
    }
  })

  it('empty Messages shows the type-to-search hint', () => {
    render(
      <CommandPalette
        open
        onClose={() => {}}
        commands={[]}
        agents={[qa]}
        conversations={[conv]}
        messagesByThreadId={{ c1: [msg] }}
        onJumpToAgent={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Messages' }))
    expect(screen.getByText('Search messages')).toBeTruthy()
    expect(screen.getByText('Type to find messages across your chats.')).toBeTruthy()
  })

  it('opens an agent from the All list', () => {
    const onJump = vi.fn()
    const onClose = vi.fn()
    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={[]}
        agents={[qa, re]}
        onJumpToAgent={onJump}
      />,
    )
    fireEvent.click(screen.getByText('Reverse Engineer'))
    expect(onJump).toHaveBeenCalledWith('re')
    expect(onClose).toHaveBeenCalled()
  })

  it('⌘2 activates the second row', () => {
    const onJump = vi.fn()
    render(
      <CommandPalette open onClose={() => {}} commands={[]} agents={[qa, re]} onJumpToAgent={onJump} />,
    )
    fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: '2', metaKey: true })
    expect(onJump).toHaveBeenCalledWith('re')
  })

  it('Escape closes', () => {
    const onClose = vi.fn()
    render(
      <CommandPalette open onClose={onClose} commands={[]} agents={[qa]} onJumpToAgent={() => {}} />,
    )
    fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('opens a group from the Groups tab', () => {
    const onGroup = vi.fn()
    render(
      <CommandPalette
        open
        onClose={() => {}}
        commands={[]}
        agents={[qa, re]}
        groups={[group]}
        onJumpToAgent={() => {}}
        onJumpToGroup={onGroup}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Groups' }))
    fireEvent.click(screen.getByText('Ops Desk'))
    expect(onGroup).toHaveBeenCalledWith('grp')
  })

  it('shows Create Routine when the scheduler is offline', () => {
    const onCreate = vi.fn()
    const onClose = vi.fn()
    render(
      <CommandPalette
        open
        onClose={onClose}
        commands={[]}
        agents={[]}
        routines="unavailable"
        onJumpToAgent={() => {}}
        onCreateRoutine={onCreate}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Routines' }))
    expect(screen.getByText(`Scheduler is offline — routines you create stay on ${hostMachinePhrase()}.`)).toBeTruthy()
    fireEvent.click(screen.getByText('Create Routine'))
    expect(onCreate).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('opens New Agent from the Agents tab', () => {
    const onCreate = vi.fn()
    render(
      <CommandPalette
        open
        onClose={() => {}}
        commands={[]}
        agents={[qa]}
        onJumpToAgent={() => {}}
        onCreateAgent={onCreate}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    fireEvent.click(screen.getByText('New Agent'))
    expect(onCreate).toHaveBeenCalled()
  })

  it('Enter faster than the search debounce acts on what was typed, not the old rows', () => {
    const onJump = vi.fn()
    const onCreate = vi.fn()
    render(
      <CommandPalette
        open
        onClose={() => {}}
        commands={[]}
        agents={[qa, re]}
        onJumpToAgent={onJump}
        onCreateAgent={onCreate}
      />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Agents' }))
    const input = screen.getByRole('combobox')
    // No timers advance: the 150 ms debounce hasn't fired, so the rows on
    // screen still start with the pinned "New Agent".
    fireEvent.change(input, { target: { value: 'reverse' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onCreate).not.toHaveBeenCalled()
    expect(onJump).toHaveBeenCalledWith('re')
  })

  it('closing gives focus back to where it was, and the dialog is modal', () => {
    const outside = document.createElement('textarea')
    document.body.appendChild(outside)
    outside.focus()
    const { rerender } = render(<CommandPalette open onClose={() => {}} commands={[]} agents={[qa]} onJumpToAgent={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Search' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    screen.getByRole('combobox').focus()
    rerender(<CommandPalette open={false} onClose={() => {}} commands={[]} agents={[qa]} onJumpToAgent={() => {}} />)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('Tab wraps inside the open search instead of leaving it', () => {
    render(<CommandPalette open onClose={() => {}} commands={[]} agents={[qa]} onJumpToAgent={() => {}} />)
    const input = screen.getByRole('combobox')
    const tabs = screen.getAllByRole('tab')
    const last = tabs[tabs.length - 1]
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('⌘1 faster than the debounce picks from the typed query too', () => {
    const onJump = vi.fn()
    render(
      <CommandPalette open onClose={() => {}} commands={[]} agents={[qa, re]} onJumpToAgent={onJump} />,
    )
    const input = screen.getByRole('combobox')
    fireEvent.change(input, { target: { value: 'reverse' } })
    fireEvent.keyDown(input, { key: '1', metaKey: true })
    expect(onJump).toHaveBeenCalledWith('re')
  })
})

describe('CommandPalette keyboard reachability', () => {
  it('keeps result rows out of the tab order while the input announces the selection', () => {
    render(
      <CommandPalette open onClose={() => {}} commands={[]} agents={[qa, re]} onJumpToAgent={() => {}} />,
    )
    const options = screen.getAllByRole('option')
    expect(options.length).toBe(2) // Only actions with real handlers are offered.
    for (const option of options) {
      expect((option as HTMLElement).tabIndex).toBe(-1)
    }
    const input = screen.getByPlaceholderText('Search')
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0].id)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toBe(options[1].id)
  })

  it('closes on Escape even when focus is not on the search input', () => {
    const onClose = vi.fn()
    render(
      <CommandPalette open onClose={onClose} commands={[]} agents={[qa]} onJumpToAgent={() => {}} />,
    )
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Agents' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses no positive tabIndex anywhere in src', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(join(__dirname, '..', '..', '..'))) {
      const src = readFileSync(file, 'utf8')
      if (/tabIndex=\{\s*([1-9]\d*)\s*\}/.test(src) || /tabIndex="([1-9]\d*)"/.test(src)) {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps the global :focus-visible outline rule', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'index.css'), 'utf8')
    expect(css).toMatch(/:focus-visible/)
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/)
  })
})

describe('CommandPalette spawn subagent', () => {
  it('routes through onDispatchToChat, so a page covering the chat closes first', () => {
    const onDispatchToChat = vi.fn()
    const seen: string[] = []
    const record = (e: Event) => seen.push(e.type)
    window.addEventListener('maia:spawn-scaffold', record)
    render(
      <CommandPalette open onClose={() => {}} commands={[]} agents={[]} onJumpToAgent={() => {}} onDispatchToChat={onDispatchToChat} />,
    )
    fireEvent.click(screen.getByText('Spawn subagent'))
    expect(onDispatchToChat.mock.calls.map(([e]) => e)).toEqual(['maia:focus-composer', 'maia:spawn-scaffold'])
    // Not also fired directly at a composer that may be switched off.
    expect(seen).toEqual([])
    window.removeEventListener('maia:spawn-scaffold', record)
  })
})
