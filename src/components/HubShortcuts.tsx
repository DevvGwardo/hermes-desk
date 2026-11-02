/**
 * Workspace shortcuts at the top of the Connect apps hub (Marketplace home):
 * Routines, Files, Tasks, Skills and Apps. They used to be rows at the top
 * of the sidebar; the hub is now the one place for everything the user
 * connects or manages, and the sidebar is conversations only.
 */
import type { ReactNode } from 'react'

export type HubShortcutId = 'routines' | 'files' | 'tasks' | 'skills' | 'apps'

export interface HubShortcut {
  id: HubShortcutId
  label: string
  /** One short line under the label. */
  hint: string
  icon: ReactNode
  /** Count chip (active routines); 0/undefined hides it. */
  badge?: number
  onSelect: () => void
}

/* 20px, 1.8 stroke, currentColor — the old sidebar nav glyphs, scaled up. */
export function RoutinesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function FilesIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-10Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

export function TasksIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M9.5 4v16M15 4v16" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  )
}

export function SkillsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5l2.4 5 5.4.7-4 3.8 1 5.4-4.8-2.6-4.8 2.6 1-5.4-4-3.8 5.4-.7L12 3.5Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}

export function AppsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16.75 13.5v6.5M13.5 16.75H20" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

/** Routines / Files / Tasks / Skills tiles; each appears only when its
 *  handler is set (Tasks only when the board is reachable, Skills only where
 *  the Skills panel runs). Apps is added by the hub itself, since it opens a
 *  view inside the hub. */
export function hubShortcuts(p: {
  onOpenRoutines?: () => void
  routinesActiveCount?: number
  onOpenFiles?: () => void
  onOpenTasks?: () => void
  onOpenSkills?: () => void
}): HubShortcut[] {
  const items: HubShortcut[] = []
  if (p.onOpenRoutines) {
    const n = p.routinesActiveCount ?? 0
    items.push({
      id: 'routines',
      label: 'Routines',
      hint: n > 0 ? `${n} active` : 'Scheduled',
      icon: <RoutinesIcon />,
      onSelect: p.onOpenRoutines,
    })
  }
  if (p.onOpenFiles) items.push({ id: 'files', label: 'Files', hint: 'Workspace', icon: <FilesIcon />, onSelect: p.onOpenFiles })
  if (p.onOpenTasks) items.push({ id: 'tasks', label: 'Tasks', hint: 'Board', icon: <TasksIcon />, onSelect: p.onOpenTasks })
  if (p.onOpenSkills) items.push({ id: 'skills', label: 'Skills', hint: 'Installed', icon: <SkillsIcon />, onSelect: p.onOpenSkills })
  return items
}
