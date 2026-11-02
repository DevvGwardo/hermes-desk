/**
 * Plain text for a one-line conversation preview. Previews are the start of
 * the agent's last reply, which is markdown, and the sidebar showed it raw:
 * "**Done.** See `notes.md`" read as asterisks and backticks. This keeps the
 * words and drops the syntax. It is display-only: the stored preview stays
 * as the server sent it.
 */
export function previewPlainText(markdown: string): string {
  return (
    markdown
      // directives like ::preview{file="..."} emitted by models: drop the tag
      .replace(/::[a-zA-Z][\w-]*\{[^}\n]*\}/g, '')
      // fenced code: keep the code, drop the fences and language tag
      .replace(/```[^\n]*\n?/g, '')
      // images, then links: keep the label
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // inline code
      .replace(/`([^`]*)`/g, '$1')
      // bold / italic / strike markers around words
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/(\*|_)(?=\S)([\s\S]*?\S)\1(?![A-Za-z0-9])/g, '$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      // a leftover run of markers from a preview cut mid-span ("**Done")
      .replace(/(^|\s)(\*\*|__|~~)(?=\S)/g, '$1')
      // line-leading heading, quote and list markers
      .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}
