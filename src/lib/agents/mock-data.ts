/** Seed agents, groups, sample messages / runs. */

import type { Agent, ChatMessage, Conversation, Group, SubagentRun } from './types'

/** Demo roster ids — stripped once a real Maia VM is linked. */
export const SEED_AGENT_IDS = ['inst_alpha', 'inst_ops', 'inst_draft', 'inst_new'] as const
export const SEED_GROUP_IDS = ['grp_ops_desk'] as const
export const SEED_CONVERSATION_IDS = [
  'conv_alpha_deploy',
  'conv_ops_ready',
  'conv_desk_room',
] as const

export function isDemoSeedAgentId(id: string): boolean {
  return (SEED_AGENT_IDS as readonly string[]).includes(id)
}

export const SEED_AGENTS: Agent[] = [
  {
    id: 'inst_alpha',
    name: 'Research Alpha',
    // One nubcat color per demo agent, so all four show.
    avatarColor: '#b7d9ff',
    status: 'running',
    region: 'remote',
    createdAt: '2026-08-01T14:00:00Z',
    summary: 'Web research and summarization agent on Hetzner CX22.',
    persona: {
      title: 'Curious researcher',
      description: 'Pulls docs, summarizes findings, drafts follow-ups.',
      instructionsPreview: 'Prefer primary sources; cite open TODOs clearly.',
    },
    memory: {
      summary: 'Mapped Instances → agents; auth and transcript TODOs still open.',
      pinnedNoteIds: ['note_deploy'],
    },
  },
  {
    id: 'inst_ops',
    name: 'Ops Runner',
    avatarColor: '#ffd7e6',
    status: 'running',
    region: 'remote',
    createdAt: '2026-08-05T09:30:00Z',
    summary: 'Shell and deploy helper for hermes-deploy workflows.',
    persona: {
      title: 'Pragmatic ops engineer',
      description: 'Inspects VMs, restarts instances, reports deploy status.',
      instructionsPreview: 'Confirm before destructive restarts.',
    },
    memory: {
      summary: 'Last checked nbg1 fleet health this morning.',
    },
  },
  {
    id: 'inst_draft',
    name: 'Draft Writer',
    avatarColor: '#dfc5ff',
    status: 'stopped',
    region: 'remote',
    createdAt: '2026-07-20T18:15:00Z',
    summary: 'Long-form drafting agent — stopped to save cost.',
    persona: {
      title: 'Careful writer',
      description: 'Long-form drafts and edits when spun up.',
    },
  },
  {
    id: 'inst_new',
    name: 'New Instance',
    avatarColor: '#c0ef82',
    status: 'provisioning',
    region: 'remote',
    createdAt: '2026-08-11T21:00:00Z',
    summary: 'Provisioning VM…',
    persona: {
      title: 'Bootstrapping',
      description: 'Fresh box coming online.',
    },
  },
]

/** Ops Desk group room (2 members) — design doc also names “Deploy War Room”. */
export const SEED_GROUPS: Group[] = [
  {
    id: 'grp_ops_desk',
    name: 'Ops Desk',
    memberAgentIds: ['inst_ops', 'inst_alpha'],
    primaryAgentId: 'inst_ops',
    summary: 'Shared ops + research room',
    createdAt: '2026-08-10T12:00:00Z',
    // Shared room: external users joined via the invite link.
    inviteLink: 'nub-agent://group/grp_ops_desk',
    remoteMembers: ['shara@remote', 'kaito@remote'],
  },
]

/**
 * Seed conversations (Grok parity): the sidebar lists these. Each conversation
 * owns a thread and talks to ONE target (agent or group). Multiple
 * conversations can share the same agent — a conversation is NOT an agent.
 */
export const SEED_CONVERSATIONS: Conversation[] = [
  {
    id: 'conv_alpha_deploy',
    title: 'Summarize the latest MaiaVM deploy docs',
    target: { type: 'agent', agentId: 'inst_alpha' },
    createdAt: '2026-08-11T16:00:00Z',
    lastUsedAt: '2026-08-11T16:05:00Z',
  },
  {
    id: 'conv_ops_ready',
    title: 'Ops Runner ready',
    target: { type: 'agent', agentId: 'inst_ops' },
    createdAt: '2026-08-11T15:00:00Z',
    lastUsedAt: '2026-08-11T15:10:00Z',
  },
  {
    id: 'conv_desk_room',
    title: 'Ops Desk — drop a task',
    target: { type: 'group', groupId: 'grp_ops_desk' },
    createdAt: '2026-08-10T14:00:00Z',
    lastUsedAt: '2026-08-11T14:05:00Z',
  },
]

export const SEED_SUBAGENT_HISTORY: SubagentRun[] = [
  {
    id: 'run_hist_1',
    parentAgentId: 'inst_alpha',
    kind: 'executor',
    title: 'Summarize deploy docs',
    status: 'completed',
    createdAt: '2026-08-11T15:30:00Z',
    startedAt: '2026-08-11T15:30:05Z',
    finishedAt: '2026-08-11T15:31:20Z',
    digests: [
      {
        id: 'd_h1',
        at: '2026-08-11T15:30:40Z',
        text: 'Scanned hermes-deploy README…',
      },
      {
        id: 'd_h2',
        at: '2026-08-11T15:31:10Z',
        text: 'Extracted open TODOs.',
      },
    ],
    result: {
      summary: 'Mapped Instances → agents; listed 3 open TODOs for auth/transcripts/scheduling.',
    },
  },
  {
    id: 'run_hist_2',
    parentAgentId: 'inst_alpha',
    kind: 'explore',
    title: 'Explore repo structure',
    status: 'completed',
    createdAt: '2026-08-11T16:10:00Z',
    startedAt: '2026-08-11T16:10:03Z',
    finishedAt: '2026-08-11T16:10:50Z',
    digests: [
      {
        id: 'd_x1',
        at: '2026-08-11T16:10:20Z',
        text: 'Listed top-level directories and entrypoints.',
      },
    ],
    result: {
      summary: 'Found Electron main/preload + Vite renderer; bridge lives in electron/main.cjs.',
    },
  },
  {
    id: 'run_hist_3',
    parentAgentId: 'inst_draft',
    kind: 'custom',
    title: 'Draft release notes',
    status: 'completed',
    createdAt: '2026-08-11T17:00:00Z',
    startedAt: '2026-08-11T17:00:05Z',
    finishedAt: '2026-08-11T17:02:10Z',
    digests: [
      {
        id: 'd_c1',
        at: '2026-08-11T17:00:40Z',
        text: 'Collected merged PR titles.',
      },
    ],
    result: {
      summary: 'Drafted v0.4 release notes covering the generalized hermes bridge.',
    },
  },
]

export function seedMessages(): Record<string, ChatMessage[]> {
  return {
    conv_alpha_deploy: [
      {
        id: 'm1',
        threadId: 'conv_alpha_deploy',
        role: 'system',
        content: 'Session started. Agent box is online.',
        createdAt: '2026-08-11T16:00:00Z',
      },
      {
        id: 'm2',
        threadId: 'conv_alpha_deploy',
        role: 'user',
        content: 'Summarize the latest MaiaVM deploy docs and list open TODOs.',
        createdAt: '2026-08-11T16:01:00Z',
      },
      {
        id: 'm3',
        threadId: 'conv_alpha_deploy',
        role: 'subagent',
        content: 'Mapped Instances → agents; listed 3 open TODOs for auth/transcripts/scheduling.',
        createdAt: '2026-08-11T16:02:00Z',
        subagentRunId: 'run_hist_1',
        subagentKind: 'executor',
        subagentStatus: 'completed',
      },
      {
        id: 'm4',
        threadId: 'conv_alpha_deploy',
        role: 'agent',
        fromAgentId: 'inst_alpha',
        content:
          'Landing page is at `/opt/data/workspace/landing/index.html`. Vite is up on http://127.0.0.1:5173/ if you want the React app instead.',
        createdAt: '2026-08-11T16:02:30Z',
        choices: [
          { id: 'c1', label: 'Draft API client' },
          { id: 'c2', label: 'Show deploy status' },
          { id: 'c3', label: 'Skip for now' },
        ],
      },
      {
        id: 'm5',
        threadId: 'conv_alpha_deploy',
        role: 'user',
        content: 'Also attach the env example when you have it.',
        createdAt: '2026-08-11T16:03:00Z',
        attachments: [{ id: 'a1', name: '.env.example', kind: 'file' }],
      },
      {
        id: 'm6',
        threadId: 'conv_alpha_deploy',
        role: 'system',
        content: 'Ops Runner asked Research Alpha for the deploy summary.',
        createdAt: '2026-08-11T16:04:00Z',
      },
      {
        id: 'm7',
        threadId: 'conv_alpha_deploy',
        role: 'agent',
        fromAgentId: 'inst_ops',
        toAgentId: 'inst_alpha',
        content: 'Need the latest deploy summary when you have a moment — pinging from Ops Desk.',
        createdAt: '2026-08-11T16:04:05Z',
      },
    ],
    conv_ops_ready: [
      {
        id: 'm_ops1',
        threadId: 'conv_ops_ready',
        role: 'agent',
        fromAgentId: 'inst_ops',
        content: 'Ops Runner ready. I can inspect VMs, restart instances, or report deploy status.',
        createdAt: '2026-08-11T15:00:00Z',
      },
    ],
    conv_desk_room: [
      {
        id: 'g1',
        threadId: 'conv_desk_room',
        role: 'system',
        content: 'Ops Desk — Research Alpha & Ops Runner are here.',
        createdAt: '2026-08-11T14:00:00Z',
      },
      {
        id: 'g2',
        threadId: 'conv_desk_room',
        role: 'agent',
        fromAgentId: 'inst_ops',
        content: 'Desk is open. Drop a task and one of us will pick it up.',
        createdAt: '2026-08-11T14:01:00Z',
      },
    ],
  }
}
