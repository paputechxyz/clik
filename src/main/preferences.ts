import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import type { PreferencesData } from '../shared/types'

// Persisted user preferences (currently: the last dismissed update version).
// Same hand-rolled userData-JSON pattern as Registry/Library — deliberately
// not renderer localStorage, which is per-origin and would be wiped by the
// very update the dismissal governs.
const DEFAULT: PreferencesData = {}

export class Preferences {
  private file: string
  private data: PreferencesData = { ...DEFAULT }

  constructor() {
    this.file = path.join(app.getPath('userData'), 'preferences.json')
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<PreferencesData>
      this.data = {
        dismissedUpdate:
          typeof parsed.dismissedUpdate === 'string' ? parsed.dismissedUpdate : undefined
      }
    } catch {
      this.data = { ...DEFAULT }
    }
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  get(): PreferencesData {
    return this.data
  }

  setDismissedUpdate(version: string): PreferencesData {
    this.data = { ...this.data, dismissedUpdate: version }
    this.save()
    return this.data
  }
}
