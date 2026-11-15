import { useMemo, useState } from 'react'
import type { AgentDraft } from '../api'
import type { SavedChat, SavedChatMessage } from '../types'
import { BEHAVIOR_TOGGLES, getTemplate } from '../agentTypes'
import { RELIC_LABELS } from '../relicFiles'
import styles from '../styles/AgentPool.module.css'

type Filter = 'all' | 'profiles' | 'jobs'

interface Props {
  drafts: AgentDraft[]
  chats: SavedChat[]
  formatDate: (ts: number) => string
  // The entry the form was last loaded from.
  editing: { kind: 'draft' | 'chat'; id: string } | null
  disabled: boolean
  onLoadDraft: (d: AgentDraft) => void
  onLaunchDraft: (d: AgentDraft) => void
  onDeleteDraft: (id: string) => void
  onLoadChatDetails: (c: SavedChat) => void
  onResumeChat: (c: SavedChat) => void
  onHideChat: (id: string) => void
}

type Entry =
  | { kind: 'draft'; id: string; savedAt: number; draft: AgentDraft }
  | { kind: 'chat'; id: string; savedAt: number; chat: SavedChat }

function behaviorLabel(id: string): string {
  return BEHAVIOR_TOGGLES.find(t => t.id === id)?.label ?? id
}

function lastLine(messages: SavedChatMessage[]): string | null {
  const last = [...messages].reverse().find(m => m.content.trim().length > 0)
  if (!last) return null
  const text = last.content.trim().replace(/\s+/g, ' ')
  const short = text.length > 110 ? `${text.slice(0, 109)}…` : text
  return last.role === 'user' ? `You: ${short}` : short
}

function entryName(e: Entry): string {
  return e.kind === 'draft' ? e.draft.agentName : e.chat.agentName
}

function entryKeywords(e: Entry): string[] {
  return e.kind === 'draft' ? e.draft.keywords : (e.chat.agentConfig.keywords ?? [])
}

// Load a previous agent: every saved profile (agent_drafts.py, on the
// server) and saved job (chatStorage.ts, this browser) in one list, newest
// first, whatever its type. A profile refills the Setup steps; a job either
// reopens its built agent or copies its settings into the steps.
export default function AgentPool({
  drafts, chats, formatDate, editing, disabled,
  onLoadDraft, onLaunchDraft, onDeleteDraft, onLoadChatDetails, onResumeChat, onHideChat,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [howOpen, setHowOpen] = useState(true)

  const entries = useMemo<Entry[]>(() => {
    const all: Entry[] = [
      ...drafts.map(d => ({ kind: 'draft' as const, id: d.id, savedAt: d.savedAt, draft: d })),
      ...chats.map(c => ({ kind: 'chat' as const, id: c.id, savedAt: c.savedAt, chat: c })),
    ]
    return all.sort((a, b) => b.savedAt - a.savedAt)
  }, [drafts, chats])

  const q = query.trim().toLowerCase()
  const shown = entries.filter(e => {
    if (filter === 'profiles' && e.kind !== 'draft') return false
    if (filter === 'jobs' && e.kind !== 'chat') return false
    if (!q) return true
    return [entryName(e), ...entryKeywords(e)].some(s => s.toLowerCase().includes(q))
  })

  const loaded = editing
    ? entries.find(e => e.kind === editing.kind && e.id === editing.id)
    : undefined

  const filters: { id: Filter; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: entries.length },
    { id: 'profiles', label: 'Profiles', count: drafts.length },
    { id: 'jobs', label: 'Jobs', count: chats.length },
  ]

  return (
    <div className={styles.pool}>
      <div className={styles.how}>
        <button
          type="button"
          className={styles.howToggle}
          aria-expanded={howOpen}
          onClick={() => setHowOpen(o => !o)}
        >
          <span aria-hidden="true">{howOpen ? '▾' : '▸'}</span> How loading works
        </button>
        {howOpen && (
          <ul className={styles.howList}>
            <li><strong>Every agent you deploy is kept here</strong>, already built, so you don't wait for it to be built again.</li>
            <li><strong>Profile → Launch:</strong> opens that built agent straight away with a fresh conversation. No brief, no build.</li>
            <li><strong>Profile → Load:</strong> fills every step again: type, Focus, personality, behaviours, location and outputs. If you change nothing, Deploy becomes Launch and opens the built agent at once. Change a step and it is built again.</li>
            <li><strong>Job → Resume:</strong> reopens the agent that was already built, with its conversation, tools and outputs. No rebuild, no wait.</li>
            <li><strong>Job → Load details:</strong> copies that job's settings into the steps. Change them and Deploy a new agent, or Save to update the job.</li>
            <li><strong>Save</strong> (the disk icon) adds what you're building here, or updates the one you loaded.</li>
            <li>Profiles are kept on the server, so they're in any browser. Jobs are kept in this browser only.</li>
          </ul>
        )}
      </div>

      {entries.length > 0 && (
        <div className={styles.controls}>
          <div className={styles.filters} role="radiogroup" aria-label="Show">
            {filters.map(f => (
              <button
                key={f.id}
                type="button"
                role="radio"
                aria-checked={filter === f.id}
                className={filter === f.id ? styles.filterActive : styles.filter}
                onClick={() => setFilter(f.id)}
              >
                {f.label} ({f.count})
              </button>
            ))}
          </div>
          <input
            className={styles.search}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Find by name or focus…"
            aria-label="Find a previous agent by name or focus"
          />
        </div>
      )}

      {entries.length === 0 ? (
        <p className={styles.empty}>
          No previous agents yet. Set one up and press Save to keep it as a profile, or use "Save chat" while an agent is working to keep the job.
        </p>
      ) : shown.length === 0 ? (
        <p className={styles.empty}>Nothing matches. Try another name or focus, or show All.</p>
      ) : (
        <ul className={styles.list}>
          {shown.map(e => {
            const isLoaded = loaded?.kind === e.kind && loaded.id === e.id
            if (e.kind === 'draft') {
              const d = e.draft
              const character = [...d.traits, ...(d.behaviorToggles ?? []).map(behaviorLabel)]
              return (
                <li key={`d-${d.id}`} className={`${styles.card} ${isLoaded ? styles.cardLoaded : ''}`}>
                  <div className={styles.cardHead}>
                    <span className={styles.kindProfile}>Profile</span>
                    <span className={styles.name}>Agent {d.agentName}</span>
                    {isLoaded && <span className={styles.loadedTag}>loaded</span>}
                  </div>
                  <span className={styles.meta}>
                    {d.builtConfig ? 'Built · ' : 'Not built yet · '}
                    {getTemplate(d.agentType ?? 'research').label}
                    {' · '}{d.location || 'No location'}
                    {d.factorLocation === false && ' (not factored in)'}
                    {' · saved '}{formatDate(d.savedAt)}
                  </span>
                  {d.keywords.length > 0 && (
                    <span className={styles.pills}>
                      {d.keywords.map(kw => <span key={kw} className={styles.focusPill}>{kw}</span>)}
                    </span>
                  )}
                  {character.length > 0 && (
                    <span className={styles.pills}>
                      {character.map(t => <span key={t} className={styles.characterPill}>{t}</span>)}
                    </span>
                  )}
                  {d.outputs && d.outputs.length > 0 && (
                    <span className={styles.meta}>Outputs: {d.outputs.map(k => RELIC_LABELS[k] ?? k).join(', ')}</span>
                  )}
                  <div className={styles.actions}>
                    {d.builtConfig && (
                      <button type="button" className={styles.primaryBtn} onClick={() => onLaunchDraft(d)} disabled={disabled}
                        title="Open this built agent straight away, with no rebuild">
                        Launch
                      </button>
                    )}
                    <button type="button" className={d.builtConfig ? styles.secondaryBtn : styles.primaryBtn} onClick={() => onLoadDraft(d)} disabled={disabled}
                      title="Fill the Setup steps with this profile">
                      Load
                    </button>
                    <button type="button" className={styles.removeBtn} onClick={() => onDeleteDraft(d.id)} disabled={disabled}
                      title="Delete this profile">
                      Delete
                    </button>
                  </div>
                </li>
              )
            }
            const c = e.chat
            const cfg = c.agentConfig
            const character = [...(cfg.persona?.traits ?? []), ...(cfg.active_toggles ?? []).map(behaviorLabel)]
            const preview = lastLine(c.messages)
            return (
              <li key={`c-${c.id}`} className={`${styles.card} ${isLoaded ? styles.cardLoaded : ''}`}>
                <div className={styles.cardHead}>
                  <span className={styles.kindJob}>Job</span>
                  <span className={styles.name}>Agent {c.agentName}</span>
                  {isLoaded && <span className={styles.loadedTag}>loaded</span>}
                </div>
                <span className={styles.meta}>
                  {getTemplate(cfg.template).label}
                  {cfg.location && ` · ${cfg.location}`}
                  {' · '}{c.messages.length} message{c.messages.length === 1 ? '' : 's'}
                  {cfg.tools.length > 0 && ` · ${cfg.tools.length} tool${cfg.tools.length === 1 ? '' : 's'}`}
                  {' · saved '}{formatDate(c.savedAt)}
                </span>
                {(cfg.keywords ?? []).length > 0 && (
                  <span className={styles.pills}>
                    {(cfg.keywords ?? []).map(kw => <span key={kw} className={styles.focusPill}>{kw}</span>)}
                  </span>
                )}
                {character.length > 0 && (
                  <span className={styles.pills}>
                    {character.map(t => <span key={t} className={styles.characterPill}>{t}</span>)}
                  </span>
                )}
                {preview && <span className={styles.preview}>{preview}</span>}
                <div className={styles.actions}>
                  <button type="button" className={styles.primaryBtn} onClick={() => onResumeChat(c)} disabled={disabled}
                    title="Reopen this built agent and its conversation">
                    Resume
                  </button>
                  <button type="button" className={styles.secondaryBtn} onClick={() => onLoadChatDetails(c)} disabled={disabled}
                    title="Copy this job's settings into the Setup steps">
                    Load details
                  </button>
                  <button type="button" className={styles.removeBtn} onClick={() => onHideChat(c.id)} disabled={disabled}
                    title="Remove from this list (the saved job itself is kept)">
                    Remove
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
