/** Correlate local stream requests without including message content. */
export function newChatRequestId(): string {
  return `c${globalThis.crypto.randomUUID().replace(/-/g, '')}`
}
