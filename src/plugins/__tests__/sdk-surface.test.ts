import { describe, expect, it } from 'vitest'
import * as sdk from '../sdk'
import { sdkImportMap } from '../sdk-runtime'

/** The exact 40 symbols hermes-bots imports from @hermes/plugin-sdk (grep-verified). */
const REQUIRED = [
  'atom',
  'useValue',
  'useQuery',
  'queryClient',
  'host',
  'PALETTE_AREA',
  'COMPOSER_AREAS',
  'cn',
  'relativeTime',
  'haptic',
  'profileColor',
  'Codicon',
  'Button',
  'Checkbox',
  'Dialog',
  'DialogContent',
  'DialogDescription',
  'DialogFooter',
  'DialogHeader',
  'DialogTitle',
  'ConfirmDialog',
  'EmptyState',
  'GlyphSpinner',
  'Input',
  'ScrollArea',
  'SearchField',
  'Select',
  'SelectContent',
  'SelectItem',
  'SelectTrigger',
  'SelectValue',
  'Switch',
  'Textarea',
  'Tip',
  'ContextMenu',
  'ContextMenuContent',
  'ContextMenuItem',
  'ContextMenuSeparator',
  'ContextMenuTrigger',
  'McpTab',
  'ToolsetConfigPanel',
]

describe('sdk surface', () => {
  it('exports every symbol hermes-bots imports', () => {
    for (const name of REQUIRED) {
      expect(name in sdk, `missing @hermes/plugin-sdk export: ${name}`).toBe(true)
    }
  })

  it('sdkImportMap maps all four specifiers to blob shim URLs', () => {
    const map = sdkImportMap()
    expect(map['@hermes/plugin-sdk']).toBeTruthy()
    expect(map['react']).toBeTruthy()
    expect(map['react/jsx-runtime']).toBeTruthy()
    expect(map['react/jsx-dev-runtime']).toBeTruthy()
    for (const url of Object.values(map)) {
      expect(url.startsWith('blob:')).toBe(true)
    }
  })
})
