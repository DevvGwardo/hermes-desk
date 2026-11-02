import { Card, fieldClass, hintClass, type LocalSettingsState } from './common'

export function ComputerPane({ config, host, busy, save }: LocalSettingsState) {
  return <Card id="pip" title="Computer PiP">
    <p className={hintClass}>Source: latest completed capture associated with the agent’s session. No live Mac frame source exists. Watching is the default.</p>
    <label className="mt-2 block text-xs">PiP placement
      <select aria-label="PiP placement" className={fieldClass} value={config?.computer.placement ?? 'docked'} disabled={!config || !host?.setConfig || busy} onChange={(event) => void save({ computer: { placement: event.target.value as 'docked' | 'floating' } })}>
        <option value="docked">Docked</option><option value="floating">Floating</option>
      </select>
    </label>
    <label className="mt-2 block text-xs">Refresh preference (fps)
      <select aria-label="PiP refresh preference" className={fieldClass} value={config?.computer.fps ?? 2} disabled={!config || !host?.setConfig || busy} onChange={(event) => void save({ computer: { fps: Number(event.target.value) } })}>
        {[1, 2, 3, 4, 5].map((fps) => <option key={fps} value={fps}>{fps}</option>)}
      </select>
    </label>
    <p className={hintClass}>The fps preference is reserved for a future approved frame source. It does not start screen capture or turn completed captures into a live feed.</p>
  </Card>
}
