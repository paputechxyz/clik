import { discoverTree } from './cobra'
import type { CliAdapter } from './types'

export { discoverTree, parseHelp, cobraAdapter } from './cobra'
export type { CliAdapter } from './types'
export type { ParsedHelp } from './cobra'

export const adapters: Record<string, CliAdapter> = {
  cobra: { name: 'cobra', discover: discoverTree }
}
