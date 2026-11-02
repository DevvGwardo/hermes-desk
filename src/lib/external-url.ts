/** Open an explicit user-selected HTTPS link, never an automatic request. */
export async function openExternalUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Only HTTPS links without credentials can be opened.')
  }
  const open = typeof window !== 'undefined' ? window.nubAgent?.openHttps : undefined
  if (open) await open(parsed.href)
  else window.open(parsed.href, '_blank', 'noopener,noreferrer')
}
