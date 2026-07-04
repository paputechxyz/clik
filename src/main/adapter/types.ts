import type { CommandTree } from '../../shared/types'

export interface CliAdapter {
  name: string
  discover: (binaryPath: string) => Promise<CommandTree>
}

export type { CommandTree }
