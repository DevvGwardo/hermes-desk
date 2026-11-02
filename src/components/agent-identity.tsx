import { createContext, memo, useContext, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { lookTint, type AgentLook } from '../lib/agents/identity'
import { FatCatIcon } from './FatCatIcon'

/**
 * Who an agent is, for anything drawn inside a chat: its mascot colors, its
 * display name, and a way to open its profile card. ChatPanel provides it;
 * outside a provider every agent falls back to its id and the default cat.
 */
export interface AgentIdentity {
  lookOf: (agentId: string) => AgentLook | null
  nameOf: (agentId: string) => string
  /** The agent a display name belongs to ("Messaged Penny" → Penny's id). */
  idForName?: (name: string) => string | null
  /** Open the profile card, anchored to the element that was clicked. */
  openProfile?: (agentId: string, anchor: HTMLElement) => void
}

const FALLBACK: AgentIdentity = { lookOf: () => null, nameOf: (id) => id }

export const AgentIdentityContext = createContext<AgentIdentity>(FALLBACK)

export function useAgentIdentity(): AgentIdentity {
  return useContext(AgentIdentityContext)
}

/** The agent's nubcat, in its own colors. */
export const AgentMascot = memo(function AgentMascot({
  agentId,
  size = 16,
}: {
  agentId: string
  size?: number
}) {
  const { lookOf } = useAgentIdentity()
  const look = lookOf(agentId)
  return <FatCatIcon size={size} still fgColor={look?.body} bgColor={look?.eye} />
})

/**
 * Mascot + name in the agent's colors. A button that opens the profile card
 * when a provider supports it; plain text otherwise.
 */
export const AgentNameChip = memo(function AgentNameChip({
  agentId,
  label,
  prefix = '',
  size = 'sm',
  children,
}: {
  agentId: string
  /** Defaults to the agent's display name. */
  label?: string
  prefix?: string
  size?: 'xs' | 'sm'
  children?: ReactNode
}) {
  const { lookOf, nameOf, openProfile } = useAgentIdentity()
  const look = lookOf(agentId)
  const name = label ?? nameOf(agentId)
  const cls = `nub-agent-chip inline-flex max-w-full min-w-0 items-center gap-1 rounded-full font-medium ${
    size === 'xs' ? 'py-0 pl-0.5 pr-1.5 text-[11px]' : 'py-0.5 pl-0.5 pr-2 text-[11px]'
  }`
  // --chip-body lets dark mode re-tint the chip (index.css): the 45% body
  // tint over a dark bubble goes mid-grey, where the eye colour can't read.
  const style = look
    ? ({ backgroundColor: lookTint(look), color: look.eye, '--chip-body': look.body } as CSSProperties)
    : undefined
  const body = (
    <>
      <FatCatIcon size={size === 'xs' ? 14 : 16} still fgColor={look?.body} bgColor={look?.eye} />
      <span className="truncate">
        {prefix}
        {name}
      </span>
      {children}
    </>
  )
  if (!openProfile) {
    return (
      <span className={`${cls} ${look ? '' : 'bg-[var(--ca-hover)] text-[var(--ca-primary-text)]'}`} style={style}>
        {body}
      </span>
    )
  }
  return (
    <button
      type="button"
      data-agent-chip={agentId}
      title={`About ${name}`}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation()
        openProfile(agentId, e.currentTarget)
      }}
      className={`${cls} cursor-pointer hover:ring-1 hover:ring-current focus-visible:outline-2 focus-visible:outline-[var(--ca-focus-ring)] ${
        look ? '' : 'bg-[var(--ca-hover)] text-[var(--ca-primary-text)]'
      }`}
      style={style}
    >
      {body}
    </button>
  )
})
