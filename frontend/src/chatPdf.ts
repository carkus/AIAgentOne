import jsPDF from 'jspdf'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ToolCall } from './types'
import { formatDate, getDateFormat } from './dateFormat'
import { renderMermaidSvg } from './components/MermaidDiagram'
import { extractMermaidDiagrams } from './mermaidExtract'
import { rasterToPdfImage, svgToPdfImage, type PdfImage } from './imageData'

/**
 * Chat PDF export, drawn to look like the deploy view: the same colours,
 * heading styles, numbered-list cards, tables, code blocks, user bubbles,
 * Mermaid diagrams, images and worker cards (values copied from
 * Chat.module.css / ToolActivity.module.css). Text is real vector text, so
 * it stays selectable and searchable, and links stay clickable.
 *
 * Markdown is rendered with the same ReactMarkdown + remark-gfm parse the
 * chat uses, then walked as DOM. It's rendered afresh rather than read from
 * the chat's own DOM so UI chrome (Expand buttons, copy buttons, collapsed
 * code blocks) never leaks in.
 *
 * Not reproduced: the run graph/log, option and relic buttons (interactive
 * only), and the site fonts (the PDF uses the built-in Helvetica/Courier).
 */

/** Agent-config context shown once, before the transcript. */
export interface PdfAgentContext {
  purpose: string
  keywords?: string[]
  location?: string
  model?: string
  persona?: { name: string; traits: string[]; rationale: string }
  /** Already-resolved labels (agentTypes.ts's BEHAVIOR_TOGGLES ids -> label), not raw ids. */
  behaviorToggles?: string[]
  /** Already-resolved labels (Setup.tsx's PERSONALITY_TRAITS ids -> label), not raw ids. */
  personalityTraits?: string[]
  tools?: string[]
}

export interface PdfMessage {
  role: 'user' | 'assistant'
  /** User: plain text. Assistant: markdown, with diagrams and JSON blobs already pulled out (as the chat does). */
  content: string
  /** Image attached to a user message (data: URL). */
  image?: string
  planDiagram?: string
  planSummary?: string
  /** Mermaid sources the chat draws above the reply. */
  diagrams?: string[]
  /** JSON blobs the chat shows as trees above the reply. */
  jsonBlobs?: unknown[]
  toolCallCount?: number
  durationSeconds?: number
  usage?: { input_tokens: number; output_tokens: number }
  /** Full tool-call log, used to draw delegated workers' cards. */
  toolCalls?: ToolCall[]
}

// ---- Colours and sizes (from the chat's CSS; 1px = 0.75pt) ----------------

type Rgb = [number, number, number]

const C = {
  text: [31, 83, 115] as Rgb, //           --color-text #1f5373
  muted: [107, 119, 133] as Rgb, //        --color-muted
  border: [221, 217, 205] as Rgb, //       --color-border
  accent: [1, 71, 146] as Rgb, //          --color-accent
  h2Bg: [238, 241, 243] as Rgb, //         rgba(40,75,106,.08) on white
  h3: [35, 50, 64] as Rgb,
  codeBg: [238, 241, 240] as Rgb, //       inline code
  codeText: [31, 87, 97] as Rgb,
  codeBlockBg: [245, 246, 244] as Rgb,
  codeHeaderBg: [210, 221, 231] as Rgb,
  codeLang: [13, 44, 72] as Rgb,
  quote: [90, 103, 115] as Rgb,
  tableBg: [252, 251, 248] as Rgb,
  theadBg: [238, 241, 240] as Rgb,
  zebra: [245, 246, 244] as Rgb,
  tdBorder: [236, 234, 227] as Rgb,
  olBadgeBg: [230, 242, 241] as Rgb,
  olBadgeBorder: [191, 204, 216] as Rgb,
  olBadgeText: [5, 56, 75] as Rgb,
  userBg: [49, 85, 148] as Rgb, //         --color-menu-bg gradient, midpoint
  userText: [242, 245, 246] as Rgb,
  workerBorder: [210, 221, 231] as Rgb,
  workerTraits: [47, 106, 138] as Rgb,
}

const REM = 12 // 16px
const BODY = 10.5 // --chat-body-size, 14px
const HEAD = 15 // --chat-header-size, 20px
const FOOTER = 9 // --chat-footer-size, 12px
const CODE = 9.75
const NAME = 21 // agent name, 1.75rem
const PAGE_MARGIN = 44

// ---- Text safety ------------------------------------------------------------

// The built-in PDF fonts only cover WinAnsi; anything else would print as
// garbage, so common symbols are spelled out and the rest (emoji) dropped.
const REPLACE: Record<string, string> = {
  '→': '->', '⇒': '=>', '←': '<-', '↔': '<->', '⟶': '->', '➔': '->', '➜': '->',
  '≥': '>=', '≤': '<=', '≠': '!=', '≈': '~', '−': '-', '‐': '-', '‑': '-',
  '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '★': '*', '☆': '*',
  '▸': '>', '▶': '>', '►': '>', '▾': 'v', '◦': '-', '▪': '-', '■': '-',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '​': '', '‍': '', '️': '', '\t': '    ',
}
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'

function pdfSafe(s: string): string {
  let out = ''
  for (const ch of s) {
    const r = REPLACE[ch]
    if (r !== undefined) { out += r; continue }
    const c = ch.codePointAt(0)!
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || c === 0x0a || WINANSI_EXTRA.includes(ch)) out += ch
  }
  return out
}

// ---- Markdown -> blocks -----------------------------------------------------

type Run = { text: string; bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; href?: string; image?: { src: string; alt: string } }
type Align = 'left' | 'center' | 'right'
type Cell = { runs: Run[]; align: Align }
type Block =
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'rule' }
  | { kind: 'table'; head: Cell[]; rows: Cell[][] }
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'diagram'; chart: string; label?: string; caption?: string }

const BLOCK_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'pre', 'blockquote', 'hr', 'table', 'div', 'section', 'article', 'figure', 'details'])

interface InlineState { bold?: boolean; italic?: boolean; code?: boolean; strike?: boolean; href?: string }

function inlineNode(node: Node, st: InlineState, runs: Run[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? ''
    if (text) runs.push({ text, ...st })
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  const el = node as HTMLElement
  const tag = el.tagName.toLowerCase()
  const kids = (next: InlineState) => el.childNodes.forEach(c => inlineNode(c, next, runs))
  switch (tag) {
    case 'br': runs.push({ text: '\n' }); return
    case 'a': kids({ ...st, href: el.getAttribute('href') || undefined }); return
    case 'strong': case 'b': kids({ ...st, bold: true }); return
    case 'em': case 'i': kids({ ...st, italic: true }); return
    case 'code': kids({ ...st, code: true }); return
    case 'del': case 's': kids({ ...st, strike: true }); return
    case 'img': runs.push({ text: '', image: { src: el.getAttribute('src') ?? '', alt: el.getAttribute('alt') ?? '' } }); return
    case 'input': runs.push({ text: el.hasAttribute('checked') ? '[x] ' : '[ ] ' }); return
    case 'button': case 'script': case 'style': return
    default: kids(st)
  }
}

function inlineRuns(el: Element): Run[] {
  const runs: Run[] = []
  el.childNodes.forEach(c => inlineNode(c, {}, runs))
  return runs
}

const hasText = (runs: Run[]) => runs.some(r => r.text.trim() !== '')

// A paragraph, split around any images in it (an image is its own block).
function pushParagraph(blocks: Block[], runs: Run[]) {
  let cur: Run[] = []
  for (const r of runs) {
    if (r.image) {
      if (hasText(cur)) blocks.push({ kind: 'paragraph', runs: cur })
      cur = []
      if (r.image.src) blocks.push({ kind: 'image', src: r.image.src, alt: r.image.alt })
    } else cur.push(r)
  }
  if (hasText(cur)) blocks.push({ kind: 'paragraph', runs: cur })
}

function cellAlign(el: HTMLElement): Align {
  const a = (el.style.textAlign || el.getAttribute('align') || '').toLowerCase()
  return a === 'center' || a === 'right' ? a : 'left'
}

function parseBlocks(root: Element): Block[] {
  const blocks: Block[] = []
  let pending: Run[] = []
  const flush = () => { pushParagraph(blocks, pending); pending = [] }
  root.childNodes.forEach(node => {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      inlineNode(node, {}, pending)
      return
    }
    const el = node as HTMLElement
    const tag = el.tagName.toLowerCase()
    if (!BLOCK_TAGS.has(tag)) {
      inlineNode(el, {}, pending)
      return
    }
    flush()
    if (/^h[1-6]$/.test(tag)) {
      blocks.push({ kind: 'heading', level: Number(tag[1]), runs: inlineRuns(el) })
    } else if (tag === 'p') {
      pushParagraph(blocks, inlineRuns(el))
    } else if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(el.children).filter(c => c.tagName.toLowerCase() === 'li').map(li => parseBlocks(li))
      blocks.push({ kind: 'list', ordered: tag === 'ol', start: Number(el.getAttribute('start')) || 1, items })
    } else if (tag === 'pre') {
      const code = el.querySelector('code')
      const lang = /language-(\S+)/.exec(code?.className ?? '')?.[1] ?? 'text'
      const text = ((code ?? el).textContent ?? '').replace(/\n$/, '')
      blocks.push(lang === 'mermaid' ? { kind: 'diagram', chart: text } : { kind: 'code', lang, text })
    } else if (tag === 'blockquote') {
      blocks.push({ kind: 'quote', blocks: parseBlocks(el) })
    } else if (tag === 'hr') {
      blocks.push({ kind: 'rule' })
    } else if (tag === 'table') {
      const head: Cell[] = []
      const rows: Cell[][] = []
      el.querySelectorAll('tr').forEach(tr => {
        const cells = Array.from(tr.children).map(td => ({ runs: inlineRuns(td), align: cellAlign(td as HTMLElement) }))
        if (tr.parentElement?.tagName.toLowerCase() === 'thead' && head.length === 0) head.push(...cells)
        else rows.push(cells)
      })
      blocks.push({ kind: 'table', head, rows })
    } else {
      blocks.push(...parseBlocks(el))
    }
  })
  flush()
  return blocks
}

function markdownBlocks(markdown: string): Block[] {
  const el = document.createElement('div')
  el.innerHTML = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown))
  return parseBlocks(el)
}

// ---- Workers ------------------------------------------------------------------

interface WorkerPdfData {
  name: string
  traits: string[]
  task?: string
  diagrams: string[]
  blocks: Block[]
  toolsUsed?: string[]
}

function extractWorkers(toolCalls: ToolCall[] | undefined): WorkerPdfData[] {
  if (!toolCalls) return []
  const out: WorkerPdfData[] = []
  for (const tc of toolCalls) {
    if (tc.tool !== 'delegate_to_worker' || tc.result === '…') continue
    let w: unknown
    try { w = JSON.parse(tc.result) } catch { continue }
    if (typeof w !== 'object' || w === null) continue
    const o = w as Record<string, unknown>
    if (typeof o.worker_name !== 'string' || typeof o.response !== 'string') continue
    const { text, diagrams } = extractMermaidDiagrams(o.response)
    out.push({
      name: o.worker_name,
      traits: Array.isArray(o.worker_traits) ? (o.worker_traits as unknown[]).map(String) : [],
      task: typeof o.task === 'string' ? o.task : undefined,
      diagrams,
      blocks: markdownBlocks(text),
      toolsUsed: Array.isArray(o.tools_used) ? (o.tools_used as unknown[]).map(String) : undefined,
    })
  }
  return out
}

// ---- Assets (diagrams and images, loaded before drawing) -------------------

type Assets = Map<string, PdfImage | null>

function collectAssets(blocks: Block[], diagrams: Set<string>, images: Set<string>) {
  for (const b of blocks) {
    if (b.kind === 'diagram') diagrams.add(b.chart)
    else if (b.kind === 'image') images.add(b.src)
    else if (b.kind === 'quote') collectAssets(b.blocks, diagrams, images)
    else if (b.kind === 'list') b.items.forEach(item => collectAssets(item, diagrams, images))
  }
}

async function loadAssets(diagrams: Set<string>, images: Set<string>): Promise<Assets> {
  const assets: Assets = new Map()
  // One at a time: mermaid.render isn't safe to run concurrently.
  for (const chart of diagrams) {
    try {
      assets.set(`mmd:${chart}`, await svgToPdfImage(await renderMermaidSvg(chart)))
    } catch {
      assets.set(`mmd:${chart}`, null)
    }
  }
  await Promise.all([...images].map(async src => { assets.set(`img:${src}`, await rasterToPdfImage(src)) }))
  return assets
}

// ---- Text layout ----------------------------------------------------------------

type BaseFont = 'helvetica' | 'courier'

interface Tok extends Run { w: number; space?: boolean; brk?: boolean }
interface PlacedTok extends Tok { x: number }
interface Line { toks: PlacedTok[]; width: number }

interface Ctx {
  x: number
  width: number
  size: number
  color: Rgb
  font: BaseFont
  /** Worker responses: plain markdown, without the chat's heading bands and list cards. */
  plain?: boolean
}

// ---- Drawing ----------------------------------------------------------------------

interface Box {
  x: number
  w: number
  top: number
  stroke?: Rgb
  radius: number
  bar?: { color: Rgb; width: number }
  padBottom: number
}

class PdfLayout {
  pdf: jsPDF
  pageW: number
  pageH: number
  contentW: number
  top = PAGE_MARGIN
  bottom: number
  y = PAGE_MARGIN
  private pendingMargin = 0
  private suppress = true
  private boxes: Box[] = []
  assets: Assets

  constructor(assets: Assets) {
    this.pdf = new jsPDF({ unit: 'pt', format: 'a4' })
    this.pageW = this.pdf.internal.pageSize.getWidth()
    this.pageH = this.pdf.internal.pageSize.getHeight()
    this.contentW = this.pageW - PAGE_MARGIN * 2
    this.bottom = this.pageH - PAGE_MARGIN
    this.assets = assets
  }

  // CSS-style collapsing margins: the larger of a block's bottom margin and
  // the next one's top margin, none at the top of a container or page.
  margin(n: number) {
    if (!this.suppress) this.pendingMargin = Math.max(this.pendingMargin, n)
  }

  startContainer() {
    this.pendingMargin = 0
    this.suppress = true
  }

  /** Apply the pending margin and make sure `height` fits on this page. */
  begin(height: number) {
    this.y += this.pendingMargin
    this.pendingMargin = 0
    this.suppress = false
    this.ensureRoom(height)
  }

  ensureRoom(height: number) {
    if (this.y + height > this.bottom && this.y > this.top + 1) this.newPage()
  }

  newPage() {
    for (const box of this.boxes) this.drawBox(box, box.top, Math.min(this.y + 4, this.bottom))
    this.pdf.addPage()
    this.y = this.top
    for (const box of this.boxes) box.top = this.top
    if (this.boxes.length) this.y += 6
    this.pendingMargin = 0
    this.suppress = true
  }

  private drawBox(box: Box, y1: number, y2: number) {
    const h = y2 - y1
    if (h <= 0) return
    if (box.stroke) {
      this.pdf.setDrawColor(...box.stroke)
      this.pdf.setLineWidth(0.75)
      this.pdf.roundedRect(box.x, y1, box.w, h, box.radius, box.radius, 'S')
    }
    if (box.bar) {
      this.pdf.setFillColor(...box.bar.color)
      this.pdf.rect(box.x, y1, box.bar.width, h, 'F')
    }
  }

  /** A bordered/barred region that may run across pages (fill ≈ white, so only the border is drawn). */
  openBox(opts: Omit<Box, 'top'> & { padTop: number }, minHeight: number): Box {
    this.begin(minHeight + opts.padTop)
    const box: Box = { ...opts, top: this.y }
    this.y += opts.padTop
    this.boxes.push(box)
    this.startContainer()
    return box
  }

  closeBox() {
    const box = this.boxes.pop()
    if (!box) return
    this.pendingMargin = 0
    this.y += box.padBottom
    this.drawBox(box, box.top, this.y)
    this.suppress = false
  }

  setFont(font: BaseFont, t: { bold?: boolean; italic?: boolean; code?: boolean }, size: number) {
    const style = t.code ? 'normal' : t.bold && t.italic ? 'bolditalic' : t.bold ? 'bold' : t.italic ? 'italic' : 'normal'
    this.pdf.setFont(t.code ? 'courier' : font, style)
    this.pdf.setFontSize(size)
  }

  textWidth(text: string, font: BaseFont, t: { bold?: boolean; italic?: boolean; code?: boolean }, size: number) {
    this.setFont(font, t, size)
    return this.pdf.getTextWidth(text)
  }

  /** Word-wraps runs into lines of at most `width`. */
  layout(runs: Run[], width: number, size: number, font: BaseFont, upper = false): Line[] {
    const toks: Tok[] = []
    for (const run of runs) {
      if (run.text === '\n') { toks.push({ text: '', w: 0, brk: true }); continue }
      const safe = pdfSafe(upper ? run.text.toUpperCase() : run.text)
      for (const part of safe.split(/(\s+)/)) {
        if (!part) continue
        const space = /^\s+$/.test(part)
        if (space && part.includes('\n') && run.code) { toks.push({ text: '', w: 0, brk: true }); continue }
        const text = space ? ' ' : part
        toks.push({ ...run, text, space, w: this.textWidth(text, font, run, size) })
      }
    }

    const lines: Line[] = []
    let cur: Line = { toks: [], width: 0 }
    let pendingSpace: Tok | null = null
    const newLine = () => { lines.push(cur); cur = { toks: [], width: 0 }; pendingSpace = null }
    const place = (t: Tok) => { cur.toks.push({ ...t, x: cur.width }); cur.width += t.w }

    for (const t of toks) {
      if (t.brk) { newLine(); continue }
      if (t.space) { if (cur.toks.length) pendingSpace = t; continue }
      const sp = pendingSpace as Tok | null
      const spaceW = sp ? sp.w : 0
      if (cur.toks.length && cur.width + spaceW + t.w > width) newLine()
      if (t.w > width) {
        // A word longer than the line (a long URL): break it by characters.
        let piece = ''
        for (const ch of t.text) {
          const w = this.textWidth(piece + ch, font, t, size)
          if (w > width - cur.width && piece) {
            place({ ...t, text: piece, w: this.textWidth(piece, font, t, size) })
            newLine()
            piece = ch
          } else piece += ch
        }
        if (piece) place({ ...t, text: piece, w: this.textWidth(piece, font, t, size) })
        continue
      }
      if (pendingSpace && cur.toks.length) place(pendingSpace)
      pendingSpace = null
      place(t)
    }
    if (cur.toks.length || lines.length === 0) lines.push(cur)
    return lines
  }

  /** Draws one laid-out line with its top at this.y. */
  drawLine(line: Line, x: number, size: number, lineHeight: number, font: BaseFont, color: Rgb, opts: { align?: Align; width?: number; linkColor?: Rgb } = {}) {
    const width = opts.width ?? line.width
    const off = opts.align === 'center' ? (width - line.width) / 2 : opts.align === 'right' ? width - line.width : 0
    const baseline = this.y + (lineHeight - size) / 2 + size * 0.8
    // Inline code backgrounds first, so they sit under the text.
    for (let i = 0; i < line.toks.length; i++) {
      const t = line.toks[i]
      if (!t.code || (t.space && (i === 0 || i === line.toks.length - 1))) continue
      const prevCode = i > 0 && line.toks[i - 1].code
      const nextCode = i < line.toks.length - 1 && line.toks[i + 1].code
      this.pdf.setFillColor(...C.codeBg)
      this.pdf.rect(x + off + t.x - (prevCode ? 0 : 2), baseline - size * 0.82, t.w + (prevCode ? 0 : 2) + (nextCode ? 0 : 2), size * 1.12, 'F')
    }
    for (const t of line.toks) {
      if (t.space) continue
      const tx = x + off + t.x
      this.setFont(font, t, size)
      const c = t.href ? (opts.linkColor ?? C.accent) : t.code ? C.codeText : color
      this.pdf.setTextColor(...c)
      this.pdf.text(t.text, tx, baseline)
      if (t.href) {
        this.pdf.setDrawColor(...c)
        this.pdf.setLineWidth(0.5)
        this.pdf.line(tx, baseline + 1.6, tx + t.w, baseline + 1.6)
        this.pdf.link(tx, baseline - size * 0.85, t.w, size * 1.15, { url: t.href })
      }
      if (t.strike) {
        this.pdf.setDrawColor(...c)
        this.pdf.setLineWidth(0.5)
        this.pdf.line(tx, baseline - size * 0.3, tx + t.w, baseline - size * 0.3)
      }
    }
  }

  /** Lines that may break across pages. */
  drawLines(lines: Line[], ctx: Ctx, lineHeight: number, color: Rgb = ctx.color) {
    for (const line of lines) {
      this.ensureRoom(lineHeight)
      this.drawLine(line, ctx.x, ctx.size, lineHeight, ctx.font, color)
      this.y += lineHeight
    }
  }

  image(img: PdfImage, x: number, maxW: number, align: Align = 'left') {
    let w = Math.min(maxW, img.width * 0.75)
    let h = w * (img.height / img.width)
    const maxH = (this.bottom - this.top) * 0.85
    if (h > maxH) { w *= maxH / h; h = maxH }
    this.begin(h)
    const ix = align === 'center' ? x + (maxW - w) / 2 : align === 'right' ? x + maxW - w : x
    this.pdf.addImage(img.dataUrl, img.format, ix, this.y, w, h)
    this.y += h
  }
}

// ---- Blocks -------------------------------------------------------------------------

function drawBlocks(L: PdfLayout, blocks: Block[], ctx: Ctx) {
  L.startContainer()
  for (const b of blocks) drawBlock(L, b, ctx)
}

function drawBlock(L: PdfLayout, b: Block, ctx: Ctx) {
  const lh = ctx.size * 1.58
  switch (b.kind) {
    case 'paragraph': {
      L.begin(lh)
      L.drawLines(L.layout(b.runs, ctx.width, ctx.size, ctx.font), ctx, lh)
      L.margin(0.85 * REM)
      return
    }
    case 'heading':
      drawHeading(L, b, ctx)
      return
    case 'list':
      if (b.ordered && !ctx.plain) drawCardList(L, b, ctx)
      else drawList(L, b, ctx)
      return
    case 'code':
      drawCode(L, b.lang, b.text, ctx)
      return
    case 'quote': {
      L.margin(0.5 * REM)
      L.openBox({ x: ctx.x, w: ctx.width, radius: 0, bar: { color: C.accent, width: 2.25 }, padTop: 0, padBottom: 0 }, lh)
      drawBlocks(L, b.blocks, { ...ctx, x: ctx.x + 11.25, width: ctx.width - 11.25, color: C.quote })
      L.closeBox()
      L.margin(0.5 * REM)
      return
    }
    case 'rule': {
      L.margin(0.9 * REM)
      L.begin(1)
      L.pdf.setDrawColor(...C.border)
      L.pdf.setLineWidth(0.75)
      L.pdf.line(ctx.x, L.y, ctx.x + ctx.width, L.y)
      L.y += 1
      L.margin(0.9 * REM)
      return
    }
    case 'table':
      drawTable(L, b, ctx)
      return
    case 'image': {
      const img = L.assets.get(`img:${b.src}`)
      L.margin(0.6 * REM)
      if (img) L.image(img, ctx.x, ctx.width)
      else {
        L.begin(lh)
        L.drawLines(L.layout([{ text: b.alt || 'Image', href: b.src }], ctx.width, ctx.size, ctx.font), ctx, lh)
      }
      L.margin(0.9 * REM)
      return
    }
    case 'diagram':
      drawDiagram(L, b.chart, ctx, b.label, b.caption)
      return
  }
}

function drawHeading(L: PdfLayout, b: Extract<Block, { kind: 'heading' }>, ctx: Ctx) {
  const runs = b.runs.map(r => ({ ...r, bold: true }))
  if (ctx.plain) {
    const size = ctx.size * (b.level <= 2 ? 1.25 : 1.1)
    L.margin(0.75 * REM)
    L.begin(size * 1.35)
    L.drawLines(L.layout(runs, ctx.width, size, ctx.font), { ...ctx, size }, size * 1.35)
    L.margin(0.35 * REM)
    return
  }
  const size = HEAD
  const lh = size * 1.3
  if (b.level === 2) {
    // Tinted band with an accent bar on the left, uppercase accent text.
    const padY = 0.45 * REM
    const padX = 0.75 * REM
    const lines = L.layout(runs, ctx.width - padX * 2, size, ctx.font, true)
    const h = lines.length * lh + padY * 2
    L.margin(1.4 * REM)
    L.begin(h)
    L.pdf.setFillColor(...C.h2Bg)
    L.pdf.roundedRect(ctx.x, L.y, ctx.width, h, 3.75, 3.75, 'F')
    L.pdf.rect(ctx.x, L.y, 6, h, 'F')
    L.pdf.setFillColor(...C.accent)
    L.pdf.rect(ctx.x, L.y, 2.25, h, 'F')
    const top = L.y
    L.y += padY
    for (const line of lines) {
      L.drawLine(line, ctx.x + padX, size, lh, ctx.font, C.accent)
      L.y += lh
    }
    L.y = top + h
    L.margin(0.6 * REM)
    return
  }
  const color = b.level === 3 ? C.h3 : C.text
  const [mt, mb] = b.level === 1 ? [1.2, 0.5] : b.level === 3 ? [0.9, 0.3] : [0.75, 0.25]
  L.margin(mt * REM)
  L.begin(lh)
  L.drawLines(L.layout(runs, ctx.width, size, ctx.font), { ...ctx, size }, lh, color)
  if (b.level === 1) {
    L.y += 0.3 * REM
    L.pdf.setDrawColor(...C.border)
    L.pdf.setLineWidth(0.75)
    L.pdf.line(ctx.x, L.y, ctx.x + ctx.width, L.y)
  }
  L.margin(mb * REM)
}

// A list whose items are all bare links (a sources list) shows as one row of links.
function linkOnly(items: Block[][]): Run[] | null {
  const runs: Run[] = []
  for (const item of items) {
    if (item.length !== 1 || item[0].kind !== 'paragraph') return null
    const own = item[0].runs.filter(r => r.text.trim())
    if (!own.length || !own.every(r => r.href)) return null
    if (runs.length) runs.push({ text: '      ' })
    runs.push(...item[0].runs)
  }
  return runs
}

function drawList(L: PdfLayout, b: Extract<Block, { kind: 'list' }>, ctx: Ctx, depth = 0) {
  const lh = ctx.size * 1.58
  const sources = b.ordered ? null : linkOnly(b.items)
  if (sources) {
    L.margin(0.4 * REM)
    L.begin(lh)
    L.drawLines(L.layout(sources, ctx.width, ctx.size, ctx.font), ctx, lh)
    L.margin(0.75 * REM)
    return
  }
  const indent = 1.25 * REM
  const inner: Ctx = { ...ctx, x: ctx.x + indent, width: ctx.width - indent }
  L.margin(depth ? 0.25 * REM : 0)
  b.items.forEach((item, i) => {
    L.begin(lh)
    const marker = b.ordered ? `${b.start + i}.` : depth ? '–' : '•'
    L.setFont(ctx.font, {}, ctx.size)
    L.pdf.setTextColor(...ctx.color)
    const mw = L.pdf.getTextWidth(marker)
    L.pdf.text(marker, inner.x - mw - 5, L.y + (lh - ctx.size) / 2 + ctx.size * 0.8)
    L.startContainer()
    for (const child of item) {
      if (child.kind === 'list' && !(child.ordered && !ctx.plain)) drawList(L, child, inner, depth + 1)
      else drawBlock(L, child, inner)
    }
    L.margin(i < b.items.length - 1 ? 0.25 * REM : 0.65 * REM)
  })
  L.margin(0.65 * REM)
}

// The chat's numbered list: each item a bordered card with a number badge.
function drawCardList(L: PdfLayout, b: Extract<Block, { kind: 'list' }>, ctx: Ctx) {
  const lh = ctx.size * 1.58
  const pad = 0.7 * REM
  const left = 2.9 * REM
  L.margin(0.5 * REM)
  b.items.forEach((item, i) => {
    const box = L.openBox({ x: ctx.x, w: ctx.width, stroke: C.border, radius: 6, padTop: pad, padBottom: pad }, lh)
    // Number badge.
    const num = String(b.start + i)
    L.setFont('helvetica', { bold: true }, REM)
    const tw = L.pdf.getTextWidth(num)
    const bw = Math.max(1.2 * REM + 0.7 * REM, tw + 0.7 * REM)
    const bh = REM + 0.4 * REM
    const bx = ctx.x + 0.7 * REM
    const by = box.top + pad - 1
    L.pdf.setFillColor(...C.olBadgeBg)
    L.pdf.setDrawColor(...C.olBadgeBorder)
    L.pdf.setLineWidth(0.75)
    L.pdf.roundedRect(bx, by, bw, bh, 3, 3, 'FD')
    L.pdf.setTextColor(...C.olBadgeText)
    L.pdf.text(num, bx + (bw - tw) / 2, by + bh / 2 + REM * 0.35)
    drawBlocks(L, item, { ...ctx, x: ctx.x + left, width: ctx.width - left - 0.9 * REM })
    L.closeBox()
    L.margin(0.5 * REM)
  })
  L.margin(0.75 * REM)
}

// A fenced code block: a bordered box with a language header bar.
function drawCode(L: PdfLayout, lang: string, text: string, ctx: Ctx) {
  const size = CODE
  const lh = size * 1.45
  const padY = 0.6 * REM
  const padX = 0.75 * REM
  const headerH = FOOTER * 1.2 + 0.6 * REM
  const lines: Line[] = []
  for (const raw of text.split('\n')) {
    lines.push(...L.layout([{ text: raw || ' ' }], ctx.width - padX * 2, size, 'courier'))
  }
  L.margin(0.5 * REM)
  L.begin(headerH + padY * 2 + lh * Math.min(2, lines.length))
  let first = true
  let i = 0
  while (i < lines.length || first) {
    // As many lines as fit on this page.
    const head = first ? headerH : 0
    const room = L.bottom - L.y - head - padY * 2
    const n = Math.max(1, Math.min(lines.length - i, Math.floor(room / lh)))
    const h = head + padY * 2 + n * lh
    const top = L.y
    L.pdf.setFillColor(...C.codeBlockBg)
    L.pdf.setDrawColor(...C.border)
    L.pdf.setLineWidth(0.75)
    L.pdf.roundedRect(ctx.x, top, ctx.width, h, 4.5, 4.5, 'FD')
    if (first) {
      L.pdf.setFillColor(...C.codeHeaderBg)
      L.pdf.roundedRect(ctx.x + 0.4, top + 0.4, ctx.width - 0.8, headerH, 4.5, 4.5, 'F')
      L.pdf.rect(ctx.x + 0.4, top + headerH / 2, ctx.width - 0.8, headerH / 2, 'F')
      L.pdf.setFont('courier', 'bold')
      L.pdf.setFontSize(FOOTER)
      L.pdf.setTextColor(...C.codeLang)
      L.pdf.text(pdfSafe(lang.toUpperCase()), ctx.x + padX, top + headerH / 2 + FOOTER * 0.35)
    }
    L.y = top + head + padY
    for (let k = 0; k < n && i < lines.length; k++, i++) {
      L.drawLine(lines[i], ctx.x + padX, size, lh, 'courier', C.text)
      L.y += lh
    }
    L.y = top + h
    first = false
    if (i < lines.length) L.newPage()
  }
  L.margin(0.5 * REM)
}

function drawTable(L: PdfLayout, b: Extract<Block, { kind: 'table' }>, ctx: Ctx) {
  const size = ctx.size * 0.9
  const lh = size * 1.4
  const padX = 0.75 * REM * 0.75
  const padHead = 0.45 * REM * 0.75
  const padCell = 0.4 * REM * 0.75
  const all = [b.head, ...b.rows].filter(r => r.length)
  const cols = Math.max(0, ...all.map(r => r.length))
  if (cols === 0) return

  // Column widths, like an auto-layout table at width 100%: each column's
  // single-line width, shrunk toward its longest word when they don't fit.
  const natural = new Array(cols).fill(0)
  const minimum = new Array(cols).fill(0)
  all.forEach((row, ri) => row.forEach((cell, c) => {
    const runs = ri === 0 && b.head.length ? cell.runs.map(r => ({ ...r, bold: true })) : cell.runs
    const one = L.layout(runs.map(r => ({ ...r, text: r.text.replace(/\n/g, ' ') })), 1e6, size, ctx.font)[0]
    natural[c] = Math.max(natural[c], one.width + padX * 2)
    const longest = Math.max(0, ...one.toks.filter(t => !t.space).map(t => t.w))
    minimum[c] = Math.max(minimum[c], Math.min(longest, ctx.width / cols) + padX * 2)
  }))
  const W = ctx.width
  const sumNat = natural.reduce((a, v) => a + v, 0)
  const sumMin = minimum.reduce((a, v) => a + v, 0)
  const widths = sumNat <= W
    ? natural.map(v => v * (W / sumNat))
    : sumMin >= W
      ? minimum.map(v => v * (W / sumMin))
      : minimum.map((v, c) => v + (natural[c] - v) * ((W - sumMin) / (sumNat - sumMin)))
  const xs = widths.reduce<number[]>((acc, w, c) => [...acc, acc[c] + w], [ctx.x])

  const measure = (row: Cell[], head: boolean) => {
    const lines = row.map((cell, c) => L.layout(head ? cell.runs.map(r => ({ ...r, bold: true })) : cell.runs, widths[c] - padX * 2, size, ctx.font))
    const pad = head ? padHead : padCell
    return { lines, h: Math.max(1, ...lines.map(l => l.length)) * lh + pad * 2, pad }
  }
  const head = b.head.length ? { cells: b.head, ...measure(b.head, true) } : null
  const rows = b.rows.map(r => ({ cells: r, ...measure(r, false) }))

  let segTop = 0
  const closeSegment = () => {
    L.pdf.setDrawColor(...C.border)
    L.pdf.setLineWidth(0.75)
    L.pdf.roundedRect(ctx.x, segTop, W, L.y - segTop, 6, 6, 'S')
  }
  const drawRow = (r: { cells: Cell[]; lines: Line[][]; h: number; pad: number }, fill: Rgb, isHead: boolean, firstInSeg: boolean, lastInSeg: boolean, border: Rgb | null) => {
    const top = L.y
    L.pdf.setFillColor(...fill)
    if (firstInSeg || lastInSeg) {
      L.pdf.roundedRect(ctx.x, top, W, r.h, 6, 6, 'F')
      if (!firstInSeg) L.pdf.rect(ctx.x, top, W, r.h / 2, 'F')
      if (!lastInSeg) L.pdf.rect(ctx.x, top + r.h / 2, W, r.h / 2, 'F')
    } else L.pdf.rect(ctx.x, top, W, r.h, 'F')
    r.cells.forEach((cell, c) => {
      L.y = top + r.pad
      for (const line of r.lines[c]) {
        L.drawLine(line, xs[c] + padX, size, lh, ctx.font, ctx.plain ? ctx.color : C.text, { align: cell.align, width: widths[c] - padX * 2 })
        L.y += lh
      }
    })
    L.y = top + r.h
    if (border && !lastInSeg) {
      L.pdf.setDrawColor(...border)
      L.pdf.setLineWidth(isHead ? 0.75 : 0.6)
      L.pdf.line(ctx.x, L.y, ctx.x + W, L.y)
    }
  }

  L.margin(0.6 * REM)
  L.begin((head?.h ?? 0) + (rows[0]?.h ?? 0))
  segTop = L.y
  if (head) drawRow(head, C.theadBg, true, true, rows.length === 0, C.border)
  rows.forEach((r, i) => {
    if (L.y + r.h > L.bottom && L.y > segTop + 1) {
      closeSegment()
      L.newPage()
      segTop = L.y
      if (head) drawRow(head, C.theadBg, true, true, false, C.border)
    }
    const last = i === rows.length - 1 || L.y + r.h + rows[i + 1].h > L.bottom
    drawRow(r, i % 2 === 1 ? C.zebra : C.tableBg, false, !head && L.y === segTop, last, C.tdBorder)
  })
  closeSegment()
  L.margin(0.9 * REM)
}

function drawDiagram(L: PdfLayout, chart: string, ctx: Ctx, label?: string, caption?: string) {
  const img = L.assets.get(`mmd:${chart}`)
  L.margin(0.5 * REM)
  if (label) {
    L.begin(FOOTER * 1.6)
    L.drawLines(L.layout([{ text: label.toUpperCase(), bold: true }], ctx.width, FOOTER, 'helvetica'), { ...ctx, size: FOOTER }, FOOTER * 1.6, C.muted)
  }
  // A chart that failed to render shows its source, as the chat does.
  if (img) L.image(img, ctx.x, ctx.width, 'center')
  else drawCode(L, 'mermaid', chart, ctx)
  if (caption) {
    L.margin(0.35 * REM)
    L.begin(FOOTER * 1.5)
    L.drawLines(L.layout([{ text: caption }], ctx.width, FOOTER, 'helvetica'), { ...ctx, size: FOOTER }, FOOTER * 1.5, C.muted)
  }
  L.margin(0.75 * REM)
}

function drawMeta(L: PdfLayout, text: string, ctx: Ctx, top = 0.35 * REM) {
  L.margin(top)
  L.begin(FOOTER * 1.5)
  L.drawLines(L.layout([{ text }], ctx.width, FOOTER, 'helvetica'), { ...ctx, size: FOOTER, font: 'helvetica' }, FOOTER * 1.5, C.muted)
}

// The user's message: a navy pill on the right, at most 70% wide.
function drawUserBubble(L: PdfLayout, text: string, x: number, width: number) {
  const padX = 1.15 * REM * 0.875
  const padY = 0.6 * REM * 0.875
  const lh = BODY * 1.5
  const maxW = width * 0.7
  const runs: Run[] = []
  text.split('\n').forEach((part, i) => { if (i) runs.push({ text: '\n' }); runs.push({ text: part || ' ' }) })
  const lines = L.layout(runs, maxW - padX * 2, BODY, 'helvetica')
  const bw = Math.min(maxW, Math.max(...lines.map(l => l.width)) + padX * 2)
  let i = 0
  L.begin(lh + padY * 2)
  while (i < lines.length) {
    const n = Math.max(1, Math.min(lines.length - i, Math.floor((L.bottom - L.y - padY * 2) / lh)))
    const h = n * lh + padY * 2
    const bx = x + width - bw
    const r = Math.min(h / 2, 15)
    L.pdf.setFillColor(...C.userBg)
    L.pdf.roundedRect(bx, L.y, bw, h, r, r, 'F')
    L.pdf.roundedRect(bx + bw - r, L.y + h - r, r, r, 4.5, 4.5, 'F') // the small bottom-right corner
    const top = L.y
    L.y += padY
    for (let k = 0; k < n; k++, i++) {
      L.drawLine(lines[i], bx + padX, BODY, lh, 'helvetica', C.userText, { linkColor: C.userText })
      L.y += lh
    }
    L.y = top + h
    if (i < lines.length) L.newPage()
  }
}

// A delegated worker's card: name and traits, what it was asked and the
// tools it used. Its own response is drawn only when `full` (the main agent
// wrote no report of its own), since otherwise the main agent's report
// already compiles what every worker found.
function drawWorker(L: PdfLayout, w: WorkerPdfData, ctx: Ctx, full: boolean) {
  const padY = 0.65 * REM
  const padX = 0.75 * REM
  L.margin(0.5 * REM)
  L.openBox({ x: ctx.x, w: ctx.width, stroke: C.workerBorder, radius: 4.5, bar: { color: C.accent, width: 1.5 }, padTop: padY, padBottom: padY }, REM * 1.5)
  const inner: Ctx = { x: ctx.x + padX + 1.5, width: ctx.width - padX * 2 - 1.5, size: BODY, color: C.text, font: 'courier', plain: true }
  const nameRuns: Run[] = [{ text: w.name, bold: true }]
  const nameLine = L.layout(nameRuns, inner.width, REM, 'courier')
  L.begin(REM * 1.4)
  L.drawLines(nameLine, { ...inner, size: REM }, REM * 1.4, C.accent)
  if (w.traits.length) {
    L.drawLines(L.layout([{ text: w.traits.join(' · '), italic: true }], inner.width, FOOTER, 'helvetica'), { ...inner, size: FOOTER, font: 'helvetica' }, FOOTER * 1.5, C.workerTraits)
  }
  if (w.task) {
    L.y += 2
    L.drawLines(L.layout([{ text: `Prompted: ${w.task}` }], inner.width, BODY, 'helvetica'), { ...inner, font: 'helvetica' }, BODY * 1.45, C.muted)
    if (full) L.y += 0.5 * REM
  }
  if (full) {
    L.startContainer()
    for (const chart of w.diagrams) drawDiagram(L, chart, inner)
    L.startContainer()
    drawBlocks(L, w.blocks, inner)
  }
  if (w.toolsUsed?.length) drawMeta(L, `Tools used: ${w.toolsUsed.join(', ')}`, { ...inner, font: 'helvetica' }, 0.5 * REM)
  L.closeBox()
  L.margin(0.25 * REM)
}

function formatMeta(msg: PdfMessage): string | null {
  const parts: string[] = []
  if (msg.toolCallCount) parts.push(`${msg.toolCallCount} tool call${msg.toolCallCount !== 1 ? 's' : ''}`)
  if (msg.durationSeconds !== undefined) parts.push(`${msg.durationSeconds}s`)
  if (msg.usage) {
    parts.push(`${(msg.usage.input_tokens + msg.usage.output_tokens).toLocaleString()} tokens (${msg.usage.input_tokens.toLocaleString()} in / ${msg.usage.output_tokens.toLocaleString()} out)`)
  }
  return parts.length ? parts.join(' · ') : null
}

// The agent's name as in the deploy header (uppercase, accent), then a meta line.
function drawTitle(L: PdfLayout, title: string, meta: string, ctx: Ctx) {
  L.begin(NAME * 1.25)
  L.drawLines(L.layout([{ text: title.toUpperCase() }], ctx.width, NAME, 'courier'), { ...ctx, size: NAME, font: 'courier' }, NAME * 1.25, C.accent)
  drawMeta(L, meta, ctx, 0)
}

function drawContextSection(L: PdfLayout, c: PdfAgentContext, ctx: Ctx) {
  const items = [
    c.model && `Model: ${c.model}`,
    c.location && `Location: ${c.location}`,
    c.keywords?.length && `Focus: ${c.keywords.join(', ')}`,
    c.personalityTraits?.length && `Personality: ${c.personalityTraits.join(', ')}`,
    c.behaviorToggles?.length && `Behaviour: ${c.behaviorToggles.join(', ')}`,
    c.tools?.length && `Tools (${c.tools.length}): ${c.tools.join(', ')}`,
  ].filter((v): v is string => Boolean(v))
  for (const item of items) drawMeta(L, item, ctx, 0.15 * REM)
  if (c.persona) {
    const traits = c.persona.traits.length ? ` (${c.persona.traits.join(', ')})` : ''
    drawBlock(L, { kind: 'heading', level: 3, runs: [{ text: `${c.persona.name}${traits}` }] }, ctx)
    if (c.persona.rationale) drawBlock(L, { kind: 'paragraph', runs: [{ text: c.persona.rationale }] }, ctx)
  }
  drawBlock(L, { kind: 'paragraph', runs: [{ text: c.purpose }] }, ctx)
  drawBlock(L, { kind: 'rule' }, ctx)
}

/** Builds the chat PDF and returns the jsPDF document without saving it (for preview-before-download). */
export async function buildChatPdf(title: string, messages: PdfMessage[], context?: PdfAgentContext): Promise<jsPDF> {
  const prepared = messages.map(msg => {
    const workers = msg.role === 'assistant' ? extractWorkers(msg.toolCalls) : []
    return {
      msg,
      blocks: msg.role === 'assistant' ? markdownBlocks(msg.content) : [],
      workers,
      // The main agent's reply is the compiled report. Only when it didn't
      // write one (a short reply, the same 400-character line the backend's
      // report nudge uses) are the workers' own findings printed instead.
      workersInFull: workers.length > 0 && msg.content.trim().length < 400,
    }
  })

  const diagrams = new Set<string>()
  const images = new Set<string>()
  for (const p of prepared) {
    collectAssets(p.blocks, diagrams, images)
    p.msg.diagrams?.forEach(d => diagrams.add(d))
    if (p.msg.planDiagram) diagrams.add(p.msg.planDiagram)
    if (p.msg.image) images.add(p.msg.image)
    if (p.workersInFull) {
      for (const w of p.workers) {
        w.diagrams.forEach(d => diagrams.add(d))
        collectAssets(w.blocks, diagrams, images)
      }
    }
  }
  const L = new PdfLayout(await loadAssets(diagrams, images))
  const ctx: Ctx = { x: PAGE_MARGIN, width: L.contentW, size: BODY, color: C.text, font: 'helvetica' }

  drawTitle(L, title, `Exported ${formatDate(new Date(), getDateFormat(), true)}`, ctx)
  if (context) drawContextSection(L, context, ctx)
  else drawBlock(L, { kind: 'rule' }, ctx)

  for (const { msg, blocks, workers, workersInFull } of prepared) {
    if (msg.role === 'user') {
      L.margin(30)
      const img = msg.image ? L.assets.get(`img:${msg.image}`) : null
      if (img) {
        L.image(img, ctx.x, Math.min(ctx.width * 0.7, 240), 'right')
        L.margin(6)
      }
      if (msg.content) drawUserBubble(L, msg.content, ctx.x, ctx.width)
      L.margin(REM)
      continue
    }
    L.margin(REM)
    if (msg.planDiagram) drawDiagram(L, msg.planDiagram, ctx, 'Plan', msg.planSummary)
    if (workers.length) {
      drawMeta(L, `Agents employed (${workers.length}): ${workers.map(w => w.name).join(', ')}`, ctx, 0)
      for (const w of workers) drawWorker(L, w, ctx, workersInFull)
      L.margin(0.75 * REM)
    }
    for (const chart of msg.diagrams ?? []) drawDiagram(L, chart, ctx)
    for (const blob of msg.jsonBlobs ?? []) drawCode(L, 'json', JSON.stringify(blob, null, 2), ctx)
    drawBlocks(L, blocks, ctx)
    const meta = formatMeta(msg)
    if (meta) drawMeta(L, meta, ctx)
    L.margin(REM)
  }
  return L.pdf
}

/**
 * A standalone report (Chat.tsx's "pdf" relic): rendered markdown drawn with
 * the same block layout as the chat export, minus the transcript.
 */
export async function buildReportPdf(title: string, contentEl: HTMLElement): Promise<jsPDF> {
  const blocks = parseBlocks(contentEl)
  const diagrams = new Set<string>()
  const images = new Set<string>()
  collectAssets(blocks, diagrams, images)
  const L = new PdfLayout(await loadAssets(diagrams, images))
  const ctx: Ctx = { x: PAGE_MARGIN, width: L.contentW, size: BODY, color: C.text, font: 'helvetica' }
  drawTitle(L, title, `Generated ${formatDate(new Date(), getDateFormat(), true)}`, ctx)
  drawBlock(L, { kind: 'rule' }, ctx)
  drawBlocks(L, blocks, ctx)
  return L.pdf
}
