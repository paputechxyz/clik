import type { ClikApi } from '../../shared/types'

declare global {
  interface Window {
    clik: ClikApi
  }
}

export {}
