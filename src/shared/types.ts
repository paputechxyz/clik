export type FlagType = 'bool' | 'int' | 'float' | 'string' | 'stringSlice' | 'duration'

export interface Flag {
  name: string
  shorthand?: string
  type: FlagType
  usage: string
  default?: boolean | number | string | string[]
  rawDefault?: string
}

export interface CommandNode {
  name: string
  path: string[]
  use: string
  short: string
  long: string
  isGroup: boolean
  flags: Flag[]
  inheritedFlags: Flag[]
  children: CommandNode[]
}

export interface CommandTree {
  binaryPath: string
  binaryName: string
  root: CommandNode
}

export interface RunRequest {
  binaryPath: string
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface CliEntry {
  id: string
  name: string
  binaryPath: string
  env: Record<string, string>
  defaultArgs?: string[]
}

export type RunChannel = 'stdout' | 'stderr' | 'exit' | 'error'

export interface RunEvent {
  runId: string
  channel: RunChannel
  payload: unknown
}

export interface ShellEnvStatus {
  ready: boolean
  count: number
  error: string | null
  shell: string
}

export interface ShellEnvRefreshResult {
  ok: boolean
  count: number
  error: string | null
  shell: string
}

export interface ResolvedCommand {
  name: string
  path: string
}

export interface CliExplorerApi {
  discover: (binaryPath: string) => Promise<CommandTree>
  run: (req: RunRequest) => Promise<string>
  stopRun: (runId: string) => Promise<boolean>
  writeStdin: (runId: string, data: string) => Promise<boolean>
  pickBinary: () => Promise<string | null>
  shellEnv: {
    status: () => Promise<ShellEnvStatus>
    refresh: () => Promise<ShellEnvRefreshResult>
  }
  scan: {
    resolve: (name: string) => Promise<string | null>
    suggest: (names?: string[]) => Promise<ResolvedCommand[]>
  }
  registry: {
    list: () => Promise<CliEntry[]>
    add: (entry: Omit<CliEntry, 'id'>) => Promise<CliEntry>
    update: (entry: CliEntry) => Promise<CliEntry>
    remove: (id: string) => Promise<void>
  }
  onRunEvent: (cb: (e: RunEvent) => void) => () => void
}
