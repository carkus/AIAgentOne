// One full-width holder for every graph in the app — Mermaid diagrams in replies,
// the plan preview, diagram relics and the React Flow trace (GraphView) — so
// they all get the same size and the same zoom in / zoom out / fit controls
// instead of each being squeezed into its own small box.
//
// Two modes:
// - Own zoom (default): the children are drawn at their natural size and the
//   frame scales/pans them itself (buttons, drag to pan, Ctrl+wheel to zoom).
//   Drag only pans an axis the scaled content overflows, and not past its
//   edges, so a diagram that fits the frame stays put.
//   Fits the content to the width and collapses the frame height to it
//   (85vh at most) until the user zooms or pans.
// - External zoom (`zoom` prop): for content that already owns a viewport
//   (React Flow). The frame only draws the square and the controls, and the
//   buttons call the given handlers.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import styles from '../styles/GraphFrame.module.css'

export interface ExternalZoom {
  zoomIn: () => void
  zoomOut: () => void
  fit: () => void
  level: number // 1 = 100%
}

interface Props {
  children: ReactNode
  zoom?: ExternalZoom
  onExpand?: () => void
  className?: string
  contentClassName?: string
  label?: string // accessible name for the frame
  // External mode only: exact frame height in px (content-sized), replacing the CSS square.
  height?: number
  // External mode only: content scrolls sideways under fixed zoom controls,
  // drawn at contentWidth (the full frame width until measured).
  scrollX?: boolean
  contentWidth?: number
  scrollRef?: Ref<HTMLDivElement>
  // False hides the zoom/fit/scale controls (a small graph that always
  // shows at its own size).
  controls?: boolean
  // False hides just +/−/fit and the scale, keeping ⛶ when onExpand is set.
  zoomButtons?: boolean
}

const MIN_SCALE = 0.1
const MAX_SCALE = 8
const STEP = 1.25
// Fixed inset (px) left around fitted content, rather than a percentage that
// grew into a wide empty margin on a full-width frame.
const FIT_PAD = 12
// Space (px) between a fitted graph's right edge and the zoom controls.
const CONTROLS_GAP = 8

// Room for a horizontal scrollbar under scrolling content, so it doesn't
// cover the bottom of the graph.
const SCROLLBAR_ALLOWANCE = 14

export default function GraphFrame({ children, zoom, onExpand, className, contentClassName, label = 'Graph', height: externalHeight, scrollX, contentWidth, scrollRef, controls = true, zoomButtons = true }: Props) {
  const frameRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const controlsRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  // Own-zoom mode: the frame's height collapses to the fitted content
  // (null until first measured, when the CSS square applies).
  const [height, setHeight] = useState<number | null>(null)
  // Keep re-fitting as the content/frame resizes until the user takes over.
  const userMoved = useRef(false)
  const drag = useRef<{ id: number; startX: number; startY: number; x: number; y: number } | null>(null)
  const external = zoom !== undefined

  const fit = useCallback(() => {
    const frame = frameRef.current
    const content = contentRef.current
    if (!frame || !content) return
    const fw = frame.clientWidth
    // Width left of the zoom controls (plus a gap), so the fitted graph
    // sits beside them instead of under them.
    const controls = controlsRef.current
    const aw = controls ? Math.max(0, controls.offsetLeft - CONTROLS_GAP) : fw
    const cw = content.offsetWidth
    const ch = content.offsetHeight
    if (!fw || !cw || !ch) return
    // Fit to the width, capped at 85vh tall (same cap as the CSS), and make
    // the frame exactly that tall so a wide diagram doesn't sit in a square
    // of empty space.
    const maxH = window.innerHeight * 0.85
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((aw - 2 * FIT_PAD) / cw, (maxH - 2 * FIT_PAD) / ch)))
    const fh = Math.min(maxH, ch * scale + 2 * FIT_PAD)
    setHeight(fh)
    setView({ scale, x: (aw - cw * scale) / 2, y: (fh - ch * scale) / 2 })
  }, [])

  const zoomBy = useCallback((factor: number) => {
    const frame = frameRef.current
    if (!frame) return
    userMoved.current = true
    const cx = frame.clientWidth / 2
    const cy = frame.clientHeight / 2
    setView(v => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
      const k = scale / v.scale
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }, [])

  useLayoutEffect(() => {
    if (external) return
    const frame = frameRef.current
    const content = contentRef.current
    if (!frame || !content) return
    fit()
    const ro = new ResizeObserver(() => { if (!userMoved.current) fit() })
    ro.observe(frame)
    ro.observe(content)
    return () => ro.disconnect()
  }, [external, fit])

  // Ctrl/Cmd + wheel zooms (plain wheel keeps scrolling the chat). Needs a
  // non-passive listener to stop the browser's own page zoom.
  useEffect(() => {
    if (external) return
    const frame = frameRef.current
    if (!frame) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
    }
    frame.addEventListener('wheel', onWheel, { passive: false })
    return () => frame.removeEventListener('wheel', onWheel)
  }, [external, zoomBy])

  // Room to pan on each axis: the scaled content against the frame's
  // visible area (left of the zoom controls). null = it fits, no panning.
  const panRange = (scale: number) => {
    const frame = frameRef.current
    const content = contentRef.current
    if (!frame || !content) return { x: null, y: null }
    const controls = controlsRef.current
    const aw = controls ? Math.max(0, controls.offsetLeft - CONTROLS_GAP) : frame.clientWidth
    const fh = frame.clientHeight
    const cw = content.offsetWidth * scale
    const ch = content.offsetHeight * scale
    return {
      x: cw + 2 * FIT_PAD > aw + 1 ? { lo: aw - cw - FIT_PAD, hi: FIT_PAD } : null,
      y: ch + 2 * FIT_PAD > fh + 1 ? { lo: fh - ch - FIT_PAD, hi: FIT_PAD } : null,
    }
  }
  const range = external ? { x: null, y: null } : panRange(view.scale)
  const fits = !range.x && !range.y

  const onPointerDown = (e: React.PointerEvent) => {
    if (external || e.button !== 0 || fits) return
    if ((e.target as HTMLElement).closest(`.${styles.controls}`)) return
    drag.current = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x: view.x, y: view.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    userMoved.current = true
    // Clamp to the content's edges; the start position is always allowed,
    // so a view left out of range by a zoom doesn't jump on the next drag.
    const axis = (r: { lo: number; hi: number } | null, start: number, delta: number) =>
      r ? Math.min(Math.max(r.hi, start), Math.max(Math.min(r.lo, start), start + delta)) : start
    setView(v => {
      const r = panRange(v.scale)
      return { ...v, x: axis(r.x, d.x, e.clientX - d.startX), y: axis(r.y, d.y, e.clientY - d.startY) }
    })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current?.id === e.pointerId) drag.current = null
  }

  const level = external ? zoom.level : view.scale
  const doZoomIn = external ? zoom.zoomIn : () => zoomBy(STEP)
  const doZoomOut = external ? zoom.zoomOut : () => zoomBy(1 / STEP)
  const doFit = external ? zoom.fit : () => { userMoved.current = false; fit() }

  return (
    <div
      ref={frameRef}
      className={`${styles.frame} ${external ? '' : styles.pannable} ${className ?? ''}`}
      style={
        !external && height !== null ? { height }
          : external && externalHeight !== undefined
            ? { height: externalHeight + (scrollX ? SCROLLBAR_ALLOWANCE : 0), aspectRatio: 'auto' }
            : undefined
      }
      data-fits={!external && fits ? '' : undefined}
      role="group"
      aria-label={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {external && scrollX ? (
        <div ref={scrollRef} className={styles.scrollX}>
          <div className={styles.scrollContent} style={{ width: contentWidth ?? '100%', height: externalHeight ?? '100%' }}>{children}</div>
        </div>
      ) : external ? (
        <div className={styles.fill}>{children}</div>
      ) : (
        <div
          ref={contentRef}
          className={`${styles.content} ${contentClassName ?? ''}`}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {children}
        </div>
      )}
      {controls && (zoomButtons || onExpand) && (
      <div ref={controlsRef} className={styles.controls}>
        {zoomButtons && <>
        <button type="button" className={styles.controlBtn} onClick={doZoomIn} aria-label="Zoom in" title="Zoom in">+</button>
        <button type="button" className={styles.controlBtn} onClick={doZoomOut} aria-label="Zoom out" title="Zoom out">−</button>
        <button type="button" className={styles.controlBtn} onClick={doFit} aria-label="Fit to frame" title="Fit to frame">⤢</button>
        </>}
        {onExpand && (
          <button type="button" className={styles.controlBtn} onClick={onExpand} aria-label="Open full view" title="Open full view">⛶</button>
        )}
        {zoomButtons && <span className={styles.level}>{Math.round(level * 100)}%</span>}
      </div>
      )}
    </div>
  )
}
