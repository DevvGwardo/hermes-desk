/** Explicit profile query, shared by native REST callers. This does not establish ownership. */
export function serveProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : ''
}
