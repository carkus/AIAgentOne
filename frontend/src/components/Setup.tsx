import { useEffect, useRef, useState } from 'react'
import { bootstrap, buildBriefRelic, createAgentDraft, createSavedSearch, deleteAgentDraft, deleteSavedSearch, fetchBriefOutputs, streamAgentBrief, fetchFocusInsights, fetchModelInfo, listAgentDrafts, listPublishedAgents, listSavedSearches, unpublishAgent, updateAgentDraft } from '../api'
import type { AgentBrief, AgentDraft, BriefMap, BriefPartId, BriefStageId, BriefStreamEvent, FocusInsights, PublishedAgent, SavedSearch } from '../api'
import { getLastOpenedPointer, hideSavedChat, loadHiddenChatIds, loadSavedChats, saveChat, setLastOpenedPointer } from '../chatStorage'
import type { AgentConfig, AgentTemplateId, ArmStat, BootstrapStreamEvent, Deliverable, LlmProvider, Relic, RelicKind, RelicSuggestion, SavedChat, SavedChatMessage, SearchDefaults } from '../types'
import { AGENT_TEMPLATES, getTemplate, PERSONALITY_TRAITS, describeTraitEffect, BEHAVIOR_TOGGLES, DEFAULT_AGENT_SPEC, MAX_FOCUS_CHARS, shortFocus, type BehaviorToggle } from '../agentTypes'
import { storedOllamaModel, storedCloudflareModel, describeModel, describeModelFallback, formatModelInfo, type ModelInfo } from '../modelLabel'
import { buildAgentBrief, joinNatural } from '../agentBrief'
import { formatDate, getDateFormat, type DateFormatId } from '../dateFormat'
import styles from '../styles/Setup.module.css'
import ah from '../styles/AgentHeader.module.css'
import splashLogo from '../assets/favicon.png'
import BriefGraph from './BriefGraph'
import ProcessGraph, { applyDeployEvent, deployColumns, EMPTY_DEPLOY_RUN, type DeployRun, type ProcessNodeData } from './ProcessGraph'
import type { ColumnNode } from './ColumnGraph'
import SettingsModal from './SettingsModal'
import ThemePicker from './ThemePicker'
import AgentStableModal from './AgentStableModal'
import AgentPool from './AgentPool'
import ScoreboardModal from './ScoreboardModal'
import LocationMapModal from './LocationMapModal'
import CharacterGenerator from './CharacterGenerator'
import HelpTip from './HelpTip'
import BehaviorIcon from './BehaviorIcon'
import RelicPreviewModal from './RelicPreviewModal'
import WebSearchLabel from './WebSearchLabel'
import { useToolbarDrag, useToolbarLayout, type ToolbarItem } from '../toolbarLayout'
import { downloadRelic, RELIC_KINDS, RELIC_LABELS, relicFilename } from '../relicFiles'

// Mono line icons matching the app's stroke-based visual style — plain
// geometric shapes (magnifier / briefcase / compass), not emoji, so they
// pick up the pill's currentColor and stay crisp at any size.
// What a built agent was built from: every step that changes its bootstrap.
// A saved agent whose key matches the current steps can be reused as it is
// instead of being built again. Provider/model aren't part of it: they only
// choose who runs the agent, so a reused agent takes the current choice.
interface BuildInputs {
  template: AgentTemplateId
  keywords: string[]
  location: string
  factorLocation: boolean
  toggles: string[]
  traits: string[]
  outputs: string[]
}

function buildKey(b: BuildInputs): string {
  const sorted = (xs: string[]) => [...xs].sort()
  return JSON.stringify([
    b.template, sorted(b.keywords), b.location.trim(), b.factorLocation,
    sorted(b.toggles), sorted(b.traits), sorted(b.outputs),
  ])
}

function configBuildKey(cfg: AgentConfig): string {
  return buildKey({
    template: cfg.template ?? 'research',
    keywords: cfg.keywords ?? [],
    location: cfg.location ?? '',
    factorLocation: cfg.factor_location ?? false,
    toggles: cfg.active_toggles ?? [],
    traits: cfg.active_traits ?? [],
    outputs: (cfg.deliverables ?? []).map(d => d.kind),
  })
}

function AgentTypeIcon({ id }: { id: AgentTemplateId }) {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  if (id === 'job_search') {
    return (
      <svg {...common}>
        <rect x="2.5" y="7" width="19" height="13.5" rx="2" />
        <path d="M8 7V5.5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2V7" />
        <line x1="2.5" y1="13" x2="21.5" y2="13" />
      </svg>
    )
  }
  if (id === 'general') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9.25" />
        <polygon points="15.5 8.5 13.2 13.2 8.5 15.5 10.8 10.8 15.5 8.5" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="10.5" cy="10.5" r="7" />
      <line x1="20.5" y1="20.5" x2="15.8" y2="15.8" />
    </svg>
  )
}

// Same mono line-art style as the other icons above — a plain floppy-disk
// outline standing in for the "Save Agent" button's old text label, once the
// button itself became icon-only.
function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 3h11l3 3v15a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M8 3v5h8V3" />
      <path d="M7 21v-8h10v8" />
    </svg>
  )
}

// Narrow screens: one button that opens the output list (see .toolbarTools).
function ToolsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="6" height="6" rx="1" />
      <rect x="14" y="4" width="6" height="6" rx="1" />
      <rect x="4" y="14" width="6" height="6" rx="1" />
      <rect x="14" y="14" width="6" height="6" rx="1" />
    </svg>
  )
}

// Toolbar icon per output kind (the Brief's offered relics).
// The Setup toolbar's buttons (toolbarLayout.ts): the default order is the
// order listed here; dragging a button on the toolbar reorders its group.
// The agent controls (Save, pool, Open agent, Advanced) aren't here: they
// sit in their own panel under the agent's name. The outputs are a
// fixed set (hide/reorder them in the toolbar builder); the Brief's picks
// only mark one or two of them as suggested. No chart: the Brief comes
// before any research, so there are no numbers to chart.
const SETUP_TOOLBAR_ITEMS: ToolbarItem[] = [
  ...(['pdf', 'docx', 'markdown', 'slides', 'diagram', 'json'] as RelicKind[])
    .map(kind => ({ id: kind, label: RELIC_LABELS[kind], group: 'outputs' })),
]

// Stacked cards: the saved agents to reload.
function AgentPoolIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="8" width="14" height="12" rx="1.5" />
      <path d="M7 5h12.5A1.5 1.5 0 0 1 21 6.5V16" />
      <circle cx="10" cy="12.5" r="2" />
      <path d="M6.5 18a3.5 3.5 0 0 1 7 0" />
    </svg>
  )
}

function OpenAgentIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  )
}

function AdvancedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="10" cy="12" r="2" />
      <circle cx="18" cy="18" r="2" />
    </svg>
  )
}


function RelicIcon({ kind }: { kind: RelicKind }) {
  const paths: Record<RelicKind, React.ReactNode> = {
    pdf: <><path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>,
    docx: <><path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5" /><path d="M9 12l1.5 6 1.5-4 1.5 4 1.5-6" /></>,
    markdown: <><path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5" /><path d="M9 12h6M9 15h6M9 18h4" /></>,
    diagram: <><rect x="3" y="3" width="7" height="5" rx="1" /><rect x="14" y="16" width="7" height="5" rx="1" /><path d="M6.5 8v5h11v3" /></>,
    chart: <><path d="M4 20h16" /><path d="M7 16v-5M12 16V6M17 16v-8" /></>,
    slides: <><rect x="3" y="4" width="18" height="12" rx="1" /><path d="M12 16v4M8 20h8" /></>,
    csv: <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 10h18M3 15h18M9 4v16" /></>,
    json: <><path d="M9 4H8a2 2 0 0 0-2 2v4l-2 2 2 2v4a2 2 0 0 0 2 2h1" /><path d="M15 4h1a2 2 0 0 1 2 2v4l2 2-2 2v4a2 2 0 0 1-2 2h-1" /></>,
  }
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[kind]}
    </svg>
  )
}

// Shared header for every collapsible subsection in the agent profile card
// (Behavior/Personality/Focus/Brief) — a clickable row that expands/
// collapses the section, plus a "?" HelpTip button. The row itself can't be
// a <button> (a HelpTip button living inside it would be an invalid
// button-in-button), so it's a div with role="button" instead; the HelpTip's
// own onClick stops propagation so opening the popover doesn't also
// toggle the section.
function SectionHeader({ label, count, expanded, onToggle, help, right }: {
  label: string
  // Shown after the label as "(n)", the same way the Dossier's section titles show theirs.
  count?: number
  expanded: boolean
  onToggle: () => void
  help: string
  right?: React.ReactNode
}) {
  return (
    <div
      className={styles.fieldLabelToggle}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
    >
      <span className={styles.fieldLabel}>
        <span className={styles.sectionBulb} aria-hidden="true" />
        {right}
        {label}{count ? ` (${count})` : ''}
      </span>
      <span className={styles.fieldLabelRight}>
        <HelpTip text={help} label={`${label} help`} />
        <span className={styles.fieldLabelCaret} aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </span>
    </div>
  )
}

type SetupStepId = 'character' | 'focus' | 'brief' | 'outputs'

const SETUP_STEPS: { id: SetupStepId; label: string; help: string }[] = [
  { id: 'character', label: 'Character', help: "Step 1: who the agent is. Personality traits and behavior toggles, both optional, shape its generated system prompt." },
  { id: 'focus', label: 'Focus', help: 'Step 2: the job. The topics, roles or keywords the agent works on: type new ones or pick from your Saved Focus pool. At least one is needed.' },
  { id: 'brief', label: 'Brief', help: "Step 3: a live preview of what this agent has agreed to do, generated from its type, focus and character. It's read-only: change those steps to change it." },
  { id: 'outputs', label: 'Outputs', help: "Step 4: what the agent hands back. It proposes the outputs it judges most useful for this job and ticks its own picks; change them freely. Chosen outputs are offered as ready-to-build files after each research turn." },
]

// The streamed brief's stages (brief.py's generate_brief_stream), in the
// order shown while it drafts. The web search runs alongside "character";
// "read" and "focus" start once it's back. "search" only shows once the
// server reports it (no Tavily key, no search).
type BriefStageState = 'pending' | 'active' | 'done' | 'failed'
interface BriefProgress {
  stages: Record<BriefStageId, BriefStageState>
  parts: Partial<Record<BriefPartId, string>>
  // The staged brief gave up and the one-call brief is being written.
  fallback: boolean
}
const EMPTY_BRIEF_PROGRESS: BriefProgress = {
  stages: { search: 'pending', read: 'pending', focus: 'pending', character: 'pending', plan: 'pending' },
  parts: {},
  fallback: false,
}
const BRIEF_STAGES: { id: BriefStageId; label: string }[] = [
  { id: 'search', label: 'Searching the web' },
  { id: 'read', label: 'Reading the case' },
  { id: 'focus', label: 'The focuses' },
  { id: 'character', label: 'Its character' },
  { id: 'plan', label: 'The plan and graph' },
]
const BRIEF_PARTS: BriefPartId[] = ['focus', 'character', 'plan']
const shownBriefStages = (p: BriefProgress) =>
  BRIEF_STAGES.filter(s => s.id !== 'search' || p.stages.search !== 'pending')

// Step navigation for the setup card: a breadcrumb of the step names, each
// one clickable. Steps aren't gated, so the user can jump straight to any
// of them.
function SetupSteps({ active, onSelect }: {
  active: SetupStepId
  onSelect: (id: SetupStepId) => void
}) {
  return (
    <nav className={styles.stepCrumbs} aria-label="Agent setup steps">
      <ol className={styles.stepCrumbList}>
        {SETUP_STEPS.map((s, n) => (
          <li key={s.id} className={styles.stepCrumbItem}>
            {n > 0 && <span className={styles.stepCrumbSep} aria-hidden="true">›</span>}
            <button
              type="button"
              id={`setup-step-${s.id}`}
              className={`${styles.stepCrumb} ${s.id === active ? styles.stepCrumbActive : ''}`}
              onClick={() => onSelect(s.id)}
              aria-current={s.id === active ? 'step' : undefined}
            >
              <span className={styles.stepCrumbNum}>{n + 1}</span>
              {s.label}
            </button>
            {s.id === active && <HelpTip text={s.help} label={`${s.label} help`} />}
          </li>
        ))}
      </ol>
    </nav>
  )
}

// What a behavior toggle's effect is actually called for each agent type —
// "findings" for research, "listings" for job search, plain "topics"
// otherwise — so a toggle's help text can say what it does to THIS agent's
// own output instead of a type-agnostic generic sentence.
const AGENT_TYPE_NOUN: Record<AgentTemplateId, string> = {
  general: 'topic',
  research: 'finding',
  job_search: 'listing',
}

// Behavior toggle help text (button tooltip + the active-effects list) used
// to be the same fixed sentence regardless of what the agent actually is —
// e.g. "Concise" read identically for a job-search agent and a research
// agent. This folds in the current agent type and its own specialty
// keywords so the help text describes what the toggle means for THIS
// agent, not behavior toggles in the abstract.
function describeBehaviorEffect(toggle: BehaviorToggle, type: AgentTemplateId, kw: string[]): string {
  const noun = AGENT_TYPE_NOUN[type] ?? 'topic'
  const subject = kw.length > 0 ? joinNatural(kw.slice(0, 3)) : `each ${noun}`
  switch (toggle.id) {
    case 'concise':
      return `${toggle.description} For this agent, that means terse bullet points on ${subject} instead of a long write-up per ${noun}.`
    case 'skeptical':
      return `${toggle.description} It will question shaky claims about ${subject} rather than repeating them as fact.`
    case 'cite-sources':
      return `${toggle.description} Every fact it states about ${subject} gets a source link attached inline.`
    case 'proactive':
      return `${toggle.description} It will flag risks or gaps in ${subject} even when you didn't ask about them directly.`
    case 'max-delegation':
      return kw.length > 1
        ? `${toggle.description} With ${kw.length} focus areas (${subject}), it splits the work across a worker agent per focus area instead of researching all of them itself.`
        : `${toggle.description} Even with just ${subject} to cover, it still splits research into parallel worker agents rather than doing it all itself.`
    default:
      return toggle.description
  }
}

// Default when the user hasn't overridden it on the Settings screen — mirrors
// backend/src/agent_stream.py's MAX_DELEGATIONS_PER_REQUEST. One worker is
// delegated per specialty, capped per turn, so more specialties than this are
// silently dropped/starved rather than all covered.
const DEFAULT_MAX_DELEGATIONS = 3

// Hard UI-side cap, independent of DEFAULT_MAX_DELEGATIONS above (that one's
// a soft delegation-capacity warning; this one actually blocks adding a 6th
// specialty at all) — keeps the specialty set small enough that the Brief
// and bootstrap prompt stay focused rather than diluted across many topics.
const MAX_SPECIALTIES = 4

// Deterministic warning check, used only when the AI-drafted brief (which
// does its own, richer warning assessment — see backend/src/brief.py)
// hasn't loaded or failed and we're falling back to buildAgentBrief()'s
// template. Only checks conditions cheap/certain enough to assert without
// an LLM call — the AI brief's own judgment always takes precedence when
// available, including its explicit choice not to warn.
function buildDeterministicWarning(keywords: string[], agentType: AgentTemplateId, loc: string | null, maxDelegations: number | null): string | null {
  const limit = maxDelegations ?? DEFAULT_MAX_DELEGATIONS
  if (keywords.length > limit) {
    return `You've added ${keywords.length} focus topics, and the agent runs up to ${limit} worker agents per research turn, so some topics will be combined or picked up in a follow-up turn rather than each getting its own worker. Trim the list or raise the worker limit in Settings if each one needs its own.`
  }
  // `loc` is null when the location toggle is off: that was deliberate, so
  // no note about it.
  if (agentType === 'job_search' && loc === '') {
    return 'No location is set, so job listings will be searched everywhere rather than in one area. Add a location if you only want roles near you.'
  }
  return null
}

type SavedSectionId = 'searches' | 'drafts' | 'chats' | 'mcp'

// The last line of a saved chat, shown in the saved-chats list so the user
// has some actual context for which conversation this is instead of just a
// name/timestamp — the name/keywords describe the agent, not what was said.
const CHAT_PREVIEW_MAX_LEN = 90
function lastChatLine(messages: SavedChatMessage[]): string | null {
  const last = [...messages].reverse().find(m => m.content.trim().length > 0)
  if (!last) return null
  const text = last.content.trim().replace(/\s+/g, ' ')
  const truncated = text.length > CHAT_PREVIEW_MAX_LEN ? `${text.slice(0, CHAT_PREVIEW_MAX_LEN - 1)}…` : text
  return last.role === 'user' ? `You: ${truncated}` : truncated
}

function formatSavedAt(ts: number, format: DateFormatId): string {
  return formatDate(ts, format, true)
}

interface Props {
  agentName: string
  onAgentNameChange: (name: string) => void
  bootstrapping: boolean
  error: string | null
  onStart: () => void
  onDone: (config: AgentConfig) => void
  onError: (msg: string) => void
  onResumeChat: (chat: SavedChat) => void
  // The config of the agent whose chat the user just came back from (App.tsx's
  // agentConfig, passed through onBackToSetup) — undefined/null the first
  // time Setup is shown, before anything has been bootstrapped yet.
  activeAgentConfig?: AgentConfig | null
  // Opens AdvancedSetup.tsx (structured spec + review step) instead of this screen.
  onOpenAdvanced?: () => void
}

export default function Setup({ agentName, onAgentNameChange, bootstrapping, error, onStart, onDone, onError, onResumeChat, activeAgentConfig, onOpenAdvanced }: Props) {
  // Persisted across reloads/new-agent resets, same localStorage idiom as
  // provider/dateFormat above — otherwise the type picker silently reverted
  // to "general" every time, discarding the user's last choice.
  const [agentType, setAgentType] = useState<AgentTemplateId>(
    () => (localStorage.getItem('aiagent_agent_type') as AgentTemplateId) || 'general'
  )
  useEffect(() => {
    localStorage.setItem('aiagent_agent_type', agentType)
  }, [agentType])
  const [keywords, setKeywords] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const [location, setLocation] = useState('Melbourne, Australia')
  // Whether the location is passed on at all (brief, bootstrap purpose,
  // agent config). Off by default except for Job search: "Augustus in
  // Melbourne" is what you get when every topic is told where the user is.
  const [factorLocation, setFactorLocation] = useState(
    () => ((localStorage.getItem('aiagent_agent_type') as AgentTemplateId) || 'general') === 'job_search'
  )
  const usedLocation = factorLocation ? location.trim() : ''
  // Persisted across "New agent"/reset (which fully remounts Setup — see
  // App.tsx's phase-conditional render) and page reloads, same
  // localStorage idiom as chatStorage.ts/aiagent_saved_chats — otherwise the
  // provider choice silently reverted to Auto (Gemini-first) on every new
  // agent, with no visible indicator on the main screen that it had reset.
  // Defaults to local-only (Ollama) rather than the cloud-first Auto cascade —
  // this app's Gemini usage was costing real money, so a fresh browser with no
  // saved preference should not silently default to the paid provider. An
  // explicit choice on the Settings screen still overrides this via localStorage.
  const [provider, setProvider] = useState<LlmProvider>(
    () => (localStorage.getItem('aiagent_provider') as LlmProvider) || 'ollama'
  )
  const [ollamaModel, setOllamaModel] = useState<string | null>(
    () => storedOllamaModel()
  )
  function handleProviderChange(p: LlmProvider) {
    setProvider(p)
    if (p) localStorage.setItem('aiagent_provider', p)
    else localStorage.removeItem('aiagent_provider')
  }
  function handleOllamaModelChange(m: string | null) {
    setOllamaModel(m)
    if (m) localStorage.setItem('aiagent_ollama_model', m)
    else localStorage.removeItem('aiagent_ollama_model')
  }
  // Workers AI model, kept apart from the local one so switching providers
  // doesn't send an Ollama name to Cloudflare or the reverse.
  const [cloudflareModel, setCloudflareModel] = useState<string>(() => storedCloudflareModel())
  function handleCloudflareModelChange(m: string) {
    setCloudflareModel(m)
    localStorage.setItem('aiagent_cloudflare_model', m)
  }
  // The API's single model slot (`ollama_model`) for the current provider.
  const activeModel = provider === 'cloudflare' ? cloudflareModel : ollamaModel
  // Same "standing preference across agents, not per-purpose content"
  // treatment as provider/ollamaModel above — these are platform-tuning
  // knobs (Settings screen), not something the bootstrap call should invent.
  const [maxDelegations, setMaxDelegations] = useState<number | null>(() => {
    const raw = localStorage.getItem('aiagent_max_delegations')
    return raw ? Number(raw) : null
  })
  function handleMaxDelegationsChange(n: number | null) {
    setMaxDelegations(n)
    if (n) localStorage.setItem('aiagent_max_delegations', String(n))
    else localStorage.removeItem('aiagent_max_delegations')
  }
  const [searchDefaults, setSearchDefaults] = useState<SearchDefaults>(() => {
    const raw = localStorage.getItem('aiagent_search_defaults')
    if (!raw) return {}
    try { return JSON.parse(raw) as SearchDefaults } catch { return {} }
  })
  function handleSearchDefaultsChange(d: SearchDefaults) {
    setSearchDefaults(d)
    if (Object.keys(d).length > 0) localStorage.setItem('aiagent_search_defaults', JSON.stringify(d))
    else localStorage.removeItem('aiagent_search_defaults')
  }
  // Cross-app date-format preference (dateFormat.ts) — same localStorage
  // idiom as the settings above; other screens/modules that render a date
  // (Chat.tsx, ToolActivity.tsx, chatPdf.ts) read the same key directly via
  // getDateFormat() instead, since they don't share this component's state.
  const [dateFormat, setDateFormatState] = useState<DateFormatId>(() => getDateFormat())
  function handleDateFormatChange(f: DateFormatId) {
    setDateFormatState(f)
    localStorage.setItem('aiagent_date_format', f)
  }
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [cloudflareModels, setCloudflareModels] = useState<string[]>([])
  const [modelsLoaded, setModelsLoaded] = useState(false)
  const [recommendedArm, setRecommendedArm] = useState<{ provider: string; model: string } | null>(null)
  const [armStats, setArmStats] = useState<ArmStat[]>([])
  const [saved, setSaved] = useState<SavedSearch[]>([])
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)
  // Shown next to the Commission Agent button when it's pressed with no
  // specialties (and therefore no brief) yet — cleared as soon as the user
  // adds one, so it never lingers stale.
  const [commissionHint, setCommissionHint] = useState<string | null>(null)
  useEffect(() => {
    if (keywords.length > 0) setCommissionHint(null)
  }, [keywords.length])
  // Optional image attached alongside Focus — sent as a real image part on
  // the bootstrap call (server.py/bootstrap.py), the same base64 data URL
  // shape and FileReader flow as Chat.tsx's composer attachment, so the
  // model can let what it depicts inform the agent the same way a keyword
  // does, not just acknowledge it.
  const [purposeImage, setPurposeImage] = useState<string | null>(null)
  const [attachingPurposeImage, setAttachingPurposeImage] = useState(false)
  const purposeImageInputRef = useRef<HTMLInputElement>(null)
  function handlePurposeImageAttachClick() {
    purposeImageInputRef.current?.click()
  }
  function handlePurposeImageFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAttachingPurposeImage(true)
    const reader = new FileReader()
    reader.onload = () => {
      setPurposeImage(typeof reader.result === 'string' ? reader.result : null)
      setAttachingPurposeImage(false)
    }
    reader.onerror = () => setAttachingPurposeImage(false)
    reader.readAsDataURL(file)
  }
  function clearPurposeImage() {
    setPurposeImage(null)
  }
  // Saved searches live server-side now (see backend/src/saved_searches.py) —
  // fetch once on mount rather than reading localStorage synchronously.
  useEffect(() => {
    listSavedSearches().then(setSaved)
  }, [])
  // Published agents — the MCP server's tool catalog (backend/mcp_server.py
  // reads backend/src/agent_registry.py). Shown here, not scoped by agent
  // type, so the user can see/manage everything currently externally
  // callable in one place.
  const [publishedAgents, setPublishedAgents] = useState<PublishedAgent[]>([])
  useEffect(() => {
    listPublishedAgents().then(setPublishedAgents)
  }, [])
  function removePublishedAgent(id: string) {
    setPublishedAgents(prev => prev.filter(a => a.id !== id))
    unpublishAgent(id).catch(() => {})
  }
  // Saved agent profiles — the pre-bootstrap draft (name/type/location/
  // specialties + character traits) captured by "Save Agent" below. Distinct
  // from a saved search (keywords only) and a saved chat (a fully
  // bootstrapped agent with real conversation history) — see
  // backend/src/agent_drafts.py.
  const [drafts, setDrafts] = useState<AgentDraft[]>([])
  // Which saved profile or job the form was loaded from, so Save edits that
  // entry in place instead of adding a new one next to it (otherwise a
  // removed Focus survives in the original and comes back on reload).
  // Cleared by CLEAR / the logo / a generated character: a fresh agent.
  const [editing, setEditing] = useState<{ kind: 'draft' | 'chat'; id: string } | null>(null)
  const toolbarLayout = useToolbarLayout('setup', SETUP_TOOLBAR_ITEMS)
  const toolbarDrag = useToolbarDrag(toolbarLayout)
  useEffect(() => {
    listAgentDrafts().then(setDrafts)
  }, [])
  // Saved chats — full bootstrapped conversations, client-side only (see
  // chatStorage.ts). Read once on mount like the other saved-* lists above;
  // resuming one skips bootstrap entirely (App.tsx's onResumeChat).
  const [savedChats, setSavedChats] = useState<SavedChat[]>(() => loadSavedChats())
  const chatFileInputRef = useRef<HTMLInputElement>(null)
  // Tucks a chat out of the dossier list without touching its underlying
  // localStorage entry — distinct from an actual delete.
  const [hiddenChatIds, setHiddenChatIds] = useState<string[]>(() => loadHiddenChatIds())
  const visibleChats = savedChats.filter(c => !hiddenChatIds.includes(c.id))
  // Only show saved searches that match the currently selected agent type —
  // a "Job search agent" list of keywords isn't a useful preset when you're
  // building a "Research agent". Pre-existing saves have no agentType and
  // are treated as 'research'.
  const visibleDrafts = drafts.filter(d => (d.agentType ?? 'research') === agentType)
  // Flattened, deduped, alphabetical pool of every keyword across every
  // saved search, shared by all three agent types — each one is its own
  // tap-to-add button rather than grouped by the entry it was originally
  // saved under or scoped to whichever type it was saved from.
  const savedKeywordPool = Array.from(
    new Set(saved.flatMap(s => s.keywords))
  ).sort((a, b) => a.localeCompare(b))
  // Smart Focus: overlapping chosen topics and related Saved Focus items
  // (POST /brief-focus), re-checked while the Focus step is open.
  const [focusInsights, setFocusInsights] = useState<FocusInsights | null>(null)
  const focusPoolKey = savedKeywordPool.join('\n')
  const hasUnsavedSpecialties = keywords.some(
    kw => !savedKeywordPool.some(pooled => pooled.toLowerCase() === kw.toLowerCase())
  )
  const [openSavedSections, setOpenSavedSections] = useState<Record<SavedSectionId, boolean>>({
    searches: true,
    drafts: false,
    chats: false,
    mcp: false,
  })
  const [progress, setProgress] = useState<string | null>(null)
  const [modelInfo, setModelInfo] = useState<ModelInfo | null>(null)
  // The bootstrap's stages for the process graph. Kept after a failed or
  // cancelled run, so the graph on the steps shows where it stopped.
  const [deployRun, setDeployRun] = useState<DeployRun | null>(null)
  const [processGraphOpen, setProcessGraphOpen] = useState(true)
  const [savedFocusOpen, setSavedFocusOpen] = useState(true)
  // Ticks once a second for the deploying overlay's "Ns elapsed" line — same
  // reset-on-stop/interval-while-active shape as Chat.tsx's own `elapsed`
  // (its `thinking` there is `bootstrapping` here).
  const [bootstrapElapsed, setBootstrapElapsed] = useState(0)
  const [locationSuggestions, setLocationSuggestions] = useState<string[]>([])
  const [showLocationSuggestions, setShowLocationSuggestions] = useState(false)
  const [locationDetecting, setLocationDetecting] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [themePickerOpen, setThemePickerOpen] = useState(false)
  const [stableModalOpen, setStableModalOpen] = useState(false)
  const [poolOpen, setPoolOpen] = useState(false)
  useEffect(() => {
    if (!poolOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPoolOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [poolOpen])
  const [scoreboardOpen, setScoreboardOpen] = useState(false)
  const [locationMapOpen, setLocationMapOpen] = useState(false)
  const [characterGenOpen, setCharacterGenOpen] = useState(false)
  // The Agent Dossier slides in from the right, opened by the manila tab at
  // the end of the numbered steps row. The setup card grows to its full
  // height and the page scrolls, so the two no longer share the screen.
  const [dossierOpen, setDossierOpen] = useState(false)
  useEffect(() => {
    if (!dossierOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDossierOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dossierOpen])
  const [specialtiesOpen, setSpecialtiesOpen] = useState(true)
  const [setupStep, setSetupStep] = useState<SetupStepId>('character')
  // The prose brief under the brief graph; the graph is the at-a-glance view.
  const [writtenBriefOpen, setWrittenBriefOpen] = useState(false)
  const [briefGraphOpen, setBriefGraphOpen] = useState(true)
  // Open by default: they're all there is on the Character step.
  const [specialInstructionsOpen, setSpecialInstructionsOpen] = useState(true)
  const [activeToggles, setActiveToggles] = useState<string[]>([])
  function toggleBehavior(id: string) {
    setActiveToggles(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
  }
  const [typeOpen, setTypeOpen] = useState(true)
  const [personalityOpen, setPersonalityOpen] = useState(true)
  const [selectedTraits, setSelectedTraits] = useState<string[]>([])
  function toggleTrait(id: string) {
    setSelectedTraits(prev => prev.includes(id) ? prev.filter(t => t !== id) : [...prev, id])
  }
  const [aiBrief, setAiBrief] = useState<AgentBrief | null>(null)
  // When the brief asks the user a question, open the Brief step so they see
  // it. Once per question: they can still move to another step meanwhile.
  const briefQuestion = aiBrief?.type === 'question' ? aiBrief.text : null
  useEffect(() => {
    if (briefQuestion) setSetupStep('brief')
  }, [briefQuestion])
  const [briefLoading, setBriefLoading] = useState(false)
  // The brief's graph, drawn in the brief's last stage alongside its third
  // paragraph. Null while drawing or when drawing failed.
  const [briefMap, setBriefMap] = useState<BriefMap | null>(null)
  const [briefMapLoading, setBriefMapLoading] = useState(false)
  // The streamed brief's stages and the paragraphs written so far, shown
  // while it drafts (brief.py's generate_brief_stream). Null when idle.
  const [briefProgress, setBriefProgress] = useState<BriefProgress | null>(null)
  // Why the AI brief failed (e.g. a 429), shown under the template fallback
  // so a quiet downgrade to the two-line brief is visible.
  const [briefError, setBriefError] = useState<string | null>(null)
  // Bumped by the brief's Retry button to re-run the same request.
  const [briefRetry, setBriefRetry] = useState(0)
  const [briefAnswer, setBriefAnswer] = useState('')
  // Media the Brief offered (aiBrief.relics) that the user has built. Tied
  // to the brief they came from, so a redrafted brief starts empty.
  const [briefRelics, setBriefRelics] = useState<Relic[]>([])
  const [briefRelicBusy, setBriefRelicBusy] = useState<RelicKind | null>(null)
  const [briefRelicError, setBriefRelicError] = useState<string | null>(null)
  const [briefRelicPreview, setBriefRelicPreview] = useState<RelicKind | null>(null)
  // Outputs step: what the agent proposes to hand back (POST /brief-outputs),
  // and the kinds the user has ticked. Proposed once per brief, when the
  // step is opened; null proposals after a failed call means the step falls
  // back to every relic kind, picked by hand.
  const [outputProposals, setOutputProposals] = useState<Deliverable[] | null>(null)
  const [outputsLoading, setOutputsLoading] = useState(false)
  const [outputsFailed, setOutputsFailed] = useState(false)
  // True from the moment a brief rebuild is scheduled until its request goes
  // out (the debounce window), so the outputs wait for the new brief.
  const [briefScheduled, setBriefScheduled] = useState(false)
  const [chosenOutputs, setChosenOutputs] = useState<RelicKind[]>([])
  // Outputs from a reloaded profile or job. They stand in as the choice
  // until the Outputs step proposes again, then become its ticks.
  const [restoredOutputs, setRestoredOutputs] = useState<{ kind: RelicKind; title: string }[] | null>(null)
  const outputsKeyRef = useRef('')
  const outputsRequestIdRef = useRef(0)
  const [answeringBrief, setAnsweringBrief] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const locationDebounceRef = useRef<number | undefined>(undefined)
  const locationAbortRef = useRef<AbortController | null>(null)
  // Lets the "Stop" button cancel an in-progress /bootstrap call — same
  // AbortController-in-a-ref pattern as Chat.tsx's stopAgent/abortRef.
  const bootstrapAbortRef = useRef<AbortController | null>(null)
  const briefDebounceRef = useRef<number | undefined>(undefined)
  const briefRequestIdRef = useRef(0)
  // The agent-creator inputs the last brief was built from. The brief is
  // only rebuilt when these actually change, not on every re-render that
  // hands the effect a new (but equal) array.
  const lastBriefInputsRef = useRef('')

  useEffect(() => {
    if (modelsLoaded) return
    fetchModelInfo().then(({ models, cloudflareModels, recommended, armStats }) => {
      setAvailableModels(models)
      setCloudflareModels(cloudflareModels)
      setModelsLoaded(true)
      setRecommendedArm(recommended)
      setArmStats(armStats)
      if (provider === 'ollama' && models.length > 0) {
        setOllamaModel(prev => (prev && models.includes(prev)) ? prev : models[0])
      }
      if (cloudflareModels.length > 0) {
        setCloudflareModel(prev => cloudflareModels.includes(prev) ? prev : cloudflareModels[0])
      }
      // No Ollama on this server (the live site, or local dev with
      // DISABLE_OLLAMA=1) and no choice other than Ollama saved: use Workers
      // AI, which is free up to its daily allowance and actually reachable,
      // instead of a local model that isn't there.
      let saved: string | null = null
      try { saved = localStorage.getItem('aiagent_provider') } catch { /* private mode */ }
      // Not saved: a server that has Ollama again (local dev) must get the
      // saved/default choice back on the next load, not a pinned Workers AI.
      if ((!saved || saved === 'ollama') && models.length === 0 && cloudflareModels.length > 0) {
        setProvider('cloudflare')
      }
      // One-time undo of the earlier version, which saved that automatic
      // switch: a browser left pinned to Workers AI on a machine with Ollama
      // goes back to local.
      try {
        if (!localStorage.getItem('aiagent_cf_autoswitch_undo')) {
          localStorage.setItem('aiagent_cf_autoswitch_undo', '1')
          if (saved === 'cloudflare' && models.length > 0) handleProviderChange('ollama')
        }
      } catch { /* private mode */ }
    })
  }, [provider, modelsLoaded])

  useEffect(() => {
    return () => {
      window.clearTimeout(locationDebounceRef.current)
      locationAbortRef.current?.abort()
    }
  }, [])

  // Free, keyless geocoding via OpenStreetMap Nominatim — matches this
  // workspace's "no API key for this" pattern (e.g. ChattyPrayers.Api's
  // Open-Meteo weather context). Debounced to respect Nominatim's ~1 req/sec
  // usage policy; only fires past 3 characters.
  async function fetchLocationSuggestions(query: string) {
    locationAbortRef.current?.abort()
    const controller = new AbortController()
    locationAbortRef.current = controller
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=5&q=${encodeURIComponent(query)}`,
        { signal: controller.signal },
      )
      if (!res.ok) return
      const data = await res.json()
      const names: string[] = Array.isArray(data)
        ? data.map((d: { display_name?: string }) => d.display_name).filter((n): n is string => Boolean(n))
        : []
      setLocationSuggestions(names)
      setShowLocationSuggestions(true)
    } catch {
      // Aborted (superseded by a newer keystroke) or offline — free-text
      // location still works fine without a suggestion.
    }
  }

  useEffect(() => {
    setBriefRelics([])
    setBriefRelicError(null)
    setBriefRelicPreview(null)
  }, [aiBrief])

  // Every output the user hasn't hidden, in their toolbar order — a fixed
  // set, so the toolbar doesn't reshuffle each time the Brief is rewritten.
  // The Brief's own picks (aiBrief.relics) carry its reason and are marked.
  const briefReady = aiBrief?.type === 'brief'
  // Narrow screens only: the outputs collapse into one Tools button, and
  // this is its overlay list (tap an output to run it and close the list).
  const [toolsOpen, setToolsOpen] = useState(false)
  useEffect(() => {
    if (!toolsOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setToolsOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toolsOpen])
  const outputsDisabled = !briefReady || briefRelicBusy !== null || bootstrapping
  const briefOutputs = (toolbarLayout.visible('outputs') as RelicKind[]).map(kind => {
    const offered = aiBrief?.relics?.find(s => s.kind === kind)
    return { kind, reason: offered?.reason ?? '', suggested: !!offered }
  })

  // Builds one of the Brief's offered media from the case and the agent on
  // board (relic.py's case mode), then opens its preview. An already-built
  // one just reopens unless `regenerate`.
  async function handleBriefRelic(suggestion: RelicSuggestion, regenerate = false) {
    if (!aiBrief || aiBrief.type !== 'brief') return
    if (!regenerate && briefRelics.some(r => r.kind === suggestion.kind)) {
      setBriefRelicPreview(suggestion.kind)
      return
    }
    if (briefRelicBusy) return
    setBriefRelicBusy(suggestion.kind)
    setBriefRelicError(null)
    try {
      const content = await buildBriefRelic(suggestion, aiBrief.text, {
        agentType,
        keywords: [...keywords],
        location: usedLocation,
        traits: (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research).filter(t => selectedTraits.includes(t.id)).map(t => t.label),
        behaviors: BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.label),
        warning: aiBrief.warning,
      }, agentName, provider, activeModel)
      const relic: Relic = { kind: suggestion.kind, content, createdAt: new Date().toISOString() }
      setBriefRelics(prev => [...prev.filter(r => r.kind !== suggestion.kind), relic])
      setBriefRelicPreview(suggestion.kind)
    } catch (err) {
      setBriefRelicError(err instanceof Error ? err.message : 'Could not build that file')
    } finally {
      setBriefRelicBusy(null)
    }
  }

  // AI-drafted Brief (backend/src/brief.py) — debounced so it doesn't fire on
  // every keystroke while adding specialties. Falls back to the deterministic
  // buildAgentBrief() template (aiBrief stays null) on any failure, so a
  // network hiccup never leaves the Brief section blank. A stale response
  // from a superseded request is dropped via briefRequestIdRef.
  // Streams the brief in stages (a read of the case and paragraphs 1-2 at
  // once, then paragraph 3 with the graph), updating briefProgress as each
  // lands. Events from a superseded request (briefRequestIdRef) are dropped.
  function streamBrief(requestId: number, priorQuestion?: string, priorAnswer?: string) {
    const behaviorLabels = BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.label)
    const traitLabels = (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research)
      .filter(t => selectedTraits.includes(t.id)).map(t => t.label)
    setBriefMap(null)
    setBriefMapLoading(false)
    setBriefProgress(EMPTY_BRIEF_PROGRESS)
    const onEvent = (event: BriefStreamEvent) => {
      if (requestId !== briefRequestIdRef.current) return
      if (event.type === 'stage') {
        setBriefProgress(p => p && { ...p, stages: { ...p.stages, [event.stage]: event.state } })
        if (event.stage === 'plan') setBriefMapLoading(event.state === 'active')
      } else if (event.type === 'part') {
        setBriefProgress(p => p && { ...p, parts: { ...p.parts, [event.part]: event.text } })
      } else if (event.type === 'fallback') {
        // The one-call brief replaces the parts; drop them.
        setBriefProgress(p => p && { ...p, parts: {}, fallback: true })
      }
    }
    return streamAgentBrief(agentType, [...keywords], usedLocation, agentName, provider, activeModel,
      priorQuestion, priorAnswer, maxDelegations, behaviorLabels, traitLabels, onEvent)
      .then(({ brief, map }) => {
        if (requestId !== briefRequestIdRef.current) return null
        setAiBrief(brief)
        setBriefMap(map)
        return brief
      })
      .finally(() => {
        if (requestId !== briefRequestIdRef.current) return
        setBriefMapLoading(false)
        setBriefProgress(null)
      })
  }

  const briefInputsKey = JSON.stringify([
    agentType, keywords, usedLocation, agentName, maxDelegations,
    [...activeToggles].sort(), [...selectedTraits].sort(),
  ])

  useEffect(() => {
    if (keywords.length === 0) {
      lastBriefInputsRef.current = ''
      setBriefScheduled(false)
      setAiBrief(null)
      setBriefMap(null)
      setBriefMapLoading(false)
      setBriefLoading(false)
      setBriefProgress(null)
      return
    }
    window.clearTimeout(briefDebounceRef.current)
    if (briefInputsKey === lastBriefInputsRef.current) {
      setBriefScheduled(false)
      return
    }
    const requestId = ++briefRequestIdRef.current
    // A new brief is on its way: the outputs proposed for the old one no
    // longer apply. Clear them (dropping any proposal still in flight) and
    // let the Outputs step propose again once the new brief lands.
    setBriefScheduled(true)
    outputsRequestIdRef.current++
    outputsKeyRef.current = ''
    setOutputProposals(null)
    setOutputsFailed(false)
    setOutputsLoading(false)
    setChosenOutputs([])
    briefDebounceRef.current = window.setTimeout(() => {
      // Recorded when the request actually goes out, so a change undone
      // inside the debounce window doesn't count as built.
      lastBriefInputsRef.current = briefInputsKey
      setBriefScheduled(false)
      setBriefLoading(true)
      streamBrief(requestId)
        .then(result => {
          if (result) setBriefError(null)
        })
        .catch(err => {
          if (requestId !== briefRequestIdRef.current) return
          setAiBrief(null)
          setBriefMap(null)
          setBriefMapLoading(false)
          setBriefError(err instanceof Error ? err.message : 'Could not draft the brief')
        })
        .finally(() => {
          if (requestId !== briefRequestIdRef.current) return
          setBriefLoading(false)
        })
    }, 700)
    return () => window.clearTimeout(briefDebounceRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [briefInputsKey, briefRetry])

  // Proposes outputs when the Outputs step is open and the brief has
  // settled; a changed brief (or focus/character) proposes again and resets
  // the ticks to the agent's new picks.
  useEffect(() => {
    if (setupStep !== 'outputs' || keywords.length === 0 || briefLoading || briefScheduled) return
    const key = briefInputsKey + '|' + (aiBrief?.text ?? '')
    if (key === outputsKeyRef.current) return
    outputsKeyRef.current = key
    const requestId = ++outputsRequestIdRef.current
    const behaviorLabels = BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.label)
    const traitLabels = (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research)
      .filter(t => selectedTraits.includes(t.id)).map(t => t.label)
    setOutputsLoading(true)
    setOutputsFailed(false)
    fetchBriefOutputs([...keywords], aiBrief?.type === 'brief' ? aiBrief.text : '', agentType, traitLabels, behaviorLabels, provider, activeModel)
      .then(outputs => {
        if (requestId !== outputsRequestIdRef.current) return
        if (restoredOutputs) {
          // A reloaded agent keeps its own picks, even ones the agent
          // didn't propose this time.
          const missing = outputs ? restoredOutputs.filter(r => !outputs.some(o => o.kind === r.kind)) : []
          setOutputProposals(outputs ? [...outputs, ...missing] : null)
          setChosenOutputs(restoredOutputs.map(r => r.kind))
          setRestoredOutputs(null)
        } else {
          setOutputProposals(outputs)
          setChosenOutputs(outputs ? outputs.filter(o => o.recommended).map(o => o.kind) : [])
        }
        setOutputsFailed(outputs === null)
        setOutputsLoading(false)
      })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupStep, briefInputsKey, aiBrief?.text, briefLoading, briefScheduled])

  // The outputs shown on the step: the agent's proposals, or every kind
  // when proposing failed.
  const outputOptions: Deliverable[] = outputProposals
    ?? (outputsFailed ? RELIC_KINDS.map(kind => ({ kind, title: RELIC_LABELS[kind] })) : [])
  const chosenDeliverables = restoredOutputs
    ?? outputOptions
      .filter(o => chosenOutputs.includes(o.kind))
      .map(({ kind, title }) => ({ kind, title }))

  // The loaded profile's or job's built agent, when the steps still match
  // what it was built from: Deploy then opens it straight away instead of
  // building it again. Change any step and it's null, so Deploy rebuilds.
  const currentTraitIds = (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research)
    .filter(t => selectedTraits.includes(t.id)).map(t => t.id)
  const currentBuildKey = buildKey({
    template: agentType,
    keywords,
    location: usedLocation,
    factorLocation,
    toggles: activeToggles,
    traits: currentTraitIds,
    outputs: chosenDeliverables.map(d => d.kind),
  })
  const loadedBuild: AgentConfig | undefined = editing?.kind === 'draft'
    ? drafts.find(d => d.id === editing.id)?.builtConfig
    : editing?.kind === 'chat'
      ? savedChats.find(c => c.id === editing.id)?.agentConfig
      : undefined
  const reusableConfig = loadedBuild && configBuildKey(loadedBuild) === currentBuildKey ? loadedBuild : null

  function toggleOutput(kind: RelicKind) {
    setChosenOutputs(prev => prev.includes(kind) ? prev.filter(k => k !== kind) : [...prev, kind])
  }

  // Debounced like the brief; embeddings are memoised server-side, so a
  // re-check after one add or remove only embeds the new topic.
  useEffect(() => {
    if (setupStep !== 'focus' || keywords.length === 0) {
      setFocusInsights(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      fetchFocusInsights([...keywords], savedKeywordPool, provider, controller.signal)
        .then(result => { if (!controller.signal.aborted) setFocusInsights(result) })
    }, 500)
    return () => { window.clearTimeout(timer); controller.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setupStep, keywords.join('\n'), focusPoolKey, provider])

  // Only insights that still match the current topics (a stale reply can
  // land just after a remove).
  const focusOverlaps = (focusInsights?.overlaps ?? []).filter(o =>
    keywords.includes(o.a) && keywords.includes(o.b))
  const focusRelated = (focusInsights?.related ?? []).filter(r =>
    keywords.includes(r.near) && !keywords.some(k => k.toLowerCase() === r.topic.toLowerCase()))

  // The process graph: the Setup steps as the agent has taken them so far,
  // then the deploy (bootstrap) stages.
  const commissionColumns: ColumnNode<ProcessNodeData>[][] = (() => {
    const traitLabels = (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research)
      .filter(t => selectedTraits.includes(t.id)).map(t => t.label)
    const behaviorLabels = BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.label)
    const character = [...traitLabels, ...behaviorLabels]
    const briefNode: ProcessNodeData = keywords.length === 0
      ? { icon: '📝', title: 'Brief', state: 'pending', detail: 'Drafted once there is Focus' }
      : briefLoading
        ? { icon: '📝', title: 'Brief', state: 'active', detail: briefProgress
            ? briefProgress.fallback
              ? 'Writing the brief in one go…'
              : `Drafting the brief: ${shownBriefStages(briefProgress).filter(s => briefProgress.stages[s.id] === 'done').length} of ${shownBriefStages(briefProgress).length} parts done`
            : 'Drafting the brief…' }
        : aiBrief?.type === 'question'
          ? { icon: '📝', title: 'Brief', state: 'active', asking: true, detail: `Asking you: ${aiBrief.text}` }
          : aiBrief
            ? { icon: '📝', title: 'Brief', state: 'done', detail: aiBrief.text.length > 160 ? `${aiBrief.text.slice(0, 157)}…` : aiBrief.text }
            : briefError
              ? { icon: '📝', title: 'Brief', state: 'error', detail: 'AI brief failed; using the basic brief' }
              : { icon: '📝', title: 'Brief', state: 'pending' }
    const outputsNode: ProcessNodeData = outputsLoading
      ? { icon: '📦', title: 'Outputs', state: 'active', detail: 'Proposing outputs for this job…' }
      : outputProposals || outputsFailed
        ? chosenDeliverables.length > 0
          ? { icon: '📦', title: 'Outputs', state: 'done', items: chosenDeliverables.map(d => d.title) }
          : { icon: '📦', title: 'Outputs', state: 'skipped', detail: 'None chosen' }
        : briefScheduled || briefLoading
          ? { icon: '📦', title: 'Outputs', state: 'pending', detail: 'Waiting for the new brief' }
          : { icon: '📦', title: 'Outputs', state: 'pending', detail: 'Proposed on the Outputs step' }
    const columns: ColumnNode<ProcessNodeData>[][] = [
      [{ id: 'character', data: { icon: '🎭', title: 'Character', state: 'done',
        items: [getTemplate(agentType).label, ...character],
        detail: character.length > 0 ? undefined : 'No traits or behaviour chosen' } }],
      [{ id: 'focus', data: keywords.length > 0
        ? { icon: '🎯', title: 'Focus', state: 'done', items: keywords.map(k => shortFocus(k).toUpperCase()),
            detail: focusOverlaps.length > 0 ? `${focusOverlaps.length} overlapping pair${focusOverlaps.length === 1 ? '' : 's'}` : undefined }
        : { icon: '🎯', title: 'Focus', state: setupStep === 'focus' ? 'active' : 'pending', detail: 'Add at least one topic' } }],
      [{ id: 'brief', data: briefNode }],
      [{ id: 'outputs', data: outputsNode }],
    ]
    // Each one is a Setup step: clicking it opens that step.
    return columns.map(col => col.map(n => ({ ...n, data: { ...n.data, link: true, selected: n.id === setupStep } })))
  })()
  const processColumns: ColumnNode<ProcessNodeData>[][] = deployRun
    ? [...commissionColumns, ...deployColumns(deployRun)]
    : [...commissionColumns, [{ id: 'deploy', data: { icon: '🚀', title: 'Deploy', state: 'pending', detail: 'Builds the agent from these steps' } }]]
  // While deploying, the graph draws only the deploy stages, after one node
  // standing for the finished commission.
  const deployOnlyColumns: ColumnNode<ProcessNodeData>[][] = [
    [{ id: 'commission', data: { icon: '📨', title: 'Commission', state: 'done', items: keywords.map(k => shortFocus(k).toUpperCase()) } }],
    ...deployColumns(deployRun ?? EMPTY_DEPLOY_RUN),
  ]

  function handleBriefAnswerSubmit() {
    const answer = briefAnswer.trim()
    if (!answer || !aiBrief || aiBrief.type !== 'question' || answeringBrief) return
    setAnsweringBrief(true)
    const requestId = ++briefRequestIdRef.current
    streamBrief(requestId, aiBrief.text, answer)
      .then(result => {
        if (result) setBriefAnswer('')
      })
      .catch(() => {
        // Leave the question showing — the user can retry the answer.
      })
      .finally(() => {
        if (requestId !== briefRequestIdRef.current) return
        setAnsweringBrief(false)
      })
  }

  function handleLocationChange(value: string) {
    setLocation(value)
    window.clearTimeout(locationDebounceRef.current)
    const query = value.trim()
    if (query.length < 3) {
      setLocationSuggestions([])
      setShowLocationSuggestions(false)
      return
    }
    locationDebounceRef.current = window.setTimeout(() => fetchLocationSuggestions(query), 400)
  }

  function selectLocation(name: string) {
    setLocation(name)
    setLocationSuggestions([])
    setShowLocationSuggestions(false)
  }

  // Browser geolocation + the same Nominatim host, just its reverse-geocode
  // endpoint (coords -> place name) instead of the forward one above. `force`
  // distinguishes the auto-run-on-mount call (only replaces the untouched
  // 'Melbourne, Australia' default) from the Settings screen's "Detect my
  // location" button (always overwrites, since the user explicitly asked).
  function detectLocation(force: boolean) {
    if (!navigator.geolocation) return
    setLocationDetecting(true)
    navigator.geolocation.getCurrentPosition(
      async pos => {
        try {
          const { latitude, longitude } = pos.coords
          const res = await fetch(
            `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=0`,
          )
          if (res.ok) {
            const data = await res.json()
            const name: string | undefined = data?.display_name
            if (name) setLocation(prev => (force || prev === 'Melbourne, Australia' ? name : prev))
          }
        } catch {
          // Offline or Nominatim unreachable — keep whatever location is set.
        } finally {
          setLocationDetecting(false)
        }
      },
      () => setLocationDetecting(false),
      { timeout: 8000 },
    )
  }

  useEffect(() => {
    detectLocation(false)
    // Mount-only: auto-detect once, falling back to the 'Melbourne, Australia' default on denial/failure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addKeyword() {
    if (bootstrapping || keywords.length >= MAX_SPECIALTIES) return
    const kw = draft.trim()
    if (!kw || keywords.map(k => k.toLowerCase()).includes(kw.toLowerCase())) return
    const next = [...keywords, kw]
    setKeywords(next)
    setDraft('')
    inputRef.current?.focus()
  }

  // Tapping the brand logo is "start a fresh search" everywhere in the app —
  // from Chat it fully remounts Setup (App.tsx's onReset), which already
  // wipes this in-progress state for free; from Setup itself the component
  // stays mounted (setup/bootstrapping share one instance so a failed
  // bootstrap doesn't lose the typed-in keywords — see the phase-conditional
  // render in App.tsx), so the current unsaved search has to be cleared here
  // explicitly instead of relying on a remount that isn't going to happen.
  function resetSearch() {
    if (bootstrapping) return
    setEditing(null)
    setKeywords([])
    setDraft('')
    setActiveToggles([])
    setSelectedTraits([])
    setAiBrief(null)
    setBriefAnswer('')
    setRestoredOutputs(null)
    setCommissionHint(null)
    setDossierOpen(false)
    inputRef.current?.focus()
  }

  function addSavedKeyword(kw: string) {
    if (bootstrapping) return
    setKeywords(prev => {
      if (prev.length >= MAX_SPECIALTIES || prev.some(k => k.toLowerCase() === kw.toLowerCase())) return prev
      return [...prev, kw]
    })
  }

  // Saved searches persist as whole keyword groups (no partial-update API),
  // so forgetting just one keyword means stripping it from every entry that
  // has it, deleting each of those, and — for any entry with keywords left
  // over — re-saving the remainder under a fresh entry, preserving its
  // original agentType.
  async function deleteSavedKeyword(kw: string) {
    const lower = kw.toLowerCase()
    const affected = saved.filter(s => s.keywords.some(k => k.toLowerCase() === lower))
    if (affected.length === 0) return
    setSaved(prev => prev
      .map(s => s.keywords.some(k => k.toLowerCase() === lower)
        ? { ...s, keywords: s.keywords.filter(k => k.toLowerCase() !== lower) }
        : s)
      .filter(s => s.keywords.length > 0))
    for (const entry of affected) {
      deleteSavedSearch(entry.id).catch(() => {})
      const remaining = entry.keywords.filter(k => k.toLowerCase() !== lower)
      if (remaining.length > 0) {
        try {
          const fresh = await createSavedSearch(remaining.join(', '), remaining, entry.agentType ?? 'research')
          setSaved(prev => [fresh, ...prev.filter(s => s.id !== entry.id)])
        } catch {
          // Best effort — the keyword is already gone from local state either way.
        }
      }
    }
  }

  // In-place rename of a saved focus tag — same "no partial-update API"
  // constraint as deleteSavedKeyword above, so it reuses that exact
  // strip-then-recreate dance per affected entry, just substituting the new
  // text instead of dropping it. Also renames the tag in the live current-
  // focus chips if it's active there, so an edited tag doesn't leave a
  // stale duplicate behind.
  const [editingSavedKeyword, setEditingSavedKeyword] = useState<string | null>(null)
  const [editSavedKeywordDraft, setEditSavedKeywordDraft] = useState('')

  async function renameSavedKeyword(oldKw: string, rawNewKw: string) {
    const newKw = rawNewKw.trim()
    setEditingSavedKeyword(null)
    setEditSavedKeywordDraft('')
    if (!newKw || newKw.toLowerCase() === oldKw.toLowerCase()) return
    if (savedKeywordPool.some(pooled => pooled.toLowerCase() === newKw.toLowerCase())) return
    const lower = oldKw.toLowerCase()
    const affected = saved.filter(s => s.keywords.some(k => k.toLowerCase() === lower))
    if (affected.length === 0) return
    setSaved(prev => prev.map(s => s.keywords.some(k => k.toLowerCase() === lower)
      ? { ...s, keywords: s.keywords.map(k => k.toLowerCase() === lower ? newKw : k) }
      : s))
    for (const entry of affected) {
      deleteSavedSearch(entry.id).catch(() => {})
      const renamed = entry.keywords.map(k => k.toLowerCase() === lower ? newKw : k)
      try {
        const fresh = await createSavedSearch(renamed.join(', '), renamed, entry.agentType ?? 'research')
        setSaved(prev => [fresh, ...prev.filter(s => s.id !== entry.id)])
      } catch {
        // Best effort — same as deleteSavedKeyword, local state already reflects the rename.
      }
    }
    setKeywords(prev => prev.map(k => k.toLowerCase() === lower ? newKw : k))
  }

  function removeKeyword(kw: string) {
    if (bootstrapping) return
    setKeywords(prev => prev.filter(k => k.toLowerCase() !== kw.toLowerCase()))
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') { e.preventDefault(); addKeyword() }
    if (e.key === 'Backspace' && !draft && keywords.length > 0) {
      setKeywords(prev => prev.slice(0, -1))
    }
  }

  // Only the specialties not already in the saved pool get saved — re-saving
  // a mix of old + new keywords used to bundle all of them into one fresh
  // SavedSearch entry every time, cluttering the saved list with duplicates
  // of specialties that were already saved. Saving nothing but the new ones
  // keeps each entry a genuinely new addition.
  async function saveSearch() {
    const newKeywords = keywords.filter(
      kw => !savedKeywordPool.some(pooled => pooled.toLowerCase() === kw.toLowerCase())
    )
    if (newKeywords.length === 0) return
    const name = newKeywords.join(', ')
    try {
      const entry = await createSavedSearch(name, newKeywords, agentType)
      // Same keywords saved under a different agent type is a distinct entry;
      // only collapse an exact (keywords, type) repeat — the backend does the
      // same collapse, this just keeps local state in sync with it.
      setSaved(prev => [entry, ...prev.filter(s => !(s.name === entry.name && s.agentType === entry.agentType))])
      setOpenSavedSections(prev => ({ ...prev, searches: true }))
      setSaveFeedback('Added to Saved Focus ✓')
    } catch {
      setSaveFeedback('Save failed — backend unreachable')
    }
    setTimeout(() => setSaveFeedback(null), 2500)
  }

  // Lets a brand-new specialty be added straight into the saved pool from
  // the dossier itself, without first adding it to the live keyword chips
  // above and clicking Save Specialties — e.g. stocking the pool with
  // presets before starting a profile at all.
  const [addingSavedKeyword, setAddingSavedKeyword] = useState(false)
  const [newSavedKeywordDraft, setNewSavedKeywordDraft] = useState('')
  const newSavedKeywordRef = useRef<HTMLInputElement>(null)

  async function addNewSavedKeyword() {
    const kw = newSavedKeywordDraft.trim()
    setNewSavedKeywordDraft('')
    setAddingSavedKeyword(false)
    if (!kw || savedKeywordPool.some(pooled => pooled.toLowerCase() === kw.toLowerCase())) return
    try {
      const entry = await createSavedSearch(kw, [kw], agentType)
      setSaved(prev => [entry, ...prev.filter(s => !(s.name === entry.name && s.agentType === entry.agentType))])
    } catch {
      // Best effort — a failed dossier add just means the pool doesn't
      // grow this time, nothing else in the form is affected.
    }
  }

  // Saves the whole draft — name, type, location, specialties, plus whichever
  // personality traits the user actually selected — as a reusable agent
  // profile, distinct from saveSearch() above (keywords only). Nothing is
  // bootstrapped here; this only becomes a real running agent once
  // Commission is clicked.
  async function saveAgentDraft() {
    if (keywords.length === 0) {
      setSaveFeedback('Add at least one focus area first')
      setTimeout(() => setSaveFeedback(null), 2500)
      return
    }
    if (editing?.kind === 'chat' && saveChatEdits(editing.id)) return
    const traitPool = PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research
    const traits = traitPool.filter(t => selectedTraits.includes(t.id)).map(t => t.label)
    // Keep the built agent only while it still matches these steps.
    const extras = { factorLocation, outputs: chosenDeliverables.map(d => d.kind), builtConfig: reusableConfig }
    try {
      let updated: AgentDraft | null = null
      if (editing?.kind === 'draft') {
        // A profile deleted elsewhere 404s here; fall through and create it.
        updated = await updateAgentDraft(editing.id, agentName, agentType, [...keywords], location.trim(), traits, [...activeToggles], extras).catch(() => null)
      }
      const entry = updated ?? await createAgentDraft(agentName, agentType, [...keywords], location.trim(), traits, [...activeToggles], extras)
      setEditing({ kind: 'draft', id: entry.id })
      setDrafts(prev => [
        entry,
        ...prev.filter(d => d.id !== entry.id && !(
          d.agentName === entry.agentName &&
          d.agentType === entry.agentType &&
          d.location === entry.location &&
          JSON.stringify(d.keywords) === JSON.stringify(entry.keywords)
        )),
      ])
      setOpenSavedSections(prev => ({ ...prev, drafts: true }))
      setSaveFeedback(updated ? 'Saved changes to this agent profile ✓' : 'Saved to Saved Agent Profiles ✓')
    } catch {
      setSaveFeedback('Save failed — backend unreachable')
    }
    setTimeout(() => setSaveFeedback(null), 2500)
  }

  // Writes the form back into a saved job's agent config (localStorage,
  // chatStorage.ts), keeping its id and conversation. The bootstrapped
  // system prompt and tools are left as they were; Focus, location, type,
  // traits and behaviours are what the agent loop reads from the config.
  // False when the job no longer exists, so Save falls back to a profile.
  function saveChatEdits(id: string): boolean {
    const chat = loadSavedChats().find(c => c.id === id)
    if (!chat) return false
    const agentConfig: AgentConfig = {
      ...chat.agentConfig,
      template: agentType,
      keywords: [...keywords],
      location: usedLocation,
      factor_location: factorLocation,
      active_toggles: [...activeToggles],
      active_traits: [...selectedTraits],
      deliverables: chosenDeliverables.length > 0 ? chosenDeliverables : chat.agentConfig.deliverables,
    }
    setSavedChats(saveChat({ ...chat, agentName, agentConfig, savedAt: Date.now() }))
    setOpenSavedSections(prev => ({ ...prev, chats: true }))
    setSaveFeedback('Saved changes to this job ✓')
    setTimeout(() => setSaveFeedback(null), 2500)
    return true
  }

  function loadDraft(d: AgentDraft) {
    if (bootstrapping) return
    setEditing({ kind: 'draft', id: d.id })
    const type = d.agentType ?? 'research'
    setAgentType(type)
    setFactorLocation(d.factorLocation ?? type === 'job_search')
    setRestoredOutputs(d.outputs && d.outputs.length > 0
      ? d.outputs.map(kind => ({ kind, title: RELIC_LABELS[kind] ?? kind }))
      : null)
    setKeywords(d.keywords.slice(0, MAX_SPECIALTIES))
    setDraft('')
    if (d.location) setLocation(d.location)
    const toggles = [...(d.behaviorToggles ?? [])]
    setActiveToggles(toggles)
    const pool = PERSONALITY_TRAITS[type] ?? PERSONALITY_TRAITS.research
    const traitIds = pool.filter(t => (d.traits ?? []).includes(t.label)).map(t => t.id)
    setSelectedTraits(traitIds)
    // A reloaded agent with behaviors/traits already set should show them
    // open, not tucked behind a collapsed "(Optional)" section header the
    // user would need to know to expand.
    if (toggles.length > 0) setSpecialInstructionsOpen(true)
    if (traitIds.length > 0) setPersonalityOpen(true)
    onAgentNameChange(d.agentName)
    setDossierOpen(false)
    setPoolOpen(false)
    setSetupStep('focus')
    inputRef.current?.focus()
  }

  // Opens the agent already built from this profile, as resuming a job does
  // but with a fresh conversation: no brief, no bootstrap.
  function launchDraft(d: AgentDraft) {
    if (bootstrapping || !d.builtConfig) return
    setPoolOpen(false)
    onResumeChat({
      id: crypto.randomUUID(),
      agentName: d.agentName,
      agentConfig: d.builtConfig,
      messages: [],
      savedAt: Date.now(),
    })
  }

  // Keeps every freshly built agent in the pool, on the profile it was
  // loaded from or as a new one, so reloading it later skips the build.
  // Best effort: a failed save only means the next Deploy builds again.
  function rememberBuild(built: AgentConfig) {
    const traits = (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research)
      .filter(t => selectedTraits.includes(t.id)).map(t => t.label)
    const extras = { factorLocation, outputs: chosenDeliverables.map(d => d.kind), builtConfig: built }
    const create = () => createAgentDraft(agentName, agentType, [...keywords], location.trim(), traits, [...activeToggles], extras)
    const save = editing?.kind === 'draft'
      ? updateAgentDraft(editing.id, agentName, agentType, [...keywords], location.trim(), traits, [...activeToggles], extras).catch(create)
      : create()
    save
      .then(entry => setDrafts(prev => [entry, ...prev.filter(d => d.id !== entry.id)]))
      .catch(() => {})
  }

  function deleteDraft(id: string) {
    if (editing?.kind === 'draft' && editing.id === id) setEditing(null)
    setDrafts(prev => prev.filter(d => d.id !== id))
    deleteAgentDraft(id).catch(() => {})
  }

  function resumeChat(chat: SavedChat) {
    if (bootstrapping) return
    setLastOpenedPointer({ kind: 'savedChat', id: chat.id })
    onResumeChat(chat)
  }

  // "Hiring" a stabled agent drops straight into a fresh chat with that
  // agent's already-bootstrapped config, same mechanism as resuming a saved
  // chat (onResumeChat/handleResumeChat in App.tsx) — just with no prior
  // message history, since a published agent's own chat history isn't
  // stored server-side (see agent_registry.py's publish()).
  function hirePublishedAgent(agent: PublishedAgent) {
    if (bootstrapping) return
    setStableModalOpen(false)
    setLastOpenedPointer({ kind: 'publishedAgent', id: agent.id })
    onResumeChat({
      id: crypto.randomUUID(),
      agentName: agent.name,
      agentConfig: agent.agent_config,
      messages: [],
      savedAt: Date.now(),
    })
  }

  // Shared by loadChatDetails (tapping a Saved Chats card) and the
  // restore-on-mount effect below (returning to Setup from an active chat) —
  // both need to repopulate every field an agent's config actually carries,
  // not just name/keywords.
  function applyAgentConfigToForm(cfg: AgentConfig, name: string) {
    if (cfg.template) setAgentType(cfg.template)
    // The job's own choice if it recorded one, else the type's default:
    // older configs all carry a location, so "has a location" isn't a signal.
    setFactorLocation(cfg.factor_location ?? (cfg.template ?? 'general') === 'job_search')
    setKeywords((cfg.keywords ?? []).slice(0, MAX_SPECIALTIES))
    setDraft('')
    if (cfg.location) setLocation(cfg.location)
    setRestoredOutputs(cfg.deliverables && cfg.deliverables.length > 0
      ? cfg.deliverables.map(({ kind, title }) => ({ kind, title }))
      : null)
    const toggles = [...(cfg.active_toggles ?? [])]
    const traits = [...(cfg.active_traits ?? [])]
    setActiveToggles(toggles)
    setSelectedTraits(traits)
    // Same "don't hide populated sections behind a collapsed header" rule
    // as loadDraft() above.
    if (toggles.length > 0) setSpecialInstructionsOpen(true)
    if (traits.length > 0) setPersonalityOpen(true)
    onAgentNameChange(name)
  }

  // Tapping a Saved Chats card loads that agent's details (type, specialties,
  // location, name) back into the Setup form — same shape as loadDraft() for
  // Saved Agent Profiles — without jumping straight into the chat itself.
  // Actually resuming the conversation is the arrow button's job (resumeChat).
  function loadChatDetails(chat: SavedChat) {
    if (bootstrapping) return
    setEditing({ kind: 'chat', id: chat.id })
    applyAgentConfigToForm(chat.agentConfig, chat.agentName)
    setDossierOpen(false)
    setPoolOpen(false)
    setSetupStep('focus')
    inputRef.current?.focus()
  }

  // Returning to Setup from an active/just-finished chat (App.tsx's
  // onBackToSetup, "Back to search") should restore this form to match that
  // agent's real config — personality traits, behaviour toggles, specialties,
  // location, type — rather than resetting to blank defaults, since nothing
  // about the agent itself changed, only which screen is showing. Setup fully
  // remounts on every phase transition (App.tsx's phase-conditional render),
  // so this only ever needs to run once, on mount.
  useEffect(() => {
    if (!activeAgentConfig) return
    applyAgentConfigToForm(activeAgentConfig, agentName)
    // The open job, if it's been saved: Save then edits it rather than
    // leaving its old Focus to be restored on the next reload. Matched on
    // the system prompt too, since the pointer can still name an earlier
    // job while a just-bootstrapped one hasn't been saved yet.
    const pointer = getLastOpenedPointer()
    const chat = pointer?.kind === 'savedChat' ? savedChats.find(c => c.id === pointer.id) : undefined
    if (chat && chat.agentConfig.system_prompt === activeAgentConfig.system_prompt) {
      setEditing({ kind: 'chat', id: chat.id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function hideChat(id: string) {
    setHiddenChatIds(hideSavedChat(id))
  }

  // Counterpart to Chat.tsx's handleSaveChatFile download — reads a .json
  // file back in, upserts it into the same localStorage-backed saved-chats
  // list (so it survives a refresh and shows up in the dossier like any
  // other saved chat), then jumps straight into it via the existing
  // onResumeChat path, same as tapping a saved chat's own resume arrow.
  function handleLoadChatFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || bootstrapping) return
    file.text().then(text => {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.agentConfig || !Array.isArray(parsed.messages)) {
        throw new Error('Not a recognised chat file')
      }
      const chat = parsed as SavedChat
      setSavedChats(saveChat(chat))
      setHiddenChatIds(prev => prev.filter(id => id !== chat.id))
      resumeChat(chat)
    }).catch(() => {
      setCommissionHint('That file doesn\'t look like a saved chat export.')
    })
  }

  function handleAgentTypeChange(type: AgentTemplateId) {
    // Previously pruned selectedTraits down to whatever overlapped the new
    // type's pool — but PERSONALITY_TRAITS pools are fully disjoint across
    // types (zero shared ids), so that always emptied the selection on any
    // type switch. Traits/toggles now persist across type changes; the
    // personality UI itself already filters selectedTraits by the current
    // type's pool wherever it's displayed, so a stale id from a previous
    // type just stays inert (not shown, not counted) until that type is
    // revisited, instead of being lost.
    setAgentType(type)
    setFactorLocation(type === 'job_search')
  }

  function toggleSavedSection(section: SavedSectionId) {
    setOpenSavedSections(prev => ({ ...prev, [section]: !prev[section] }))
  }

  // The failure panel's Dismiss hides it until the next deploy attempt.
  const [errorDismissed, setErrorDismissed] = useState(false)
  useEffect(() => {
    if (bootstrapping) setErrorDismissed(false)
  }, [bootstrapping])

  // Extracted from handleSubmit so a post-error "Retry" button can re-run the
  // exact same commission attempt (form state is untouched after a failed
  // bootstrap — Setup stays mounted across setup/bootstrapping phases) without
  // needing a form submit event.
  async function runBootstrap() {
    if (bootstrapping) return
    if (keywords.length === 0) {
      setCommissionHint('Add at least one focus area above — the brief needs it before this agent can be commissioned.')
      return
    }
    if (reusableConfig) {
      onStart()
      onDone({
        ...reusableConfig,
        provider,
        ollama_model: provider === 'ollama' || provider === 'cloudflare' ? activeModel : null,
        max_delegations: maxDelegations,
        search_defaults: searchDefaults,
      })
      return
    }
    const loc = usedLocation
    const activeInstructions = BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.instruction)
    const traitPool = PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research
    const traitInstructions = traitPool.filter(t => selectedTraits.includes(t.id)).map(t => t.instruction)
    const purpose = getTemplate(agentType).buildPurpose(keywords, loc) +
      (activeInstructions.length > 0 ? ` ${activeInstructions.join(' ')}` : '') +
      (traitInstructions.length > 0 ? ` ${traitInstructions.join(' ')}` : '') +
      (chosenDeliverables.length > 0
        ? ` The user wants these finished outputs from this job: ${chosenDeliverables.map(d => `${d.title} (${RELIC_LABELS[d.kind]})`).join('; ')}.`
        : '')
    onStart()
    setProgress(null)
    setModelInfo(null)
    setDeployRun(EMPTY_DEPLOY_RUN)
    function handleProgress(event: BootstrapStreamEvent) {
      setDeployRun(run => applyDeployEvent(run ?? EMPTY_DEPLOY_RUN, event,
        e => formatModelInfo({ used: e.used, failed: e.failed })))
      if (event.type === 'status') setProgress(event.message)
      else if (event.type === 'model') setModelInfo({ used: event.used, failed: event.failed })
    }
    const controller = new AbortController()
    bootstrapAbortRef.current = controller
    try {
      const config = await bootstrap(
        purpose,
        provider,
        provider === 'ollama' || provider === 'cloudflare' ? activeModel : null,
        handleProgress,
        agentType,
        controller.signal,
        purposeImage,
        DEFAULT_AGENT_SPEC,
      )
      const built: AgentConfig = {
        ...config,
        keywords,
        location: loc,
        factor_location: factorLocation,
        provider,
        ollama_model: provider === 'ollama' || provider === 'cloudflare' ? activeModel : null,
        template: agentType,
        max_delegations: maxDelegations,
        deliverables: chosenDeliverables.length > 0 ? chosenDeliverables : undefined,
        search_defaults: searchDefaults,
        active_toggles: activeToggles,
        // Only the ids that actually belong to this type's pool — selectedTraits
        // itself can still hold ids left over from a type visited earlier in
        // this session (no longer pruned on type change), which must not leak
        // into a persisted/resumable AgentConfig.
        active_traits: traitPool.filter(t => selectedTraits.includes(t.id)).map(t => t.id),
      }
      rememberBuild(built)
      onDone(built)
    } catch (err) {
      const message = err instanceof Error && err.name === 'AbortError' ? 'Cancelled' : err instanceof Error ? err.message : 'Unknown error'
      setDeployRun(run => (run ? { ...run, error: run.error ?? message } : run))
      if (err instanceof Error && err.name === 'AbortError') {
        onError('Bootstrap cancelled.')
      } else {
        onError(err instanceof Error ? err.message : 'Unknown error')
      }
    }
  }

  // "Stop" for the Setup screen's own in-flight query — mirrors Chat.tsx's
  // stopAgent, just for /bootstrap instead of /agent. Aborting rejects the
  // bootstrap() promise with an AbortError, which runBootstrap's catch above
  // turns into a clean "Bootstrap cancelled." revert to the setup form
  // rather than surfacing the raw AbortError message.
  function stopBootstrap() {
    bootstrapAbortRef.current?.abort()
  }

  useEffect(() => {
    if (!bootstrapping) { setBootstrapElapsed(0); return }
    const t = setInterval(() => setBootstrapElapsed(s => s + 1), 1000)
    return () => clearInterval(t)
  }, [bootstrapping])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    await runBootstrap()
  }

  const briefWarning = keywords.length === 0
    ? null
    // The model's own note wins; with none (or a disclaimer the backend
    // dropped) the code-checked facts — topic count over the worker limit,
    // missing job-search location — still show.
    : aiBrief?.warning ?? buildDeterministicWarning(keywords, agentType, factorLocation ? usedLocation : null, maxDelegations)

  // The brief in prose. Under the brief graph it sits in its own collapsible
  // "Written brief for Agent" section; without a graph it shows as before.
  // Paragraphs of a brief still drafting, in order, once any has landed;
  // until then the previous brief (or the template) stays in view.
  const draftParts = briefProgress ? BRIEF_PARTS.map(id => briefProgress.parts[id]).filter(Boolean) : []
  const briefDraftText = draftParts.length > 0 ? draftParts.join('\n\n') : null

  // Which stages of the streamed brief are done, shown while it drafts.
  const briefStagesEl = briefProgress && (
    <ol className={styles.briefStages} aria-label="Brief progress">
      {briefProgress.fallback ? (
        <li className={styles.briefStage} data-state="active">
          <span className={styles.briefStageMark} aria-hidden="true"><span className={styles.briefUpdatingSpinner} /></span>
          Writing the brief in one go
        </li>
      ) : shownBriefStages(briefProgress).map(s => {
        const state = briefProgress.stages[s.id]
        return (
          <li key={s.id} className={styles.briefStage} data-state={state}>
            <span className={styles.briefStageMark} aria-hidden="true">
              {state === 'active' ? <span className={styles.briefUpdatingSpinner} /> : state === 'done' ? '✓' : state === 'failed' ? '✕' : '·'}
            </span>
            {s.label}
          </li>
        )
      })}
    </ol>
  )

  const briefTextEl = (
    <p className={styles.agentSummaryText}>
      {briefDraftText ?? aiBrief?.text ?? buildAgentBrief(
        agentType,
        keywords,
        usedLocation,
        agentName,
        BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => t.label),
        (PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research).filter(t => selectedTraits.includes(t.id)).map(t => t.label),
      )}
    </p>
  )

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <button
          type="button"
          className={styles.brandLogoBtn}
          onClick={resetSearch}
          aria-label="Return to search"
          title="Return to search"
        >
          <img src={splashLogo} alt="Agent One" className={styles.brandLogo} />
        </button>

        <div className={styles.focusStack}>
        <div className={styles.agentCard}>
          <div className={styles.agentCardFields}>
          <div className={styles.agentCardFieldsContent}>
          <div className={`${ah.header} ${styles.agentCardMain}`}>
            {/* The agent's header, shared with Chat (AgentHeader.module.css):
                row 1 is the name and model, row 2 the action strip (agent
                controls left, location right). Save is always shown. */}
            <div className={ah.identity}>
              <h1 className={`${ah.name} ${styles.setupAgentName}`}>Agent {agentName}</h1>
              <div className={`${ah.meta} ${styles.setupModelMeta}`}>
                <span className={ah.metaStack}>
                  <button
                    type="button"
                    className={ah.metaItem}
                    onClick={ev => { ev.stopPropagation(); setSettingsOpen(true) }}
                    title={describeModelFallback(provider)}
                  >
                    <span aria-hidden="true">🧠</span>
                    <span>{describeModel(provider, activeModel)}</span>
                  </button>
                  <WebSearchLabel />
                </span>
              </div>
            </div>
            <div className={ah.actions}>
              <div className={styles.topToolsRow}>
              <div className={`${ah.group} ${styles.topTools}`} role="group" aria-label="Saved agents">
                <button
                  type="button"
                  className={`${ah.btn} ${ah.btnText} ${poolOpen ? ah.btnOpen : ''}`}
                  onClick={ev => { ev.stopPropagation(); setPoolOpen(o => !o) }}
                  disabled={bootstrapping}
                  aria-expanded={poolOpen}
                  aria-controls="agent-pool-panel"
                  title={`Load a previous agent: ${drafts.length + visibleChats.length} saved`}
                  aria-label={`Load a previous agent (${drafts.length + visibleChats.length} saved)`}
                >
                  <AgentPoolIcon />
                  <span>Load Agent</span>
                </button>
                <button
                  type="button"
                  className={ah.btn}
                  onClick={saveAgentDraft}
                  disabled={bootstrapping}
                  title="Save Agent profile — name, type, location and focus areas"
                  aria-label="Save agent"
                >
                  <SaveIcon />
                </button>
              </div>
              <div className={`${ah.group} ${styles.topTools}`} role="group" aria-label="New agent">
                <button
                  type="button"
                  className={`${ah.btn} ${ah.btnText}`}
                  onClick={ev => { ev.stopPropagation(); setCharacterGenOpen(true) }}
                  disabled={bootstrapping}
                  title="New Agent: generate a character"
                  aria-label="New agent"
                >
                  <OpenAgentIcon />
                  <span>New Agent</span>
                </button>
                {onOpenAdvanced && (
                  <button
                    type="button"
                    className={ah.btn}
                    onClick={ev => { ev.stopPropagation(); onOpenAdvanced() }}
                    disabled={bootstrapping}
                    title="Advanced: define the agent with a structured spec, hard tool limits and a review step"
                    aria-label="Advanced setup"
                  >
                    <AdvancedIcon />
                  </button>
                )}
              </div>
              </div>
            <div className={`${styles.locationMap} ${!factorLocation ? styles.locationMapOff : ''}`}>
              <button
                type="button"
                className={styles.locationMapPlace}
                onClick={() => setLocationMapOpen(true)}
                disabled={bootstrapping}
                title="Change the search location on a map"
                aria-haspopup="dialog"
              >
                <svg className={styles.locationMapPin} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />
                  <circle cx="12" cy="9.5" r="2.5" />
                </svg>
                <span className={styles.locationMapName}>{location || 'No location set'}</span>
              </button>
              {/* Factor in location: a small tickbox at the card's right. */}
              <input
                type="checkbox"
                className={styles.locationMapToggle}
                checked={factorLocation}
                onChange={ev => setFactorLocation(ev.target.checked)}
                disabled={bootstrapping}
                aria-label="Factor in location"
                title={factorLocation
                  ? 'Factor in location: on. The location is passed to the agent, which applies it only to location-dependent topics.'
                  : 'Factor in location: off. The location is not passed to the agent at all.'}
              />
            </div>
            </div>
          </div>

          {/* Tabs sit outside the scrolling body so they stay put while
              the selected view scrolls. */}
          <div className={styles.setupTabsWrap}>
          {/* "Build your agent": the step breadcrumbs and the process graph
              in one panel. Outside the bootstrap shield, so it stays live
              while deploying. */}
          <div className={`${styles.processGraphWrap} ${styles.processGraphPanel}`}>
            <SectionHeader
              label="Build your agent"
              expanded={processGraphOpen}
              onToggle={() => setProcessGraphOpen(o => !o)}
              help="The four steps, then a graph of what the agent has done so far and what it's doing now: each step, then each stage of building the agent when you deploy it. Click a step, or its node in the graph, to open it. The toggle hides just the graph."
            />
          <SetupSteps
            active={setupStep}
            onSelect={setSetupStep}
          />
            {/* While deploying, just the deploy stages, so the live ones
                aren't scrolled off to the right of the Setup steps. */}
            {processGraphOpen && (
              <ProcessGraph
                columns={bootstrapping ? deployOnlyColumns : processColumns}
                label={bootstrapping ? 'Deploy graph' : 'Build your agent'}
                onSelect={bootstrapping ? undefined : id => {
                  const step = SETUP_STEPS.find(s => s.id === id)
                  if (step) setSetupStep(step.id)
                }}
              />
            )}
          </div>

          {/* The step's working panel. While deploying, the shield covers
              just this, so the breadcrumbs and process graph stay in view. */}
          <div className={`${styles.stepArea} ${bootstrapping ? styles.stepAreaBusy : ''}`}>
          <div className={`${styles.agentCardBody} ${bootstrapping ? styles.agentCardFieldsHidden : ''}`}>
          {setupStep === 'character' && (
          <div className={styles.setupPanel} role="region" id="setup-panel-character" aria-labelledby="setup-step-character">
          <div className={styles.agentCardScroll}>
            <div className={styles.traitsPanel}>
            {/* Type: the one choice on this step that isn't optional. */}
            <div className={styles.specialInstructionsRow}>
              <SectionHeader
                label="Type"
                expanded={typeOpen}
                onToggle={() => setTypeOpen(o => !o)}
                help="Type: what kind of agent this is. Required, one of these. It sets the brief's template and which personality traits are on offer below."
                right={!typeOpen && (
                  <span className={styles.fieldLabelCount}>{getTemplate(agentType).label}</span>
                )}
              />
              {typeOpen && (
                <div className={styles.behaviorIconRow} role="radiogroup" aria-label="Agent type">
                  {AGENT_TEMPLATES.map(t => {
                    const active = agentType === t.id
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={active ? styles.behaviorIconBtnActive : styles.behaviorIconBtn}
                        onClick={() => handleAgentTypeChange(t.id)}
                        disabled={bootstrapping}
                        title={t.label}
                      >
                        <span className={styles.behaviorIconGlyph} aria-hidden="true"><AgentTypeIcon id={t.id} /></span>
                        <span className={styles.behaviorIconLabel}>{t.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            <div className={styles.personalityRow}>
              {(() => {
                // selectedTraits can carry ids from a previously-selected
                // agent type (no longer pruned on type change, see
                // handleAgentTypeChange) — every display below counts/shows
                // only the ids that actually belong to the CURRENT type's
                // pool, so a stale cross-type id never inflates the badge or
                // shows a phantom active trait/effect.
                const traitPool = PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research
                const activeTraits = traitPool.filter(t => selectedTraits.includes(t.id))
                return (
                  <>
                    <SectionHeader
                      label="Personality (Optional)"
                      expanded={personalityOpen}
                      onToggle={() => setPersonalityOpen(o => !o)}
                      help="Personality traits give the agent a consistent character quirk beyond its raw behavior — e.g. Inquisitive or Meticulous for a researcher. Purely optional flavor that still shapes its generated system prompt, and the pool of traits on offer changes with the Type above. Active traits are summarized in the Brief below."
                      count={activeTraits.length}
                    />
                    {personalityOpen && (
                      <div className={styles.behaviorTogglesRow}>
                        {(PERSONALITY_TRAITS[agentType] ?? PERSONALITY_TRAITS.research).map(t => {
                          const active = selectedTraits.includes(t.id)
                          return (
                            <button
                              key={t.id}
                              type="button"
                              className={active ? styles.behaviorToggleActive : styles.behaviorToggle}
                              onClick={() => toggleTrait(t.id)}
                              disabled={bootstrapping}
                              title={t.instruction}
                              aria-pressed={active}
                            >
                              {t.label}
                            </button>
                          )
                        })}
                      </div>
                    )}
                    {personalityOpen && activeTraits.length > 0 && (
                      <ul className={styles.behaviorEffectsList}>
                        {activeTraits.map(t => (
                          <li key={t.id}>
                            <span className={styles.behaviorEffectLabel}>{t.label}:</span> {describeTraitEffect(t)}
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )
              })()}
            </div>

            <div className={styles.specialInstructionsRow}>
              <SectionHeader
                label="Behavior (Optional)"
                expanded={specialInstructionsOpen}
                onToggle={() => setSpecialInstructionsOpen(o => !o)}
                help="Behavior toggles shape how the agent communicates — concise vs. detailed, skeptical vs. trusting, whether it cites sources, acts proactively, or delegates aggressively. Turn on as many as you like; their effects combine. Active toggles are summarized in the Brief below."
                right={!specialInstructionsOpen && activeToggles.length > 0 && (
                  <span className={styles.fieldLabelCount}>{activeToggles.length}/{BEHAVIOR_TOGGLES.length}</span>
                )}
              />
              {specialInstructionsOpen && (
                <div className={styles.behaviorIconRow}>
                  {BEHAVIOR_TOGGLES.map(t => {
                    const active = activeToggles.includes(t.id)
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={active ? styles.behaviorIconBtnActive : styles.behaviorIconBtn}
                        onClick={() => toggleBehavior(t.id)}
                        disabled={bootstrapping}
                        title={describeBehaviorEffect(t, agentType, keywords)}
                        aria-label={t.label}
                        aria-pressed={active}
                      >
                        <span className={styles.behaviorIconGlyph} aria-hidden="true"><BehaviorIcon id={t.id} /></span>
                        <span className={styles.behaviorIconLabel}>{t.label}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {specialInstructionsOpen && activeToggles.length > 0 && (
                <ul className={styles.behaviorEffectsList}>
                  {BEHAVIOR_TOGGLES.filter(t => activeToggles.includes(t.id)).map(t => (
                    <li key={t.id}>
                      <span className={styles.behaviorEffectLabel}>{t.label}:</span> {describeBehaviorEffect(t, agentType, keywords)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            </div>
          </div>
          </div>
          )}

          {setupStep === 'focus' && (
          <div className={styles.setupPanel} role="region" id="setup-panel-focus" aria-labelledby="setup-step-focus">
          <div className={styles.agentCardScroll}>
            <div className={styles.specialtiesRow}>
              <SectionHeader
                label="Focus"
                expanded={specialtiesOpen}
                onToggle={() => setSpecialtiesOpen(o => !o)}
                help="Focus: the topics, roles, or keywords this agent will actually work on. Add at least one — they drive the Brief below and what the agent searches or reports on once commissioned."
                count={keywords.length}
              />
              {specialtiesOpen && (
                <p className={styles.specialtiesHint}>
                  {keywords.length >= MAX_SPECIALTIES
                    ? `Limit of ${MAX_SPECIALTIES} reached — remove one to add another.`
                    : 'Focus keywords define the Agent job - they act like a search.\nType a keyword and press Enter, or pick from your Saved Focus below'}
                </p>
              )}
              {specialtiesOpen && (
                <div className={`${styles.chipArea} ${keywords.length > 0 ? styles.chipAreaWithSave : ''}`} onClick={() => inputRef.current?.focus()}>
                  {keywords.map(kw => (
                    <span key={kw} className={styles.chip} title={kw.length > MAX_FOCUS_CHARS ? kw : undefined}>
                      {shortFocus(kw)}
                      <button
                        type="button"
                        className={styles.chipX}
                        onClick={ev => { ev.stopPropagation(); removeKeyword(kw) }}
                        aria-label={`Remove ${kw}`}
                        disabled={bootstrapping}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <input
                    ref={inputRef}
                    className={styles.chipInput}
                    value={draft}
                    onChange={e => setDraft(e.target.value.slice(0, MAX_FOCUS_CHARS))}
                    onKeyDown={handleKeyDown}
                    onBlur={() => { if (draft.trim()) addKeyword() }}
                    placeholder={keywords.length >= MAX_SPECIALTIES ? `Limit of ${MAX_SPECIALTIES} reached` : (keywords.length === 0 ? getTemplate(agentType).keywordPlaceholder : '+ Add Focus')}
                    disabled={bootstrapping || keywords.length >= MAX_SPECIALTIES}
                    maxLength={MAX_FOCUS_CHARS}
                  />
                  {keywords.length > 0 && (
                    <button
                      type="button"
                      className={`${styles.focusAttachBtn} ${styles.focusSaveBtn}`}
                      onClick={ev => { ev.stopPropagation(); saveSearch() }}
                      disabled={bootstrapping || !hasUnsavedSpecialties}
                      title={hasUnsavedSpecialties ? 'Save Focus: add the focus items that aren\'t saved yet to Saved Focus' : 'All current focus items are already saved'}
                      aria-label="Save Focus"
                    >
                      <span className={styles.focusSaveIcon} aria-hidden="true"><SaveIcon /></span>
                    </button>
                  )}
                  <button
                    type="button"
                    className={styles.focusAttachBtn}
                    onClick={ev => { ev.stopPropagation(); handlePurposeImageAttachClick() }}
                    disabled={bootstrapping || attachingPurposeImage}
                    title="Attach an image for the agent to look at — it'll inform the agent's design the same way a keyword would"
                    aria-label="Attach an image"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" width="16" height="16" aria-hidden="true">
                      <path d="M16.5 6.5 8.7 14.3a3 3 0 1 0 4.24 4.24l7.1-7.1a5 5 0 1 0-7.07-7.07L5.5 11.84" />
                    </svg>
                  </button>
                </div>
              )}
              {/* Always mounted: the paperclip in the Focus field opens it. */}
              <input
                ref={purposeImageInputRef}
                type="file"
                accept="image/*"
                className={styles.hiddenFileInput}
                onChange={handlePurposeImageFileChange}
              />
              {/* The rows below only render with content, so an empty one
                  doesn't leave a gap above the info line. */}
              {specialtiesOpen && (purposeImage || attachingPurposeImage) && (
                <div className={styles.purposeImageRow}>
                  <div className={styles.purposeImageLeft}>
                    {(purposeImage || attachingPurposeImage) && (
                      <div className={styles.purposeImageChip}>
                        {attachingPurposeImage ? (
                          <span className={styles.attachmentPlaceholder}>Loading image…</span>
                        ) : (
                          <>
                            <img src={purposeImage!} alt="Attached image" className={styles.attachmentThumb} />
                            <span>Attached — will inform the agent's design</span>
                            <button
                              type="button"
                              className={styles.attachmentRemove}
                              onClick={clearPurposeImage}
                              aria-label="Remove attached image"
                            >
                              ✕
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
              {specialtiesOpen && (saveFeedback || draft.length > 0) && (
                <div className={styles.specialtiesActionsRow}>
                  {saveFeedback ? (
                    <p className={`${styles.saveFeedbackText} ${saveFeedback.includes('failed') ? styles.saveFeedbackError : styles.saveFeedbackSuccess}`}>
                      {saveFeedback}
                    </p>
                  ) : (
                    <p className={styles.charHint}>
                      {draft.length > 0 ? `${MAX_FOCUS_CHARS - draft.length} chars remaining` : ''}
                    </p>
                  )}
                </div>
              )}
              {specialtiesOpen && (() => {
                // One worker per focus topic, up to the per-turn limit
                // (Settings), so going past it changes what the agent does.
                const limit = maxDelegations ?? DEFAULT_MAX_DELEGATIONS
                if (keywords.length > limit) {
                  return (
                    <div className={styles.focusWarnBox} role="alert">
                      <p className={styles.briefNoteText}>
                        <span className={styles.focusWarnIcon} aria-hidden="true">⚠</span>{' '}
                        {keywords.length} focus topics, but the agent runs at most {limit} worker agents per research turn,
                        so some topics will be combined or left for a follow-up turn, and the brief gets broader.
                        Keep to {limit} for the sharpest results, or raise the worker limit in Settings.
                      </p>
                    </div>
                  )
                }
                return (
                  <div className={styles.briefNoteBox} role="note">
                    <p className={styles.briefNoteText}>
                      <span className={styles.briefNoteIcon} aria-hidden="true">i</span>{' '}
                      {keywords.length === limit
                        ? `That's ${limit} focus topics, the most the agent covers with a worker each per turn. Adding more works, but some topics will share a worker.`
                        : `Up to ${limit} focus topics each get their own worker agent per turn (Settings). Fewer, sharper topics give a more focused brief.`}
                    </p>
                  </div>
                )
              })()}
              {specialtiesOpen && focusOverlaps.map(o => (
                <div key={`${o.a}|${o.b}`} className={styles.focusWarnBox} role="note">
                  <p className={styles.briefNoteText}>
                    <span className={styles.focusWarnIcon} aria-hidden="true">⚠</span>{' '}
                    “{shortFocus(o.a)}” and “{shortFocus(o.b)}” mean nearly the same thing, so two workers would cover the same ground.{' '}
                    <button
                      type="button"
                      className={styles.focusInlineAction}
                      onClick={() => removeKeyword(o.b)}
                      disabled={bootstrapping}
                    >
                      Remove “{shortFocus(o.b)}”
                    </button>
                  </p>
                </div>
              ))}
            </div>

            {/* The Saved Focus pool from the Agent Dossier, so focus can be
                picked here without leaving the step. Renaming, deleting and
                adding to the pool stay in the Dossier. */}
            <div className={styles.focusPoolRow}>
              <SectionHeader
                label="Saved Focus"
                count={savedKeywordPool.length}
                expanded={savedFocusOpen}
                onToggle={() => setSavedFocusOpen(o => !o)}
                help="Focus items you've saved for reuse across agents. Tap one to add it to this agent's focus, or tap it again to take it off. Renaming and adding to the pool are in the Agent Dossier."
              />
              {savedFocusOpen && (<>
              {focusRelated.length > 0 && (
                <h4 className={styles.focusSubheading}>Related to your focus</h4>
              )}
              {focusRelated.length > 0 && (
                <div className={styles.focusRelatedRow}>
                  {focusRelated.map(r => {
                    const atCap = keywords.length >= MAX_SPECIALTIES
                    return (
                      <button
                        key={r.topic}
                        type="button"
                        className={`${styles.savedKeywordChip} ${atCap ? styles.savedKeywordChipDisabled : ''}`}
                        onClick={() => addSavedKeyword(r.topic)}
                        disabled={bootstrapping || atCap}
                        title={atCap ? `Limit of ${MAX_SPECIALTIES} focus areas reached` : `Close to “${r.near}”. Tap to add`}
                      >
                        <span className={styles.savedKeywordLabel}>+ {shortFocus(r.topic)}</span>
                      </button>
                    )
                  })}
                </div>
              )}
              {focusRelated.length > 0 && savedKeywordPool.length > 0 && (
                <h4 className={styles.focusSubheading}>Other</h4>
              )}
              {savedKeywordPool.length === 0 ? (
                <p className={styles.briefPlaceholderText}>
                  <span className={styles.briefPlaceholderIcon} aria-hidden="true">✎</span>
                  No focus items saved yet. Save the ones above to reuse them on other agents.
                </p>
              ) : (
                <div className={styles.savedKeywordPool}>
                  {savedKeywordPool.map(kw => {
                    const alreadyAdded = keywords.some(k => k.toLowerCase() === kw.toLowerCase())
                    const atCap = !alreadyAdded && keywords.length >= MAX_SPECIALTIES
                    const toggle = () => { if (bootstrapping || atCap) return; if (alreadyAdded) removeKeyword(kw); else addSavedKeyword(kw) }
                    // A div, not a button, so the delete button can sit inside it.
                    return (
                      <div
                        key={kw}
                        className={`${styles.savedKeywordChip} ${alreadyAdded ? styles.savedKeywordChipAdded : ''} ${atCap ? styles.savedKeywordChipDisabled : ''}`}
                        role="button"
                        tabIndex={bootstrapping || atCap ? -1 : 0}
                        onClick={toggle}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } }}
                        aria-pressed={alreadyAdded}
                        aria-disabled={bootstrapping || atCap}
                        title={alreadyAdded ? 'Tap to remove from this agent\'s focus' : atCap ? `Limit of ${MAX_SPECIALTIES} focus areas reached` : 'Tap to add to this agent\'s focus'}
                      >
                        <span className={styles.savedKeywordLabel} title={kw.length > MAX_FOCUS_CHARS ? kw : undefined}>
                          {shortFocus(kw)}
                        </span>
                        <button
                          type="button"
                          className={styles.savedKeywordDelete}
                          onClick={ev => { ev.stopPropagation(); deleteSavedKeyword(kw) }}
                          disabled={bootstrapping}
                          aria-label={`Delete saved focus area ${kw}`}
                          title="Delete saved focus area"
                        >
                          ×
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
              </>)}
            </div>

          </div>
          </div>
          )}

          {/* Brief: generated from the builder fields, never typed into
              directly, so it reads as assembled output rather than another
              field to fill in. It keeps drafting while the other steps are
              showing. */}
          {setupStep === 'brief' && (
          <div className={`${styles.setupPanel} ${styles.briefSection}`} role="region" id="setup-panel-brief" aria-labelledby="setup-step-brief">
            {keywords.length === 0 ? (
                <p className={styles.briefPlaceholderText}>
                  <span className={styles.briefPlaceholderIcon} aria-hidden="true">✎</span>
                  Add Focus and behaviors to build this agent’s brief.
                </p>
              ) : aiBrief?.type === 'question' ? (
                <>
                  <div className={styles.briefQuestionBox}>
                    <p className={styles.briefQuestionText}><span aria-hidden="true">🤔</span> {aiBrief.text}</p>
                    <div className={styles.briefAnswerRow}>
                      <input
                        className={styles.briefAnswerInput}
                        value={briefAnswer}
                        onChange={e => setBriefAnswer(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleBriefAnswerSubmit() }}
                        placeholder="Your answer…"
                        disabled={answeringBrief || bootstrapping}
                      />
                      <button
                        type="button"
                        className={styles.briefAnswerBtn}
                        onClick={handleBriefAnswerSubmit}
                        disabled={!briefAnswer.trim() || answeringBrief || bootstrapping}
                      >
                        {answeringBrief ? '…' : 'Continue'}
                      </button>
                    </div>
                    {answeringBrief && briefStagesEl}
                  </div>
                  {briefWarning && (
                    <div className={styles.briefNoteBox} role="note">
                      <p className={styles.briefNoteText}><span className={styles.briefNoteIcon} aria-hidden="true">i</span> {briefWarning}</p>
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className={styles.briefBody} aria-busy={briefLoading}>
                  {/* Progress sits above the graph and text, never over them. */}
                  {briefLoading && (briefStagesEl ?? (
                    <p className={styles.briefMapDrawing} role="status">
                      <span className={styles.briefUpdatingSpinner} aria-hidden="true" />
                      <span>Updating brief…</span>
                    </p>
                  ))}
                  {(briefMap || briefMapLoading) && (
                    <div className={styles.writtenBrief}>
                      <SectionHeader
                        label="Brief graph"
                        expanded={briefGraphOpen}
                        onToggle={() => setBriefGraphOpen(o => !o)}
                        help="The brief drawn as a flow: what you asked for, how the agent understood it, the lines of work it will split into, and what it hands back."
                      />
                      {briefGraphOpen && briefMap && <BriefGraph map={briefMap} focuses={keywords} />}
                      {briefGraphOpen && !briefMap && briefMapLoading && (
                        <p className={styles.briefMapDrawing} role="status">
                          <span className={styles.briefUpdatingSpinner} aria-hidden="true" />
                          <span>Drawing the brief graph…</span>
                        </p>
                      )}
                    </div>
                  )}
                  {briefMap ? (
                    <div className={styles.writtenBrief}>
                      <SectionHeader
                        label="Written brief for Agent"
                        expanded={writtenBriefOpen}
                        onToggle={() => setWrittenBriefOpen(o => !o)}
                        help="The full brief in prose: what the graph above summarises, as the agent will receive it."
                      />
                      {writtenBriefOpen && briefTextEl}
                    </div>
                  ) : briefTextEl}
                  {!aiBrief && briefError && !briefLoading && (
                    <p className={`${styles.focusWarnBox} ${styles.briefFallbackNote}`} role="status">
                      <span className={styles.focusWarnIcon} aria-hidden="true">⚠</span>{' '}
                      Showing the basic brief: the AI brief couldn't be drafted ({briefError}).{' '}
                      <button
                        type="button"
                        className={styles.briefRetryBtn}
                        onClick={() => {
                          lastBriefInputsRef.current = ''
                          setBriefRetry(n => n + 1)
                        }}
                        disabled={bootstrapping}
                      >
                        ↻ Retry
                      </button>
                    </p>
                  )}
                  </div>
                  {briefWarning && (
                    <div className={styles.briefNoteBox} role="note">
                      <p className={styles.briefNoteText}><span className={styles.briefNoteIcon} aria-hidden="true">i</span> {briefWarning}</p>
                    </div>
                  )}
                  {briefRelicError && !briefRelicPreview && (
                    <p className={styles.briefLoadingHint}>{briefRelicError}</p>
                  )}
                </>
              )}
          </div>
          )}

          {/* Outputs: the deliverables the agent proposes for this job,
              its own picks pre-ticked. Chosen ones go on the AgentConfig
              (deliverables) and are offered after every research turn. */}
          {setupStep === 'outputs' && (
          <div className={styles.setupPanel} role="region" id="setup-panel-outputs" aria-labelledby="setup-step-outputs">
            {keywords.length === 0 ? (
              <p className={styles.briefPlaceholderText}>
                <span className={styles.briefPlaceholderIcon} aria-hidden="true">✎</span>
                Add Focus first: the agent proposes outputs for the job it's been given.
              </p>
            ) : outputsLoading || ((briefLoading || briefScheduled) && !outputProposals) ? (
              <div className={`${styles.briefUpdating} ${styles.outputsUpdating}`} role="status">
                <span className={styles.briefUpdatingSpinner} aria-hidden="true" />
                <span>{briefLoading || briefScheduled ? 'Waiting for the new brief…' : 'Proposing outputs for this job…'}</span>
              </div>
            ) : (
              <>
                <p className={styles.outputsIntro}>
                  {outputsFailed
                    ? "Couldn't get the agent's proposals, so pick the kinds of output you want by hand."
                    : 'What this agent proposes to hand back. Its picks are ticked; change them freely.'}
                </p>
                <ul className={styles.outputList}>
                  {outputOptions.map(o => {
                    const on = chosenOutputs.includes(o.kind)
                    return (
                      <li key={o.kind}>
                        <label className={`${styles.outputCard} ${on ? styles.outputCardOn : ''}`}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleOutput(o.kind)}
                            disabled={bootstrapping}
                          />
                          <span className={styles.outputIcon}><RelicIcon kind={o.kind} /></span>
                          <span className={styles.outputText}>
                            <span className={styles.outputTitle}>
                              {o.title}
                              {o.recommended && <span className={styles.outputPick}>agent's pick</span>}
                            </span>
                            <span className={styles.outputMeta}>
                              {RELIC_LABELS[o.kind]}{o.reason ? ` · ${o.reason}` : ''}
                            </span>
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
                {chosenOutputs.length === 0 && (
                  <p className={styles.briefLoadingHint}>None chosen: the agent answers in chat and suggests formats as it goes.</p>
                )}
              </>
            )}
          </div>
          )}
          </div>
          {bootstrapping && (
            <div className={styles.bootstrapShield}>
              <button
                type="button"
                className={styles.bootstrapShieldClose}
                onClick={stopBootstrap}
                title="Cancel this in-progress bootstrap"
                aria-label="Cancel bootstrap"
              >
                &times;
              </button>
              <p className={styles.bootstrapShieldText}>
                {progress ?? (provider === 'ollama'
                  ? `${ollamaModel ?? 'Your local model'} is designing your agent's tools and behaviour…`
                  : 'Designing your agent\'s tools and behaviour…')}
              </p>
              <div className={styles.bootstrapShieldDots}>
                <span />
                <span />
                <span />
              </div>
              <p className={styles.bootstrapShieldMeta}>
                {modelInfo ? formatModelInfo(modelInfo) : describeModel(provider, activeModel)}
                {' · '}{bootstrapElapsed}s elapsed
              </p>
            </div>
          )}
          </div>
          </div>
          </div>
          </div>

          {/* Save toolbar and Deploy share one row. */}
          <div className={styles.saveDeployRow}>
          {/* Bottom left, opposite the Deploy toolbar. */}
          <a
            href="#/release-notes"
            target="_blank"
            rel="noopener"
            className={styles.releaseNotesLink}
            title="What changed in Agent One, and the AI services it uses"
          >
            Release Notes · v{__APP_VERSION__}
          </a>
          {commissionHint && (
            <p className={styles.commissionHint} role="status">{commissionHint}</p>
          )}
          <div className={styles.resetToolbar}>
            {briefOutputs.length > 0 && (
              // Output buttons, grouped on their own background.
              <div className={styles.toolbarOutputs} role="group" aria-label="Outputs">
                {briefOutputs.map(s => {
                  const built = briefRelics.some(r => r.kind === s.kind)
                  const label = RELIC_LABELS[s.kind]
                  const title = briefRelicBusy === s.kind
                    ? `Building ${label}…`
                    : !briefReady
                      ? `${label}: available once the Brief is generated`
                      : `${built ? 'Open' : 'Build'} ${label}${s.suggested ? ` (suggested): ${s.reason}` : ''}`
                  return (
                    <button
                      key={s.kind}
                      {...toolbarDrag.dragProps(s.kind)}
                      type="button"
                      className={`${styles.toolbarIconBtn} ${styles.toolbarOutputBtn} ${s.suggested ? styles.toolbarOutputSuggested : ''} ${briefRelicBusy === s.kind ? styles.toolbarIconBusy : ''}`}
                      title={title}
                      aria-label={`${built ? 'Open' : 'Build'} ${label}${s.suggested ? ' (suggested)' : ''}`}
                      disabled={outputsDisabled}
                      onClick={() => handleBriefRelic(s)}
                    >
                      <RelicIcon kind={s.kind} />
                    </button>
                  )
                })}
              </div>
            )}
            {briefOutputs.length > 0 && (
              // Narrow screens: stands in for the outputs group above
              // (CSS shows one or the other).
              <button
                type="button"
                className={`${styles.toolbarIconBtn} ${styles.toolbarOutputBtn} ${styles.toolbarToolsBtn} ${briefRelicBusy ? styles.toolbarIconBusy : ''}`}
                title={briefRelicBusy ? `Building ${RELIC_LABELS[briefRelicBusy]}…` : 'Tools'}
                aria-label="Tools"
                aria-haspopup="dialog"
                disabled={bootstrapping || briefRelicBusy !== null}
                onClick={() => setToolsOpen(true)}
              >
                <ToolsIcon />
              </button>
            )}
            <button
              type="button"
              className={`${styles.toolbarIconBtn} ${styles.toolbarIsolated}`}
              onClick={() => setSettingsOpen(true)}
              disabled={bootstrapping}
              aria-haspopup="dialog"
              aria-label="Settings"
              title="Settings"
            >
              <span className={styles.toolbarGlyph} aria-hidden="true">⚙</span>
            </button>
            {/* Deploy ends the toolbar: everything for this agent in one bar. */}
            <button
              type="submit"
              form="agentSetupForm"
              className={`${styles.profileCommissionBtn} ${styles.toolbarDeploy} ${keywords.length === 0 ? styles.profileCommissionBtnBlocked : ''}`}
              disabled={bootstrapping}
              aria-disabled={keywords.length === 0}
              title={reusableConfig
                ? 'Deploy: this agent is already built from these steps, so it opens straight away'
                : 'Deploy: build the agent from these steps and start the job'}
            >
              {bootstrapping ? 'Configuring…' : 'Deploy >'}
            </button>
            {bootstrapping && (
              <button
                type="button"
                className={styles.bootstrapStopBtn}
                onClick={stopBootstrap}
                title="Cancel this in-progress bootstrap"
              >
                Stop
              </button>
            )}
          </div>

          </div>
        </div>

        {dossierOpen && (
          <div className={styles.dossierBackdrop} onClick={() => setDossierOpen(false)} aria-hidden="true" />
        )}
        <form
          id="agentSetupForm"
          onSubmit={handleSubmit}
          className={`${styles.form} ${styles.dossierDrawer} ${dossierOpen ? styles.dossierDrawerOpen : ''}`}
        >
          <button
            type="button"
            className={styles.dossierClose}
            onClick={() => setDossierOpen(false)}
            aria-label="Close the Agent Dossier"
            title="Close"
          >
            ×
          </button>
          <div className={styles.dossierWrap}>
          <div className={styles.savedSectionsScroll}>
          <span className={styles.dossierTab} aria-hidden="true">Agent Dossier</span>
          <span className={styles.dossierStamp} aria-hidden="true">On file</span>
          <div className={styles.savedSectionsScrollInner}>
          <div className={styles.savedAccordion}>
            <div className={styles.savedSection}>
              <div
                className={styles.savedSectionHeader}
                role="button"
                tabIndex={0}
                aria-expanded={openSavedSections.searches}
                onClick={() => toggleSavedSection('searches')}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSavedSection('searches') } }}
              >
                <span className={styles.savedSectionTitle}>Saved Focus ({savedKeywordPool.length})</span>
                <span className={styles.savedSectionRight}>
                  <HelpTip text="Focus keywords you've saved for reuse across agents — tap one later to add it back into the Focus list above without retyping it." label="Saved Focus help" />
                  <span className={styles.savedSectionCaret} aria-hidden="true">
                    {openSavedSections.searches ? '▾' : '▸'}
                  </span>
                </span>
              </div>
              {openSavedSections.searches && (
                <div className={styles.savedSectionBody}>
                  {savedKeywordPool.length === 0 && !addingSavedKeyword && (
                    <p className={styles.savedEmpty}>No focus items saved yet.</p>
                  )}
                  <div className={styles.savedKeywordPool}>
                    {savedKeywordPool.map(kw => {
                      const alreadyAdded = keywords.some(k => k.toLowerCase() === kw.toLowerCase())
                      const atCap = !alreadyAdded && keywords.length >= MAX_SPECIALTIES
                      const toggle = () => { if (bootstrapping || atCap) return; if (alreadyAdded) { removeKeyword(kw) } else { addSavedKeyword(kw) } }
                      const isEditing = editingSavedKeyword === kw
                      return (
                        <div
                          key={kw}
                          className={`${styles.savedKeywordChip} ${alreadyAdded ? styles.savedKeywordChipAdded : ''} ${atCap ? styles.savedKeywordChipDisabled : ''}`}
                          role={isEditing ? undefined : 'button'}
                          tabIndex={isEditing || bootstrapping || atCap ? -1 : 0}
                          onClick={isEditing ? undefined : toggle}
                          onKeyDown={isEditing ? undefined : (e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() } })}
                          aria-pressed={isEditing ? undefined : alreadyAdded}
                          aria-disabled={atCap}
                          aria-label={isEditing ? undefined : (alreadyAdded ? `${kw} is in current focus areas — tap to remove` : atCap ? `Cannot add ${kw} — limit of ${MAX_SPECIALTIES} focus areas reached` : `Add saved focus area ${kw} to current focus areas`)}
                          title={isEditing ? undefined : (alreadyAdded ? 'Tap to remove from current focus areas · double-click to rename' : atCap ? `Limit of ${MAX_SPECIALTIES} focus areas reached` : 'Tap to add to current focus areas · double-click to rename')}
                        >
                          {isEditing ? (
                            <input
                              className={styles.savedKeywordLabelEditing}
                              value={editSavedKeywordDraft}
                              autoFocus
                              onFocus={e => e.currentTarget.select()}
                              onClick={e => e.stopPropagation()}
                              onChange={e => setEditSavedKeywordDraft(e.target.value.slice(0, MAX_FOCUS_CHARS))}
                              onKeyDown={e => {
                                if (e.key === 'Enter') { e.preventDefault(); renameSavedKeyword(kw, editSavedKeywordDraft) }
                                if (e.key === 'Escape') { e.preventDefault(); setEditingSavedKeyword(null); setEditSavedKeywordDraft('') }
                              }}
                              onBlur={() => renameSavedKeyword(kw, editSavedKeywordDraft)}
                              maxLength={MAX_FOCUS_CHARS}
                            />
                          ) : (
                            <span
                              className={styles.savedKeywordLabel}
                              onDoubleClick={ev => { ev.stopPropagation(); setEditingSavedKeyword(kw); setEditSavedKeywordDraft(kw) }}
                              title={kw.length > MAX_FOCUS_CHARS ? kw : undefined}
                            >
                              {shortFocus(kw)}
                            </span>
                          )}
                          <button
                            type="button"
                            className={styles.savedKeywordDelete}
                            onClick={ev => { ev.stopPropagation(); deleteSavedKeyword(kw) }}
                            disabled={bootstrapping}
                            aria-label={`Delete saved focus area ${kw}`}
                            title="Delete saved focus area"
                          >
                            ×
                          </button>
                        </div>
                      )
                    })}
                    {addingSavedKeyword ? (
                      <input
                        ref={newSavedKeywordRef}
                        className={styles.chipInput}
                        value={newSavedKeywordDraft}
                        onChange={e => setNewSavedKeywordDraft(e.target.value.slice(0, MAX_FOCUS_CHARS))}
                        onKeyDown={e => {
                          if (e.key === 'Enter') { e.preventDefault(); addNewSavedKeyword() }
                          if (e.key === 'Escape') { setNewSavedKeywordDraft(''); setAddingSavedKeyword(false) }
                        }}
                        onBlur={addNewSavedKeyword}
                        placeholder="New focus area…"
                        autoFocus
                        maxLength={MAX_FOCUS_CHARS}
                      />
                    ) : (
                      <button
                        type="button"
                        className={styles.savedKeywordAddNew}
                        onClick={() => setAddingSavedKeyword(true)}
                        disabled={bootstrapping}
                        title="Add a new focus area straight to the saved pool"
                      >
                        Add New
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            <div className={styles.savedSection}>
              <div
                className={styles.savedSectionHeader}
                role="button"
                tabIndex={0}
                aria-expanded={openSavedSections.drafts}
                onClick={() => toggleSavedSection('drafts')}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSavedSection('drafts') } }}
              >
                <span className={styles.savedSectionTitle}>Saved Agent Profiles ({visibleDrafts.length})</span>
                <span className={styles.savedSectionRight}>
                  <HelpTip text="Full agent setups you've saved — type, behavior, personality, and focus together — so you can reload one later instead of rebuilding it from scratch." label="Saved Agent Profiles help" />
                  <span className={styles.savedSectionCaret} aria-hidden="true">
                    {openSavedSections.drafts ? '▾' : '▸'}
                  </span>
                </span>
              </div>
              {openSavedSections.drafts && (
                <div className={styles.savedSectionBody}>
                  {visibleDrafts.length > 0 ? (
                    <div className={styles.savedList}>
                      {visibleDrafts.map(d => (
                        <div
                          key={d.id}
                          className={`${styles.savedRow} ${bootstrapping ? styles.savedRowDisabled : ''}`}
                          onClick={ev => { ev.stopPropagation(); if (bootstrapping) return; loadDraft(d) }}
                          title={bootstrapping ? 'Agent is being commissioned — profiles can’t be loaded right now' : 'Load this agent profile'}
                          aria-disabled={bootstrapping}
                        >
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatName}>Agent {d.agentName}</span>
                            <div className={styles.savedPillRow}>
                              {(d.behaviorToggles ?? []).map(id => (
                                <span key={id} className={styles.savedBehaviorBadge}>
                                  {BEHAVIOR_TOGGLES.find(t => t.id === id)?.label ?? id}
                                </span>
                              ))}
                              {d.traits.map(label => (
                                <span key={label} className={styles.savedTraitBadge}>{label}</span>
                              ))}
                              {d.keywords.map(kw => (
                                <span key={kw} className={styles.savedChip}>{kw}</span>
                              ))}
                            </div>
                            <span className={styles.savedChatMeta}>
                              {d.location || 'No location set'} · {getTemplate(d.agentType ?? 'research').label} · {formatSavedAt(d.savedAt, dateFormat)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.savedDelete}
                            onClick={ev => { ev.stopPropagation(); deleteDraft(d.id) }}
                            disabled={bootstrapping}
                            aria-label="Delete agent profile"
                            title="Delete agent profile"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.savedEmpty}>No saved profiles for {getTemplate(agentType).label} yet.</p>
                  )}
                </div>
              )}
            </div>

            <div className={styles.savedSection}>
              <div
                className={styles.savedSectionHeader}
                role="button"
                tabIndex={0}
                aria-expanded={openSavedSections.chats}
                onClick={() => toggleSavedSection('chats')}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSavedSection('chats') } }}
              >
                <span className={styles.savedSectionTitle}>Saved Jobs ({visibleChats.length})</span>
                <span className={styles.savedSectionRight}>
                  <HelpTip text="Finished or in-progress conversations you've saved — reload one to pick up right where it left off." label="Saved Jobs help" />
                  <span className={styles.savedSectionCaret} aria-hidden="true">
                    {openSavedSections.chats ? '▾' : '▸'}
                  </span>
                </span>
              </div>
              {openSavedSections.chats && (
                <div className={styles.savedSectionBody}>
                  <input
                    ref={chatFileInputRef}
                    type="file"
                    accept="application/json"
                    onChange={handleLoadChatFile}
                    style={{ display: 'none' }}
                  />
                  <button
                    type="button"
                    className={styles.loadChatFileBtn}
                    onClick={() => chatFileInputRef.current?.click()}
                    disabled={bootstrapping}
                    title="Load a chat previously saved as a .json file and resume it"
                  >
                    Load Chat File…
                  </button>
                  {visibleChats.length > 0 ? (
                    <div className={styles.savedList}>
                      {visibleChats.map(c => (
                        <div
                          key={c.id}
                          className={`${styles.savedRow} ${bootstrapping ? styles.savedRowDisabled : ''}`}
                          onClick={ev => { ev.stopPropagation(); if (bootstrapping) return; loadChatDetails(c) }}
                          title={bootstrapping ? 'Agent is being commissioned — details can’t be loaded right now' : 'Load this agent’s details into the form'}
                          aria-disabled={bootstrapping}
                        >
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatName}>Agent {c.agentName}</span>
                            {c.agentConfig.persona?.traits && c.agentConfig.persona.traits.length > 0 && (
                              <span className={styles.savedChatTraits}>{c.agentConfig.persona.traits.join(' · ')}</span>
                            )}
                            {c.agentConfig.keywords && c.agentConfig.keywords.length > 0 && (
                              <div className={styles.savedChips}>
                                {[...c.agentConfig.keywords].sort((a, b) => a.localeCompare(b)).map(kw => (
                                  <span key={kw} className={styles.savedChip}>{kw}</span>
                                ))}
                              </div>
                            )}
                            {c.agentConfig.active_toggles && c.agentConfig.active_toggles.length > 0 && (
                              <div className={styles.savedBehaviorBadges}>
                                {c.agentConfig.active_toggles.map(id => (
                                  <span key={id} className={styles.savedBehaviorBadge}>
                                    {BEHAVIOR_TOGGLES.find(t => t.id === id)?.label ?? id}
                                  </span>
                                ))}
                              </div>
                            )}
                            {lastChatLine(c.messages) && (
                              <span className={styles.savedChatPreview}>{lastChatLine(c.messages)}</span>
                            )}
                            <span className={styles.savedChatMeta}>
                              {getTemplate(c.agentConfig.template).label} · {c.messages.length} message{c.messages.length === 1 ? '' : 's'} · {formatSavedAt(c.savedAt, dateFormat)}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.savedResume}
                            onClick={ev => { ev.stopPropagation(); resumeChat(c) }}
                            disabled={bootstrapping}
                            aria-label={`Continue chat with Agent ${c.agentName}`}
                            title="Continue this chat"
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M9 18l6-6-6-6" />
                            </svg>
                          </button>
                          <button
                            type="button"
                            className={styles.savedDelete}
                            onClick={ev => { ev.stopPropagation(); hideChat(c.id) }}
                            disabled={bootstrapping}
                            aria-label={`Remove Agent ${c.agentName}'s chat from this list`}
                            title="Remove from this list (keeps the saved chat itself)"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.savedEmpty}>No saved chats yet — use "Save chat" in an active conversation.</p>
                  )}
                </div>
              )}
            </div>

            <div className={styles.savedSection}>
              <div
                className={styles.savedSectionHeader}
                role="button"
                tabIndex={0}
                aria-expanded={openSavedSections.mcp}
                onClick={() => toggleSavedSection('mcp')}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSavedSection('mcp') } }}
              >
                <span className={styles.savedSectionTitle}>Agent Roster ({publishedAgents.length})</span>
                <span className={styles.savedSectionRight}>
                  <HelpTip text="Agents you've published as callable MCP tools — reachable by other MCP clients, not just this app's own chat." label="Agent Roster help" />
                  <span className={styles.savedSectionCaret} aria-hidden="true">
                    {openSavedSections.mcp ? '▾' : '▸'}
                  </span>
                </span>
              </div>
              {openSavedSections.mcp && (
                <div className={styles.savedSectionBody}>
                  {publishedAgents.length > 0 ? (
                    <div className={styles.savedList}>
                      {publishedAgents.map(a => (
                        <div key={a.id} className={styles.savedRow} title={a.description}>
                          <div className={styles.savedChatInfo}>
                            <span className={styles.savedChatNameRow}>
                              <span className={styles.savedChatName}>{a.name}</span>
                              <span className={styles.savedAgentNo}>Agent No. {a.id}</span>
                            </span>
                            <span className={styles.savedChatMeta}>
                              Callable as: {a.tool_name}{a.description ? ` · ${a.description}` : ''}
                            </span>
                          </div>
                          <button
                            type="button"
                            className={styles.savedDelete}
                            onClick={ev => { ev.stopPropagation(); removePublishedAgent(a.id) }}
                            disabled={bootstrapping}
                            aria-label={`Deactivate ${a.name}`}
                            title="Deactivate (stop exposing as an MCP tool)"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.savedEmpty}>No agents deployed to the roster yet — launch one from a chat.</p>
                  )}
                </div>
              )}
            </div>
          </div>
          </div>
          </div>
          </div>

        </form>
        </div>

        {/* Bootstrap progress lives on the shield; only a failure is shown here. */}
        {!bootstrapping && error && !errorDismissed && (
          <div className={styles.setupError}>
          <div className={styles.errorPanel}>
            <span className={styles.errorIcon} aria-hidden="true">⚠</span>
            <div className={styles.errorMessageRow}>
              <div className={styles.errorBody}>
                <p className={styles.errorHeadline}>Couldn't design this agent</p>
                <p className={styles.errorDetail}>{error}</p>
              </div>
              <button type="button" className={styles.errorRetry} onClick={runBootstrap}>
                ↻ Retry
              </button>
              <button type="button" className={styles.errorRetry} onClick={() => setErrorDismissed(true)}>
                Dismiss
              </button>
            </div>
          </div>
          </div>
        )}
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        location={location}
        onLocationChange={handleLocationChange}
        locationSuggestions={locationSuggestions}
        showLocationSuggestions={showLocationSuggestions}
        onLocationFocus={() => { if (locationSuggestions.length > 0) setShowLocationSuggestions(true) }}
        onLocationBlur={() => window.setTimeout(() => setShowLocationSuggestions(false), 150)}
        onSelectLocation={selectLocation}
        onDetectLocation={() => detectLocation(true)}
        detectingLocation={locationDetecting}
        provider={provider}
        onProviderChange={handleProviderChange}
        ollamaModel={ollamaModel}
        onOllamaModelChange={handleOllamaModelChange}
        availableModels={availableModels}
        cloudflareModel={cloudflareModel}
        onCloudflareModelChange={handleCloudflareModelChange}
        cloudflareModels={cloudflareModels}
        modelsLoaded={modelsLoaded}
        recommendedArm={recommendedArm}
        armStats={armStats}
        maxDelegations={maxDelegations}
        onMaxDelegationsChange={handleMaxDelegationsChange}
        searchDefaults={searchDefaults}
        onSearchDefaultsChange={handleSearchDefaultsChange}
        dateFormat={dateFormat}
        onDateFormatChange={handleDateFormatChange}
        disabled={bootstrapping}
      />

      <ThemePicker
        isOpen={themePickerOpen}
        onClose={() => setThemePickerOpen(false)}
      />

      {/* Load a previous agent: a popup from the button by the name. */}
      {poolOpen && (
        <div className={styles.agentPoolOverlay} onClick={() => setPoolOpen(false)}>
          <div
            id="agent-pool-panel"
            className={styles.agentPoolPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-pool-title"
            onClick={e => e.stopPropagation()}
          >
            <div className={styles.agentPoolPanelHead}>
              <h2 id="agent-pool-title" className={styles.agentPoolPanelTitle}>Load a previous agent</h2>
              <button type="button" className={styles.agentPoolPanelClose} onClick={() => setPoolOpen(false)} aria-label="Close" autoFocus>×</button>
            </div>
            <div className={styles.agentPoolPanelBody}>
              <AgentPool
                drafts={drafts}
                chats={visibleChats}
                formatDate={ts => formatSavedAt(ts, dateFormat)}
                editing={editing}
                disabled={bootstrapping}
                onLoadDraft={loadDraft}
                onLaunchDraft={launchDraft}
                onDeleteDraft={deleteDraft}
                onLoadChatDetails={loadChatDetails}
                onHideChat={hideChat}
              />
            </div>
          </div>
        </div>
      )}
      <AgentStableModal
        isOpen={stableModalOpen}
        onClose={() => setStableModalOpen(false)}
        onHire={hirePublishedAgent}
      />

      <LocationMapModal
        isOpen={locationMapOpen}
        location={location}
        onClose={() => setLocationMapOpen(false)}
        onSelect={selectLocation}
      />
      <ScoreboardModal
        isOpen={scoreboardOpen}
        onClose={() => setScoreboardOpen(false)}
      />

      {toolsOpen && (
        <div className={styles.toolsOverlay} onClick={() => setToolsOpen(false)}>
          <div
            className={styles.toolsSheet}
            role="dialog"
            aria-label="Tools"
            onClick={e => e.stopPropagation()}
          >
            {!briefReady && <p className={styles.toolsNote}>Available once the Brief is generated.</p>}
            {briefOutputs.map(s => {
              const built = briefRelics.some(r => r.kind === s.kind)
              return (
                <button
                  key={s.kind}
                  type="button"
                  className={`${styles.toolsItem} ${s.suggested ? styles.toolsItemSuggested : ''}`}
                  disabled={outputsDisabled}
                  onClick={() => { setToolsOpen(false); handleBriefRelic(s) }}
                >
                  <RelicIcon kind={s.kind} />
                  <span className={styles.toolsItemText}>
                    <span className={styles.toolsItemLabel}>
                      {built ? 'Open' : 'Build'} {RELIC_LABELS[s.kind]}{s.suggested ? ' · suggested' : ''}
                    </span>
                    {s.suggested && s.reason && <span className={styles.toolsItemReason}>{s.reason}</span>}
                  </span>
                </button>
              )
            })}
            <button type="button" className={styles.toolsClose} onClick={() => setToolsOpen(false)}>Close</button>
          </div>
        </div>
      )}

      {briefRelicPreview && aiBrief && (() => {
        const relic = briefRelics.find(r => r.kind === briefRelicPreview)
        const suggestion = aiBrief.relics?.find(s => s.kind === briefRelicPreview)
          ?? { kind: briefRelicPreview, reason: '' }
        if (!relic) return null
        return (
          <RelicPreviewModal
            relic={relic}
            filename={relicFilename(relic, agentName)}
            agentName={agentName}
            busy={briefRelicBusy === relic.kind}
            error={briefRelicError}
            onDownload={() => downloadRelic(relic, agentName).catch(err => setBriefRelicError(err instanceof Error ? err.message : 'Download failed'))}
            onRegenerate={() => handleBriefRelic(suggestion, true)}
            onClose={() => { setBriefRelicPreview(null); setBriefRelicError(null) }}
          />
        )
      })()}

      <CharacterGenerator
        isOpen={characterGenOpen}
        agentType={agentType}
        onClose={() => setCharacterGenOpen(false)}
        onEmploy={character => {
          onAgentNameChange(character.surname)
          setAgentType(character.agentType)
          setFactorLocation(character.agentType === 'job_search')
          setSelectedTraits(character.traitIds)
          setActiveToggles(character.behaviorIds)
          setEditing(null)
          setKeywords(character.specialties.slice(0, MAX_SPECIALTIES))
        }}
      />
    </div>
  )
}
