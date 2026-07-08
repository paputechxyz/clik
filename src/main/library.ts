import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { LibraryData } from '../shared/types'
import { normalizeLibrary } from './library-migrate'

const EMPTY: LibraryData = { saved: [], history: [], folders: [] }

export class Library {
  private file: string
  private data: LibraryData = { ...EMPTY }

  constructor() {
    this.file = path.join(app.getPath('userData'), 'library.json')
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      this.data = normalizeLibrary(JSON.parse(raw) as Partial<LibraryData>)
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
    this.data = normalizeLibrary(data)
    this.save()
  }
}
