# Background process notices

Hermes uses model-facing `user` messages to deliver background results. That role
does not mean the person typed the message. Desk follows the backend's display
contract instead:

- `process_complete` and `async_delegation_complete` become system notices.
- `display_metadata.display_text` supplies the compact title. Both object and
  JSON-string metadata are accepted; missing or invalid titles use a generic label.
- Raw output stays in `noticeDetails`, behind a closed, keyboard-accessible native
  disclosure. It renders as plain text, not executable HTML or links.
- `hidden` rows stay out of displayed history.
- Unclassified user text and assistant responses retain their original presentation.

RPC history, CLI exports, and REST history use the same projection. This change
does not disable jobs, change notification routing, or suppress agent continuation.
Completion batching and follow-up budgets are separate backend concerns.

Regression checks:

```sh
npm run test:unit -- src/lib/__tests__/transcript-notices.test.ts src/components/chat/SystemNotice.test.tsx src/components/__tests__/transcript-notice-render.test.tsx
```

Keep this change as a focused commit on a fork feature branch. Merge it into the
fork's main branch once reviewed, so later app builds include it. If upstream
changes the renderer, preserve the shared history projection and reconnect the
`SystemNotice` component at the system-message rendering boundary.
