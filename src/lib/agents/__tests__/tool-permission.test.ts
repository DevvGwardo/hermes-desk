import { afterEach, describe, expect, it } from 'vitest'
import {
  getApprovalMode,
  parseApprovalMode,
  setApprovalMode,
  shouldPromptToolPermission,
  normalizePermissionChoices,
  isHighStakesApproval,
  choicesForApprovalRisk,
} from '../tool-permission'

afterEach(() => {
  window.localStorage.removeItem('maia:approvalMode')
})

describe('approval mode', () => {
  it('parses Hermes session info into ask / smart / yolo', () => {
    expect(parseApprovalMode('manual')).toBe('ask')
    expect(parseApprovalMode('ask')).toBe('ask')
    expect(parseApprovalMode('smart')).toBe('smart')
    expect(parseApprovalMode('off')).toBe('yolo')
    expect(parseApprovalMode('yolo')).toBe('yolo')
    expect(parseApprovalMode(true)).toBe('yolo')
  })

  it('survives reload via localStorage', () => {
    expect(getApprovalMode()).toBe('ask')
    setApprovalMode('yolo')
    expect(getApprovalMode()).toBe('yolo')
  })

  it('yolo skips the in-chat prompt; ask still shows it', () => {
    expect(shouldPromptToolPermission('ask')).toBe(true)
    expect(shouldPromptToolPermission('smart')).toBe(true)
    expect(shouldPromptToolPermission('yolo')).toBe(false)
  })

  it('keeps Allow once / Always / Deny as valid choices', () => {
    expect(normalizePermissionChoices(['once', 'always', 'deny'])).toEqual(['once', 'always', 'deny'])
  })
})

describe('high-stakes approvals', () => {
  it('flags money movement in command / description / message', () => {
    expect(isHighStakesApproval('stripe purchase', 'buying tokens')).toBe(true)
    expect(isHighStakesApproval('ls -la', 'Pay for the order via Stripe')).toBe(true)
    expect(isHighStakesApproval(undefined, undefined, 'withdraw 10 USDC')).toBe(true)
    expect(isHighStakesApproval('npm run build', 'compile the app')).toBe(false)
  })

  it('does not trip on substrings like payload', () => {
    expect(isHighStakesApproval('node payload.js', 'process the payload')).toBe(false)
  })

  it('strips standing grants for high-stakes, keeps one-time choices', () => {
    expect(choicesForApprovalRisk(['once', 'session', 'always', 'deny'], 'high-stakes')).toEqual([
      'once',
      'deny',
    ])
  })

  it('leaves standard approvals untouched', () => {
    expect(choicesForApprovalRisk(['once', 'session', 'always', 'deny'], 'standard')).toEqual([
      'once',
      'session',
      'always',
      'deny',
    ])
  })

  it('falls back to once/deny when the gateway only offered standing grants', () => {
    expect(choicesForApprovalRisk(['always'], 'high-stakes')).toEqual(['once', 'deny'])
    expect(choicesForApprovalRisk(undefined, 'high-stakes')).toEqual(['once', 'deny'])
  })
})
