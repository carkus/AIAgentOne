import { useEffect, type RefObject } from 'react'

// Mouse drag scrolls an element sideways (touch already does natively),
// only while its content is wider than it is: a graph that fits can't be
// dragged, and the grab cursor shows only when there is somewhere to go.
// It only becomes a drag past a few pixels, so a plain click on something
// inside still works; the click that ends a real drag is swallowed. Used by
// the horizontal graphs (GraphView, BriefGraph) on GraphFrame's scroller.
export function useDragScroll(ref: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let drag: { id: number; startX: number; left: number; moved: boolean } | null = null
    let justDragged = false
    const scrollable = () => el.scrollWidth > el.clientWidth + 1
    const updateCursor = () => { if (!drag?.moved) el.style.cursor = scrollable() ? 'grab' : '' }
    const ro = new ResizeObserver(updateCursor)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    updateCursor()
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0 || !scrollable()) return
      drag = { id: e.pointerId, startX: e.clientX, left: el.scrollLeft, moved: false }
    }
    const onMove = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return
      const dx = e.clientX - drag.startX
      if (!drag.moved && Math.abs(dx) < 5) return
      if (!drag.moved) {
        drag.moved = true
        el.setPointerCapture(e.pointerId)
        el.style.cursor = 'grabbing'
        el.style.userSelect = 'none'
      }
      el.scrollLeft = drag.left - dx
    }
    const onUp = (e: PointerEvent) => {
      if (!drag || drag.id !== e.pointerId) return
      justDragged = drag.moved
      drag = null
      el.style.userSelect = ''
      updateCursor()
    }
    // Capture phase on the scroller runs before React's own click
    // dispatch, so stopping it here keeps node click handlers from firing.
    const onClick = (e: MouseEvent) => {
      if (!justDragged) return
      justDragged = false
      e.stopPropagation()
      e.preventDefault()
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('click', onClick, true)
    return () => {
      ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('click', onClick, true)
    }
  }, [ref])
}
