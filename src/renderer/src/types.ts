import type { CliExplorerApi } from '../../shared/types'

declare global {
  interface Window {
    cliExplorer: CliExplorerApi
  }
}

export {}
