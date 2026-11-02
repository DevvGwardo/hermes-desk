/** Recovery uses the native CLI; Desk never guesses a filesystem path or launch-home RPC. */
export function memoryRecoveryCommands(profile: string): { status: string; chat: string } | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile)) return null
  return { status: `hermes -p ${profile} memory status`, chat: `hermes -p ${profile}` }
}

export function memoryReviewRequest(): string {
  return 'Review this Hermes profile’s own built-in persistent memory (MEMORY.md and USER.md) using read-only tools if available. Distinguish current saved contents from memory cached in this conversation and any external memory provider. If access is unavailable, explain that instead of assuming the memory is empty. Do not add, replace, remove, reset, or configure memory. Propose any changes for me to review, and wait for my explicit approval before writing.'
}
