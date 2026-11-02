/**
 * pdfjs renderer for FilePreview (A3) — lazily imported.
 *
 * The worker is the vite-bundled asset URL (same-origin), which the existing
 * CSP allows (`script-src 'self' blob:` — no separate worker-src directive).
 * If the CSP ever blocks workers, tighten here to an in-band fallback rather
 * than loosening the policy.
 */

import type { PDFDocumentProxy } from 'pdfjs-dist'

export type { PDFDocumentProxy }

export async function loadPdf(data: ArrayBuffer, signal?: AbortSignal): Promise<PDFDocumentProxy> {
  const checkCancelled = () => {
    if (signal?.aborted) throw new DOMException('PDF preview closed', 'AbortError')
  }
  checkCancelled()
  // Exact build path: the package ships build/ (modern) + legacy/ trees, so
  // the bare specifier leaves chunk identity up to the resolver. The worker
  // stays lazy — configured here on first load, never at module top-level.
  // (Types via ./pdf-build.d.ts; the package ships no build/pdf.d.mts.)
  const pdfjs = await import('pdfjs-dist/build/pdf.mjs')
  checkCancelled()
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(data) })
  let destroyed = false
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    void task.destroy().catch(() => {})
  }
  signal?.addEventListener('abort', destroy, { once: true })
  try {
    const doc = await task.promise
    checkCancelled()
    return doc
  } catch (error) {
    destroy()
    throw error
  } finally {
    signal?.removeEventListener('abort', destroy)
  }
}

/** Paint one page into a canvas at `scale` (1 = 72dpi CSS px). */
export async function renderPdfPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.5,
): Promise<void> {
  const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages))
  const viewport = page.getViewport({ scale })
  canvas.width = Math.floor(viewport.width)
  canvas.height = Math.floor(viewport.height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
}

/** Decode a readDataUrl payload (data:...;base64,…) into bytes. */
export function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const comma = dataUrl.indexOf(',')
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes.buffer
}
