import { Fragment, useCallback, useEffect, useRef } from 'react'
import type { DragEvent as ReactDragEvent } from 'react'
import { useAppStore } from '../store/useAppStore'
import { computeDropZone, topRightLeafId } from '../lib/paneTree'
import type { PaneLeaf, PaneNode, PaneSplit } from '../lib/paneTree'
import { attachTo, focusTerminal, releaseFrom } from '../lib/terminalSlots'
import { Resizer } from './Resizer'
import { PaneTabBar } from './PaneTabBar'
import { isTabDrag, usePaneDnd } from './paneDnd'

interface PaneTreeViewProps {
  onCollapse: () => void
}

export function PaneTreeView({ onCollapse }: PaneTreeViewProps): JSX.Element {
  const root = useAppStore((s) => s.paneLayout.root)
  const actionsPaneId = topRightLeafId(root)
  return <PaneNodeView node={root} actionsPaneId={actionsPaneId} onCollapse={onCollapse} />
}

/**
 * Grow factor for child `i`. Weights already sum to 1, so scaling by the child
 * count keeps the ratios while putting the total at n >= 2 — comfortably clear
 * of flexbox's rule that grow factors summing to under 1 leave the rest of the
 * container as empty background.
 */
function growOf(node: PaneSplit, i: number): number {
  const n = node.children.length
  const w = node.weights[i]
  return (Number.isFinite(w) && w > 0 ? w : 1 / n) * n
}

interface PaneNodeViewProps {
  node: PaneNode
  actionsPaneId: string
  onCollapse: () => void
}

function PaneNodeView({ node, actionsPaneId, onCollapse }: PaneNodeViewProps): JSX.Element {
  const resizePaneSplit = useAppStore((s) => s.resizePaneSplit)
  const splitRef = useRef<HTMLDivElement>(null)

  if (node.kind === 'leaf') {
    return <PaneLeafView leaf={node} actionsPaneId={actionsPaneId} onCollapse={onCollapse} />
  }

  return (
    <div className={`pane-split ${node.direction}`} ref={splitRef}>
      {node.children.map((child, i) => (
        <Fragment key={child.id}>
          <div className="pane-slot" style={{ flex: `${growOf(node, i)} 1 0` }}>
            <PaneNodeView node={child} actionsPaneId={actionsPaneId} onCollapse={onCollapse} />
          </div>
          {i < node.children.length - 1 ? (
            <Resizer
              orientation={node.direction === 'row' ? 'vertical' : 'horizontal'}
              title="Drag to resize"
              onDrag={(d) => {
                const el = splitRef.current
                if (!el) return
                const px = node.direction === 'row' ? el.clientWidth : el.clientHeight
                if (px > 0) resizePaneSplit(node.id, i, px, d)
              }}
            />
          ) : null}
        </Fragment>
      ))}
    </div>
  )
}

interface PaneLeafViewProps {
  leaf: PaneLeaf
  actionsPaneId: string
  onCollapse: () => void
}

function PaneLeafView({ leaf, actionsPaneId, onCollapse }: PaneLeafViewProps): JSX.Element {
  const focusedPaneId = useAppStore((s) => s.paneLayout.focusedPaneId)
  const focusPane = useAppStore((s) => s.focusPane)
  const moveRunToPane = useAppStore((s) => s.moveRunToPane)
  const splitPaneWithRun = useAppStore((s) => s.splitPaneWithRun)
  const { drag, hint, setHint, end } = usePaneDnd()

  const leafRef = useRef<HTMLDivElement>(null)
  const isFocused = focusedPaneId === leaf.id

  // The terminal is portaled in from TerminalHostLayer, so React synthetic
  // events raised inside it never reach this component. Listen natively — those
  // events do bubble through the real DOM, which holds the adopted node.
  useEffect(() => {
    const el = leafRef.current
    if (!el) return
    const onDown = (): void => focusPane(leaf.id)
    el.addEventListener('mousedown', onDown, true)
    return () => el.removeEventListener('mousedown', onDown, true)
  }, [leaf.id, focusPane])

  // Keep the caret with the focused pane's visible tab, so switching tabs or
  // panes by click puts the next keystroke in the right PTY.
  useEffect(() => {
    if (isFocused && leaf.activeRunId) focusTerminal(leaf.activeRunId)
  }, [isFocused, leaf.activeRunId])

  const zoneHint = hint?.kind === 'zone' && hint.paneId === leaf.id ? hint.zone : null

  const onShieldDragOver = (e: ReactDragEvent): void => {
    if (!drag || !isTabDrag(e.dataTransfer.types)) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    const zone = computeDropZone(
      e.currentTarget.getBoundingClientRect(),
      e.clientX,
      e.clientY
    )
    // Suppress the highlight for the drops that would do nothing, so the
    // missing green rectangle tells the user before they let go.
    const ownPane = drag.fromPaneId === leaf.id
    if (ownPane && (zone === 'center' || leaf.runIds.length === 1)) {
      setHint(null)
      return
    }
    setHint({ kind: 'zone', paneId: leaf.id, zone })
  }

  const onShieldDrop = (e: ReactDragEvent): void => {
    if (!drag || !isTabDrag(e.dataTransfer.types)) return
    e.preventDefault()
    e.stopPropagation()
    // Recompute: the pointer may have moved since the last dragover.
    const zone = computeDropZone(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)
    if (zone === 'center') {
      moveRunToPane(drag.runId, leaf.id, leaf.runIds.filter((id) => id !== drag.runId).length)
    } else {
      splitPaneWithRun(leaf.id, zone, drag.runId)
    }
    end()
  }

  return (
    <div className={`pane-leaf${isFocused ? ' focused' : ''}`} data-pane-id={leaf.id} ref={leafRef}>
      <PaneTabBar leaf={leaf} showPanelActions={leaf.id === actionsPaneId} onCollapse={onCollapse} />
      <div className="pane-body">
        {leaf.activeRunId ? <RunPaneSlot runId={leaf.activeRunId} /> : null}
        {drag ? (
          <div
            className="pane-drop-shield"
            onDragOver={onShieldDragOver}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setHint(null)
            }}
            onDrop={onShieldDrop}
          />
        ) : null}
        {zoneHint ? <div className={`pane-drop-hint ${zoneHint}`} /> : null}
      </div>
    </div>
  )
}

/**
 * Adopts a run's stable terminal container (lib/terminalSlots). The container is
 * moved with appendChild rather than re-rendered, so xterm is never rebuilt.
 *
 * A callback ref, not an effect: when a pane moves in the tree React gives this
 * component a brand new host element without `runId` changing, and an effect
 * keyed on runId would leave the terminal attached to the discarded node.
 */
function RunPaneSlot({ runId }: { runId: string }): JSX.Element {
  // The ref is called with null on detach, so the host has to be remembered to
  // release it — and a pane reuses one element across tab switches, so "which
  // element" is exactly what distinguishes a handover from a real teardown.
  const hostRef = useRef<HTMLDivElement | null>(null)

  const attach = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) {
        hostRef.current = el
        attachTo(runId, el)
      } else {
        const prev = hostRef.current
        hostRef.current = null
        // After the commit, so a pane move has already re-homed the container.
        queueMicrotask(() => releaseFrom(runId, prev))
      }
    },
    [runId]
  )

  return <div className="run-pane" ref={attach} />
}
