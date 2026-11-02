/**
 * Marketplace → Routines: ready-made routines a user can start from. "Use"
 * opens the routine editor pre-filled (RoutineEditor `seed`), so nothing
 * is scheduled until the user reviews it and presses Create. Every recipe
 * only needs what ships on every VM (web search/fetch, X, Hacker News,
 * files; hermes-deploy src/lib/bundled-skills.ts). The prompts are shown to
 * the user, so they say what to do in plain words and never name a skill:
 * the agent picks its own tools.
 *
 * Words in [brackets] are the bits to make your own (a topic, a URL); the
 * detail page says so.
 */
import type { RoutineDraft } from '../routines'

export interface RoutineRecipe {
  slug: string
  name: string
  /** One line for the row. */
  tagline: string
  /** The instruction the routine runs. */
  prompt: string
  /** 5-field cron in the agent's time zone. */
  schedule: string
}

export const ROUTINE_RECIPES: RoutineRecipe[] = [
  {
    slug: 'morning-briefing',
    name: 'Morning briefing',
    tagline: 'The few stories that matter on your topics',
    prompt:
      'Search the news from the last 24 hours about [AI, tech and markets]. Give me the five stories that matter most, one line each with a link. Skip anything I would already have seen yesterday.',
    schedule: '0 9 * * 1-5',
  },
  {
    slug: 'weekly-wrap-up',
    name: 'Weekly wrap-up',
    tagline: 'What got done this week and what is still open',
    prompt:
      'Look back over this week’s chats and the files you worked on. List what got done, what is still open, and the three things to pick up first on Monday. Keep it under 150 words.',
    schedule: '0 17 * * 5',
  },
  {
    slug: 'hn-digest',
    name: 'Hacker News digest',
    tagline: 'Top threads on the topics you care about',
    prompt:
      'Find the most discussed Hacker News threads from the last day about [AI agents]. Give me the top five with a one-line summary of what people think and a link to each.',
    schedule: '0 9 * * *',
  },
  {
    slug: 'x-account-watch',
    name: 'X account watch',
    tagline: 'New posts from an account, with likes and links',
    prompt:
      'Check the latest posts on X from [@nasa]. List anything posted since yesterday with its likes and a link. If nothing is new, just say so.',
    schedule: '0 18 * * *',
  },
  {
    slug: 'price-check',
    name: 'Price check',
    tagline: 'Tells you when something drops below your price',
    prompt:
      'Check the current price of [the product] at the big online stores. Tell me only if one is under [$100], with the store and a link. Never buy anything.',
    schedule: '0 10 * * *',
  },
  {
    slug: 'site-check',
    name: 'Website check',
    tagline: 'Makes sure your site is up and loading',
    prompt:
      'Open [https://example.com] like a visitor would. Tell me only if it is down, very slow or showing an error. Otherwise reply "all good".',
    schedule: '0 9 * * *',
  },
  {
    slug: 'workspace-tidy',
    name: 'Workspace tidy-up',
    tagline: 'Sorts loose files into folders once a month',
    prompt:
      'Sort the loose files at the top of the workspace into folders by type (documents, images, data, other). Do not delete anything. Reply with a short list of what moved where.',
    schedule: '0 9 1 * *',
  },
]

/** What "Use" puts in the editor: a new routine, not yet saved. */
export function draftForRecipe(r: RoutineRecipe): Pick<RoutineDraft, 'name' | 'prompt' | 'schedule'> {
  return { name: r.name, prompt: r.prompt, schedule: r.schedule }
}
