interface SystemNoticeProps {
  content: string
  details?: string
}

/** Machine-authored notices stay small; raw output is plain text and opt-in. */
export function SystemNotice({ content, details }: SystemNoticeProps) {
  const style = 'sand-on-wall rounded-full border border-[var(--ca-border)] px-3 py-1 text-[11px] text-[var(--ca-ink-muted)]'
  return (
    <div className="flex min-w-0 justify-center">
      {details ? (
        <details className={`${style} min-w-0 max-w-full rounded-xl`}>
          <summary className="cursor-pointer">
            {content}
            <span className="ml-2 opacity-70">Details</span>
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words border-t border-[var(--ca-border)] pt-2 text-left">
            {details}
          </pre>
        </details>
      ) : (
        <span className={style}>{content}</span>
      )}
    </div>
  )
}
