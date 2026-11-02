import { useEffect, useState } from 'react'
import { Card, buttonClass, fieldClass, hintClass, errorText, type LocalSettingsState } from './common'

export function HermesPane({ config, status, host, busy, save, refresh }: LocalSettingsState) {
  const [mode, setMode] = useState(config?.serve.mode ?? 'auto')
  const [port, setPort] = useState(String(config?.serve.port ?? 9120))
  const [restarting, setRestarting] = useState(false)
  const [note, setNote] = useState('')
  useEffect(() => {
    if (config) { setMode(config.serve.mode); setPort(String(config.serve.port)) }
  }, [config])
  const restart = async () => {
    if (!host || restarting) return
    setRestarting(true)
    setNote('')
    try { await host.restartServe(); await refresh(); setNote('Serve restart/reconnect requested.') }
    catch (cause) { setNote(errorText(cause, 'Could not restart serve.')) }
    finally { setRestarting(false) }
  }
  return <>
    <Card id="hermes-home" title="Hermes home"><code className="break-all text-xs">{config?.hermesHome ?? 'Unavailable'}</code></Card>
    <Card id="serve" title="Hermes serve">
      <p className={hintClass}>Status: {status?.serve.state ?? 'unknown'} · {status?.serve.mode ?? 'not connected'} · port {status?.serve.port ?? 'unknown'}</p>
      <label className="mt-2 block text-xs">Serve mode
        <select aria-label="Serve mode" value={mode} className={fieldClass} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="auto">Choose an available app-owned port</option><option value="attach">Attach only (unavailable)</option><option value="spawn">Spawn app-owned serve on this port</option>
        </select>
      </label>
      <label className="mt-2 block text-xs">Serve port
        <input aria-label="Serve port" type="number" min={1024} max={65535} value={port} onChange={(event) => setPort(event.target.value)} className={fieldClass} />
      </label>
      <div className="mt-2 flex gap-2">
        <button type="button" className={buttonClass} disabled={busy || !config || !host?.setConfig}
          onClick={() => void save({ serve: { mode, port: Number(port) } }).then((ok) => { if (ok) setNote('Saved locally. Restart serve to apply these preferences.') })}>Save serve preferences</button>
        <button type="button" className={buttonClass} disabled={!host || restarting} onClick={() => void restart()}>{restarting ? 'Restarting…' : 'Restart serve'}</button>
      </div>
      <p className={hintClass}>External serve attachment is unavailable because its peer cannot be authenticated. Auto/spawn starts an app-owned process. Restart leaves the gateway and other apps alone.</p>
      {status?.installation && <p className={hintClass}>{status.installation.detected ? `Hermes binary: ${status.installation.binary}` : 'Hermes not found. Install the Hermes CLI, then restart serve.'}</p>}
      {note ? <p role="status" className={hintClass}>{note}</p> : null}
    </Card>
    <Card id="gateway" title="Gateway health and version">
      <p className={hintClass}>Gateway: {status?.gateway.state ?? 'unknown'} · version {status?.gateway.version ?? 'unknown'}</p>
      <p className={hintClass}>Serve version: {status?.serve.version ?? 'unknown'}</p>
      <p className={hintClass}>Gateway health is read-only. Hermes Desk has no messaging connections.</p>
    </Card>
  </>
}
