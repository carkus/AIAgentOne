import type { SavedChatMessage } from './types'

export interface JobWorker {
  name: string
  task: string
}

// The workers a saved job delegated to, read from its saved tool calls
// (delegate_to_worker results carry worker_name and task, orchestrator.py).
export function jobWorkers(messages: SavedChatMessage[]): JobWorker[] {
  const workers: JobWorker[] = []
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      if (tc.tool !== 'delegate_to_worker') continue
      let result: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(tc.result)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) result = parsed
      } catch { /* an unfinished or failed call */ }
      const name = typeof result.worker_name === 'string' ? result.worker_name : 'Worker'
      const task = typeof result.task === 'string' ? result.task
        : typeof tc.inputs.task === 'string' ? tc.inputs.task : ''
      workers.push({ name, task: task.trim().replace(/\s+/g, ' ') })
    }
  }
  return workers
}
