import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { CommandTree } from '../shared/types'

interface CacheEntry {
  mtimeMs: number
  tree: CommandTree
}

export class TreeCache {
  private file: string
  private entries: Record<string, CacheEntry> = {}

  constructor() {
    this.file = path.join(app.getPath('userData'), 'tree-cache.json')
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, CacheEntry>
      this.entries = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      this.entries = {}
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.entries))
    } catch (err) {
      console.warn('[tree-cache] failed to save:', err)
    }
  }

  get(binaryPath: string, mtimeMs: number): CommandTree | null {
    const e = this.entries[binaryPath]
    if (!e || e.mtimeMs !== mtimeMs) return null
    return e.tree
  }

  set(binaryPath: string, mtimeMs: number, tree: CommandTree): void {
    this.entries[binaryPath] = { mtimeMs, tree }
    this.save()
  }

  clear(binaryPath?: string): void {
    if (binaryPath) {
      if (!(binaryPath in this.entries)) return
      delete this.entries[binaryPath]
    } else {
      this.entries = {}
    }
    this.save()
  }
}
