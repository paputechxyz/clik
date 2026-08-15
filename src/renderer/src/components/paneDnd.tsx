import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { DropZone } from '../lib/paneTree'

/**
 * Ephemeral state for a tab drag. It is not app state (nothing survives the
 * gesture), and the pane tree is recursive, so a context beats prop-drilling.
 *
 * Native HTML5 DnD, matching the library/entry lists. `dataTransfer.getData()`
 * returns '' during dragover in protected mode, so the dragged run is read from
 * here and `dataTransfer.types` is only used to reject foreign drags.
 */
export const TAB_DRAG_MIME = 'application/x-clik-tab'

export interface TabDrag {
  runId: string
  fromPaneId: string
}

export type PaneDropHint =
  | { kind: 'zone'; paneId: string; zone: DropZone }
  | { kind: 'tab'; paneId: string; runId: string; before: boolean }
  | { kind: 'strip-end'; paneId: string }

interface PaneDndValue {
  drag: TabDrag | null
  hint: PaneDropHint | null
  begin: (d: TabDrag) => void
  setHint: (h: PaneDropHint | null) => void
  end: () => void
}

const PaneDndContext = createContext<PaneDndValue>({
  drag: null,
  hint: null,
  begin: () => undefined,
  setHint: () => undefined,
  end: () => undefined
})

export function usePaneDnd(): PaneDndValue {
  return useContext(PaneDndContext)
}

export function PaneDndProvider({ children }: { children: ReactNode }): JSX.Element {
  const [drag, setDrag] = useState<TabDrag | null>(null)
  const [hint, setHint] = useState<PaneDropHint | null>(null)

  const begin = useCallback((d: TabDrag) => {
    setDrag(d)
    setHint(null)
  }, [])
  const end = useCallback(() => {
    setDrag(null)
    setHint(null)
  }, [])

  const value = useMemo(
    () => ({ drag, hint, begin, setHint, end }),
    [drag, hint, begin, end]
  )
  return <PaneDndContext.Provider value={value}>{children}</PaneDndContext.Provider>
}

/** True when this drag carries one of our tabs (and not a file or foreign text). */
export function isTabDrag(types: readonly string[]): boolean {
  return types.includes(TAB_DRAG_MIME)
}
