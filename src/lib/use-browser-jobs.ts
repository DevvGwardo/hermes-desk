/**
 * The legacy browser-job API is absent. Native workspace control has its
 * own bridge; retain this compatibility hook without state, effects or probes.
 */
export function useBrowserJobsSupported(_instanceId: string | null | undefined): boolean {
  return false
}
