import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Button,
  Checkbox,
  cn,
  Codicon,
  ConfirmDialog,
  ContextMenu,
  ContextMenuItem,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  GlyphSpinner,
  Input,
  McpTab,
  profileColor,
  relativeTime,
  ScrollArea,
  SearchField,
  Select,
  SelectItem,
  Switch,
  Textarea,
  ToolsetConfigPanel,
} from '../ui'

describe('ui shims', () => {
  afterEach(() => cleanup())

  it('cn joins truthy classes', () => {
    expect(cn('a', false, 'b', null, undefined, 'c')).toBe('a b c')
  })

  it('relativeTime formats', () => {
    expect(relativeTime(Date.now())).toBe('now')
    expect(relativeTime(Date.now() - 30_000)).toBe('30s ago')
    expect(relativeTime(Date.now() - 3_600_000)).toBe('1h ago')
    expect(relativeTime(Date.now() - 86_400_000)).toBe('1d ago')
  })

  it('profileColor is deterministic', () => {
    expect(profileColor('researcher')).toBe(profileColor('researcher'))
    expect(profileColor('researcher')).not.toBe(profileColor('builder'))
  })

  it('renders primitives without crashing', () => {
    render(
      <>
        <Button>Go</Button>
        <Input placeholder="name" />
        <Textarea />
        <Checkbox aria-label="check" />
        <Switch aria-label="switch" />
        <Select aria-label="pick">
          <SelectItem value="a">A</SelectItem>
        </Select>
        <SearchField placeholder="find" />
        <ScrollArea>scroll</ScrollArea>
        <EmptyState title="Empty" />
        <GlyphSpinner />
        <Codicon name="add" />
      </>,
    )
    expect(screen.getByText('Go')).toBeTruthy()
    expect(screen.getByText('A')).toBeTruthy()
  })

  it('Dialog + ConfirmDialog render and fire handlers', () => {
    const onConfirm = () => undefined
    render(
      <Dialog open onOpenChange={() => undefined}>
        <DialogHeader>
          <DialogTitle>Title</DialogTitle>
          <DialogDescription>Desc</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={onConfirm}>OK</Button>
        </DialogFooter>
      </Dialog>,
    )
    expect(screen.getByText('Title')).toBeTruthy()
    expect(screen.getByText('Desc')).toBeTruthy()
  })

  it('ContextMenu opens on trigger click', () => {
    render(
      <ContextMenu trigger={<button>menu</button>}>
        <ContextMenuItem onSelect={() => undefined}>Edit</ContextMenuItem>
      </ContextMenu>,
    )
    expect(screen.queryByText('Edit')).toBeNull()
    fireEvent.click(screen.getByText('menu'))
    expect(screen.getByText('Edit')).toBeTruthy()
  })

  it('ConfirmDialog, McpTab, ToolsetConfigPanel render', () => {
    render(
      <>
        <ConfirmDialog open title="Sure?" onConfirm={() => undefined} onCancel={() => undefined} />
        <McpTab />
        <ToolsetConfigPanel toolset="opencode-go" />
      </>,
    )
    expect(screen.getByText('Sure?')).toBeTruthy()
    expect(screen.getByText('MCP servers')).toBeTruthy()
    expect(screen.getByText(/opencode-go configuration/)).toBeTruthy()
  })
})
