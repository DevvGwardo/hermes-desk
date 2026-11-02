/** API-compatible no-ops. Hermes Desk never sends telemetry or records sessions. */
export const POSTHOG_HOST = ''
export const POSTHOG_ASSETS_HOST = ''

export type AnalyticsEvent = 'agent_linked' | 'message_sent' | 'routine_created' | 'routine_run'
type Props = Record<string, string | number | boolean>
type Env = { PROD?: boolean; VITE_POSTHOG_KEY?: string; VITE_POSTHOG_HOST?: string }

export function analyticsConfig(_env?: Env): null { return null }
export function analyticsOptedOut(): boolean { return true }
export function startAnalytics(): Promise<void> { return Promise.resolve() }
export function track(_event: AnalyticsEvent, _props?: Props): void {}
export function setAnalyticsOptOut(_optOut: boolean): void {}
export function resetAnalyticsForTests(): void {}
