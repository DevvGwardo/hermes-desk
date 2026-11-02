import { lazy, Suspense, useEffect, useState } from 'react'
import { getComputerBridge, type ComputerState } from '../lib/desktop-bridge'
import { ComputerPipLauncher } from './ComputerPipLauncher'

const ComputerPip = lazy(() => import('./ComputerPip').then(module => ({ default: module.ComputerPip })))

export function WorkspaceComputerPreview({ profile, agentName, placement = 'docked', visible = true }: {
  profile?: string
  agentName?: string
  placement?: 'docked' | 'floating'
  visible?: boolean
}) {
  const [state, setState] = useState<ComputerState | null>(null)
  useEffect(() => {
    const bridge = getComputerBridge()
    if (!bridge) return
    return bridge.onState(setState)
  }, [])

  return (
    <div className="workspace-computer-preview" hidden={!visible}>
      <Suspense fallback={<div className="computer-pip" role="status">Opening computer preview…</div>}>
        {state?.open && state.docked && state.profile && (
          <ComputerPip profile={state.profile} agentName={state.agentName} agentColor={state.agentColor} />
        )}
      </Suspense>
      <ComputerPipLauncher profile={profile} agentName={agentName} placement={placement} />
    </div>
  )
}
