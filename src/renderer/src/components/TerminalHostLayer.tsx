import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore } from '../store/useAppStore'
import { getContainer, pruneContainers } from '../lib/terminalSlots'
import { TerminalView } from './TerminalView'

/**
 * Mounts one TerminalView per run, portaled into that run's stable container
 * (see lib/terminalSlots). Lives at the app root, outside the terminal panel's
 * collapsed/expanded branches, so a terminal is created exactly once per run and
 * survives tab switches, pane moves, and collapsing the panel.
 */
export function TerminalHostLayer(): JSX.Element {
  const runs = useAppStore((s) => s.runs)
  const ids = runs.map((r) => r.id)

  // Runs by identity, so the portals are not rebuilt on every output flush.
  const key = ids.join(',')
  useEffect(() => {
    pruneContainers(new Set(key ? key.split(',') : []))
  }, [key])

  return <>{runs.map((run) => createPortal(<TerminalView key={run.id} run={run} />, getContainer(run.id)))}</>
}
