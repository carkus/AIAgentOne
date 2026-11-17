import type { SavedChat } from './types'

// Client-side chat persistence. The backend is stateless (CLAUDE.md limitation
// #3: full history always travels with every /agent request), so "saving a
// chat" just means keeping a snapshot of agentConfig + agentName + messages
// around in localStorage — same idiom as Setup.tsx's `aiagent_saved_searches`.
const STORAGE_KEY = 'aiagent_saved_chats'

export function loadSavedChats(): SavedChat[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
  } catch {
    return []
  }
}

// False when the browser refuses the write (storage quota full). Never
// throws: a save runs inside React effects, where a throw takes the whole
// Chat screen down.
function writeSavedChats(chats: SavedChat[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats))
    return true
  } catch (err) {
    console.warn('Saving chats to browser storage failed', err)
    return false
  }
}

// Embedded images (generate_image's base64 `data:` URIs) are what fill the
// browser's ~5 MB storage. This copy of a chat leaves out any large one.
const BIG_DATA_URI = 2000
function withoutEmbeddedImages<T>(value: T): T {
  return JSON.parse(JSON.stringify(value), (_k, v) =>
    typeof v === 'string' && v.startsWith('data:') && v.length > BIG_DATA_URI ? '' : v)
}

// Upserts by id, most-recently-saved first, so re-saving the same
// conversation (e.g. after sending a few more messages) updates its existing
// entry instead of piling up duplicates. When storage is full it retries
// without the chat's embedded images; if that still doesn't fit, the chat
// isn't saved and the other saved chats are left untouched (none are
// deleted to make room).
export function saveChat(chat: SavedChat): SavedChat[] {
  const stored = loadSavedChats()
  const rest = stored.filter(c => c.id !== chat.id)
  for (const candidate of [chat, withoutEmbeddedImages(chat)]) {
    const updated = [candidate, ...rest]
    if (writeSavedChats(updated)) return updated
  }
  return stored
}

export function deleteSavedChat(id: string): SavedChat[] {
  const updated = loadSavedChats().filter(c => c.id !== id)
  writeSavedChats(updated)
  return updated
}

// "Hiding" a chat only affects what the dossier list renders — the entry
// stays in `aiagent_saved_chats` untouched, so it isn't lost, just tucked
// out of view (distinct from deleteSavedChat, which is a real delete).
const HIDDEN_KEY = 'aiagent_hidden_chats'

export function loadHiddenChatIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? '[]')
  } catch {
    return []
  }
}

export function hideSavedChat(id: string): string[] {
  const updated = [...new Set([...loadHiddenChatIds(), id])]
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(updated))
  return updated
}

// Remembers which chat/agent was last open so a page reload can drop the
// user straight back into it instead of the splash/setup screen — but only
// a *pointer* (kind + id), never a full snapshot, so "still exist" means
// something: App.tsx re-checks the pointer against the live source (saved
// chats in localStorage, or the published-agent registry on the backend)
// on every load rather than trusting a possibly-stale cached copy. A saved
// chat that's since been deleted, or a published agent that's since been
// unpublished, correctly fails that check and falls back to a fresh start.
export type LastOpenedPointer =
  | { kind: 'savedChat'; id: string }
  | { kind: 'publishedAgent'; id: string }

const LAST_OPENED_KEY = 'aiagent_last_opened'

export function getLastOpenedPointer(): LastOpenedPointer | null {
  try {
    const raw = localStorage.getItem(LAST_OPENED_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function setLastOpenedPointer(pointer: LastOpenedPointer | null) {
  try {
    if (pointer) localStorage.setItem(LAST_OPENED_KEY, JSON.stringify(pointer))
    else localStorage.removeItem(LAST_OPENED_KEY)
  } catch {
    // localStorage unavailable (private browsing, quota) — reopening on
    // reload just won't work this session, nothing else depends on it.
  }
}

// Settings → "On reload or new tab": reopen the last chat (default) or
// start at Setup. Only skips the reopen; the pointer itself is kept.
const REOPEN_KEY = 'aiagent_reopen_last_chat'

export function getReopenLastChat(): boolean {
  try {
    return localStorage.getItem(REOPEN_KEY) !== '0'
  } catch {
    return true
  }
}

export function setReopenLastChat(on: boolean) {
  try {
    if (on) localStorage.removeItem(REOPEN_KEY)
    else localStorage.setItem(REOPEN_KEY, '0')
  } catch {
    // localStorage unavailable — the default (reopen) applies.
  }
}
