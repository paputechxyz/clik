import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { LibraryData } from '../shared/types'

const EMPTY: LibraryData = { saved: [], history: [] }

export class Library {
  private file: string
  private data: LibraryData = { ...EMPTY }

  constructor() {
    this.file = path.join(app.getPath('userData'), 'library.json')
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<LibraryData>
      this.data = {
        saved: Array.isArray(parsed.saved) ? parsed.saved : [],
        history: Array.isArray(parsed.history) ? parsed.history : []
      }
    } catch {
      this.data = { ...EMPTY }
    }
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  get(): LibraryData {
    return this.data
  }

  set(data: LibraryData): void {
    this.data = {
      saved: Array.isArray(data.saved) ? data.saved : [],
      history: Array.isArray(data.history) ? data.history : []
    }
    this.save()
  }
}
