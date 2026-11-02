/** Local marks for well-known headings in agent markdown (env dumps, etc.). */

export type BrandMark = {
  id: string
  src: string
  color: string
}

const MARKS: { test: RegExp; mark: BrandMark }[] = [
  { test: /\bhetzner\b/i, mark: { id: 'hetzner', src: './brand-marks/hetzner.svg', color: '#D50C2D' } },
  { test: /\bcloudflare\b/i, mark: { id: 'cloudflare', src: './brand-marks/cloudflare.svg', color: '#F38020' } },
  { test: /\bvercel\b|\bturbo\b/i, mark: { id: 'vercel', src: './brand-marks/vercel.svg', color: '#111111' } },
  { test: /\btelegram\b/i, mark: { id: 'telegram', src: './brand-marks/telegram.svg', color: '#26A5E4' } },
  { test: /\bstripe\b/i, mark: { id: 'stripe', src: './brand-marks/stripe.svg', color: '#635BFF' } },
  { test: /\bupstash\b/i, mark: { id: 'upstash', src: './brand-marks/upstash.svg', color: '#00E9A3' } },
]

export function brandMarkFor(heading: string): BrandMark | null {
  const text = heading.trim()
  if (!text) return null
  for (const row of MARKS) {
    if (row.test.test(text)) return row.mark
  }
  return null
}
