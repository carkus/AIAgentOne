// The Setup Brief drawn as a flow: the commission → how the agent understood
// it → the lines of work it will split into → the result it hands back.
// Same look and behaviour as the run trace (GraphView), via ColumnGraph. The
// content is the brief call's own "map" (brief.py's _brief_map), so it is
// the model's reading of the job, not a re-layout of the keyword list.
import { useMemo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { BriefMap } from '../api'
import ColumnGraph, { type ColumnNode } from './ColumnGraph'
import graph from '../styles/GraphView.module.css'
import styles from '../styles/BriefGraph.module.css'

const NODE_WIDTH = 220 // BriefGraph.module.css .node

type Variant = 'ask' | 'understood' | 'work' | 'result'

interface BriefNodeData extends Record<string, unknown> {
  variant: Variant
  icon: string
  title: string
  detail?: string
  items?: string[]
  first?: boolean
  last?: boolean
}

function BriefNode({ data }: { data: BriefNodeData }) {
  return (
    <div className={`${styles.node} ${styles[`node_${data.variant}`]}`}>
      {!data.first && <Handle isConnectable={false} type="target" position={Position.Left} className={graph.handle} />}
      <div className={graph.nodeHeader}>
        <span className={graph.nodeIcon} aria-hidden="true">{data.icon}</span>
        <span className={styles.nodeTitle}>{data.title}</span>
      </div>
      {data.detail && <p className={styles.nodeText}>{data.detail}</p>}
      {data.items && data.items.length > 0 && (
        <ul className={styles.nodeList}>
          {data.items.map((item, i) => <li key={i}>{item}</li>)}
        </ul>
      )}
      {!data.last && <Handle isConnectable={false} type="source" position={Position.Right} className={graph.handle} />}
    </div>
  )
}

export default function BriefGraph({ map }: { map: BriefMap }) {
  const columns = useMemo<ColumnNode<BriefNodeData>[][]>(() => [
    [{ id: 'ask', data: { variant: 'ask', icon: '📨', title: 'The commission', detail: map.ask } }],
    ...(map.understood.length > 0
      ? [[{ id: 'understood', data: { variant: 'understood' as const, icon: '🧠', title: 'Understood as', items: map.understood } }]]
      : []),
    map.work.map((w, i) => ({
      id: `work-${i}`,
      data: { variant: 'work' as const, icon: '🕵️', title: w.label, detail: w.detail || undefined },
    })),
    [{ id: 'result', data: { variant: 'result', icon: '📁', title: 'Desired result', detail: map.result } }],
  ], [map])
  // No zoom/fit/expand controls: the brief graph always fits its frame.
  return <ColumnGraph columns={columns} node={BriefNode} nodeWidth={NODE_WIDTH} label="Brief graph" zoomControls={false} />
}
