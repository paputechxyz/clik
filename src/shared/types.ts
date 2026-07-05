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

export interface CliEntry {
  id: string
  name: string
  binaryPath: string
  env: Record<string, string>
  defaultArgs?: string[]
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

export interface PtyOpenRequest {
  file: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  cols?: number
  rows?: number
}

export type PtyChannel = 'data' | 'exit'

export interface PtyExitPayload {
  code: number
  signal?: number
}

export interface PtyEvent {
  id: string
  channel: PtyChannel
  payload: unknown
}

export type MenuAction = 'new-tab' | 'close-tab'

export interface CliExplorerApi {
  discover: (binaryPath: string) => Promise<CommandTree>
  discoverCommand: (binaryPath: string, cmdPath: string[]) => Promise<CommandNode>
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
  pty: {
    open: (req: PtyOpenRequest) => Promise<string>
    openShell: () => Promise<string>
    input: (id: string, data: string) => void
    resize: (id: string, cols: number, rows: number) => void
    kill: (id: string) => Promise<boolean>
    onEvent: (cb: (e: PtyEvent) => void) => () => void
  }
  onMenu: (cb: (action: MenuAction) => void) => () => void
}
