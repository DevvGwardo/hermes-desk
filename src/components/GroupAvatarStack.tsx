import { learnedRoomMember } from '../lib/agents/rooms'
import { FatCatIcon } from './FatCatIcon'
import { sidebarOrbPaused } from './Sidebar'
import { agentOrbExpression, resolveAgentMascot, type Agent, type Group } from '../lib/agents'
import { memberCatColors } from '../lib/agents/identity'

/** Grok `sand-group-avatar` / `sand-kit-avatar-stack`: two overlapping member marks. */
/**
 * A group's members as agents, in member order. A member this device's
 * roster doesn't have (made on another device) is filled in from what the
 * room feed said about it: name, title, role and mascot colors. Members
 * nobody has described yet are left out.
 */
export function groupMemberAgents(group: Group, agents: Agent[]): Agent[] {
  return group.memberAgentIds
    .map((id): Agent | null => {
      const known = agents.find((a) => a.id === id)
      if (known) return known
      const learned = learnedRoomMember(id)
      if (!learned) return null
      return {
        id,
        name: learned.name,
        summary: learned.title ?? '',
        status: 'running',
        region: 'remote',
        createdAt: '',
        ...(learned.title ? { persona: { title: learned.title, description: '' } } : {}),
        ...(learned.role ? { role: learned.role } : {}),
        ...(learned.avatarColor ? { avatarColor: learned.avatarColor } : {}),
        ...(learned.avatarEyeColor ? { avatarEyeColor: learned.avatarEyeColor } : {}),
      }
    })
    .filter((a): a is Agent => Boolean(a))
}

export function GroupAvatarStack(props: {
  members: Agent[]
  size: number
  live?: boolean
  focused?: boolean
  className?: string
}) {
  const live = props.live ?? false
  const focused = props.focused ?? true
  const shown = props.members.slice(0, 2)
  const colors = memberCatColors(props.members)
  const inner = shown.length >= 2 ? Math.round(props.size * 0.65) : props.size
  const paused = sidebarOrbPaused(focused, live)

  if (shown.length === 0) {
    return (
      <span
        className={`nub-group-stack nub-group-stack--empty ${props.className ?? ''}`.trim()}
        style={{ width: props.size, height: props.size }}
        aria-hidden="true"
      />
    )
  }

  if (shown.length === 1) {
    const mascot = resolveAgentMascot(shown[0])
    return (
      <FatCatIcon
        size={props.size}
        shape={mascot.shape}
        fgColor={mascot.color}
        expression={agentOrbExpression(shown[0], live)}
        still={paused}
        framed={false}
      />
    )
  }

  return (
    <span
      className={`nub-group-stack ${props.className ?? ''}`.trim()}
      style={{ width: props.size, height: props.size }}
      aria-hidden="true"
    >
      {shown.map((member, i) => {
        const mascot = resolveAgentMascot(member)
        return (
          <span key={member.id} className={`nub-group-stack-cat nub-group-stack-cat--${i}`}>
            <FatCatIcon
              size={inner}
              shape={mascot.shape}
              fgColor={colors.get(member.id) ?? mascot.color}
              expression={agentOrbExpression(member, live)}
              still={paused}
              framed={false}
            />
          </span>
        )
      })}
    </span>
  )
}
