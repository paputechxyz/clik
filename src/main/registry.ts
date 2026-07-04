import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { CliEntry } from '../shared/types'

export class Registry {
  private file: string
  private entries: CliEntry[] = []

  constructor() {
    this.file = path.join(app.getPath('userData'), 'registry.json')
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as CliEntry[]
      this.entries = Array.isArray(parsed) ? parsed : []
    } catch {
      this.entries = []
    }
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2))
  }

  list(): CliEntry[] {
    return this.entries
  }

  add(entry: Omit<CliEntry, 'id'>): CliEntry {
    const e: CliEntry = { ...entry, id: randomUUID() }
    this.entries.push(e)
    this.save()
    return e
  }

  update(entry: CliEntry): CliEntry {
    this.entries = this.entries.map((e) => (e.id === entry.id ? entry : e))
    this.save()
    return entry
  }

  remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id)
    this.save()
  }
}
