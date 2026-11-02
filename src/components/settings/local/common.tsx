import { useSyncExternalStore, type ReactNode } from 'react'
import { getLocalPrefs, subscribeLocalPrefs } from '../../../lib/local-prefs'
import type { HostBridge, HostConfig, HostConfigPatch, HostStatus, WorkspaceBridge } from '../../../lib/desktop-bridge'
import { Section } from '../../ui/Section'
import '../../../styles/desk-tokens.css'

export type { LocalProfile, AuditEntry, ConfigDiff as BrowsingConfigDiff } from '../../../lib/desktop-bridge'
export type LocalHostConfig = HostConfig
export type LocalConfigPatch = HostConfigPatch
export type LocalHostBridge = HostBridge
export interface LocalWorkspaceBridge extends WorkspaceBridge {
  // CONTRACT: a consent-gated partition-clear handler has not been exposed yet.
  clearLaneData?(laneId: string): Promise<void>
}
export interface LocalSettingsState {
  config: LocalHostConfig | null
  status: HostStatus | null
  host: LocalHostBridge | null
  busy: boolean
  save(patch: LocalConfigPatch): Promise<boolean>
  refresh(): Promise<void>
}

export const fieldClass = 'w-full min-h-8 rounded-lg border border-[var(--desk-control-border)] bg-[var(--desk-surface-2)] px-3 py-1.5 text-[13px] text-[var(--desk-text-primary)] outline-none'
export const hintClass = 'mt-1 text-[12px] leading-4 text-[var(--desk-text-secondary)]'
export const buttonClass = 'desk-button min-h-8 min-w-8 rounded-lg border border-[var(--desk-hairline-strong)] bg-[var(--desk-surface-3)] px-3 py-1.5 text-[13px] disabled:opacity-50'
export const monoClass = 'mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[var(--desk-surface-1)] p-3 font-mono text-[12px] text-[var(--desk-text-secondary)]'
export const useLocalPrefs = () => useSyncExternalStore(subscribeLocalPrefs, getLocalPrefs, getLocalPrefs)

export function Card({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <div data-setting={id} className="desk-settings-card mb-6 rounded-lg bg-[var(--desk-surface-2)] p-4">
    <Section title={title} headingLevel={3}>{children}</Section>
  </div>
}

/** Scope legacy child tokens too, including modal/dock roots owned elsewhere. */
export function LocalPanelTheme() {
  return <style>{`
    [role="dialog"][aria-label="Settings"], [role="dialog"][aria-label="Welcome to Hermes Desk"],
    [data-side-panel="files"], [data-side-panel="info"], .hd-local-surface {
      --ca-card:var(--desk-surface-2); --ca-canvas:var(--desk-surface-0);
      --ca-ink:var(--desk-text-primary); --ca-ink-muted:var(--desk-text-secondary);
      --ca-primary-soft:var(--desk-accent-surface); --ca-primary-text:var(--desk-accent);
      --ca-primary-fill:var(--desk-accent); --ca-primary:var(--desk-accent); --ca-placeholder:var(--desk-text-tertiary);
      --ca-border:var(--desk-hairline); --ca-border-strong:var(--desk-control-border);
      --ca-hover:var(--desk-surface-3); --ca-danger:var(--desk-danger);
      --ca-success:var(--desk-success); --ca-success-text:var(--desk-success);
      color:var(--desk-text-primary); background:var(--desk-surface-1);
      font-family:var(--desk-font); color-scheme:dark;
    }
    [role="dialog"][aria-label="Settings"] button:not(.desk-switch), [data-side-panel="files"] button:not(.desk-switch),
    [data-side-panel="info"] button:not(.desk-switch), [data-side-panel="info"] summary {
      min-height:28px; min-width:28px;
    }
    [role="dialog"][aria-label="Settings"] :is(input,select,textarea):not([type="checkbox"]),
    [data-side-panel="files"] input, [data-side-panel="info"] :is(input,textarea) {
      min-height:32px; border-color:var(--desk-control-border);
    }
    [role="dialog"][aria-label="Settings"] :focus-visible, [data-side-panel="files"] :focus-visible,
    [data-side-panel="info"] :focus-visible {outline:2px solid var(--desk-focus-ring);outline-offset:2px}
  `}</style>
}

export function scrubDebugText(value: string): string {
  return value
    .replace(/-{5}BEGIN ([A-Z0-9 ]*PRIVATE[ ]KEY)-{5}[\s\S]*?(?:-{5}END \1-{5}|$)/g, '[secret]')
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|xox[bpas]-[\w-]+|AKIA[A-Z0-9]{16})\b/g, '[secret]')
    .replace(/\beyJ[\w-]+={0,2}\.[\w-]+={0,2}\.[\w-]*={0,2}(?![\w-])/g, '[secret]')
    .replace(/(bearer\s+)\S+/gi, '$1[secret]')
    .replace(/((?:password|passwd|passphrase|api[_-]?key|token|secret|authorization)(?:\s*["'])?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,;}]+)/gi, '$1[secret]')
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, '$1[secret]')
    .replace(/https?:\/\/[^\s"'<>]+/g, (text) => {
      try { return new URL(text).origin } catch { return '[url]' }
    })
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card]')
    .replace(/((?:otp|verification|one.time|code)(?:\s*[:=])?\s*)\d{4,8}\b/gi, '$1[code]')
}

export function errorText(cause: unknown, fallback: string): string {
  return cause instanceof Error ? scrubDebugText(cause.message).slice(0, 500) : fallback
}

export function controllerDetail(status: HostStatus | null): string {
  const extended = status as (HostStatus & { controllerDetail?: string; detail?: string }) | null
  const detail = {
    off: 'Hermes Desk MCP browser route is off.',
    connecting: 'Hermes Desk MCP browser route is starting.',
    ready: 'Hermes Desk MCP browser socket is listening. Enabled agents need a restarted Hermes session to load its tools.',
    error: 'Hermes Desk MCP browser route is unavailable. Check local host diagnostics.',
    mismatch: 'Hermes Desk MCP browser route reports a protocol mismatch.',
  }
  return scrubDebugText(extended?.controllerDetail || extended?.detail ||
    (status ? detail[status.controller] : 'Hermes Desk MCP browser status is not available.'))
}
