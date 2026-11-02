/** AGENTS.md in the local workspace, resolved by the guarded filesystem bridge. */
import { isBridgeAvailable, readText, writeText } from './fs'

export const PROJECT_INSTRUCTIONS_PATH = 'AGENTS.md'
export const projectInstructionsAvailable = isBridgeAvailable
export interface InstructionsRead {
  ok: boolean
  content: string
  exists: boolean
  error?: string
}
async function instructionsPath(): Promise<string> {
  const result = await window.nubAgent?.hermes?.('fs', ['root'])
  const data = result?.data as { cwd?: string } | undefined
  if (!result?.ok || !data?.cwd) throw new Error(result?.error || 'Local workspace unavailable.')
  return `${data.cwd.replace(/\/+$/, '')}/${PROJECT_INSTRUCTIONS_PATH}`
}
export async function readProjectInstructions(): Promise<InstructionsRead> {
  try {
    const path = await instructionsPath()
    try { return { ok: true, content: await readText(path), exists: true } }
    catch (error) {
      if (/not found|no such file|enoent/i.test(String(error))) return { ok: true, content: '', exists: false }
      throw error
    }
  } catch (error) {
    return { ok: false, content: '', exists: false, error: error instanceof Error ? error.message : String(error) }
  }
}
export async function writeProjectInstructions(content: string): Promise<{ ok: boolean; error?: string }> {
  try { await writeText(await instructionsPath(), content); return { ok: true } }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
}
