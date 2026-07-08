import type { Folder, LibraryData, SavedCommandItem } from '../shared/types'

// Normalize a single saved item so older data (no `folderId`) is treated as a
// root item. Pure (no Electron deps) so it is unit-testable from the node
// vitest suite. Back-compat for the folder model (plan R13).
export function normalizeSaved(it: Partial<SavedCommandItem>): SavedCommandItem {
  return { ...(it as SavedCommandItem), folderId: it.folderId ?? null }
}

// Normalize a whole library payload: guarantee `folders` exists and every saved
// item carries a normalized `folderId`.
export function normalizeLibrary(data: Partial<LibraryData>): LibraryData {
  return {
    saved: Array.isArray(data.saved) ? data.saved.map(normalizeSaved) : [],
    history: Array.isArray(data.history) ? data.history : [],
    folders: Array.isArray(data.folders) ? (data.folders as Folder[]) : []
  }
}
