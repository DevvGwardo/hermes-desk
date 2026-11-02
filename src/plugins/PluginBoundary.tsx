/**
 * Keeps a plugin's render failure inside the plugin: the app keeps working,
 * the plugin is unloaded, and Settings → Plugins shows why.
 */
import { Component, type ReactNode } from 'react'
import { contributionOwner, inventoryEntries, publishPlugin } from './areas'
import { unloadRuntimePlugin } from './loader'
import { logger } from '../lib/logger'

interface Props { contributionId: string; children: ReactNode; fallback?: ReactNode }

export class PluginBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  componentDidCatch(error: Error) {
    const owner = contributionOwner(this.props.contributionId)
    logger.error(`[plugins] ${owner} crashed while rendering`, error)
    // After this commit: unloading removes the contribution being rendered.
    queueMicrotask(() => {
      const entry = inventoryEntries().find((row) => row.id === owner)
      unloadRuntimePlugin(owner)
      if (entry) publishPlugin({ ...entry, status: 'error',
        error: `Stopped after a display error: ${error.message}`.slice(0, 300) })
    })
  }

  render() {
    return this.state.failed ? this.props.fallback ?? null : this.props.children
  }
}

/** Renders one contribution's UI behind its own boundary. */
export function PluginRender({ id, render, fallback }: { id: string; render: () => ReactNode; fallback?: ReactNode }) {
  return <PluginBoundary contributionId={id} fallback={fallback}><RenderCall render={render} /></PluginBoundary>
}

// Calling render() inside a child lets the boundary catch a throw from it.
function RenderCall({ render }: { render: () => ReactNode }) {
  return <>{render()}</>
}
