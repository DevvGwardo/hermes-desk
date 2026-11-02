export interface NativeDelegate {
  subagent_id: string
  goal?: string
  status?: string
  model?: string
  last_tool?: string
  tool_count?: number
  accepting_steer?: boolean
}
export interface NativeDelegationSnapshot {
  generation: string
  subagents: NativeDelegate[]
  delegations: { delegation_id: string; task_index: number; goal: string; error?: string; status: string }[]
}
export interface NativeDelegateTail { available: boolean; text: string; truncated: boolean }
export interface NativeDelegationActions {
  list: () => Promise<NativeDelegationSnapshot>
  tail: (id: string, generation: string) => Promise<NativeDelegateTail>
  steer: (id: string, text: string, generation: string) => Promise<boolean>
  interrupt: (id: string, generation: string) => Promise<boolean>
}
