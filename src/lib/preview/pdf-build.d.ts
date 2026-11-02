/**
 * Types for the exact pdfjs modern-build entry. The package ships no
 * `build/pdf.d.mts` (types live behind the root entry), so this pins the
 * two members FilePreview's lazy loader uses. Narrower than the real API
 * on purpose — the loader only ever passes `{ data }`.
 */
declare module 'pdfjs-dist/build/pdf.mjs' {
  import type { PDFDocumentProxy } from 'pdfjs-dist'
  export const GlobalWorkerOptions: { workerSrc: string }
  export function getDocument(src: { data: Uint8Array }): {
    promise: Promise<PDFDocumentProxy>
    destroy(): Promise<void>
  }
}
