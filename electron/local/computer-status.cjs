'use strict'

/** Publish only readiness flags and local copy, never raw driver diagnostics.
 * @param {Record<string, unknown> | null | undefined} result
 * @returns {{computerUse: string, computerUseDetail: string}}
 */
function computerStatus(result) {
  if (result?.platform_supported === false) return {
    computerUse: 'unavailable', computerUseDetail: 'Computer use is not supported on this platform.',
  }
  if (result?.installed === false) return {
    computerUse: 'unavailable', computerUseDetail: 'Computer-use driver is not installed. Run hermes computer-use install.',
  }
  const missing = [
    result?.accessibility === false ? 'Accessibility' : null,
    result?.screen_recording === false ? 'Screen Recording' : null,
  ].filter(Boolean)
  if (missing.length) return {
    computerUse: 'unavailable',
    computerUseDetail: `CuaDriver needs ${missing.join(' and ')} permission in macOS System Settings.`,
  }
  if (result?.ready === true) return {
    computerUse: 'available', computerUseDetail: 'Computer use is ready.',
  }
  // Hermes can report ready:false when the idle driver has no permission
  // booleans. That is unverified, not evidence that macOS denied a grant.
  if (result?.platform === 'darwin' && result?.ready === false &&
      (typeof result.accessibility !== 'boolean' || typeof result.screen_recording !== 'boolean')) return {
    computerUse: 'unknown',
    computerUseDetail: 'CuaDriver permissions are unverified. Start CuaDriver and check Accessibility and Screen Recording.',
  }
  if (result?.ready === false && !result.error) return {
    computerUse: 'unavailable', computerUseDetail: 'Computer use is not ready. Check the computer-use driver.',
  }
  return {
    computerUse: 'unknown', computerUseDetail: 'Computer-use readiness could not be verified.',
  }
}

module.exports = { computerStatus }
