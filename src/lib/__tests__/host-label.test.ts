import { describe, expect, it } from 'vitest'
import { hostMachinePhrase } from '../host-label'

describe('hostMachinePhrase', () => {
  it('names Windows as this PC and Mac as this Mac', () => {
    expect(hostMachinePhrase('win32')).toBe('this PC')
    expect(hostMachinePhrase('darwin')).toBe('this Mac')
    expect(hostMachinePhrase('linux')).toBe('this computer')
  })
})
