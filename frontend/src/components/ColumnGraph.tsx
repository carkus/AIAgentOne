// A left-to-right flow of card columns, sized to its tallest column and
// scrolled or dragged sideways inside GraphFrame. Shared by Setup's brief
// graph (BriefGraph) and the live process graph (ProcessGraph): the caller
// supplies the columns and a node component, and this does the measuring,
// placing and fitting the run trace (GraphView) also does.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useNodesInitialized,
  useStore,
  Background,
  BackgroundVariant,
  type Node,
  type Edge,
  type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import GraphFrame from './GraphFrame'
import { useDragScroll } from '../useDragScroll'
import graph from '../styles/GraphView.module.css'

const ROW_GAP = 14
const DEFAULT_NODE_HEIGHT = 70
const FIT_PAD = 14
const MIN_FRAME_PX = 120
const MIN_ZOOM = 0.3
const MAX_ZOOM = 2
const ZOOM_STEP = 1.25

export interface ColumnNode<D extends Record<string, unknown>> {
  id: string
  data: D
}

interface Size { width: number; height: number }

interface Props<D extends Record<string, unknown>> {
  columns: ColumnNode<D>[][]
  // The card component, rendered for every node.
  node: NodeTypes[string]
  nodeWidth: number
  colGap?: number
  label: string
  // Extra class per edge, from its two ends (e.g. to dim edges into
  // steps that haven't run yet).
  edgeClass?: (source: D, target: D) => string | undefined
  // Called with the id of a clicked card.
  onNodeClick?: (id: string) => void
  // False drops the zoom/fit/scale buttons; the graph stays at 100%.
  zoomControls?: boolean
}

function buildGraph<D extends Record<string, unknown>>(
  columns: ColumnNode<D>[][], sizes: Map<string, Size>, nodeWidth: number, colGap: number,
  edgeClass?: (source: D, target: D) => string | undefined,
): { nodes: Node[]; edges: Edge[] } {
  // One column per stage, a stage's branches stacked and centred on a
  // shared midline.
  const nodes: Node[] = []
  columns.forEach((col, c) => {
    const heights = col.map(n => sizes.get(n.id)?.height ?? DEFAULT_NODE_HEIGHT)
    let y = -(heights.reduce((a, b) => a + b, 0) + ROW_GAP * (col.length - 1)) / 2
    col.forEach((n, i) => {
      nodes.push({
        id: n.id,
        type: 'card',
        position: { x: c * (nodeWidth + colGap), y },
        ...(sizes.has(n.id) ? { measured: sizes.get(n.id) } : {}),
        data: { ...n.data, first: c === 0, last: c === columns.length - 1 },
        draggable: false,
        connectable: false,
      })
      y += heights[i] + ROW_GAP
    })
  })

  const edges: Edge[] = []
  for (let c = 0; c < columns.length - 1; c++) {
    for (const a of columns[c]) {
      for (const b of columns[c + 1]) {
        const extra = edgeClass?.(a.data, b.data)
        edges.push({ id: `${a.id}->${b.id}`, source: a.id, target: b.id, className: extra ? `${graph.edge} ${extra}` : graph.edge })
      }
    }
  }
  return { nodes, edges }
}

export default function ColumnGraph<D extends Record<string, unknown>>(props: Props<D>) {
  return (
    <ReactFlowProvider>
      <ColumnGraphInner {...props} />
    </ReactFlowProvider>
  )
}

function ColumnGraphInner<D extends Record<string, unknown>>({ columns, node, nodeWidth, colGap = 48, label, edgeClass, onNodeClick, zoomControls = true }: Props<D>) {
  const nodeTypes = useMemo(() => ({ card: node }), [node])
  const [sizes, setSizes] = useState<Map<string, Size>>(() => new Map())
  const { nodes, edges } = useMemo(
    () => buildGraph(columns, sizes, nodeWidth, colGap, edgeClass),
    [columns, sizes, nodeWidth, colGap, edgeClass],
  )
  const flow = useReactFlow()
  const initialized = useNodesInitialized()
  const sizeKey = useStore(st => {
    let k = ''
    for (const n of st.nodeLookup.values()) k += `${n.id}:${Math.round(n.measured?.width ?? 0)}x${Math.round(n.measured?.height ?? 0)};`
    return k
  })
  const wrapRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  useDragScroll(scrollRef)
  const [width, setWidth] = useState(0)
  const [height, setHeight] = useState<number | undefined>(undefined)
  const [contentWidth, setContentWidth] = useState<number | undefined>(undefined)
  const [userZoom, setUserZoom] = useState<number | null>(null)
  const [zoomLevel, setZoomLevel] = useState(1)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const fitToContent = useCallback(() => {
    if (!width) return
    const b = flow.getNodesBounds(flow.getNodes().map(n => n.id))
    if (!b.width || !b.height) return
    const z = userZoom ?? 1
    const h = Math.max(MIN_FRAME_PX, b.height * z + 2 * FIT_PAD)
    setHeight(h)
    setContentWidth(Math.max(width, b.width * z + 2 * FIT_PAD))
    setZoomLevel(z)
    void flow.setViewport({ x: FIT_PAD - b.x * z, y: (h - b.height * z) / 2 - b.y * z, zoom: z })
  }, [flow, width, userZoom])

  // Feed measured card heights back into the layout, then fit.
  useEffect(() => {
    let changed = false
    const next = new Map(sizes)
    for (const { id } of flow.getNodes()) {
      const m = flow.getInternalNode(id)?.measured
      const w = Math.round(m?.width ?? 0)
      const h = Math.round(m?.height ?? 0)
      if (!w || !h) continue
      const prev = next.get(id)
      if (!prev || prev.width !== w || prev.height !== h) { next.set(id, { width: w, height: h }); changed = true }
    }
    if (changed) { setSizes(next); return }
    if (!initialized) return
    const raf = requestAnimationFrame(fitToContent)
    return () => cancelAnimationFrame(raf)
  }, [initialized, nodes, sizeKey, fitToContent, flow, sizes])

  const zoomBy = (factor: number) =>
    setUserZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomLevel * factor)))

  return (
    <div ref={wrapRef}>
      <GraphFrame
        className={graph.container}
        label={label}
        height={height}
        scrollX
        contentWidth={contentWidth}
        scrollRef={scrollRef}
        controls={zoomControls}
        zoom={{
          zoomIn: () => zoomBy(ZOOM_STEP),
          zoomOut: () => zoomBy(1 / ZOOM_STEP),
          fit: () => setUserZoom(null),
          level: zoomLevel,
        }}
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick ? (_, n) => onNodeClick(n.id) : undefined}
          minZoom={0.1}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          nodesConnectable={false}
          connectOnClick={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--graph-20)" />
        </ReactFlow>
      </GraphFrame>
    </div>
  )
}
