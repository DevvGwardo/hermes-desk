import { beforeEach, describe, expect, it, vi } from 'vitest'

const serveGetDetailed = vi.fn()
const serveSend = vi.fn()
vi.mock('../hermes-rest', () => ({
  serveGetDetailed: (...a: unknown[]) => serveGetDetailed(...a),
  serveSend: (...a: unknown[]) => serveSend(...a),
}))

import {
  blueprintDefaults,
  deliveryLabel,
  deliveryRowLabel,
  homeChatHint,
  instantiateBlueprint,
  isRunOnce,
  jobSkills,
  lastAssistantText,
  splitSilence,
  listBlueprints,
  listDeliveryTargets,
  listRoutineRuns,
  listSkillOptions,
  missingBlueprintFields,
  optionLabel,
  parseBlueprints,
  parseDeliveryTargets,
  parseRuns,
  parseSkills,
  readRunOutput,
  readRunOutputDetailed,
  repeatUpdateValue,
  runStatus,
} from '../routine-cron'

beforeEach(() => {
  serveGetDetailed.mockReset()
  serveSend.mockReset()
})

describe('delivery targets', () => {
  const payload = {
    targets: [
      { id: 'local', name: 'Local (save only)', home_target_set: true, home_env_var: null },
      { id: 'telegram', name: 'Telegram', home_target_set: false, home_env_var: 'TELEGRAM_HOME_CHANNEL' },
      { id: 'discord', name: 'Discord', home_target_set: true },
      { id: 'bot_chat:default', name: 'Bot Chat (default)', home_target_set: true },
    ],
  }

  it('always leads with "Only in Nub Agent", drops profile bot-chat targets', () => {
    const t = parseDeliveryTargets(payload)
    expect(t.map((x) => x.id)).toEqual(['local', 'telegram', 'discord'])
    expect(t[0]!.name).toBe('Only in Nub Agent')
    expect(t[1]).toMatchObject({ name: 'Telegram', homeTargetSet: false })
    expect(parseDeliveryTargets(null).map((x) => x.id)).toEqual(['local'])
  })

  it('loads via GET /api/cron/delivery-targets; 404 ⇒ outdated', async () => {
    serveGetDetailed.mockResolvedValueOnce({ data: payload, status: 200 })
    const ok = await listDeliveryTargets()
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/cron/delivery-targets')
    expect(ok.kind === 'ok' && ok.value.length).toBe(3)

    serveGetDetailed.mockResolvedValueOnce({ data: null, status: 404 })
    expect(await listDeliveryTargets()).toEqual({ kind: 'outdated' })

    serveGetDetailed.mockResolvedValueOnce({ data: null, error: { message: 'down' } })
    expect(await listDeliveryTargets()).toEqual({ kind: 'unavailable', message: 'down' })
  })

  it('home chat hint only for platforms without /sethome', () => {
    expect(homeChatHint({ id: 'telegram', name: 'Telegram', homeTargetSet: false })).toMatch(/\/sethome in your Telegram chat/)
    expect(homeChatHint({ id: 'telegram', name: 'Telegram', homeTargetSet: true })).toBeNull()
    expect(homeChatHint({ id: 'local', name: 'x', homeTargetSet: false })).toBeNull()
    expect(homeChatHint(undefined)).toBeNull()
  })

  it('labels deliver values for rows', () => {
    expect(deliveryLabel('local')).toBe('Only in Nub Agent')
    expect(deliveryLabel('')).toBe('Only in Nub Agent')
    expect(deliveryLabel('telegram')).toBe('Telegram')
    expect(deliveryLabel('telegram:12345,discord')).toBe('Telegram + Discord')
    expect(deliveryLabel('home_assistant')).toBe('Home Assistant')
    expect(deliveryRowLabel('local')).toBe('In Nub Agent')
    expect(deliveryRowLabel('telegram')).toBe('To Telegram')
    expect(deliveryRowLabel('origin')).toBe('To the chat it was set up from')
  })
})

describe('repeat', () => {
  it('reads hermes repeat.times === 1 as run once', () => {
    expect(isRunOnce({ times: 1, completed: 0 })).toBe(true)
    expect(isRunOnce({ times: null, completed: 3 })).toBe(false)
    expect(isRunOnce({ times: 5 })).toBe(false)
    expect(isRunOnce(undefined)).toBe(false)
    expect(isRunOnce(1)).toBe(true)
  })
  it('writes 1 / forever', () => {
    expect(repeatUpdateValue(true)).toBe(1)
    expect(repeatUpdateValue(false)).toBe('forever')
  })
})

describe('blueprints', () => {
  const catalog = {
    blueprints: [
      {
        key: 'morning-brief',
        title: 'Morning briefing',
        description: 'A short daily briefing',
        category: 'daily',
        scheduleHuman: 'daily at 08:00',
        fields: [
          { name: 'time', type: 'time', label: 'What time?', default: '08:00', options: [], optional: false, help: '24h' },
          { name: 'deliver', type: 'enum', label: 'Where to deliver?', default: 'origin', options: ['origin', 'local', 'telegram'], optional: false },
        ],
      },
      {
        key: 'reminder',
        title: 'Reminder',
        fields: [
          { name: 'recurrence', type: 'weekdays', label: 'Repeat on', default: 'everyday', options: ['everyday', 'weekdays', 'weekends'] },
          { name: 'message', type: 'text', label: 'Remind me to', default: null },
          { name: 'interval_min', type: 'enum', label: 'How often?', default: 30, options: [15, 30] },
          { name: 'weird', type: 'slider', label: '' },
        ],
      },
      { title: 'no key' },
    ],
  }

  it('parses the schema and coerces types', () => {
    const bps = parseBlueprints(catalog)
    expect(bps.map((b) => b.key)).toEqual(['morning-brief', 'reminder'])
    const r = bps[1]!
    expect(r.fields.find((f) => f.name === 'message')!.default).toBe('')
    expect(r.fields.find((f) => f.name === 'interval_min')!.options).toEqual(['15', '30'])
    expect(r.fields.find((f) => f.name === 'weird')!).toMatchObject({ type: 'text', label: 'Weird' })
  })

  it('defaults deliver=origin to local (no originating chat from the app)', () => {
    const [brief, reminder] = parseBlueprints(catalog)
    expect(blueprintDefaults(brief!)).toEqual({ time: '08:00', deliver: 'local' })
    expect(missingBlueprintFields(reminder!, blueprintDefaults(reminder!))).toEqual(['Remind me to', 'Weird'])
  })

  it('starts free text empty: a template default is an example, not a value', () => {
    const [watch] = parseBlueprints({
      blueprints: [
        {
          key: 'competitor-watch',
          title: 'Competitor news watch',
          fields: [
            { name: 'companies', type: 'text', label: 'Which companies?', default: 'two or three competitors, by canonical name' },
            { name: 'time', type: 'time', label: 'What time?', default: '09:00' },
            { name: 'recurrence', type: 'weekdays', label: 'Repeat on', default: 'monday', options: ['monday', 'weekdays'] },
          ],
        },
      ],
    })
    const values = blueprintDefaults(watch!)
    expect(values).toEqual({ companies: '', time: '09:00', recurrence: 'monday' })
    // Required text has to be typed before the routine can be created.
    expect(missingBlueprintFields(watch!, values)).toEqual(['Which companies?'])
  })

  it('labels options', () => {
    const [, reminder] = parseBlueprints(catalog)
    const rec = reminder!.fields[0]!
    expect(optionLabel(rec, 'weekdays')).toBe('Weekdays')
    expect(optionLabel(reminder!.fields[2]!, '15')).toBe('Every 15 minutes')
  })

  it('lists via GET /api/cron/blueprints', async () => {
    serveGetDetailed.mockResolvedValueOnce({ data: catalog, status: 200 })
    const res = await listBlueprints()
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/cron/blueprints')
    expect(res.kind === 'ok' && res.value.length).toBe(2)
    serveGetDetailed.mockResolvedValueOnce({ data: null, status: 404 })
    expect(await listBlueprints()).toEqual({ kind: 'outdated' })
  })

  it('instantiates with trimmed non-empty values', async () => {
    serveSend.mockResolvedValueOnce({ ok: true, data: { id: 'j1' } })
    const res = await instantiateBlueprint('morning-brief', { time: ' 07:30 ', deliver: 'telegram', note: '  ' })
    expect(serveSend).toHaveBeenCalledWith('POST', '/api/cron/blueprints/instantiate', {
      blueprint: 'morning-brief',
      values: { time: '07:30', deliver: 'telegram' },
    })
    expect(res).toEqual({ ok: true, job: { id: 'j1' } })
  })

  it('surfaces 422 field errors and maps a route 404 to "needs an update"', async () => {
    serveSend.mockResolvedValueOnce({ ok: false, data: null, status: 422, error: "invalid time '25:00'" })
    expect(await instantiateBlueprint('x', {})).toEqual({ ok: false, error: "invalid time '25:00'" })
    serveSend.mockResolvedValueOnce({ ok: false, data: null, status: 404, error: 'Not Found' })
    expect(await instantiateBlueprint('x', {})).toMatchObject({ ok: false, outdated: true })
    serveSend.mockResolvedValueOnce({ ok: false, data: null, status: 404, error: 'Unknown blueprint: x' })
    expect(await instantiateBlueprint('x', {})).toEqual({ ok: false, error: 'Unknown blueprint: x' })
  })
})

describe('run history', () => {
  it('derives status from the run session', () => {
    expect(runStatus({ is_active: true })).toBe('running')
    expect(runStatus({ ended_at: 1, end_reason: 'cron_complete' })).toBe('ok')
    expect(runStatus({ ended_at: 1, end_reason: 'cron_incomplete_no_output' })).toBe('failed')
    expect(runStatus({ ended_at: null, is_active: false })).toBe('failed')
    // A run in an agent profile's store is closed by the agent, not the scheduler.
    expect(runStatus({ ended_at: 1, end_reason: 'agent_close' })).toBe('ok')
  })

  it('keeps the profile a run lives in, and reads its output from there', async () => {
    const [run] = parseRuns({ runs: [{ id: 'cron_j9_1', started_at: 1, ended_at: 2, end_reason: 'agent_close', profile: 'coderbob' }] })
    expect(run).toMatchObject({ status: 'ok', profile: 'coderbob' })
    serveGetDetailed.mockResolvedValueOnce({ data: { messages: [{ role: 'assistant', content: 'Two new PRs.' }] }, status: 200 })
    expect(await readRunOutputDetailed(run!.id, run!.profile)).toEqual({ kind: 'ok', value: { text: 'Two new PRs.', silent: false } })
    expect(serveGetDetailed).toHaveBeenLastCalledWith('/api/sessions/cron_j9_1/messages?limit=50&order=latest&profile=coderbob')
    serveGetDetailed.mockResolvedValueOnce({ data: { messages: [] }, status: 200 })
    await readRunOutputDetailed('cron_j1_1')
    expect(serveGetDetailed).toHaveBeenLastCalledWith('/api/sessions/cron_j1_1/messages?limit=50&order=latest')
  })

  it('parses runs (epoch seconds → ms)', () => {
    const runs = parseRuns({
      runs: [
        { id: 'cron_j1_2', started_at: 1_700_000_000, ended_at: 1_700_000_042, end_reason: 'cron_complete', is_active: false },
        { id: '' },
      ],
    })
    expect(runs).toEqual([
      { id: 'cron_j1_2', startedAt: 1_700_000_000_000, endedAt: 1_700_000_042_000, status: 'ok', endReason: 'cron_complete' },
    ])
  })

  it('GETs /api/cron/jobs/{id}/runs with a clamped limit', async () => {
    serveGetDetailed.mockResolvedValueOnce({ data: { runs: [] }, status: 200 })
    await listRoutineRuns('a b', 500)
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/cron/jobs/a%20b/runs?limit=100')
    serveGetDetailed.mockResolvedValueOnce({ data: null, status: 404 })
    expect(await listRoutineRuns('j')).toEqual({ kind: 'outdated' })
  })

  it('splits the [SILENT] marker off a run the way the cron scheduler does', () => {
    expect(splitSilence('[SILENT]')).toEqual({ text: '', silent: true })
    expect(splitSilence('  no_reply ')).toEqual({ text: '', silent: true })
    expect(splitSilence('**Tick**\n\nNothing new.\n\n[SILENT]')).toEqual({ text: '**Tick**\n\nNothing new.', silent: true })
    expect(splitSilence('[silent]\nNothing new.')).toEqual({ text: 'Nothing new.', silent: true })
    expect(splitSilence('I considered staying [SILENT] but here is the summary')).toEqual({
      text: 'I considered staying [SILENT] but here is the summary',
      silent: false,
    })
    // Bracketless tokens only count as the whole reply.
    expect(splitSilence('Report\nSILENT').silent).toBe(false)
  })

  it('reads the last assistant reply as output', async () => {
    expect(
      lastAssistantText({
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: [{ type: 'text', text: 'Here is ' }, { type: 'text', text: 'your brief' }] },
          { role: 'tool', content: 'x' },
          { role: 'assistant', content: '' },
        ],
      }),
    ).toBe('Here is your brief')
    expect(lastAssistantText({ messages: [{ role: 'assistant', content: '[SILENT]' }] })).toBe('[SILENT]')
    expect(lastAssistantText({ messages: [] })).toBeNull()

    serveGetDetailed.mockResolvedValueOnce({ data: { messages: [{ role: 'assistant', content: 'done' }] } })
    expect(await readRunOutput('cron_j_1')).toBe('done')
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/sessions/cron_j_1/messages?limit=50&order=latest')
  })

  it.each(['[SILENT]', 'silent', 'no_reply', 'no reply', '[silent]'])('preserves %s as not sent', async (marker) => {
    serveGetDetailed.mockResolvedValueOnce({ data: { messages: [{ role: 'assistant', content: marker }] }, status: 200 })
    expect(await readRunOutputDetailed('run-a')).toEqual({ kind: 'ok', value: { text: '', silent: true } })
  })

  it('distinguishes output loading failure from a successful empty session', async () => {
    serveGetDetailed.mockResolvedValueOnce({ data: null, status: 503 })
    expect(await readRunOutputDetailed('run-a')).toMatchObject({ kind: 'unavailable' })
    serveGetDetailed.mockResolvedValueOnce({ data: { messages: [] }, status: 200 })
    expect(await readRunOutputDetailed('run-a')).toEqual({ kind: 'ok', value: null })
  })
})

describe('skills', () => {
  it('accepts the bare array hermes returns and hides disabled skills', async () => {
    expect(parseSkills([{ name: 'b', description: 'B' }, { name: 'a' }, { name: 'off', enabled: false }])).toEqual([
      { name: 'a', description: '' },
      { name: 'b', description: 'B' },
    ])
    expect(parseSkills({ skills: [{ name: 'x' }] }).map((s) => s.name)).toEqual(['x'])
    serveGetDetailed.mockResolvedValueOnce({ data: [{ name: 'x' }], status: 200 })
    const res = await listSkillOptions()
    expect(serveGetDetailed).toHaveBeenCalledWith('/api/skills')
    expect(res.kind).toBe('ok')
  })

  it('reads job skills or legacy skill', () => {
    expect(jobSkills({ skills: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(jobSkills({ skill: 'a' })).toEqual(['a'])
    expect(jobSkills({})).toEqual([])
  })
})
