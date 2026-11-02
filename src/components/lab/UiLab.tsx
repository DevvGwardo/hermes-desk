import { useState } from 'react'
import type {
  Agent,
  Group,
  Conversation,
  ThreadRef,
  MessageReplyTo,
  ChatMessage,
  MessageReaction,
} from '../../lib/agents'
import { Sidebar } from '../Sidebar'
import { TopBar } from '../TopBar'
import { MessageBody } from '../MessageBody'
import { LinkPreviews } from '../LinkPreviewCard'
import { ReplyQuote } from '../ReplyQuote'
import { FileCard, FileCardStack } from '../FileCard'
import { FilePanel } from '../FilePanel'
import { primeFileText } from '../../lib/file-text-cache'
import { ProjectArtifactCard } from '../ProjectArtifactCard'
import { GroupAvatarStack } from '../GroupAvatarStack'
import { FatCatIcon } from '../FatCatIcon'
import { FatCatIconDemo } from '../FatCatIconDemo'
import NewChatBar from '../NewChatBar'
import { MessageActionAnchor, ReactionPills } from '../MessageActions'
import type { FileRef } from '../../lib/file-refs'
import type { ProjectArtifact } from '../../lib/project-artifacts'
import { RoutinesPage } from '../RoutinesPage'
import { Marketplace } from '../Marketplace'
import { hubShortcuts } from '../HubShortcuts'
import type { Routine } from '../../lib/routines'


/** Real /api/link-preview answers (captured 2026-10-02), seeded into the
 *  client cache so the cards render without a linked platform session. */
const LINK_FIXTURES: Record<string, unknown> = {
  'https://www.youtube.com/watch?v=Mgjwq1ZzdPQ': { url: 'https://www.youtube.com/watch?v=Mgjwq1ZzdPQ', kind: 'video', siteName: 'YouTube', title: 'Clueless (1995) Trailer #1 | Movieclips Classic Trailers', description: 'Rotten Tomatoes Classic Trailers', image: 'https://i.ytimg.com/vi/Mgjwq1ZzdPQ/hqdefault.jpg', favicon: 'https://www.youtube.com/s/desktop/favicon.ico', provider: 'youtube', embed: { provider: 'youtube', id: 'Mgjwq1ZzdPQ' }, author: { name: 'Rotten Tomatoes Classic Trailers', handle: '@RottenTomatoesCLASSICTRAILERS', avatar: 'https://yt3.ggpht.com/pVvKWiwE7Q3lFc9IJDIlOCIt0fgc-27QMsUzl5E4SZ4dA5cJPw0TW5bhPYVvnEkiOCabXxNHtw=s48-c-k-c0x00ffffff-no-rj' }, durationSeconds: 147, stats: [{ kind: 'views', value: 2751230 }], publishedAt: '2017-11-15T16:16:23.000Z' },
  'https://www.youtube.com/watch?v=MgjwqlZzdPQ': { url: 'https://www.youtube.com/watch?v=MgjwqlZzdPQ', kind: 'video', siteName: 'YouTube', title: null, description: null, image: null, provider: 'youtube', unavailable: true },
  'https://x.com/jack/status/20': { url: 'https://x.com/jack/status/20', kind: 'link', siteName: 'X', title: 'jack', description: 'just setting up my twttr', image: null, provider: 'x', author: { name: 'jack', handle: '@jack', avatar: 'https://pbs.twimg.com/profile_images/1661201415899951105/azNjKOSH_200x200.jpg' }, stats: [{ kind: 'replies', value: 18065 }, { kind: 'reposts', value: 124661 }, { kind: 'likes', value: 308545 }], publishedAt: '2006-03-21T20:50:14.000Z' },
  'https://github.com/vercel/next.js': { url: 'https://github.com/vercel/next.js', kind: 'link', siteName: 'GitHub', title: 'vercel/next.js', description: 'The React Framework', image: null, provider: 'github', author: { name: 'vercel', handle: null, avatar: 'https://avatars.githubusercontent.com/u/14985020?v=4' }, stats: [{ kind: 'stars', value: 142993 }, { kind: 'forks', value: 33644 }], publishedAt: '2026-10-02T18:46:45.000Z', tags: ['JavaScript'] },
  'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT': { url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', kind: 'link', siteName: 'Spotify', title: 'Never Gonna Give You Up', description: 'Rick Astley · Whenever You Need Somebody · Song · 1987', image: 'https://i.scdn.co/image/ab67616d0000b273baf89eb11ec7c657805d2da0', favicon: 'https://open.spotifycdn.com/cdn/images/favicon32.b64ecc03.png', provider: 'spotify', embed: { provider: 'spotify', type: 'track', id: '4cOdK2wGLETKBW3PvgPWqT' } },
  'https://www.theverge.com/': { url: 'https://www.theverge.com/', kind: 'link', siteName: 'The Verge', title: 'The Verge', description: 'The Verge is about technology and how it makes us feel. Founded in 2011, we offer our audience everything from breaking news to reviews to award-winning features and investigations.', image: 'https://platform.theverge.com/wp-content/uploads/sites/2/2024/10/the_verge_social_share.png', favicon: 'https://www.theverge.com/static-assets/icons/favicon-32x32.png' },
}
function seedLinkFixtures(): void {
  try {
    const key = 'nub:link-previews:v2'
    const store = JSON.parse(window.localStorage.getItem(key) || '{}') as Record<string, unknown>
    for (const [url, p] of Object.entries(LINK_FIXTURES)) store[url] = { p, at: Date.now() }
    window.localStorage.setItem(key, JSON.stringify(store))
  } catch {
    /* no storage: cards stay empty */
  }
}
const LINK_REPLY = [
  'Best one: [https://www.youtube.com/watch?v=Mgjwq1ZzdPQ](https://www.youtube.com/watch?v=Mgjwq1ZzdPQ) (Movieclips\' official trailer upload).',
  'Also https://x.com/jack/status/20 and https://github.com/vercel/next.js.',
].join('\n\n')
const LINK_REPLY_2 = 'Song: https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT, news: https://www.theverge.com/ and a dead one https://www.youtube.com/watch?v=MgjwqlZzdPQ'
const LINK_REPLY_3 = 'Poster https://upload.wikimedia.org/wikipedia/en/5/5a/Clueless_film_poster.png and the script https://example.com/files/clueless-script.pdf'

/**
 * Dev-only UI Lab: mounts real app components with fixture data so every
 * visual state can be inspected side-by-side. Gated behind isProdBuild()
 * in App.tsx — never reachable in production builds.
 */

const AGENTS: Agent[] = [
  { id: 'a1', name: 'Research Alpha', status: 'running', region: 'fsn1', createdAt: '2026-08-01T14:00:00Z', summary: 'Web research agent' },
  { id: 'a2', name: 'Ops Sentinel', status: 'stopped', region: 'fsn1', createdAt: '2026-08-02T10:00:00Z', summary: 'Infra watchdog' },
  { id: 'a3', name: 'Frost Protocol', status: 'provisioning', region: 'nbg1', createdAt: '2026-08-20T09:00:00Z', summary: 'Cold storage writer' },
]
const GROUPS: Group[] = [
  { id: 'g1', name: 'War Room', memberAgentIds: ['a1', 'a2'], primaryAgentId: 'a1', createdAt: '2026-08-01T14:00:00Z', unreadCount: 2 },
]
const CONVS: Conversation[] = [
  { id: 'c1', title: 'Scrape the launch metrics', target: { kind: 'agent', agentId: 'a1' }, createdAt: '2026-08-21T10:00:00Z', lastUsedAt: '2026-08-22T08:00:00Z' },
  { id: 'c2', title: 'War Room', target: { kind: 'group', groupId: 'g1' }, createdAt: '2026-08-01T14:00:00Z', lastUsedAt: '2026-08-22T07:30:00Z', unreadCount: 2 },
  { id: 'c3', title: 'Weekly infra digest', target: { kind: 'agent', agentId: 'a2' }, createdAt: '2026-08-15T12:00:00Z', lastUsedAt: '2026-08-20T16:00:00Z' },
] as unknown as Conversation[]
const REPLY: MessageReplyTo = { id: 'm0', role: 'agent', snippet: 'Deployed the landing page to Vercel — build went green in 42s.' }
const FILE: FileRef = { path: '/opt/data/site/index.html', action: 'write', source: 'tool' }

/** Reaction pill fixtures — mine vs theirs, single vs multi-count. */
const REACTIONS_MINE: MessageReaction[] = [{ emoji: '👍', author: 'user' }]
const REACTIONS_CROWD: MessageReaction[] = [
  { emoji: '🔥', author: 'user' },
  { emoji: '🔥', author: 'agent', at: 1755900000 },
  { emoji: '🔥', author: 'agent', at: 1755900060 },
  { emoji: '❤️', author: 'agent', at: 1755900100 },
  { emoji: '❤️', author: 'agent', at: 1755900200 },
]

/** Bubble fixtures for the hover action toolbar (real ChatMessage shape). */
const MSG_AGENT: ChatMessage = {
  id: 'm1',
  threadId: 'c1',
  role: 'agent',
  content: 'Site audit finished — 3 regressions found, patch pushed.',
  createdAt: '2026-08-22T08:00:00Z',
  fromAgentId: 'a1',
}
const MSG_USER: ChatMessage = {
  id: 'm2',
  threadId: 'c1',
  role: 'user',
  content: 'Nice — ship the patch.',
  createdAt: '2026-08-22T08:01:00Z',
}

/** Every legacy expression FatCatIcon accepts — keeps the sweep exhaustive. */
const ORB_EXPRESSIONS = [
  'sleeping', 'waking', 'idle', 'listening', 'thinking', 'searching',
  'working', 'excited', 'surprised', 'suspicious', 'angry', 'drowsy',
  'happy', 'curious', 'confused', 'bored', 'proud', 'shy',
  'sad', 'laughing', 'scared', 'playful', 'celebrate', 'orbit',
  'radar', 'progress', 'spawning', 'humming', 'loading', 'dictating',
  'writing', 'sending', 'receiving', 'uploading', 'notifying', 'alerting',
  'dragging', 'bouncing', 'powering-down', 'error',
] as const

const ARTIFACT: ProjectArtifact = {
  id: 'art1', kind: 'vite', title: 'Launch Dashboard', rootPath: '/opt/data/dashboard',
  entryFile: 'index.html', port: 5199,
}

const MARKDOWN = [
  '# Launch report',
  '',
  'Build **passed** in 42s. Files written:',
  '',
  '- `index.html` — landing page',
  '- `app.tsx` — dashboard shell',
  '',
  '| metric | value |',
  '|---|---|',
  '| LCP | 1.2s |',
  '| CLS | 0.01 |',
  '',
  '```bash',
  'vercel deploy --prod',
  '```',
].join('\n')

/** Every state the chat card can be in, as it lands on the sky wallpaper. */
const CHAT_ARTIFACTS: ProjectArtifact[] = [
  {
    id: 'site', kind: 'html', title: 'Crumb & Co. — Artisan Bakery', rootPath: '/opt/data/workspace/bakery-launch',
    entryFile: '/opt/data/workspace/bakery-launch/index.html', hostedUrl: 'https://bakery-launch-7kpr-site.nub.lol',
  },
  {
    id: 'draft', kind: 'html', title: 'bakery-launch (HTML)', rootPath: '/opt/data/workspace/bakery-launch',
    entryFile: '/opt/data/workspace/bakery-launch/index.html',
  },
  { id: 'dev', kind: 'vite', title: 'Launch Dashboard', rootPath: '/opt/data/dashboard', entryFile: 'index.html', port: 5199 },
  { id: 'static', kind: 'static', title: 'press-kit', rootPath: '/opt/data/workspace/press-kit' },
]

const HOUR = 3_600_000
const LAB_ROUTINES: Routine[] = [
  { id: 'r1', name: 'Competitor news watch', prompt: 'Check competitor news', schedule: '28 20 * * 1-5', enabled: true, origin: 'remote', deliver: 'local', lastRunAt: new Date(Date.now() - 20 * HOUR).toISOString() },
  { id: 'r2', name: 'Morning briefing', prompt: 'Brief me', schedule: '0 8 * * *', enabled: true, origin: 'remote', deliver: 'telegram', lastRunAt: new Date(Date.now() - 3 * HOUR).toISOString() },
  { id: 'r3', name: 'Inbox sweep with a deliberately long name that has to truncate on phones', prompt: 'Sweep', schedule: 'every 2h', enabled: true, origin: 'hermes' },
  { id: 'r5', name: 'repo-watcher-fastlane', prompt: 'Watch the repos', schedule: 'every 60m', enabled: true, origin: 'remote', deliver: 'origin', lastRunAt: new Date(Date.now() - 0.25 * HOUR).toISOString(), lastStatus: 'ok' },
  { id: 'r4', name: 'Weekly digest', prompt: 'Summarize', schedule: '0 9 * * 1', enabled: false, origin: 'remote', deliver: 'discord' },
]

/** Routines main view with fixture data: full list, phone width, empty. */
/** Connect apps hub: opens the real Marketplace modal with the workspace row. */
function ConnectAppsHubLab() {
  const noop = () => {}
  const [open, setOpen] = useState(false)
  const shortcuts = hubShortcuts({ onOpenRoutines: noop, routinesActiveCount: 3, onOpenFiles: noop, onOpenTasks: noop, onOpenSkills: noop })
  return (
    <Card label="Connect apps hub (real Marketplace)">
      <button type="button" data-lab-open-hub onClick={() => setOpen(true)} className="sidebar-connect-pill">
        Open Connect apps
      </button>
      <Marketplace open={open} agents={[]} onClose={() => setOpen(false)} onAdd={async () => {}} onOpenAgent={noop} shortcuts={shortcuts} />
    </Card>
  )
}

function RoutinesPageLab() {
  const [jobs, setJobs] = useState(LAB_ROUTINES)
  const toggle = async (job: Routine, enabled: boolean) => {
    await new Promise((r) => setTimeout(r, 300))
    setJobs((cur) => cur.map((j) => (j.id === job.id ? { ...j, enabled } : j)))
  }
  const page = (routines: Routine[]) => (
    <RoutinesPage
      routines={routines}
      onClose={() => {}}
      onCreate={() => {}}
      onOpen={() => {}}
      onToggle={toggle}
      onRunNow={() => new Promise((r) => setTimeout(r, 300))}
    />
  )
  const frame = { height: 560, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--ca-border)' } as const
  return (
    <section data-lab-routines style={{ gridColumn: '1 / -1', display: 'grid', gap: 12, gridTemplateColumns: 'minmax(0,1fr) 375px' }}>
      <div style={frame}>{page(jobs)}</div>
      <div style={{ ...frame, width: 375 }}>{page(jobs)}</div>
      <div style={{ ...frame, gridColumn: '1 / -1', height: 420 }}>{page([])}</div>
    </section>
  )
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section style={{ border: '1px solid var(--ca-border)', borderRadius: 14, padding: 14, background: 'var(--ca-card)' }}>
      <h3 style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--ca-ink-muted)', marginBottom: 8 }}>{label}</h3>
      {children}
    </section>
  )
}

export function UiLab() {
  const [sel, setSel] = useState('c1')
  const noop = () => {}
  return (
    <div style={{ padding: 20, background: 'var(--ca-primary-soft)', minHeight: '100vh', display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill,minmax(340px,1fr))', alignItems: 'start' }}>
      <Card label="Sidebar (real)">
        <div style={{ width: 300, height: 420, position: 'relative', border: '1px solid var(--ca-border,#e5e9f0)', borderRadius: 12, overflow: 'hidden' }}>
          <Sidebar
            agents={AGENTS}
            groups={GROUPS}
            conversations={CONVS}
            selectedConversationId={sel}
            onSelectConversation={setSel}
            onNewConversation={noop}
            onOpenTarget={noop}
            onOpenSettings={noop}
          />
        </div>
      </Card>

      <Card label="TopBar (real)">
        <TopBar agent={AGENTS[0]} showInfo={false} onToggleInfo={noop} live statusLine="Running site audit…" />
        <div style={{ height: 8 }} />
        <TopBar agent={AGENTS[1]} showInfo={true} onToggleInfo={noop} live={false} />
      </Card>

      <Card label="MessageBody — markdown / streaming / empty-caret">
        <MessageBody content={MARKDOWN} variant="markdown" />
        <hr style={{ margin: '10px 0', border: 0, borderTop: '1px solid var(--ca-border)' }} />
        <MessageBody content={'Writing the deploy script and the'} variant="plain" streaming />
        <hr style={{ margin: '10px 0', border: 0, borderTop: '1px solid var(--ca-border)' }} />
        <MessageBody content="" variant="plain" streaming />
      </Card>

      <Card label="Link previews — YouTube / X / GitHub / Spotify / page / dead / image / PDF">
        <LinkLabSection />
      </Card>

      <Card label="ReplyQuote — quote + pill">
        <ReplyQuote replyTo={REPLY} variant="quote" />
        <div style={{ height: 8 }} />
        <ReplyQuote replyTo={{ ...REPLY, role: 'user' }} variant="pill" onUser />
      </Card>

      <section
        data-lab-artifacts
        style={{ gridColumn: '1 / -1', borderRadius: 14, padding: 20, background: 'linear-gradient(180deg, var(--ca-canvas), var(--ca-canvas-deep))' }}
      >
        <div style={{ maxWidth: '42rem', display: 'grid', gap: 10 }}>
          {CHAT_ARTIFACTS.map((a) => (
            <ProjectArtifactCard key={a.id} artifact={a} onPreview={noop} onDownload={noop} onHost={noop} />
          ))}
          <ProjectArtifactCard artifact={CHAT_ARTIFACTS[0]} onPreview={noop} />
          <FileCard file={FILE} onOpen={noop} onSaveToMac={noop} />
        </div>
      </section>

      <FilePreviewLab />

      <RoutinesPageLab />

      <ConnectAppsHubLab />

      <Card label="FileCard + ProjectArtifactCard">
        <FileCard file={FILE} onOpen={noop} onSaveToMac={noop} />
        <div style={{ height: 10 }} />
        <ProjectArtifactCard artifact={ARTIFACT} onPreview={noop} onDownload={noop} onHost={noop} />
      </Card>

      <Card label="GroupAvatarStack — sizes × live">
        {[28, 40, 56].map(s => (
          <div key={s} style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
            <GroupAvatarStack members={AGENTS} size={s} live />
            <span style={{ fontSize: 11, color: 'var(--ca-ink-muted)' }}>{s}px live</span>
          </div>
        ))}
      </Card>

      <Card label={`FatCatIcon — expression sweep (all ${ORB_EXPRESSIONS.length})`}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {ORB_EXPRESSIONS.map(e => (
            <div key={e} style={{ textAlign: 'center' }}>
              <FatCatIcon expression={e} size={44} framed />
              <div style={{ fontSize: 9, color: 'var(--ca-ink-muted)', marginTop: 2 }}>{e}</div>
            </div>
          ))}
        </div>
        <hr style={{ margin: '10px 0', border: 0, borderTop: '1px solid var(--ca-border)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <FatCatIconDemo />
        </div>
      </Card>

      <Card label="ReactionPills — mine / crowd / align">
        <ReactionPills reactions={REACTIONS_MINE} />
        <div style={{ height: 6 }} />
        <ReactionPills reactions={REACTIONS_CROWD} onToggle={noop} />
        <div style={{ height: 6 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <ReactionPills reactions={REACTIONS_MINE} align="end" />
        </div>
        <div style={{ height: 6 }} />
        {/* No-toggle pills render non-interactive (cursor-default). */}
        <ReactionPills reactions={REACTIONS_CROWD.slice(3)} />
      </Card>

      <Card label="MessageActionAnchor — hover toolbar (agent vs user)">
        <MessageActionAnchor msg={MSG_AGENT} speakerName="Research Alpha">
          <div style={{ maxWidth: 340, borderRadius: 14, padding: '8px 12px', background: 'var(--ca-primary-soft, #eaf2ff)', fontSize: 13 }}>
            {MSG_AGENT.content}
          </div>
        </MessageActionAnchor>
        <div style={{ height: 10, display: 'flex', justifyContent: 'flex-end' }}>
          <MessageActionAnchor msg={MSG_USER} speakerName="You">
            <div style={{ maxWidth: 300, borderRadius: 14, padding: '8px 12px', background: 'var(--ca-primary, #2f7ed8)', color: '#fff', fontSize: 13 }}>
              {MSG_USER.content}
            </div>
          </MessageActionAnchor>
        </div>
      </Card>

      <Card label="NewChatBar — recipient picker (open)">
        <div style={{ position: 'relative', height: 360, border: '1px solid var(--ca-border,#e5e9f0)', borderRadius: 12, overflow: 'hidden', background: 'var(--ca-card)' }}>
          <NewChatBar open agents={AGENTS} groups={GROUPS} onOpenTarget={noop} onCreateAgent={noop} onClose={noop} />
        </div>
      </Card>

    </div>
  )
}

/** Route helper used by App.tsx: true when the lab is open. */
export function labThread(): ThreadRef | null { return null }

const LAB_DOCS: Record<string, string> = {
  '/opt/data/workspace/patent_test_report.md': `# Patent test report

**Verdict:** a broad patent here would be dead on arrival. Leaders open-source the protocols.

## Where a patent could still live
- Reputation-gated dynamic pricing from on-chain work history
- Auto-arbitration escrow for non-human counterparties
- Cross-rail agent identity

## Prior art checked
| Area | Hits | Risk |
|---|---|---|
| x402 payments | 14 | high |
| Solana MPP | 6 | medium |
| Agent escrow | 3 | low |

Shipping a niche product on the existing rails earns money faster than any patent would.
`,
  '/opt/data/workspace/.hermes/plans/2026-09-28-agent-payments-monetization.md': `# Agent payments: monetization plan

1. **Validate** (week 1, free): map the open rails, patent-sweep the gaps, pick one niche.
2. **Build** (weeks 2–4): tiny devnet demo of the wedge, dogfood it on Nub Agent.
3. **IP gate** (end of week 4): file a provisional only if the mechanism is novel.

> Each phase has a hard stop, so no more than one week goes by without a decision.
`,
  '/opt/data/workspace/prospects.csv': 'name,segment,channel\nAcme Law,legal,r/selfhosted\nByte CPA,accounting,Show HN\nTherapy Co,health,r/LocalLLaMA\n',
  '/opt/data/workspace/scrape.py': 'import httpx\n\n\ndef fetch(url: str) -> str:\n    """Fetch one page."""\n    return httpx.get(url, timeout=10).text\n',
}
const LAB_FILES: FileRef[] = [
  ...Object.keys(LAB_DOCS).map((path) => ({ path }) as FileRef),
  { path: '/opt/data/workspace/pitch-deck.pdf' } as FileRef,
]
for (const [path, text] of Object.entries(LAB_DOCS)) primeFileText(path, text)

/** Chat column + docked FilePanel with fixture files, so the Gumloop-style
 *  preview can be checked without a signed-in VM. */
function FilePreviewLab() {
  const [open, setOpen] = useState<string | null>(null)
  return (
    <section
      data-lab-file-preview
      style={{ gridColumn: '1 / -1', display: 'flex', height: 560, borderRadius: 14, overflow: 'hidden', border: '1px solid var(--ca-border)', background: 'var(--ca-canvas)', position: 'relative' }}
    >
      <div style={{ flex: 1, minWidth: 0, padding: 20, overflow: 'auto' }}>
        <div style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--ca-ink-muted)', marginBottom: 10 }}>
          FileCardStack + FilePanel (click a card)
        </div>
        <div style={{ maxWidth: '42rem' }}>
          <MessageBody content={'Plan\'s written. Report and supporting files below.'} variant="markdown" />
          <div style={{ height: 10 }} />
          <FileCardStack files={LAB_FILES} onOpen={setOpen} onSaveToMac={() => {}} />
        </div>
      </div>
      <FilePanel filePath={open} onClose={() => setOpen(null)} />
    </section>
  )
}

function LinkLabSection() {
  const [ready] = useState(() => {
    seedLinkFixtures()
    return true
  })
  if (!ready) return null
  return (
    <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
      {[LINK_REPLY, LINK_REPLY_2, LINK_REPLY_3].map((text) => (
        <div key={text} className="ca-bubble border border-[var(--ca-border)] bg-[var(--ca-card)] px-4 py-3 text-[15px] leading-relaxed text-[var(--ca-ink)]">
          <MessageBody content={text} variant="markdown" />
          <LinkPreviews text={text} />
        </div>
      ))}
    </div>
  )
}
