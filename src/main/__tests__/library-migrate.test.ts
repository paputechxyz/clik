import { describe, it, expect } from 'vitest'
import { normalizeLibrary, normalizeSaved } from '../library-migrate'
import type { LibraryData, SavedCommandItem } from '../../shared/types'

function saved(id: string, folderId?: string | null): SavedCommandItem {
  return {
    id,
    name: id,
    entryId: 'e',
    entryName: 'e',
    binaryName: 'x',
    selection: [],
    flags: {},
    positional: '',
    preview: 'x',
    createdAt: 1,
    ...(folderId === undefined ? {} : { folderId })
  }
}

describe('library migration (R13)', () => {
  it('normalizes old data: folders [] and missing folderId -> null', () => {
    // Old payload shape: no `folders`, saved items carry no `folderId`.
    const oldData = { saved: [saved('s1'), saved('s2')], history: [] } as unknown as Partial<LibraryData>
    const out = normalizeLibrary(oldData)
    expect(out.folders).toEqual([])
    expect(out.saved).toHaveLength(2)
    expect(out.saved[0].folderId).toBeNull()
    expect(out.saved[1].folderId).toBeNull()
  })

  it('preserves explicit folderId and folders on new data', () => {
    const fresh: Partial<LibraryData> = {
      saved: [saved('s1', 'f1'), saved('s2', null)],
      history: [],
      folders: [{ id: 'f1', name: 'Deploy' }]
    }
    const out = normalizeLibrary(fresh)
    expect(out.folders).toEqual([{ id: 'f1', name: 'Deploy' }])
    expect(out.saved[0].folderId).toBe('f1')
    expect(out.saved[1].folderId).toBeNull()
  })

  it('normalizeSaved coerces undefined folderId to null', () => {
    expect(normalizeSaved(saved('x')).folderId).toBeNull()
    expect(normalizeSaved(saved('x', 'f1')).folderId).toBe('f1')
    expect(normalizeSaved(saved('x', null)).folderId).toBeNull()
  })

  it('tolerates missing/invalid arrays', () => {
    const out = normalizeLibrary({ saved: undefined, history: undefined, folders: undefined } as unknown as Partial<LibraryData>)
    expect(out.saved).toEqual([])
    expect(out.history).toEqual([])
    expect(out.folders).toEqual([])
  })
})
