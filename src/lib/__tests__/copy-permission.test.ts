import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCopyPermissionChoice,
  getCopyPermission,
  setCopyPermission,
} from '../copy-permission'

afterEach(() => {
  window.localStorage.removeItem('nub.copyPermission')
})

describe('copy permission', () => {
  it('defaults to ask', () => {
    expect(getCopyPermission()).toBe('ask')
  })

  it('Always remembers; Once does not', () => {
    expect(applyCopyPermissionChoice('once')).toBe(true)
    expect(getCopyPermission()).toBe('ask')
    expect(applyCopyPermissionChoice('always')).toBe(true)
    expect(getCopyPermission()).toBe('always')
  })

  it('Never stores a block', () => {
    expect(applyCopyPermissionChoice('never')).toBe(false)
    expect(getCopyPermission()).toBe('never')
    setCopyPermission('ask')
    expect(getCopyPermission()).toBe('ask')
  })
})
