/**
 * Local pictures of files this device just uploaded, keyed by their path on
 * the agent computer. The sent message shows the image straight away from
 * here instead of downloading it back. Session-only: after a reload the
 * thread fetches the picture from the agent computer.
 */
const previews = new Map<string, string>()

export function setAttachmentPreview(path: string, url: string): void {
  previews.set(path, url)
}

export function attachmentPreview(path: string): string | undefined {
  return previews.get(path)
}
