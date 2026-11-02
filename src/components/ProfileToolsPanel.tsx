import { useEffect, useState } from 'react'
import { AppModal } from './AppModal'
import { ProfileTools } from './AgentPersonaPanel'
import { ProfileSkills } from './ProfileSkills'
import { Button } from './ui/Button'
import { LocalPanelTheme } from './settings/local/common'
import './profile-skills.css'

type Tab = 'skills' | 'memory' | 'cron' | 'usage'
export function ProfileToolsPanel({ open, onClose, initialTab = 'skills', profile, onUseSkill, onPrepareMemoryReview }: {
  open: boolean; onClose: () => void; initialTab?: Tab; profile?: string
  onUseSkill?: (profile: string, name: string) => void
  onPrepareMemoryReview?: (profile: string) => void
}) {
  const [tab, setTab] = useState<Tab>(initialTab)
  useEffect(() => { if (open) setTab(initialTab) }, [open, initialTab])
  // Do not retain an old request owner through the modal's exit animation.
  if (!open) return null
  return <AppModal open={open} onClose={onClose} title="Profile skills and memory" size="md"
    toolbar={<div className="flex gap-2" role="group" aria-label="Profile tools">
      <Button size="sm" variant={tab === 'skills' ? 'secondary' : 'ghost'} aria-pressed={tab === 'skills'} onClick={() => setTab('skills')}>Skills</Button>
      <Button size="sm" variant={tab === 'memory' ? 'secondary' : 'ghost'} aria-pressed={tab === 'memory'} onClick={() => setTab('memory')}>Memory</Button>
    </div>}>
    <LocalPanelTheme />
    <div className="desk-theme p-4">
      {!profile ? <p>Select an individual local agent to inspect its profile.</p> :
        open && tab === 'skills' ? <ProfileSkills profile={profile} onUseSkill={onUseSkill} /> :
        open && tab === 'memory' ? <ProfileTools profile={profile} kind="memory" onPrepareMemoryReview={onPrepareMemoryReview} /> :
        tab === 'cron' ? <a href="#/routines">Open Routines for saved jobs and results</a> :
        tab === 'usage' ? <p>Reported usage is shown in the owning chat. Room token limits are not billing caps.</p> : null}
    </div>
  </AppModal>
}
