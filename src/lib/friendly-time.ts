/**
 * Dates the way people say them: "Today, 8:29 PM", "Yesterday, 8:29 PM",
 * "Thu, Oct 2, 8:29 PM" (with the year only when it isn't this year).
 * Shared by routine results, chat history, tasks and notifications.
 */
export function formatFriendlyWhen(input: number | string | Date | null | undefined, now = Date.now()): string {
  const ms = input instanceof Date ? input.getTime() : typeof input === 'string' ? Date.parse(input) : input
  if (ms == null || !Number.isFinite(ms)) return 'Unknown time'
  try {
    const d = new Date(ms)
    const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    const day = (t: number) => new Date(t).toDateString()
    if (day(ms) === day(now)) return `Today, ${time}`
    if (day(ms) === day(now - 86_400_000)) return `Yesterday, ${time}`
    const sameYear = d.getFullYear() === new Date(now).getFullYear()
    return d.toLocaleString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' as const }),
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return new Date(ms).toISOString()
  }
}
