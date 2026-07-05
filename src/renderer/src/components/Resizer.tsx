import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react'

interface ResizerProps {
  orientation: 'vertical' | 'horizontal'
  onDrag: (deltaPx: number) => void
  onDoubleClick?: () => void
  title?: string
}

export function Resizer({ orientation, onDrag, onDoubleClick, title }: ResizerProps): JSX.Element {
  const startRef = useRef<number | null>(null)
  const onDragRef = useRef(onDrag)
  onDragRef.current = onDrag

  useEffect(() => {
    const isVertical = orientation === 'vertical'
    const move = (e: MouseEvent): void => {
      if (startRef.current === null) return
      const current = isVertical ? e.clientX : e.clientY
      const delta = current - startRef.current
      startRef.current = current
      if (delta !== 0) onDragRef.current(delta)
    }
    const up = (): void => {
      if (startRef.current === null) return
      startRef.current = null
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [orientation])

  const down = (e: ReactMouseEvent): void => {
    startRef.current = orientation === 'vertical' ? e.clientX : e.clientY
    document.body.style.cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div
      className={`resizer ${orientation}`}
      onMouseDown={down}
      onDoubleClick={onDoubleClick}
      title={title}
    />
  )
}
