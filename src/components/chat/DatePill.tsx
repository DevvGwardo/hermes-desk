import { memo } from 'react'
import '../../styles/skin-messenger.css'

/** Local calendar dates, not elapsed 24-hour periods (including DST days). */
export function messengerDayKey(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function messengerDateLabel(iso: string, now = new Date()): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return ''
  if (messengerDayKey(iso) === messengerDayKey(now.toISOString())) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  if (messengerDayKey(iso) === messengerDayKey(yesterday.toISOString())) return 'Yesterday'
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date)
  const month = new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(date)
  return `${weekday} ${date.getDate()} ${month}`
}

export const DatePill = memo(function DatePill({ date, now }: { date: string; now?: Date }) {
  const label = messengerDateLabel(date, now)
  if (!label) return null
  return (
    <div className="messenger-date" data-testid="date-pill">
      <time dateTime={date} className="messenger-date-pill">{label}</time>
    </div>
  )
})
