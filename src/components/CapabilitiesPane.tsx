/** Skills are managed by the existing profile-scoped local serve panel. */
export type SkillSetupPane = 'agents'
export function CapabilitiesPane({ active, profile = 'default' }: {
  active: boolean; profile?: string; onOpenSection?: (pane: SkillSetupPane) => void
}) {
  return active ? <a className="text-xs underline" href={`#/agent/${encodeURIComponent(`profile:${profile}`)}?tools=skills`}>Open local profile skills</a> : null
}
