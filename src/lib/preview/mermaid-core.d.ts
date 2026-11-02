/**
 * Types for the explicit mermaid core entry. The package ships no
 * `mermaid.core.d.mts`, but the core default export is the same Mermaid
 * object as the root entry — only the diagram chunks stay lazy.
 */
declare module 'mermaid/dist/mermaid.core.mjs' {
  import type mermaid from 'mermaid'
  const api: typeof mermaid
  export default api
}
