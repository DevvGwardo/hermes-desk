// `toLocale*String(undefined, opts)` builds a fresh Intl.DateTimeFormat on
// every call — the priciest thing in a sidebar render, repaid for every row.
// One formatter per style, created on first use.
const fmtCache = new Map<string, Intl.DateTimeFormat>()
export function cachedDateFormat(key: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let f = fmtCache.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(undefined, opts)
    fmtCache.set(key, f)
  }
  return f
}
