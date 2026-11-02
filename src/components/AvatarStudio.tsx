import { memo } from 'react'
import { DEFAULT_BODY_COLOR, DEFAULT_EYE_COLOR } from '../lib/avatar-spec'
import { FatCatIcon, type CatExpression } from './FatCatIcon'

const EXPRESSIONS: { id: CatExpression; label: string }[] = [
  { id: 'happy', label: 'Happy' },
  { id: 'idle', label: 'Idle' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'sleeping', label: 'Sleeping' },
]

/**
 * AvatarStudio — the agent's nubcat and the expressions it shows. Every agent
 * shares the one look (sky body, navy eyes); the body and eye colour pickers
 * that used to sit here are gone.
 */
export const AvatarStudio = memo(function AvatarStudio() {
  return (
    <div data-testid="avatar-studio" className="space-y-3">
      <div className="flex justify-center">
        <FatCatIcon
          expression="happy"
          shape="cat"
          fx={null}
          still={false}
          size={120}
          fgColor={DEFAULT_BODY_COLOR}
          bgColor={DEFAULT_EYE_COLOR}
        />
      </div>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-[var(--ca-ink-muted)]">
          Expressions
        </div>
        <div className="grid grid-cols-4 gap-1.5" role="group" aria-label="Avatar expressions preview">
          {EXPRESSIONS.map((e) => (
            <div
              key={e.id}
              className="flex flex-col items-center gap-0.5 rounded-lg bg-[var(--ca-card)] py-1.5 ring-1 ring-[var(--ca-border)]"
            >
              <FatCatIcon
                expression={e.id}
                shape="cat"
                fx={null}
                still
                size={32}
                fgColor={DEFAULT_BODY_COLOR}
                bgColor={DEFAULT_EYE_COLOR}
              />
              <span className="text-[9px] text-[var(--ca-ink-muted)]">{e.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
})
