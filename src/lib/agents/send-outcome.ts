/** Acceptance, not model completion. Unknown acceptance must never auto-retry. */
export type SendOutcome = { status: 'accepted' | 'queued' | 'rejected' | 'uncertain' }

export class SendError extends Error {
  readonly status: 'rejected' | 'uncertain'
  constructor(status: 'rejected' | 'uncertain', cause?: unknown) {
    super(cause instanceof Error ? cause.message :
      status === 'rejected' ? 'Message was not accepted.' : 'Message acceptance is unconfirmed.', { cause })
    this.name = 'SendError'
    this.status = status
  }
}

export function failedSend(error: unknown, dispatched = true): SendOutcome {
  return { status: error instanceof SendError ? error.status : dispatched ? 'uncertain' : 'rejected' }
}
