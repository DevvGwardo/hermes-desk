'use strict'
const { requestOwnedJson } = require('../serve-auth.cjs')

/** Main-owned authenticated REST write, followed by exact scoped read-back. */
async function setProfileTimezone(profile, timezone, endpoint, stillCurrent, request = requestOwnedJson) {
  if (typeof profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile) ||
      typeof timezone !== 'string' || !timezone || timezone.length > 100) throw new Error('Invalid profile time zone')
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }) } catch { throw new Error('Use an IANA time zone') }
  if (!stillCurrent()) throw new Error('Hermes endpoint changed; reopen settings')
  const route = `/api/config?${new URLSearchParams({ profile })}`
  const result = await request(route, { ...endpoint, timezonePatch: { profile, timezone } })
  if (!stillCurrent()) throw new Error('Hermes endpoint changed after writing; reload to verify the time zone')
  if (result?.ok !== true) throw new Error('Hermes did not acknowledge the time zone write; reload to verify')
  const config = await request(`${route}&include_defaults=false`, endpoint)
  if (!stillCurrent() || config?.timezone !== timezone) throw new Error('Could not verify the saved profile time zone; reload settings')
  return true
}

module.exports = { setProfileTimezone }
