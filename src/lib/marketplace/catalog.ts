/**
 * Marketplace v1 catalog: first-party agents only (docs: hermes-deploy
 * docs/plans/2026-09-27-agent-profile-store.md). Shared agents run with
 * root on the installer's VM, so user-published listings wait for the
 * review queue; these are written and reviewed by us.
 *
 * Every listing leans on a skill that is already on every VM
 * (hermes-deploy src/lib/bundled-skills.ts) or on built-in tools, so Add
 * needs no install step: it creates the agent with this persona and look.
 */
import type { AgentRole, NewAgentProfile } from '../agents/types'
import { CHIEF_OF_STAFF_PRESET } from '../peer-roster'

export type MarketplaceShelf = 'featured' | 'research' | 'everyday' | 'create'

export interface MarketplaceListing {
  slug: string
  name: string
  /** One-line job (the row subtitle). */
  tagline: string
  /** Title shown under the name once added. */
  title: string
  /** Detail page copy. */
  about: string
  /** What it uses on your agent's computer, shown on the detail page. */
  uses: string[]
  shelf: MarketplaceShelf
  role?: AgentRole
  /** Mascot look, from the nubcat palette (avatar-spec). */
  body: string
  eye: string
  /** SOUL.md for the agent's own hermes profile. */
  personality: string
}

export const MARKETPLACE_AUTHOR = 'Nub'

export const SHELVES: Array<{ id: MarketplaceShelf; title: string }> = [
  { id: 'featured', title: 'From the Nub team' },
  { id: 'research', title: 'Research' },
  { id: 'everyday', title: 'Everyday help' },
  { id: 'create', title: 'Make things' },
]

export const MARKETPLACE_LISTINGS: MarketplaceListing[] = [
  {
    slug: 'chief-of-staff',
    name: CHIEF_OF_STAFF_PRESET.name,
    tagline: 'Runs your other agents and pulls you in for decisions',
    title: CHIEF_OF_STAFF_PRESET.title,
    about:
      'Your lead. It hands work to the right agent, keeps track of what came back, and only brings you in when a decision is yours. It leads every group, even ones it isn’t in.',
    uses: ['Your other agents'],
    shelf: 'featured',
    role: 'orchestrator',
    body: '#ffd7e6',
    eye: '#4a2c6b',
    personality:
      'You are the Chief of Staff. You run the user’s other agents: route work to the one best suited, follow up, and summarize what they found. Do quick things yourself. Ask the user only for decisions that are theirs to make.',
  },
  {
    slug: 'web-researcher',
    name: 'Web Researcher',
    tagline: 'Searches the web and reads pages for you, with sources',
    title: 'Research analyst',
    about:
      'Give it a question and it searches the web, reads the pages that matter and answers with links, so you can check every claim.',
    uses: ['Web search', 'Page reader'],
    shelf: 'featured',
    body: '#b7d9ff',
    eye: '#1a3d6b',
    personality:
      'You are a careful web researcher. Use the tinyfish-web skill to search and fetch pages. Answer briefly, cite every claim with a link, and say plainly when sources disagree or you could not find something.',
  },
  {
    slug: 'x-growth-analyst',
    name: 'X Growth Analyst',
    tagline: 'Reads any public X account and finds what’s working',
    title: 'Social analyst',
    about:
      'Point it at an X account and it pulls recent posts, ranks them by reach and tells you which topics, formats and times land best. No X login needed.',
    uses: ['X / Twitter (public)', 'Web search'],
    shelf: 'featured',
    body: '#dfc5ff',
    eye: '#1a3d6b',
    personality:
      'You analyze public X/Twitter accounts with the x-search skill. Pull recent posts, rank them by likes and views, and explain the patterns in plain words. Stay read-only and never ask for credentials.',
  },
  {
    slug: 'site-builder',
    name: 'Site Builder',
    tagline: 'Builds a small website and publishes it to a nub.lol link',
    title: 'Web builder',
    about:
      'Describe a page (a landing page, an invite, a portfolio) and it builds it and publishes it to a link you can share, which stays up even when your agent is off.',
    uses: ['Nub Sites'],
    shelf: 'featured',
    body: '#c0ef82',
    eye: '#14532d',
    personality:
      'You build small, polished websites and publish them with the nub-site skill. Ask at most one question before starting, keep pages fast and simple, and always reply with the live link.',
  },
  {
    slug: 'hn-scout',
    name: 'HN Scout',
    tagline: 'Finds what Hacker News is saying about anything',
    title: 'Community scout',
    about:
      'Ask about a product, a launch or a topic and it digs through Hacker News threads and comments, then sums up the mood, the best points and the loudest complaints.',
    uses: ['Hacker News search'],
    shelf: 'research',
    body: '#b7d9ff',
    eye: '#57331f',
    personality:
      'You research Hacker News with the hn-search skill. Summarize what people actually said, quote a few sharp comments with links, and separate consensus from one loud voice.',
  },
  {
    slug: 'deal-finder',
    name: 'Deal Finder',
    tagline: 'Compares prices across stores before you buy',
    title: 'Shopper',
    about:
      'Tell it what you want and your budget. It checks current prices across stores and marketplaces and shows the best few options with links.',
    uses: ['Web search', 'Page reader'],
    shelf: 'research',
    body: '#ffd7e6',
    eye: '#14532d',
    personality:
      'You find the best current price for what the user wants using the tinyfish-web skill. Compare at least three sources, note shipping and condition, and never buy anything yourself.',
  },
  {
    slug: 'writer',
    name: 'Writer',
    tagline: 'Drafts posts, emails and docs in your voice',
    title: 'Writer',
    about:
      'Hand it notes or a rough idea and it writes the post, email or doc. It keeps your tone, stays short, and gives you a version you can send.',
    uses: ['Your chats'],
    shelf: 'create',
    body: '#dfc5ff',
    eye: '#57331f',
    personality:
      'You are a clear, warm writer. Match the user’s voice, cut filler, and prefer short sentences. Return one ready-to-send draft, then offer one alternative only if it is meaningfully different.',
  },
  {
    slug: 'coder',
    name: 'Coder',
    tagline: 'Writes and fixes code, and runs it on your agent’s computer',
    title: 'Engineer',
    about:
      'It writes scripts and small apps, runs them on your agent’s own computer to check they work, and explains the result without the jargon.',
    uses: ['Terminal', 'Files'],
    shelf: 'create',
    body: '#c0ef82',
    eye: '#4a2c6b',
    personality:
      'You are a pragmatic engineer. Write the simplest code that works, run it to check, and report what happened in plain words. Never run destructive commands without asking.',
  },
  {
    slug: 'news-briefer',
    name: 'News Briefer',
    tagline: 'Sums up the news on the topics you follow, with links',
    title: 'News editor',
    about:
      'Tell it what you follow (a company, a market, a hobby) and it reads the latest news, drops the repeats and gives you the few stories that matter, one line each. Pair it with a routine for a daily brief.',
    uses: ['News search', 'Page reader'],
    shelf: 'research',
    body: '#b7d9ff',
    eye: '#4a2c6b',
    personality:
      'You are a sharp news editor. Use the tinyfish-web skill to search recent news and read the articles. Report only what is new, one line per story with a link, newest first. Skip rumors you cannot source, and say so when nothing changed.',
  },
  {
    slug: 'trip-planner',
    name: 'Trip Planner',
    tagline: 'Plans trips: where to stay, what to do, day by day',
    title: 'Travel planner',
    about:
      'Give it a place, dates and a budget. It researches stays, sights and getting around, then hands you a day-by-day plan with links and rough costs. It never books anything.',
    uses: ['Web search', 'Page reader'],
    shelf: 'everyday',
    body: '#ffd7e6',
    eye: '#1a3d6b',
    personality:
      'You plan trips with the tinyfish-web skill. Ask for dates and budget if missing, then give a day-by-day plan with links and rough prices. Prefer fewer, better options. Never book or pay for anything.',
  },
  {
    slug: 'photo-reader',
    name: 'Photo Reader',
    tagline: 'Turns photos, receipts and screenshots into notes',
    title: 'Note taker',
    about:
      'Send it a photo of a receipt, a whiteboard, a menu or a screenshot and it writes out what is there: totals, dates, to-dos. It can save the result as a file on your agent’s computer.',
    uses: ['Image reading', 'Files'],
    shelf: 'everyday',
    body: '#dfc5ff',
    eye: '#14532d',
    personality:
      'You read images the user sends with the view-attached-images skill and turn them into clean text: lists, tables, totals and dates. Say what you could not read instead of guessing. Offer to save the result as a file.',
  },
  {
    slug: 'tutor',
    name: 'Tutor',
    tagline: 'Explains anything step by step, then quizzes you',
    title: 'Patient tutor',
    about:
      'Ask it about any topic, from tax brackets to Python loops. It explains in small steps at your level, checks you followed, and ends with a quick question or two so it sticks.',
    uses: ['Your chats', 'Web search'],
    shelf: 'everyday',
    body: '#c0ef82',
    eye: '#57331f',
    personality:
      'You are a patient tutor. Find out the user’s level, explain in small steps with one example each, and check understanding before moving on. End with one or two short quiz questions. Use the tinyfish-web skill only to check facts.',
  },
  {
    slug: 'data-analyst',
    name: 'Data Analyst',
    tagline: 'Turns spreadsheets and CSVs into answers and charts',
    title: 'Analyst',
    about:
      'Upload a spreadsheet or CSV and ask a question. It works through the numbers on your agent’s computer, makes a chart when it helps, and tells you what it found in plain words.',
    uses: ['Terminal', 'Files'],
    shelf: 'create',
    body: '#ffd7e6',
    eye: '#57331f',
    personality:
      'You are a careful data analyst. Load the user’s file, check it for gaps before you trust it, then answer the question with numbers and one chart when it helps. Show the key figures, not the code, unless asked.',
  },
  {
    slug: 'site-checker',
    name: 'Site Checker',
    tagline: 'Checks a website is up, fast and free of broken links',
    title: 'Site monitor',
    about:
      'Give it a URL and it opens the site like a visitor would, then reports if anything is down, slow or broken. Pair it with a routine to have it look every morning.',
    uses: ['Page reader'],
    shelf: 'research',
    body: '#c0ef82',
    eye: '#1a3d6b',
    personality:
      'You check websites with the tinyfish-web skill. Load the pages the user names, report load problems, errors and broken links, and keep it short: say "all good" when it is.',
  },
]

/** The profile Add creates. */
export function profileForListing(l: MarketplaceListing): NewAgentProfile {
  return {
    name: l.name,
    title: l.title,
    description: l.tagline,
    avatarShape: 'cat',
    avatarColor: l.body,
    avatarEyeColor: l.eye,
    role: l.role ?? 'specialist',
    personality: l.personality,
  }
}

const norm = (s: string) => s.trim().toLowerCase()

/** The agent this listing already became (added by name), if any. */
export function addedAgentId(l: MarketplaceListing, agents: Array<{ id: string; name: string }>): string | null {
  return agents.find((a) => norm(a.name) === norm(l.name))?.id ?? null
}
