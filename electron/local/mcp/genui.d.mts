export interface GenUiStat { type: 'stat'; title: string; value: string; detail?: string }
export interface GenUiTable { type: 'table'; title: string; columns: string[]; rows: (string | number)[][] }
export interface GenUiBarChart { type: 'bar_chart'; title: string; items: { label: string; value: number }[]; unit?: string }
export interface GenUiChecklist { type: 'checklist'; title: string; items: { id: string; label: string; checked?: boolean }[] }
export interface GenUiHandbook {
  type: 'handbook'; title: string; subtitle?: string; paragraphs: string[]
  columns?: string[]; rows?: (string | number)[][]
  notice?: { level: 'NOTE' | 'CAUTION' | 'WARNING'; text: string }
}
export type GenUiComponent = GenUiStat | GenUiTable | GenUiBarChart | GenUiChecklist | GenUiHandbook
export interface GenUiSpec { version: 1; components: GenUiComponent[] }
export const MAX_GENUI_BYTES: number
export const MAX_GENUI_CALLS: number
export const GENUI_INPUT_SCHEMA: Record<string, unknown>
export function parseGenUi(raw: unknown): GenUiSpec | null
export function genUiFromResult(raw: unknown): GenUiSpec | null
export function genUiResultFromResult(raw: unknown): { genui: GenUiSpec; genuiOccurrence?: string } | null
export function isGenUiOccurrence(value: unknown): value is string
export function isSuccessfulGenUiStatus(status: unknown): boolean
export function isRenderUiTool(name: unknown): boolean
