import { PaneTreeView } from './PaneTreeView'
import { PaneDndProvider, usePaneDnd } from './paneDnd'

interface RunTabsProps {
  onCollapse: () => void
}

/**
 * The terminal panel: a grid of panes, each its own tab group. The terminals
 * themselves are mounted by TerminalHostLayer and adopted by whichever pane is
 * showing them (see lib/terminalSlots).
 */
export function RunTabs({ onCollapse }: RunTabsProps): JSX.Element {
  return (
    <PaneDndProvider>
      <OutputSection onCollapse={onCollapse} />
    </PaneDndProvider>
  )
}

function OutputSection({ onCollapse }: RunTabsProps): JSX.Element {
  const { drag } = usePaneDnd()
  // While a tab is in flight the terminal must stop being an event target, or
  // it swallows the dragover the pane's drop shield needs.
  return (
    <section className={`output${drag ? ' dragging' : ''}`}>
      <PaneTreeView onCollapse={onCollapse} />
    </section>
  )
}
