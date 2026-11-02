/**
 * Brand marks for Marketplace plugin rows, the installed stack and the sidebar
 * "Connect apps" pill. Assets live in public/plugin-icons/:
 *  - SVG marks are drawn as a CSS mask in the brand colour (Simple Icons,
 *    CC0, v16.33.0 for most; near-white brand colours use dark ink so they
 *    stay visible on the white tile).
 *  - PNG marks are the brand's own site icon where Simple Icons has none.
 * Ids are hermes MCP server / catalog names. Unknown ids get a lettered tile.
 */

const SVG_COLOR: Record<string, string> = {
  gmail: '#EA4335',
  'google-calendar': '#4285F4',
  'google-drive': '#0F9D58',
  slack: '#4A154B',
  notion: '#111111',
  'aws-agents': '#FF9900',
  'aws-sagemaker': '#FF9900',
  intercom: '#1F8DED',
  canva: '#00C4CC',
  linear: '#5E6AD2',
  github: '#24292F',
  sentry: '#362D59',
  airtable: '#18BFFF',
  algolia: '#003DFF',
  alltrails: '#142800',
  asana: '#F06A6A',
  atlassian: '#0052CC',
  betterstack: '#000000',
  buildkite: '#14CC80',
  calendly: '#006BFF',
  circleci: '#343434',
  clickup: '#7B68EE',
  cloudflare: '#F38020',
  cloudinary: '#3448C5',
  datadog: '#632CA6',
  dropbox: '#0061FF',
  figma: '#F24E1E',
  gitlab: '#FC6D26',
  grafana: '#F46800',
  'hugging_face': '#FFD21E',
  indeed: '#003A9B',
  miro: '#050038',
  mixpanel: '#7856FF',
  'n8n-official': '#EA4B71',
  neon: '#34D59A',
  netlify: '#00C7B7',
  paypal: '#002991',
  postman: '#FF6C37',
  'prisma-postgres': '#2D3748',
  railway: '#0B0D0E',
  robinhood: '#111111',
  square: '#3E4348',
  strava: '#FC4C02',
  stripe: '#635BFF',
  supabase: '#3FCF8E',
  todoist: '#E44332',
  trivago: '#E32851',
  'unreal-engine': '#0E1128',
  vercel: '#000000',
  webflow: '#146EF5',
  wolfram: '#DD1100',
  'wordpress-com': '#21759B',
}

const PNG_IDS = new Set([
  'granola',
  'composio',
  'atlan',
  'opsera',
  'firetiger',
  'context7',
  'plain',
  'amplitude',
  'attio',
  'aws-knowledge',
  'close',
  'comfy-cloud',
  'craft',
  'deepwiki',
  'fireflies',
  'gamma',
  'globalping',
  'kiwi',
  'klaviyo',
  'microsoft-learn',
  'monday',
  'motherduck',
  'plaid',
  'semgrep',
  'twelve-data',
  'twilio-docs',
])

/** Catalog / preset ids that share another id's asset. */
const ALIAS: Record<string, string> = {
  n8n: 'n8n-official',
  huggingface: 'hugging_face',
  'hugging-face': 'hugging_face',
  twilio: 'twilio-docs',
  wordpress: 'wordpress-com',
}

type Size = 'md' | 'sm' | 'xs'
/** Tile px / glyph px / corner radius per size. md = catalog rows (40px). */
const SIZES: Record<Size, { tile: number; glyph: number; img: number; radius: number }> = {
  md: { tile: 40, glyph: 22, img: 28, radius: 10 },
  sm: { tile: 22, glyph: 13, img: 16, radius: 6 },
  xs: { tile: 18, glyph: 11, img: 13, radius: 5 },
}

/** Vite's base: './' in the Electron build (dist loads over file://, where a
 *  root-absolute '/plugin-icons' resolves to the filesystem root and the
 *  marks render blank), '/' on the hosted web build. */
const ICON_BASE = `${import.meta.env.BASE_URL}plugin-icons/`

function assetFor(id: string): { kind: 'svg' | 'png'; src: string; color?: string } | null {
  const raw = id.toLowerCase()
  const key = ALIAS[raw] ?? raw
  if (key in SVG_COLOR) return { kind: 'svg', src: `${ICON_BASE}${key}.svg`, color: SVG_COLOR[key] }
  if (PNG_IDS.has(key)) return { kind: 'png', src: `${ICON_BASE}${key}.png` }
  return null
}

/** Reference MCP servers without a brand: a drawn glyph instead of letters. */
function GenericGlyph({ id, px }: { id: string; px: number }) {
  const key = id.toLowerCase()
  if (key === 'memory') {
    return (
      <svg width={px} height={px} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a3 3 0 0 0-3-1Zm6 0a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      </svg>
    )
  }
  if (key === 'sequential-thinking') {
    return (
      <svg width={px} height={px} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="5" cy="6" r="2" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="12" cy="12" r="2" stroke="currentColor" strokeWidth="1.7" />
        <circle cx="19" cy="18" r="2" stroke="currentColor" strokeWidth="1.7" />
        <path d="M6.5 7.5 10.5 10.5M13.5 13.5l4 3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    )
  }
  return null
}

export function PluginMark({ id, name, size = 'md' }: { id: string; name: string; size?: Size }) {
  const s = SIZES[size]
  const tile = { width: s.tile, height: s.tile, borderRadius: s.radius }
  const asset = assetFor(id)
  const frame = 'flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-[var(--ca-border)]'
  if (asset?.kind === 'svg') {
    return (
      <span className={frame} style={tile} aria-hidden>
        <span
          className="block"
          style={{
            width: s.glyph,
            height: s.glyph,
            backgroundColor: asset.color,
            WebkitMaskImage: `url(${asset.src})`,
            maskImage: `url(${asset.src})`,
            WebkitMaskRepeat: 'no-repeat',
            maskRepeat: 'no-repeat',
            WebkitMaskPosition: 'center',
            maskPosition: 'center',
            WebkitMaskSize: 'contain',
            maskSize: 'contain',
          }}
        />
      </span>
    )
  }
  if (asset?.kind === 'png') {
    return (
      <span className={frame} style={tile} aria-hidden>
        <img src={asset.src} alt="" aria-hidden style={{ width: s.img, height: s.img }} className="object-contain" />
      </span>
    )
  }
  const glyph = GenericGlyph({ id, px: s.glyph })
  if (glyph) {
    return (
      <span className={`${frame} text-[var(--ca-primary-text)]`} style={tile} aria-hidden>
        {glyph}
      </span>
    )
  }
  const initial = (name.replace(/[^A-Za-z0-9]/g, '')[0] ?? '?').toUpperCase()
  return (
    <span
      className="flex shrink-0 items-center justify-center bg-[var(--ca-primary-soft)] font-semibold text-[var(--ca-primary-text)] ring-1 ring-[var(--ca-border)]"
      style={{ ...tile, fontSize: Math.round(s.tile * 0.4) }}
      aria-hidden
    >
      {initial}
    </span>
  )
}
