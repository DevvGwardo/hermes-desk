import { useEffect, useState } from 'react'
import { KNOWN_SETUP_SKILLS } from '../lib/skill-feasibility'
import {
  computeSkillSetup,
  getEnvStatus,
  getSkillRequirements,
  hasUpstreamReadiness,
  type SkillSetupState,
} from '../lib/skill-setup'

interface ReadinessRow {
  name: string
  provenance?: unknown
  [key: string]: unknown
}

/** Which installed skills get a frontmatter check when upstream says nothing. */
export function shouldCheckSkill(row: ReadinessRow): boolean {
  if (hasUpstreamReadiness(row)) return true
  return row.provenance === 'hub' || KNOWN_SETUP_SKILLS.has(row.name.toLowerCase())
}

const CONCURRENCY = 4

/**
 * name → setup state for installed skills. Uses upstream readiness fields on
 * `/api/skills` rows when present; otherwise fetches SKILL.md for the
 * skills likely to need keys and compares with `/api/env`. `version` bumps
 * force a re-check (after the drawer saves).
 */
export function useSkillReadiness(rows: readonly ReadinessRow[], enabled: boolean, version = 0): Record<string, SkillSetupState> {
  const [map, setMap] = useState<Record<string, SkillSetupState>>({})
  const key = rows.map((r) => r.name).join('|')

  useEffect(() => {
    if (!enabled || rows.length === 0) {
      setMap({})
      return
    }
    let cancelled = false
    const run = async () => {
      const targets = rows.filter(shouldCheckSkill)
      if (!targets.length) {
        setMap({})
        return
      }
      const needFetch = targets.some((r) => !hasUpstreamReadiness(r))
      const env = needFetch ? await getEnvStatus() : null
      const out: Record<string, SkillSetupState> = {}
      let i = 0
      const worker = async () => {
        while (i < targets.length && !cancelled) {
          const row = targets[i++]
          if (hasUpstreamReadiness(row)) {
            out[row.name] = computeSkillSetup(null, env, row)
            continue
          }
          const req = await getSkillRequirements(row.name)
          if (req) out[row.name] = computeSkillSetup(req, env)
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker))
      if (!cancelled) setMap(out)
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [key, enabled, version])

  return map
}
