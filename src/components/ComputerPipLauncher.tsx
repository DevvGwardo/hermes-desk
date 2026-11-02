import { useEffect, useRef, useState } from 'react'
import { getComputerBridge } from '../lib/desktop-bridge'
import { Icon } from './ui/icons'
import '../styles/pip.css'

export interface ComputerPipLauncherProps {
  profile?: string
  agentName?: string
  className?: string
  placement?: 'docked' | 'floating'
}

export function ComputerPipLauncher({ profile, agentName, className = '', placement }: ComputerPipLauncherProps) {
  const bridge = getComputerBridge()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setPending(false)
    setError('')
    return () => { generation.current++ }
  }, [profile])

  async function open() {
    if (!bridge || !profile || pending) return
    const token = generation.current
    setPending(true)
    setError('')
    try {
      if (placement) await bridge.open(profile, { docked: placement === 'docked' })
      else await bridge.open(profile)
    } catch {
      if (token === generation.current) setError('Computer preview is unavailable.')
    } finally { if (token === generation.current) setPending(false) }
  }

  return (
    <span className={`computer-pip-launcher ${className}`} style={{ color: '#f0f0f2', colorScheme: 'dark' }}>
      <button type="button" disabled={!bridge || !profile || pending} onClick={() => void open()}
        title="Last completed computer-use capture, not a live feed"
        aria-label={profile ? `Open computer preview for ${agentName || profile}` : 'Select an agent to preview its computer'}>
        <Icon name="computer" size={16} /><span>{pending ? 'Opening…' : 'Computer capture'}</span>
        {agentName && <span className="computer-pip-launcher-agent"> · {agentName}</span>}
      </button>
      {error && <span role="status">{error}</span>}
    </span>
  )
}
