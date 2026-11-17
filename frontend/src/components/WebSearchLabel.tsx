// The web search agents use right now, shown under the model in the agent
// header (Setup and Chat). Tavily first, Exa while Tavily is unavailable
// (mcp_client.active_web_search). Re-fetched whenever `refresh` changes, so
// Chat can update it after each turn.
import { useEffect, useState } from 'react'
import { fetchWebSearchStatus } from '../api'
import ah from '../styles/AgentHeader.module.css'

type Status = { active: string | null; paused: string[] }

// The last status fetched on any page, so the label shows at once when
// Setup hands over to Chat instead of waiting for its own fetch.
let lastStatus: Status | null = null

export default function WebSearchLabel({ refresh }: { refresh?: unknown }) {
  const [status, setStatus] = useState<Status | null>(lastStatus)

  useEffect(() => {
    let live = true
    fetchWebSearchStatus().then(s => {
      if (s) lastStatus = s
      if (live) setStatus(s ?? lastStatus)
    })
    return () => { live = false }
  }, [refresh])

  if (!status) return null
  const paused = status.paused.length ? ` (${status.paused.join(', ')} paused at its limit)` : ''
  return (
    <span
      className={ah.metaItem}
      title="The web search agents use now. Tavily first; Exa when Tavily is missing or has used its monthly allowance."
    >
      <span aria-hidden="true">🔎</span>
      <span>{status.active ? `${status.active} web search${paused}` : `No web search${paused}`}</span>
    </span>
  )
}
