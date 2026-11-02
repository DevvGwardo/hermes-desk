export interface AutomationFlag { e2e?: boolean; isPackaged?: boolean }
export interface DeskAutomation {
  getState(): unknown
  selectAgent(id: string): void
  openPanel(name: string): void
  getMascotStates(): unknown
  version: string
}

/** For local automation only. Packaged builds and ordinary development never expose controls. */
export function installDeskAutomation(target: Window, dev: boolean, flag: AutomationFlag | undefined, api: DeskAutomation): () => void {
  if (!dev || flag?.e2e !== true || flag.isPackaged !== false) return () => {}
  const window = target as Window & { __hermesDesk?: DeskAutomation }
  window.__hermesDesk = api
  return () => { if (window.__hermesDesk === api) delete window.__hermesDesk }
}
