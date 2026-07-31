export type FlagType = 'bool' | 'int' | 'float' | 'string' | 'stringSlice' | 'duration'

export interface Flag {
  name: string
  shorthand?: string
  type: FlagType
  usage: string
  default?: boolean | number | string | string[]
  rawDefault?: string
  singleDash?: boolean
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
  // For a 'binary' entry this is a filesystem path to an executable. For a
  // 'shellFunction' entry there is no file on PATH — binaryPath holds the bare
  // command name (e.g. "sdk"), which is invoked through the login+interactive
  // shell for discovery and injected verbatim into a shell tab when run.
  binaryPath: string
  // Defaults to 'binary' when absent (older registry data has no kind).
  kind?: 'binary' | 'shellFunction'
  env: Record<string, string>
  defaultArgs?: string[]
}

// How a shell name resolves when adding a CLI: a real executable on PATH, or a
// shell function/alias only defined inside the login+interactive shell.
export type NameClassification =
  | { kind: 'binary'; path: string }
  | { kind: 'shellFunction'; name: string }

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

export type MenuAction = 'new-tab' | 'close-tab' | 'clear-tab' | 'toggle-library' | 'toggle-terminal'

export type UpdateState =
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatusEvent {
  state: UpdateState
  version?: string
  percent?: number
  message?: string
}

export interface DiscoverProgress {
  binaryPath: string
  done: number
  total: number
  current: string
}

export interface SavedCommandItem {
  id: string
  name: string
  entryId: string
  entryName: string
  binaryName: string
  selection: string[]
  flags: Record<string, unknown>
  positional: string
  preview: string
  createdAt: number
  // Single-level folder grouping: null = root. Older data without this field
  // is migrated to null on load (see src/main/library.ts).
  folderId?: string | null
  // Arbitrary command string (not tied to a CLI entry). When set, inject uses
  // this verbatim; loadCommand is a no-op (no entry to restore).
  rawCommand?: string
}

export interface Folder {
  id: string
  name: string
}

export interface HistoryItem {
  id: string
  entryId: string
  entryName: string
  binaryName: string
  selection: string[]
  flags: Record<string, unknown>
  positional: string
  preview: string
  createdAt: number
  // Arbitrary command string typed directly in the terminal (not produced via
  // the flag-panel Run button). When set, the row injects this verbatim
  // instead of restoring into the flag panel (loadCommand is a no-op).
  rawCommand?: string
}

export interface LibraryData {
  saved: SavedCommandItem[]
  history: HistoryItem[]
  folders: Folder[]
}

// Payload written to / read from a saved-commands export file. Only saved
// commands (and the folders they live in) travel — history is session-local and
// intentionally excluded.
export interface SavedExportData {
  saved: SavedCommandItem[]
  folders: Folder[]
}

export interface ExportResult {
  ok: boolean
  // The user dismissed the native save dialog — not an error.
  canceled?: boolean
  error?: string
  count?: number
}

export interface ImportResult {
  ok: boolean
  // The user dismissed the native open dialog — not an error.
  canceled?: boolean
  error?: string
  count?: number
  saved?: SavedCommandItem[]
  folders?: Folder[]
}

export interface PreferencesData {
  // Last update version the user dismissed. While the latest available
  // update equals this, the update banner stays suppressed (until a newer
  // version appears). Persisted in userData so it survives the upgrade.
  dismissedUpdate?: string
}

export interface ClikApi {
  discover: (binaryPath: string, forceFresh?: boolean, kind?: CliEntry['kind']) => Promise<CommandTree>
  discoverCommand: (binaryPath: string, cmdPath: string[], kind?: CliEntry['kind']) => Promise<CommandNode>
  onDiscoverProgress: (cb: (p: DiscoverProgress) => void) => () => void
  pickBinary: () => Promise<string | null>
  shellEnv: {
    status: () => Promise<ShellEnvStatus>
    refresh: () => Promise<ShellEnvRefreshResult>
  }
  scan: {
    resolve: (name: string) => Promise<string | null>
    classify: (name: string) => Promise<NameClassification | null>
    suggest: (names?: string[]) => Promise<ResolvedCommand[]>
  }
  registry: {
    list: () => Promise<CliEntry[]>
    add: (entry: Omit<CliEntry, 'id'>) => Promise<CliEntry>
    update: (entry: CliEntry) => Promise<CliEntry>
    remove: (id: string) => Promise<void>
    reorder: (ids: string[]) => Promise<void>
  }
  library: {
    get: () => Promise<LibraryData>
    save: (data: LibraryData) => Promise<void>
    export: (data: SavedExportData) => Promise<ExportResult>
    import: () => Promise<ImportResult>
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
  version: () => Promise<string>
  update: {
    check: () => Promise<{ ok: boolean }>
    restart: () => Promise<void>
    onStatus: (cb: (e: UpdateStatusEvent) => void) => () => void
    status: () => Promise<UpdateStatusEvent | null>
  }
  preferences: {
    get: () => Promise<PreferencesData>
    dismissUpdate: (version: string) => Promise<PreferencesData>
  }
}
