import { Icon } from '../ui/icons'

export function SessionFooter({ todos = [], usage }: { todos?: unknown[]; usage?: Record<string, unknown> }) {
  const items = todos.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const value = item as Record<string, unknown>
    const text = value.content ?? value.text ?? value.title ?? value.task
    return typeof text === 'string' && text.trim()
      ? [{ text, status: String(value.status ?? 'pending') }] : []
  })
  const number = (...keys: string[]) => {
    const value = keys.map(key => usage?.[key]).find(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
    return typeof value === 'number' ? value : undefined
  }
  const input = number('input_tokens', 'prompt_tokens')
  const output = number('output_tokens', 'completion_tokens')
  const total = number('total_tokens') ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined)
  const cost = number('cost_usd', 'total_cost_usd', 'cost', 'total_cost')
  if (!items.length && total === undefined && cost === undefined) return null
  return <div className="messenger-session-footer">
    {items.length > 0 && <details className="messenger-todos">
      <summary>{items.filter(item => item.status === 'completed' || item.status === 'done').length}/{items.length} tasks</summary>
      <ul>{items.map((item, index) => <li key={`${index}:${item.text}`} data-status={item.status}>
        <Icon name={item.status === 'completed' || item.status === 'done' ? 'check' : 'tool'} size={14} />
        <span>{item.text}</span><span className="sr-only"> · {item.status}</span>
      </li>)}</ul>
    </details>}
    {(total !== undefined || cost !== undefined) && <p aria-label="Session usage">
      {total !== undefined && `${total.toLocaleString('en-US')} tokens`}
      {total !== undefined && cost !== undefined && ' · '}
      {cost !== undefined && `$${cost.toFixed(4)}`}
    </p>}
  </div>
}
