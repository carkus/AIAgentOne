// Live graph of what the agent is doing while it's configured and deployed:
// Character → Focus → Brief → Outputs on the Setup steps, then the bootstrap
// stages streamed from bootstrap.py (grounding → design → one node per tool
// → code checks → self-checks → ready). Each node is pending, active (shows
// the current status line), done, skipped or failed. Drawn with ColumnGraph,
// so it looks and scrolls like the brief graph and the run trace.
import { useCallback, useMemo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { BootstrapStreamEvent } from '../types'
import ColumnGraph, { type ColumnNode } from './ColumnGraph'
import graph from '../styles/GraphView.module.css'
import styles from '../styles/ProcessGraph.module.css'

const NODE_WIDTH = 190 // ProcessGraph.module.css .node

export type ProcessState = 'pending' | 'active' | 'done' | 'skipped' | 'error'

export interface ProcessNodeData extends Record<string, unknown> {
  icon: string
  title: string
  state: ProcessState
  detail?: string
  items?: string[]
  // Set on the Setup-step nodes: clicking one opens that step.
  link?: boolean
  // The Setup step currently open.
  selected?: boolean
  first?: boolean
  last?: boolean
}

const STATE_LABEL: Record<ProcessState, string> = {
  pending: 'waiting',
  active: 'working',
  done: 'done',
  skipped: 'skipped',
  error: 'failed',
}

function ProcessNode({ data }: { data: ProcessNodeData }) {
  return (
    <div
      className={`${styles.node} ${styles[`node_${data.state}`]}${data.link ? ` ${styles.nodeLink}` : ''}${data.selected ? ` ${styles.nodeSelected}` : ''}`}
      aria-label={`${data.title}: ${STATE_LABEL[data.state]}${data.selected ? ' (open)' : ''}`}
      aria-current={data.selected ? 'step' : undefined}
      title={data.link ? `Go to the ${data.title} step` : undefined}
    >
      {!data.first && <Handle isConnectable={false} type="target" position={Position.Left} className={graph.handle} />}
      <div className={graph.nodeHeader}>
        <span className={graph.nodeIcon} aria-hidden="true">{data.icon}</span>
        <span className={styles.nodeTitle}>{data.title}</span>
        {data.state === 'active'
          ? <span className={styles.spinner} aria-hidden="true" />
          : <span className={styles.nodeState}>{data.state === 'done' ? '✓' : data.state === 'error' ? '✗' : ''}</span>}
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

export default function ProcessGraph({ columns, label = 'Process graph', onSelect }: {
  columns: ColumnNode<ProcessNodeData>[][]
  label?: string
  // Gets the id of a clicked node that has `link` set.
  onSelect?: (id: string) => void
}) {
  // Edges into a step that hasn't started stay faint.
  const edgeClass = useCallback(
    (_: ProcessNodeData, target: ProcessNodeData) => (target.state === 'pending' ? styles.edgePending : undefined),
    [],
  )
  // Stable identity unless the content changes, so ColumnGraph doesn't
  // re-lay out on every parent render.
  const key = JSON.stringify(columns)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useMemo(() => columns, [key])
  const handleClick = useCallback((id: string) => {
    if (stable.some(col => col.some(n => n.id === id && n.data.link))) onSelect?.(id)
  }, [stable, onSelect])
  return (
    <ColumnGraph
      columns={stable} node={ProcessNode} nodeWidth={NODE_WIDTH} colGap={36} label={label}
      edgeClass={edgeClass} onNodeClick={onSelect ? handleClick : undefined}
      zoomControls={false}
    />
  )
}

// ---- Deploy (bootstrap) run --------------------------------------------

export type DeployStage = 'grounding' | 'design' | 'checks' | 'selfcheck'
const DEPLOY_STAGES: DeployStage[] = ['grounding', 'design', 'checks', 'selfcheck']

export interface DeployRun {
  stage: DeployStage | null
  message: string | null
  grounding: string | null
  model: string | null
  tools: string[]
  checkNotes: string[]
  selfChecks: { check: string; passed: boolean; reason: string }[]
  error: string | null
  finished: boolean
}

export const EMPTY_DEPLOY_RUN: DeployRun = {
  stage: null, message: null, grounding: null, model: null, tools: [],
  checkNotes: [], selfChecks: [], error: null, finished: false,
}

// Folds one bootstrap stream event into the run. `modelLabel` formats a
// 'model' event (Setup already has formatModelInfo for that).
export function applyDeployEvent(run: DeployRun, event: BootstrapStreamEvent, modelLabel: (e: Extract<BootstrapStreamEvent, { type: 'model' }>) => string): DeployRun {
  switch (event.type) {
    case 'status': {
      const stage = event.stage ?? run.stage ?? 'grounding'
      const next = { ...run, stage, message: event.message }
      if (stage === 'grounding' && /similar/i.test(event.message)) next.grounding = event.message
      if (stage === 'checks' && event.message !== 'Checking the tool code…') next.checkNotes = [...run.checkNotes, event.message]
      return next
    }
    case 'tool':
      return run.tools.includes(event.name) ? run : { ...run, tools: [...run.tools, event.name] }
    case 'model':
      return { ...run, model: modelLabel(event) }
    case 'eval_result':
      return { ...run, selfChecks: [...run.selfChecks, { check: event.check, passed: event.passed, reason: event.reason }] }
    case 'done':
      return { ...run, finished: true, message: null }
    case 'error':
      return { ...run, error: event.message }
  }
  return run
}

function stageState(run: DeployRun, stage: DeployStage): ProcessState {
  const at = run.stage ? DEPLOY_STAGES.indexOf(run.stage) : -1
  const mine = DEPLOY_STAGES.indexOf(stage)
  if (run.finished || mine < at) return 'done'
  if (mine > at) return 'pending'
  return run.error ? 'error' : 'active'
}

const humanCheck = (check: string) => check.replace(/_/g, ' ')

export function deployColumns(run: DeployRun): ColumnNode<ProcessNodeData>[][] {
  const grounding = stageState(run, 'grounding')
  const design = stageState(run, 'design')
  const checks = stageState(run, 'checks')
  const selfcheck = stageState(run, 'selfcheck')
  const activeLine = (s: ProcessState) => (s === 'active' || s === 'error' ? (run.error ?? run.message ?? undefined) : undefined)

  const toolColumn: ColumnNode<ProcessNodeData>[] = run.tools.length > 0
    ? run.tools.map(name => ({
        id: `tool-${name}`,
        data: { icon: '🛠️', title: name, state: design === 'active' ? 'active' : design === 'pending' ? 'pending' : 'done' },
      }))
    : [{
        id: 'tools',
        data: {
          icon: '🛠️', title: 'Tools',
          state: design === 'active' ? 'active' : design === 'pending' ? 'pending' : run.error ? 'error' : 'skipped',
          detail: design === 'active' ? 'Named as the design streams in' : design === 'pending' ? undefined : 'No tools of its own',
        },
      }]

  return [
    [{ id: 'grounding', data: {
      icon: '🔎', title: 'Grounding', state: grounding,
      detail: activeLine(grounding) ?? (grounding === 'done' ? (run.grounding ?? 'No similar past agents yet') : 'Looks for similar past agents'),
    } }],
    [{ id: 'design', data: {
      icon: '🧠', title: 'Design', state: design,
      detail: activeLine(design) ?? (design === 'done' ? 'Persona, system prompt and tools written' : 'Persona, system prompt, tools'),
      items: run.model ? [run.model] : undefined,
    } }],
    toolColumn,
    [{ id: 'checks', data: {
      icon: '🧪', title: 'Code checks', state: checks,
      detail: activeLine(checks) ?? (checks === 'done' && run.checkNotes.length === 0 ? 'Tool code compiled clean' : checks === 'pending' ? 'Compile, forbidden calls, undefined names' : undefined),
      items: run.checkNotes.length > 0 ? run.checkNotes : undefined,
    } }],
    [{ id: 'selfcheck', data: {
      icon: '✅', title: 'Self-checks', state: selfcheck,
      detail: activeLine(selfcheck) ?? (run.selfChecks.length === 0 ? 'Grades the finished design' : undefined),
      items: run.selfChecks.length > 0
        ? run.selfChecks.map(c => `${c.passed ? '✓' : '✗'} ${humanCheck(c.check)}${c.passed ? '' : `: ${c.reason}`}`)
        : undefined,
    } }],
    [{ id: 'ready', data: {
      icon: '🚀', title: 'Ready', state: run.finished ? 'done' : run.error ? 'skipped' : 'pending',
      detail: run.finished ? 'Opening the job' : run.error ? 'Stopped' : 'Starts the job',
    } }],
  ]
}
