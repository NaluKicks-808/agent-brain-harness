// Pure logic for the manager-console mod: no `$`, no I/O, so the tests can call it directly.
import type {
  ManagerAsk,
  ManagerBoard,
  ManagerCard,
  ManagerCardState,
  ManagerCodexJob,
  ManagerHelper,
  ManagerInboxKind,
  ManagerInboxReport,
  ManagerOutbound,
  ManagerRecordInfo,
  ManagerReport,
  ManagerReportKind,
  ManagerTail,
} from '../types'

export const DEFAULT_OPTIONS = ['Yes', 'No']
export const SEND_LIMIT = 10
export const SEND_WARN_AT = 8
export const WORKING_WINDOW_MS = 2 * 60 * 1000
/** owner, 2026-10-14 22:43: no idle pings; leads work to a /goal, then stop until the next job. */
export const IDLE_ALARM_WAKES = false
export const IDLE_ALARM_AFTER_MS = 2 * 60 * 60_000
export const IDLE_ALARM_EVERY_MS = 4 * 60 * 60_000
export const idleAlarmText = (leads: readonly string[]): string =>
  `Ready for 2 h: ${leads.join(', ')}. Find each lead's next authorized job and restart them.`
/** Board Skip answers an ask with its stated default. */
export const SKIP_ANSWER = 'Skip, use the default'
export const NEAR_DEADLINE_MS = 60 * 60 * 1000
/** Percentages of the reported context window (300k in the settings excerpt), ahead of native compaction at 95%. */
export const HANDOFF_AT = 88
export const POST_HANDOFF_COMPACT_AT = 92
export const COMPACT_AT = 94
export const COMPACT_SPACING_MS = 30 * 60_000
export const HANDOFF_WAIT_MS = 10 * 60_000
/** Assumed context window when the session's own figure is not known (claude-opus-5-5: 1M). */
export const DEFAULT_WINDOW = 1_000_000
export const GATE_RECHECK_MS = 60_000
export const GATE_TIMEOUT_MS = 10 * GATE_RECHECK_MS
export type Gate = { status: 'manager' | 'lead' | 'worker' | 'off' | 'unknown'; firstCheckedAt: number; leadSlug?: string; workerSlug?: string }

export const workerSlug = (title: string): string | undefined =>
  /^[A-Z][A-Za-z ]* ·/.test(title) && !title.startsWith('Lead · ')
    ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : undefined

export const handoffPath = (gate: Gate, cwd: string, configDir: string): string | undefined =>
  gate.status === 'manager' ? `${configDir}/harness/handoffs/manager.md`
    : gate.status === 'lead' && gate.leadSlug ? `${configDir}/harness/handoffs/${gate.leadSlug}.md`
      : gate.status === 'worker' && gate.workerSlug ? `${configDir}/harness/handoffs/${gate.workerSlug}.md` : undefined

export type CompactCycle = { nudgeAt: number; lastCompactAt: number; awaitDrop: boolean }
export const emptyCompactCycle = (): CompactCycle => ({ nudgeAt: 0, lastCompactAt: 0, awaitDrop: false })
export type CompactAction = 'none' | 'nudge' | 'compact' | 'check-file'
export function compactAction(cycle: CompactCycle, percent: number | undefined, now: number, idle: boolean): CompactAction {
  if (!idle || percent === undefined || cycle.awaitDrop) return 'none'
  if (now - cycle.lastCompactAt < COMPACT_SPACING_MS) return 'none'
  if (percent >= COMPACT_AT) return 'compact'
  if (percent < HANDOFF_AT) return 'none'
  if (!cycle.nudgeAt) return 'nudge'
  if (percent < POST_HANDOFF_COMPACT_AT) return 'none'
  return now - cycle.nudgeAt >= HANDOFF_WAIT_MS ? 'compact' : 'check-file'
}

export const allowedInstructionFile = (path: string, roots: readonly string[]): boolean =>
  path.startsWith('/') && /\.(md|txt)$/i.test(path) &&
  !path.split('/').some(part => part === '.' || part === '..') &&
  roots.some(root => path.startsWith(root.endsWith('/') ? root : `${root}/`))

export function leadSlug(title: string): string | undefined {
  if (!title.startsWith('Lead · ')) return undefined
  const slug = title.slice('Lead · '.length).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return slug || undefined
}

/** An exact desktop title is required; a missing title may arrive later. */
export function gateForTitle(title: string | undefined, firstCheckedAt: number, now: number, leadSlugs: readonly string[] = []): Gate {
  const candidate = title === undefined ? undefined : leadSlug(title)
  const slug = candidate && leadSlugs.includes(candidate) ? candidate : undefined
  const worker = title === undefined ? undefined : workerSlug(title)
  return {
    status: title === 'Manager' ? 'manager' : slug ? 'lead' : worker ? 'worker' : title ? 'off' : now - firstCheckedAt >= GATE_TIMEOUT_MS ? 'off' : 'unknown',
    firstCheckedAt,
    ...(slug ? { leadSlug: slug } : {}),
    ...(worker ? { workerSlug: worker } : {}),
  }
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`

const asString = (value: unknown): string => (typeof value === 'string' ? value : '')

// ─── The ask queue ──────────────────────────────────────────────────────────

export type AskInput = {
  id?: unknown
  text?: unknown
  default?: unknown
  options?: unknown
  session?: unknown
  file?: unknown
  meaning?: unknown
  deadlineAt?: unknown
}

export type AddAskResult =
  | { error: string }
  | { queue: ManagerAsk[]; ask: ManagerAsk; isNew: boolean }

/** Adds an ask, or replaces the open ask with the same id (keeping its place in line). */
export function addAsk(
  queue: readonly ManagerAsk[],
  input: AskInput,
  now: number,
  makeId: () => string,
  roots: readonly string[] = [],
): AddAskResult {
  const text = asString(input.text).trim()
  if (text === '') return { error: 'text is required: the question for owner.' }
  const rawOptions = Array.isArray(input.options) ? input.options : []
  const seen = new Set<string>()
  const options: string[] = []
  for (const one of rawOptions) {
    const label = clip(asString(one).trim(), 40)
    if (label === '' || ['later', 'reply', 'dismiss'].includes(label.toLowerCase()) || seen.has(label.toLowerCase())) continue
    seen.add(label.toLowerCase())
    options.push(label)
    if (options.length === 6) break
  }
  const chosen = options.length > 0 ? options : [...DEFAULT_OPTIONS]
  const fallback = asString(input.default).trim()
  if (fallback === '') return { error: 'default is required: what happens if owner does not answer.' }
  const wanted = asString(input.id).trim()
  const id = wanted !== '' ? clip(wanted, 64) : makeId()
  const session = asString(input.session).trim()
  const file = asString(input.file).trim()
  const meaning = asString(input.meaning).trim().replace(/\s+/g, ' ')
  const deadlineText = asString(input.deadlineAt)
  const deadline = input.deadlineAt === undefined ? undefined : /(?:Z|[+-]\d{2}:\d{2})$/i.test(deadlineText) ? Date.parse(deadlineText) : NaN
  if (deadline !== undefined && !Number.isFinite(deadline)) return { error: 'deadlineAt must be an ISO date and time with a time zone.' }
  if (input.file !== undefined && !allowedInstructionFile(file, roots)) return { error: 'file must be an absolute .md or .txt path under the approved folders.' }
  const existing = queue.find(one => one.id === id)
  const ask: ManagerAsk = {
    id,
    text: clip(text, 2000),
    default: clip(fallback, 400),
    options: chosen,
    askedAt: existing?.askedAt ?? now,
    ...(deadline !== undefined ? { deadlineAt: deadline } : existing?.deadlineAt !== undefined ? { deadlineAt: existing.deadlineAt } : {}),
    ...(session !== '' ? { session: clip(session, 200) } : {}),
    ...(file !== '' ? { file } : {}),
    ...(meaning !== '' ? { meaning: clip(meaning, 240) } : {}),
  }
  if (existing) {
    return { queue: queue.map(one => (one.id === id ? ask : one)), ask, isNew: false }
  }
  return { queue: [...queue, ask], ask, isNew: true }
}

export type BandItem = { kind: 'ask'; ask: ManagerAsk } | { kind: 'send'; card: ManagerOutbound }
export const bandKey = (item: BandItem): string => `${item.kind}:${item.kind === 'ask' ? item.ask.id : item.card.id}`

/** Shared queue: imminent deadlines first, then short sends, then other asks. */
export function bandQueue(asks: readonly ManagerAsk[], sends: readonly ManagerOutbound[], now: number): BandItem[] {
  const items: BandItem[] = [
    ...asks.map(ask => ({ kind: 'ask' as const, ask })),
    ...sends.map(card => ({ kind: 'send' as const, card })),
  ]
  const level = (item: BandItem) => item.kind === 'send' ? 1 : item.ask.deadlineAt !== undefined && item.ask.deadlineAt - now <= NEAR_DEADLINE_MS ? 0 : 2
  const deadline = (item: BandItem) => item.kind === 'ask' ? item.ask.deadlineAt ?? Infinity : Infinity
  const size = (item: BandItem) => item.kind === 'send' ? item.card.text.length : item.ask.text.length
  const age = (item: BandItem) => item.kind === 'ask' ? item.ask.askedAt : item.card.queuedAt
  return items.sort((a, b) => level(a) - level(b) ||
    (level(a) === 0 ? deadline(a) - deadline(b) : 0) ||
    size(a) - size(b) || age(a) - age(b) || bandKey(a).localeCompare(bandKey(b)))
}

/** Old Later options are omitted; the board has a separate Dismiss action. */
export const askAnswers = (ask: ManagerAsk): string[] => ask.options.filter(option =>
  !['later', 'dismiss', 'reply'].includes(option.trim().toLowerCase()))

export const dismissPrompt = (ask: ManagerAsk): string =>
  `Dismissed — ask ${ask.id}: dismissed by owner — "${clip(ask.text.replace(/\s+/g, ' '), 400)}"`
export function resolveAsk(
  queue: readonly ManagerAsk[],
  id: string,
): { queue: ManagerAsk[]; ask?: ManagerAsk } {
  const ask = queue.find(one => one.id === id)
  return { queue: queue.filter(one => one.id !== id), ask }
}

const startsWithWord = (text: string, word: string): boolean => {
  const head = text.trimStart().toLowerCase()
  const want = word.trim().toLowerCase()
  if (want === '' || !head.startsWith(want)) return false
  const after = head.charAt(want.length)
  return after === '' || !/[\p{L}\p{N}]/u.test(after)
}

/** Which of the ask's answers the prompt starts with (case-insensitive, whole word), if any. */
export function matchAnswer(prompt: string, ask: ManagerAsk): string | undefined {
  const longestFirst = askAnswers(ask).sort((a, b) => b.length - a.length)
  return longestFirst.find(option => startsWithWord(prompt, option))
}

/** The prompt a button press submits as owner's words: it starts with the answer. */
export function answerPrompt(ask: ManagerAsk, option: string): string {
  const question = clip(ask.text.replace(/\s+/g, ' '), 400)
  if (option === SKIP_ANSWER) return `${SKIP_ANSWER} (${ask.default}) — my answer to: "${question}"`
  return `${option} — my answer to: "${question}"`
}

/** The prompt sent when owner types directly into an ask card. */
export function typedAskPrompt(ask: ManagerAsk, words: string): string {
  return `Re: ${ask.text.replace(/\s+/g, ' ').slice(0, 80)} (ask ${ask.id}): ${words.trim()}`
}

// ─── Outbound send cards ────────────────────────────────────────────────────

export type DraftFile = { path: string; text: string }

/** Draft frontmatter uses scalar fields; the message body stays intact for owner review. */
export function draftCards(files: readonly DraftFile[], now: number): ManagerOutbound[] {
  const cards: ManagerOutbound[] = []
  for (const file of files) {
    if (!/^(?:drafts\/)?[^/]+\.md$/i.test(file.path)) continue
    const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(file.text)
    if (!match) continue
    const fields: Record<string, string> = {}
    for (const line of match[1].split(/\r?\n/)) {
      const field = /^(channel|to|to_handle|status):\s*(.*?)\s*$/.exec(line)
      if (!field) continue
      let value = field[2]
      if (value.startsWith('"') && value.endsWith('"')) {
        try { value = JSON.parse(value) } catch { continue }
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1).replace(/''/g, "'")
      } else {
        value = value.replace(/\s+#.*$/, '').trim()
      }
      fields[field[1]] = value
    }
    if (fields.status !== 'awaiting-owner') continue
    const body = match[2].trim()
    const lastParagraph = body.split(/\r?\n\s*\r?\n/).at(-1) ?? ''
    const text = /^_Why\b/.test(lastParagraph) ? body.slice(0, body.lastIndexOf(lastParagraph)).trim() : body
    if (!fields.channel || !fields.to || !text) continue
    cards.push({
      id: file.path.split('/').at(-1)!.replace(/\.md$/i, ''),
      channel: fields.channel === 'text' ? 'Text' : fields.channel === 'email' ? 'Gmail' : fields.channel,
      to: fields.to_handle ? `${fields.to} (${fields.to_handle})` : fields.to,
      text,
      queuedAt: now,
      source: 'draft',
    })
  }
  return cards
}

const normalizedDraftText = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Only cards owned by this sync may be changed or removed. Preserve queue age on edits. */
export function syncDrafts(current: ManagerOutbound[], drafts: readonly ManagerOutbound[]): ManagerOutbound[] {
  const byId = new Map(drafts.map(card => [card.id, card]))
  const next = current.filter(card => card.source !== 'draft' || byId.has(card.id)).map(card => {
    const draft = byId.get(card.id)
    if (card.source !== 'draft' || !draft ||
        (card.text === draft.text && card.channel === draft.channel && card.to === draft.to)) return card
    return { ...card, text: draft.text, channel: draft.channel, to: draft.to }
  })
  for (const draft of drafts) {
    const longest = draft.text.split(/\r?\n\s*\r?\n/).filter(p => !/^_Why\b/.test(p.trim()))
      .map(normalizedDraftText).sort((a, b) => b.length - a.length)[0] ?? ''
    if (next.some(card => card.id === draft.id || (longest !== '' && normalizedDraftText(card.text).includes(longest)))) continue
    next.push(draft)
  }
  return next.length === current.length && next.every((card, i) => card === current[i]) ? current : next
}

export type OutboundInput = { id?: unknown; channel?: unknown; to?: unknown; text?: unknown }

export type AddOutboundResult =
  | { error: string }
  | { list: ManagerOutbound[]; card: ManagerOutbound; isNew: boolean }

export function addOutbound(
  list: readonly ManagerOutbound[],
  input: OutboundInput,
  now: number,
  makeId: () => string,
): AddOutboundResult {
  const channel = asString(input.channel).trim()
  const to = asString(input.to).trim()
  // The text is kept exactly as given: the send guard compares it word for word.
  const text = asString(input.text)
  if (channel === '') return { error: 'channel is required (Chat, Gmail, ...).' }
  if (to === '') return { error: 'to is required: who receives it.' }
  if (text.trim() === '') return { error: 'text is required: the exact message.' }
  if (text.length > 20000) return { error: 'text is too long for a send card (20,000 characters at most).' }
  const wanted = asString(input.id).trim()
  const id = wanted !== '' ? clip(wanted, 64) : makeId()
  const existing = list.find(one => one.id === id)
  const card: ManagerOutbound = {
    id,
    channel: clip(channel, 60),
    to: clip(to, 120),
    text,
    queuedAt: existing?.queuedAt ?? now,
  }
  if (existing) return { list: list.map(one => (one.id === id ? card : one)), card, isNew: false }
  return { list: [...list, card], card, isNew: true }
}

const sendHead = (card: ManagerOutbound): string => `Send it — ${card.channel} to ${card.to}, exactly:`

/** What Send submits and Edit puts in the box: always the full exact text. */
export function sendPrompt(card: ManagerOutbound): string {
  return `${sendHead(card)} "${card.text}"`
}

/** True when a prompt owner submitted is this card's send (sent from the box after an Edit). */
export function isSendPromptFor(prompt: string, card: ManagerOutbound): boolean {
  return prompt.trimStart().toLowerCase().startsWith(sendHead(card).toLowerCase())
}

// ─── Prompts and messages ───────────────────────────────────────────────────

const NOT_OWNER = /^\s*(?:<task-notification|<system-reminder|Stop hook feedback:|Base directory for this skill:|\[SYSTEM NOTIFICATION|Caveat:|Another Claude session sent a message|The [\w-]+ plugin sent a message|Inbox: )/i

/**
 * owner's own words? Not a cross-session message, not a task notification, not a
 * system reminder (a prompt that is only reminders is not his), not a hook's note.
 */
export function isGenuinePromptText(text: string): boolean {
  if (text.includes('<cross-session-message')) return false
  const withoutReminders = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  if (withoutReminders === '') return false
  return !NOT_OWNER.test(withoutReminders)
}

/** The prompt origins that are owner typing (the desktop composer, or the phone bridge). */
export const isPersonOrigin = (kind: string): boolean => kind === 'composer' || kind === 'bridge'

/** Whether a SendMessage `to` names another Claude session rather than an in-process subagent. */
export function isSessionTarget(to: string, agentNames: readonly string[]): boolean {
  const target = to.trim()
  if (target === '' || target === 'main') return false
  if (/^(local_|session_|uds:)/.test(target)) return true
  return !agentNames.includes(target)
}

export type CrossSession = { sessionId?: string; name?: string; body: string }

const attr = (attrs: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)
  return m?.[1]
}

/** Reads a `<cross-session-message ...>` envelope: who sent it and its body. */
export function parseCrossSession(text: string): CrossSession | undefined {
  const m = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)(?:<\/cross-session-message>|$)/.exec(text)
  if (!m) return undefined
  const attrs = m[1] ?? ''
  const from = attr(attrs, 'from')
  const sessionId = attr(attrs, 'from-session') ?? (from?.startsWith('local_') ? from : undefined)
  const name = attr(attrs, 'from-name') ?? attr(attrs, 'name')
  return { sessionId, name, body: (m[2] ?? '').trim() }
}

const plain = (text: string): string =>
  text
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*#>]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The report's first lines, flattened: what an alert judges. */
export function reportHead(body: string): string {
  const lines = body.split('\n').map(line => line.trim()).filter(line => line !== '')
  return clip(plain(lines.slice(0, 2).join(' ')), 300)
}

/** The first sentence of a report, for the board card. */
export function firstSentence(body: string): string {
  const flat = plain(body.split('\n').find(line => line.trim() !== '') ?? '')
  const m = /^(.+?[.!?])(?:\s|$)/.exec(flat)
  return clip(m?.[1] ?? flat, 200)
}

const SHIPPED = /\b(shipped|ships|is live|now live|went live|live now|merged|landed)\b/i
// Verbs and states, not the topic: "sorting failures into outage or bad answer" is no breakage.
const BROKE = /\b(failed|fails|failing|blocked|refused|refuses|broken|broke)\b/gi
const NEGATED = /\b(no|not|nothing|none|never|without|zero|0)\s+(?:\S+\s+){0,1}$/i
const CONDITIONAL = /\b(if|unless|whether|in case|should)\s+(?:\S+\s+){0,3}$/i

/** Shipped, broke, or neither, from the report's first lines. "Broke" wins a tie. */
export function classifyReport(body: string): ManagerReportKind {
  const head = reportHead(body)
  for (const m of head.matchAll(BROKE)) {
    const before = head.slice(Math.max(0, (m.index ?? 0) - 40), m.index ?? 0)
    if (!NEGATED.test(before) && !CONDITIONAL.test(before)) return 'broke'
  }
  return SHIPPED.test(head) ? 'shipped' : null
}

export const hasQuestionForOwner = (body: string): boolean => /question for (?:the )?owner/i.test(body)

// ─── The Manager transcript, read incrementally ─────────────────────────────

export type Alert = { kind: 'shipped' | 'broke'; name: string; line: string }

type Row = {
  type?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  timestamp?: unknown
  origin?: { kind?: unknown; fromSession?: unknown; name?: unknown; body?: unknown; asUser?: unknown }
  message?: { content?: unknown }
}

type Block = { type?: unknown; text?: unknown; name?: unknown; input?: unknown }

const blocksOf = (content: unknown): Block[] =>
  Array.isArray(content) ? content.filter((b): b is Block => typeof b === 'object' && b !== null) : []

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : blocksOf(content)
        .filter(b => b.type === 'text')
        .map(b => asString(b.text))
        .join('\n')

export const emptyTail = (): ManagerTail => ({ offset: -1, msgs: 0, reports: {}, agentNames: [], seededAt: 0 })

const timeOf = (row: Row, fallback: number): number => {
  const parsed = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

/** Applies one transcript row: a report, a genuine prompt (count back to 0), or a send (+1). */
export function applyRow(tail: ManagerTail, row: Row, now: number, alerts: Alert[] | undefined): ManagerTail {
  if (row.isSidechain === true) return tail
  const content = row.message?.content
  if (row.type === 'user') {
    if (blocksOf(content).some(b => b.type === 'tool_result')) return tail
    const text = textOf(content)
    const originKind = asString(row.origin?.kind)
    const isPeer = originKind === 'peer' || originKind === 'peer-send-message'
    if (isPeer || text.includes('<cross-session-message')) {
      const parsed = parseCrossSession(text)
      const sessionId = asString(row.origin?.fromSession) || parsed?.sessionId || ''
      const body = parsed?.body ?? asString(row.origin?.body)
      if (sessionId === '' || body === '') return tail
      const name = asString(row.origin?.name) || parsed?.name || sessionId
      const kind = classifyReport(body)
      const report: ManagerReport = {
        sessionId,
        name: clip(name, 120),
        line: firstSentence(body),
        at: timeOf(row, now),
        kind,
        hasQuestion: hasQuestionForOwner(body),
      }
      if (alerts && kind) alerts.push({ kind, name: report.name, line: clip(reportHead(body), 160) })
      return { ...tail, reports: { ...tail.reports, [sessionId]: report } }
    }
    if (row.isMeta === true) return tail
    const isPerson = originKind === 'human' || originKind === 'composer' || originKind === 'bridge' || originKind === '' ||
      (originKind === 'plugin' && row.origin?.name === 'manager-console' && row.origin?.asUser === true)
    if (isPerson && isGenuinePromptText(text)) return { ...tail, msgs: 0 }
    return tail
  }
  if (row.type === 'assistant') {
    let next = tail
    for (const block of blocksOf(content)) {
      if (block.type !== 'tool_use') continue
      const input = (typeof block.input === 'object' && block.input !== null ? block.input : {}) as Record<string, unknown>
      if (block.name === 'Agent' && asString(input.name) !== '') {
        const agentNames = [...next.agentNames.filter(n => n !== input.name), asString(input.name)].slice(-50)
        next = { ...next, agentNames }
      } else if (block.name === 'SendMessage' && isSessionTarget(asString(input.to), next.agentNames)) {
        next = { ...next, msgs: next.msgs + 1 }
      } else if (block.name === 'mcp__ccd_session_mgmt__send_message') {
        next = { ...next, msgs: next.msgs + 1 }
      }
    }
    return next
  }
  return tail
}

/** Applies a run of complete JSONL lines; bad lines are skipped. */
export function applyChunk(tail: ManagerTail, chunk: string, now: number, alerts: Alert[] | undefined): ManagerTail {
  let next = tail
  for (const line of chunk.split('\n')) {
    if (line.trim() === '') continue
    let row: Row
    try {
      row = JSON.parse(line) as Row
    } catch {
      continue
    }
    if (typeof row !== 'object' || row === null) continue
    next = applyRow(next, row, now, alerts)
  }
  return next
}

// ─── Session records and the board ──────────────────────────────────────────

const ROLE_SEP = ' · '

export function roleOf(title: string): { role: string; short: string } | undefined {
  const at = title.indexOf(ROLE_SEP)
  if (at <= 0) return undefined
  return { role: title.slice(0, at).trim(), short: title.slice(at + ROLE_SEP.length).trim() }
}

/** The folder name the CLI keeps a session's transcript under, from its working directory. */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

export function recordInfo(json: unknown, mtimeMs: number): ManagerRecordInfo | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const r = json as Record<string, unknown>
  const summary = r.postTurnSummary as Record<string, unknown> | undefined
  const info: ManagerRecordInfo = {
    mtimeMs,
    archived: r.isArchived === true,
    title: asString(r.title),
    sessionId: asString(r.sessionId),
    cliSessionId: asString(r.cliSessionId),
    cwd: asString(r.cwd),
    lastActivityAt: typeof r.lastActivityAt === 'number' ? r.lastActivityAt : mtimeMs,
    summary: clip(asString(summary?.status_detail), 200),
  }
  return info.sessionId === '' ? undefined : info
}

export function codexJobInfo(json: unknown): ManagerCodexJob | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const j = json as Record<string, unknown>
  const id = asString(j.id)
  if (id === '') return undefined
  const started = Date.parse(asString(j.startedAt) || asString(j.createdAt))
  const label = asString(j.kindLabel) || asString(j.title) || 'Codex job'
  return {
    id,
    label: clip(label, 40),
    summary: clip(plain(asString(j.summary)), 120),
    status: asString(j.status),
    phase: asString(j.phase),
    startedAt: Number.isFinite(started) ? started : 0,
    ...(asString(j.sessionId) !== '' ? { sessionId: asString(j.sessionId) } : {}),
  }
}

const DONE = new Set(['completed', 'complete', 'done', 'failed', 'cancelled', 'canceled', 'error', 'errored', 'stopped'])
export const isRunningJob = (job: ManagerCodexJob): boolean => !DONE.has(job.status.toLowerCase())

/** Whether an open ask is about this card's session. */
export function askNamesCard(ask: ManagerAsk, card: Pick<ManagerCard, 'sessionId' | 'cliSessionId' | 'title' | 'shortTitle'>): boolean {
  const names = [card.sessionId, card.cliSessionId, card.title, card.shortTitle].map(n => n.toLowerCase()).filter(n => n !== '')
  const session = (ask.session ?? '').toLowerCase()
  if (session !== '' && names.some(n => n === session)) return true
  const text = ask.text.toLowerCase()
  if (card.title !== '' && text.includes(card.title.toLowerCase())) return true
  return card.shortTitle.length >= 8 && text.includes(card.shortTitle.toLowerCase())
}

/** Context fill as a whole percentage: input + cache read + cache creation tokens over the window. */
export function contextPercent(tokens: number, window: number): number | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0 || !Number.isFinite(window) || window <= 0) return undefined
  return Math.min(100, Math.round((tokens / window) * 100))
}

/** "claude-opus-5-5[1m]" and "claude-opus-5-5" are one model for the window. */
export const sameModel = (a: string, b: string): boolean =>
  a !== '' && b !== '' && a.replace(/\[.*\]$/, '') === b.replace(/\[.*\]$/, '')

export const isHandoffDue = (percent: number | undefined): boolean => percent !== undefined && percent >= HANDOFF_AT

export type BoardInputs = {
  records: readonly ManagerRecordInfo[]
  transcriptMtimes: Readonly<Record<string, number>>
  reports: Readonly<Record<string, ManagerReport>>
  asks: readonly ManagerAsk[]
  jobs: readonly ManagerCodexJob[]
  managerCliId: string
  now: number
  /** Context fill by cli session id. */
  ctx?: Readonly<Record<string, number>>
  /** Unread inbox reports. */
  inbox?: readonly ManagerInboxReport[]
  latestInbox?: readonly ManagerInboxReport[]
  helpers?: Readonly<Record<string, ManagerHelper[]>>
}

export const isStalledCard = (card: ManagerCard): boolean =>
  card.state === 'idle' && (card.codex.length > 0 || card.report?.kind === 'broke' || (card.inbox ?? []).some(one => one.kind === 'break'))

export const boardGroup = (card: ManagerCard): 'needs-you' | 'stalled' | 'leads' | 'workers' =>
  card.state === 'needs you' || card.state === 'needs owner' ? 'needs-you' : isStalledCard(card) ? 'stalled' : card.isLead ? 'leads' : 'workers'

/** Presentation order only; does not change lead states or wake rules. */
export const leadDisplayState = (card: ManagerCard): string => {
  const latestInbox = [...(card.inbox ?? [])].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  const broke = latestInbox && latestInbox.mtimeMs >= (card.report?.at ?? 0)
    ? latestInbox.kind === 'break' : card.report?.kind === 'broke'
  if (broke) return 'Broke'
  if (isStalledCard(card)) return 'Stalled'
  if (card.state === 'working' || card.state === 'running') return 'Working'
  if (card.state === 'needs owner' || card.state === 'needs you') return 'Waiting on you'
  if (card.state === 'waiting on') return 'Waiting'
  if (card.state === 'budget-paused') return 'Waiting on budget'
  return 'Idle'
}
export const sortedLeads = (cards: readonly ManagerCard[]): ManagerCard[] => {
  const rank = (card: ManagerCard) => {
    const state = leadDisplayState(card)
    return state === 'Broke' || state === 'Stalled' ? 0 : state === 'Working' ? 1 : state.startsWith('Waiting') ? 2 : 3
  }
  return cards.filter(card => card.isLead).sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title))
}
export const leadSummary = (card: ManagerCard): string => {
  const latest = [...(card.inbox ?? [])].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  const note = latest && latest.mtimeMs >= (card.report?.at ?? 0) ? latest.line : card.report?.line
  const helpers = (card.helpers ?? []).filter(helper => helper.status === 'running').length + card.codex.length
  return `${card.title} · ${leadDisplayState(card)} · ${clip(note || card.summary || 'No update yet', 100)} · ${helpers} helper${helpers === 1 ? '' : 's'}`
}

const GROUP_ORDER = { 'needs-you': 0, stalled: 1, leads: 2, workers: 3 }

/** Open worker sessions plus running jobs/helpers; completed history does not inflate the count. */
export const workerCount = (board: ManagerBoard): number => board.cards.filter(card => !card.isLead).length
  + board.cards.reduce((n, card) => n + (card.helpers ?? []).filter(helper => helper.status === 'running').length + card.codex.length, 0)
  + board.otherJobs.length

export function buildBoard(input: BoardInputs): ManagerBoard {
  const running = input.jobs.filter(isRunningJob)
  const cards: ManagerCard[] = []
  for (const record of input.records) {
    if (record.archived || record.cliSessionId === input.managerCliId || record.title === 'Manager') continue
    const role = roleOf(record.title)
    if (!role) continue
    const base = {
      sessionId: record.sessionId,
      cliSessionId: record.cliSessionId,
      title: record.title,
      shortTitle: role.short,
    }
    const report = input.reports[record.sessionId]
    const isAsked = input.asks.some(ask => askNamesCard(ask, base))
    const mtime = input.transcriptMtimes[record.cliSessionId] ?? 0
    const inbox = (input.inbox ?? []).filter(one => inboxMatchesCard(one, base))
    const latest = (input.latestInbox ?? input.inbox ?? []).filter(one => inboxMatchesCard(one, base))
      .reduce<ManagerInboxReport | undefined>((best, one) => !best || one.mtimeMs > best.mtimeMs ? one : best, undefined)
    const cardJobs = running.filter(job => job.sessionId === record.cliSessionId)
    const isLead = role.role.toLowerCase() === 'lead'
    const helpers = isLead ? input.helpers?.[record.cliSessionId] ?? [] : []
    const isRunning = helpers.some(helper => helper.status === 'running') || cardJobs.length > 0 || input.now - mtime < WORKING_WINDOW_MS
    const wakeAt = isLead && !isRunning && latest ? statedWakeAt(latest.line, latest.mtimeMs) : undefined
    const overdue = wakeAt !== undefined && input.now > wakeAt + OVERDUE_GRACE_MS && mtime < wakeAt
    const state: ManagerCardState = isLead
      ? isRunning ? 'running'
        : overdue ? 'ready'
        : latest?.signal === 'needs owner' && isAsked ? 'needs owner'
          : latest?.signal === 'waiting on' ? 'waiting on'
            : latest?.signal === 'budget-paused' ? 'budget-paused' : 'ready'
      : isAsked || report?.hasQuestion === true || inbox.some(one => one.kind === 'needs-owner')
        ? 'needs you' : input.now - mtime < WORKING_WINDOW_MS ? 'working' : 'idle'
    cards.push({
      ...base,
      role: role.role,
      isLead,
      state,
      ...(report ? { report } : {}),
      ...(record.summary !== '' ? { summary: record.summary } : {}),
      lastActiveAt: Math.max(record.lastActivityAt, mtime),
      ...(overdue ? { overdueSince: wakeAt } : {}),
      codex: cardJobs,
      ...(helpers.length ? { helpers } : {}),
      ...(input.ctx?.[record.cliSessionId] !== undefined ? { ctxPercent: input.ctx[record.cliSessionId] } : {}),
      ...(inbox.length > 0 ? { inbox } : {}),
    })
  }
  cards.sort((a, b) => GROUP_ORDER[boardGroup(a)] - GROUP_ORDER[boardGroup(b)] || b.lastActiveAt - a.lastActiveAt)
  const shown = new Set(cards.map(card => card.cliSessionId))
  const otherJobs = running.filter(job => job.sessionId === undefined || !shown.has(job.sessionId))
  const claimed = new Set(cards.flatMap(card => (card.inbox ?? []).map(one => one.file)))
  const inboxOther = (input.inbox ?? []).filter(one => !claimed.has(one.file))
  const finishedJobs = input.jobs.filter(job => !isRunningJob(job))
  return { cards, otherJobs, finishedJobs, scannedAt: input.now, ...(inboxOther.length > 0 ? { inboxOther } : {}) }
}

// ─── The inbox: reports sessions drop as files when their messages run out ──

export const WAKE_EVERY_MS = 5 * 60 * 1000

/** "2026-10-12-1641-Lead · Research phases 1–4.md" → its stamp and session title. */
export function parseInboxName(file: string): { stamp?: string; title: string } {
  const base = file.replace(/\.md$/i, '')
  const m = /^(\d{4}-\d{2}-\d{2}-\d{4})[-_ ]+(.*)$/.exec(base)
  return m ? { stamp: m[1], title: (m[2] ?? '').trim() } : { title: base.trim() }
}

const INBOX_KINDS: [RegExp, ManagerInboxKind][] = [
  [/^(ship|shipped|ships)\b/i, 'ship'],
  [/^(break|broke|broken|breaks)\b/i, 'break'],
  [/^needs?[\s-]+(?:the[\s-]+)?owner\b/i, 'needs-owner'],
  [/^fyi\b/i, 'fyi'],
]

/** The report's first non-empty line and what it says it is: ship / break / needs owner / FYI. */
export function parseInboxFirstLine(text: string): { kind: ManagerInboxKind; line: string } {
  const first = text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
  const line = clip(first.replace(/^[#>*\-\s]+/, '').replace(/\*\*|__|`/g, '').trim(), 200)
  const bare = line.replace(/^\[|^\(/, '')
  const kind = INBOX_KINDS.find(([pattern]) => pattern.test(bare))?.[1] ?? 'other'
  return { kind, line }
}

export const OVERDUE_GRACE_MS = 5 * 60_000

/** A stated UTC resume time, using the next such moment after the report. */
export function statedWakeAt(line: string, mtimeMs: number): number | undefined {
  const m = /\b(?:until|after|at|resets?)\s+(\d{1,2}):(\d{2})\s*UTC\b/i.exec(line)
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined
  const d = new Date(mtimeMs)
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), Number(m[1]), Number(m[2]))
  if (at < mtimeMs - 60 * 60_000) at += 24 * 60 * 60_000
  return at
}

/** The newest report's first line gives a lead's blocking reason. */
export function reportSignal(line: string): ManagerInboxReport['signal'] {
  if (/\bneeds?\s+(?:the\s+)?owner\b/i.test(line)) return 'needs owner'
  if (/\bwaiting\s+on\b/i.test(line)) return 'waiting on'
  if (/\bbudget\b|\bqueued\s+for\b/i.test(line)) return 'budget-paused'
  return undefined
}

export function inboxReport(file: string, text: string, mtimeMs: number): ManagerInboxReport {
  const { kind, line } = parseInboxFirstLine(text)
  return { file, title: parseInboxName(file).title, kind, line, mtimeMs, ...(reportSignal(line) ? { signal: reportSignal(line) } : {}) }
}

const squash = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** A report belongs to the card whose title its file name carries (spacing and marks ignored). */
export function inboxMatchesCard(report: ManagerInboxReport, card: Pick<ManagerCard, 'title' | 'shortTitle'>): boolean {
  const title = squash(report.title)
  if (title === '') return false
  const full = squash(card.title)
  const short = squash(card.shortTitle)
  const core = squash(card.shortTitle.replace(/\([^)]*\)/g, ' '))
  return title === full || (short.length >= 6 && (title === short || title.endsWith(short))) ||
    (core.length >= 6 && (title === core || title.endsWith(core)))
}

/** The three alert kinds; FYI and anything else stay quiet. */
export function inboxAlert(report: ManagerInboxReport): string | undefined {
  const who = report.title || report.file
  if (report.kind === 'ship') return `Shipped · ${who}: ${report.line}`
  if (report.kind === 'break') return `Problem · ${who}: ${report.line}`
  if (report.kind === 'needs-owner') return `Needs you · ${who}: ${report.line}`
  return undefined
}

/** "Inbox: <first line> (<file name>)", several joined into one wake. */
export function wakeText(reports: readonly ManagerInboxReport[]): string {
  const shown = reports.slice(0, 5).map(one => `${one.line} (${one.file})`)
  const more = reports.length > 5 ? ` · and ${reports.length - 5} more` : ''
  return `Inbox: ${shown.join(' · ')}${more}`
}

export const leadWakeText = (reports: readonly ManagerInboxReport[]): string =>
  `Worker report: ${reports.map(one => `${one.line} (${one.file})`).join(' · ')}`

export type WakePlan = { wake: { lastAt: number; pending: string[]; seen: string[] }; text?: string; heldBy?: string }

/**
 * Whether to wake the Manager now. Pending reports already read (moved out) are dropped;
 * one wake names every report still waiting; at most one wake per five minutes; never while
 * a turn runs or owner has a draft in the box.
 */
export function planWake(
  wake: { lastAt: number; pending: readonly string[]; seen: readonly string[] },
  unread: readonly ManagerInboxReport[],
  now: number,
  isTurnRunning: boolean,
  isTyping: boolean,
  format: (reports: readonly ManagerInboxReport[]) => string = wakeText,
): WakePlan {
  const byFile = new Map(unread.map(one => [one.file, one]))
  const pending = wake.pending.filter(file => byFile.has(file))
  const kept = { ...wake, pending: [...pending], seen: [...wake.seen] }
  if (pending.length === 0) return { wake: kept }
  if (isTurnRunning) return { wake: kept, heldBy: 'a turn is running' }
  if (isTyping) return { wake: kept, heldBy: 'owner is typing' }
  if (now - wake.lastAt < WAKE_EVERY_MS) return { wake: kept, heldBy: 'woke under five minutes ago' }
  const reports = pending.flatMap(file => byFile.get(file) ?? []).sort((a, b) => a.mtimeMs - b.mtimeMs)
  return { wake: { ...kept, lastAt: now, pending: [] }, text: format(reports) }
}

/** Only actionable new reports join pending; every new report joins seen. */
export const wakesManager = (report: ManagerInboxReport): boolean =>
  report.kind === 'break' || report.kind === 'needs-owner' || /^needs?\b/i.test(report.line) || /\?/.test(report.line)

export function noteInbox(
  wake: { lastAt: number; pending: readonly string[]; seen: readonly string[] },
  unread: readonly ManagerInboxReport[],
  wakes: (report: ManagerInboxReport) => boolean = () => true,
): { wake: { lastAt: number; pending: string[]; seen: string[] }; fresh: ManagerInboxReport[] } {
  const seen = new Set(wake.seen)
  const fresh = unread.filter(one => !seen.has(one.file))
  const names = new Set(unread.map(one => one.file))
  return {
    wake: {
      lastAt: wake.lastAt,
      pending: [...wake.pending.filter(file => names.has(file)), ...fresh.filter(wakes).map(one => one.file)],
      seen: [...wake.seen.filter(file => names.has(file)), ...fresh.map(one => one.file)].slice(-500),
    },
    fresh,
  }
}

export type IdleAlarm = { idleSince: number; lastAt: number; readySince?: Record<string, number> }
export const emptyIdleAlarm = (): IdleAlarm => ({ idleSince: 0, lastAt: 0, readySince: {} })

/** Each unpaused ready lead gets its own two hour timer, even when another lead is running. */
export function idleAlarmPlan(
  board: ManagerBoard | null, alarm: IdleAlarm, now: number,
  shares: Readonly<Record<string, BudgetPct>> = {},
): { alarm: IdleAlarm; holds: boolean; due: boolean; leads: string[] } {
  const ready = (board?.cards ?? []).filter(card => {
    const share = shares[budgetLeadName(card.title)]
    return card.isLead && card.state === 'ready' && !(share?.codexPct === 0 && share.claudePct === 0)
  })
  const readySince: Record<string, number> = {}
  for (const card of ready) {
    readySince[card.cliSessionId] = card.overdueSince !== undefined
      ? Math.min(card.overdueSince - IDLE_ALARM_AFTER_MS, alarm.readySince?.[card.cliSessionId] || now)
      : alarm.readySince?.[card.cliSessionId] ||
      (card.lastActiveAt > 0 ? Math.min(now, card.lastActiveAt + WORKING_WINDOW_MS) : now)
  }
  const overdueNew = ready.some(card => card.overdueSince !== undefined && alarm.lastAt < card.overdueSince)
  const dueLeads = ready.filter(card => now - readySince[card.cliSessionId]! >= IDLE_ALARM_AFTER_MS)
    .map(card => card.title)
  const idleSince = Object.keys(readySince).length ? Math.min(...Object.values(readySince)) : 0
  const holds = dueLeads.length > 0
  return {
    alarm: { ...alarm, idleSince, readySince },
    holds,
    due: holds && (alarm.lastAt === 0 || overdueNew || now - alarm.lastAt >= IDLE_ALARM_EVERY_MS),
    leads: dueLeads,
  }
}

// ─── The status line ────────────────────────────────────────────────────────

export function formatCount(n: number): string {
  const sign = n < 0 ? '-' : ''
  const digits = String(Math.round(Math.abs(n)))
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export type StatusInputs = {
  board: ManagerBoard | null
  asks: readonly ManagerAsk[]
  msgs: number | undefined
  ghLeft: number | undefined
  next: { date: string; label: string } | undefined
  /** The Manager's own context fill, 0-100. */
  selfCtx?: number
  /** Unread inbox reports. */
  reports?: number
  idleAlarm?: boolean
  lastCompactAt?: number
  now?: number
  nextCompactAt?: number
}

/** "ctx 41%" or, from HANDOFF_AT, "⚠ ctx 88% handoff due". */
export function ctxLabel(percent: number): string {
  return isHandoffDue(percent) ? `⚠ ctx ${percent}% handoff due` : `ctx ${percent}%`
}

/**
 * Needs-you count: every open ask, plus each card asking a question (in a report or an unread
 * "needs owner" inbox file) that no ask covers, plus unclaimed "needs owner" inbox files.
 */
export function needsYouCount(board: ManagerBoard | null, asks: readonly ManagerAsk[]): number {
  const extra = (board?.cards ?? []).filter(
    card =>
      (card.report?.hasQuestion === true || (card.inbox ?? []).some(one => one.kind === 'needs-owner')) &&
      !asks.some(ask => askNamesCard(ask, card)),
  ).length
  const loose = (board?.inboxOther ?? []).filter(one => one.kind === 'needs-owner').length
  return asks.length + extra + loose
}

/** Quarter pie for a usage percent: ○ only at 0, ● only at 100, else ◔ ◑ ◕ by nearest quarter. */
export function pieGlyph(percent: number): string {
  if (percent <= 0) return '○'
  if (percent >= 100) return '●'
  return ['◔', '◑', '◕'][Math.max(1, Math.min(3, Math.round(percent / 25))) - 1]
}

export type CmuxStatusInputs = {
  /** Input tokens of the last response. */
  ctxTokens?: number
  /** The auto-compact window the bar measures against (autoCompactWindow, 300k). */
  ctxLimit: number
  /** five_hour and seven_day percents used, 0-100, when the API reported them. */
  fiveHour?: number
  week?: number
}

/** cmux footer stats (owner, 2026-10-20): "ctx ▓▓▓░░░░ 41% · ◕ wk 93% · ◔ 5h 7%". */
export function cmuxStatus(input: CmuxStatusInputs): string {
  const parts: string[] = []
  if (input.ctxTokens === undefined || input.ctxLimit <= 0) parts.push('ctx …')
  else {
    const p = Math.max(0, Math.min(100, Math.round(input.ctxTokens / input.ctxLimit * 100)))
    const cells = Math.round(p / 100 * 7)
    parts.push(`ctx ${'▓'.repeat(cells)}${'░'.repeat(7 - cells)} ${p}%`)
  }
  const pct = (n: number) => Math.round(n)
  if (input.week !== undefined) parts.push(`${pieGlyph(input.week)} wk ${pct(input.week)}%`)
  if (input.fiveHour !== undefined) parts.push(`${pieGlyph(input.fiveHour)} 5h ${pct(input.fiveHour)}%`)
  return parts.join(' · ')
}

/** The prompt hint with the cmux stats after it; the "(shift+tab to cycle)" reminder gives up its room. */
export function hintWithStats(hint: string, stats: string): string {
  const kept = hint.replace(/\s*\(shift\+tab to cycle\)/, '').trim()
  return kept ? `${kept} · ${stats}` : stats
}

export function statusLine(input: StatusInputs): string {
  const parts: string[] = ['Team board: /board']
  if (input.board) {
    const leads = input.board.cards.filter(card => card.isLead).length
    const workers = workerCount(input.board)
    parts.push(`${leads} lead${leads === 1 ? '' : 's'}`)
    if (workers > 0) parts.push(`${workers} worker${workers === 1 ? '' : 's'}`)
    parts.push(`${input.board.cards.filter(card => card.state === 'working' || card.state === 'running').length} working`)
    if (input.idleAlarm) parts.push('lead ready 2h')
  }
  const needs = needsYouCount(input.board, input.asks)
  if (needs > 0) parts.push(`${needs} needs you`)
  if ((input.reports ?? 0) > 0) parts.push(`${input.reports} report${input.reports === 1 ? '' : 's'}`)
  if (input.msgs !== undefined) {
    const shown = Math.min(input.msgs, SEND_LIMIT)
    const more = input.msgs > SEND_LIMIT ? '+' : ''
    parts.push(input.msgs >= SEND_WARN_AT ? `⚠ msgs ${shown}${more}/${SEND_LIMIT}` : `msgs ${shown}/${SEND_LIMIT}`)
  }
  if (input.selfCtx !== undefined) parts.push(ctxLabel(input.selfCtx))
  if (input.nextCompactAt !== undefined) {
    parts.push(input.lastCompactAt && input.now ? `compacted ${ago(Math.max(0, input.now - input.lastCompactAt))} ago` : 'last compact unknown')
    parts.push(`next threshold ${input.nextCompactAt}%${input.nextCompactAt === HANDOFF_AT ? ' handoff' : ' compact'}`)
  }
  if (input.ghLeft !== undefined) parts.push(`GH ${formatCount(input.ghLeft)} min left`)
  if (input.next) parts.push(`next: ${shortDay(input.next.date)} ${input.next.label}`)
  return parts.join(' · ')
}

// ─── Daily budget reservations ─────────────────────────────────────────────
export type BudgetSide = 'codex' | 'claude'
export type BudgetPct = { codexPct: number; claudePct: number }
export type BudgetLead = { reserved: BudgetPct; spent: BudgetPct; jobs: Record<string, { side: BudgetSide; reserved: number; spent: number }> }
export type BudgetLedger = { shares: Record<string, BudgetPct>; days: Record<string, Record<string, BudgetLead>> }
export type LeadsConfig = { leads: { title: string; slug: string; codexPct: number; claudePct: number }[]; manager?: BudgetPct }
export function sharesFromConfig(config: LeadsConfig): Record<string, BudgetPct> {
  const shares: Record<string, BudgetPct> = {}
  for (const lead of config.leads) {
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lead.slug) &&
        lead.slug === leadSlug(lead.title) &&
        Number.isFinite(lead.codexPct) && Number.isFinite(lead.claudePct)) {
      shares[budgetLeadName(lead.title)] = { codexPct: lead.codexPct, claudePct: lead.claudePct }
    }
  }
  if (config.manager) shares.manager = config.manager
  return shares
}
export const emptyBudget = (shares: Record<string, BudgetPct> = {}): BudgetLedger => ({ shares: { ...shares }, days: {} })
export const budgetLeadName = (name: string): string => name.trim().replace(/^Lead\s*·\s*/i, '').toLowerCase().replace(/\s+phases?\b.*$/, '').trim()
export const budgetDate = (now: number, offsetMin = 0): string => new Date(now + offsetMin * 60_000).toISOString().slice(0, 10)
export type BudgetInput = { lead: unknown; side: unknown; pct: unknown; job: unknown }
export type BudgetResult = { ledger: BudgetLedger; message: string; error?: string }
export function budgetChange(ledger: BudgetLedger, date: string, input: BudgetInput, action: 'reserve' | 'spent'): BudgetResult {
  const lead = budgetLeadName(asString(input.lead))
  const side = input.side
  const pct = input.pct
  const job = asString(input.job).trim()
  if (!lead || (side !== 'codex' && side !== 'claude') || typeof pct !== 'number' || !Number.isFinite(pct) || pct <= 0 || job === '') {
    return { ledger, message: 'lead, side (codex or claude), positive pct, and job are required.', error: 'invalid input' }
  }
  const share = ledger.shares[lead]
  if (!share) return { ledger, message: `No daily share configured for ${lead}.`, error: 'unknown lead' }
  const key = side === 'codex' ? 'codexPct' : 'claudePct'
  const old = ledger.days[date]?.[lead] ?? { reserved: { codexPct: 0, claudePct: 0 }, spent: { codexPct: 0, claudePct: 0 }, jobs: {} }
  const previous = old.jobs[job]
  if (previous && previous.side !== side) return { ledger, message: `Job ${job} already uses ${previous.side}.`, error: 'job side differs' }
  if (action === 'reserve' && previous?.reserved) return { ledger, message: `Job ${job} already has a reservation.`, error: 'already reserved' }
  const outstanding = Object.values(old.jobs).filter(one => one.side === side).reduce((n, one) => n + Math.max(0, one.reserved - one.spent), 0)
  if (action === 'reserve' && old.spent[key] + outstanding + pct > share[key] + 1e-9) {
    return { ledger, message: `${lead} ${side} daily share ${share[key]}% would be exceeded (${old.spent[key]}% spent, ${outstanding}% outstanding, ${pct}% requested).`, error: 'share exceeded' }
  }
  const next: BudgetLead = {
    reserved: { ...old.reserved }, spent: { ...old.spent }, jobs: { ...old.jobs },
  }
  if (action === 'reserve') next.reserved[key] += pct
  else next.spent[key] += pct
  next.jobs[job] = { side, reserved: (previous?.reserved ?? 0) + (action === 'reserve' ? pct : 0), spent: (previous?.spent ?? 0) + (action === 'spent' ? pct : 0) }
  return {
    ledger: { ...ledger, days: { ...ledger.days, [date]: { ...ledger.days[date], [lead]: next } } },
    message: `${action === 'reserve' ? 'Reserved' : 'Recorded'} ${pct}% ${side} for ${lead}, job ${job}. Today: ${next.reserved[key]}% reserved, ${next.spent[key]}% spent of ${share[key]}%.`,
  }
}

export function budgetSummary(ledger: BudgetLedger, date: string, lead?: string): string {
  const day = ledger.days[date] ?? {}
  const names = lead ? [budgetLeadName(lead)] : Object.keys(ledger.shares)
  return names.map(name => {
    const row = day[name]
    const share = ledger.shares[name]
    if (!share) return `${name}: share unknown`
    return `${name}: Codex ${row?.reserved.codexPct ?? 0}/${row?.spent.codexPct ?? 0}/${share.codexPct}%, Claude ${row?.reserved.claudePct ?? 0}/${row?.spent.claudePct ?? 0}/${share.claudePct}% (reserved/spent/share)`
  }).join(' · ')
}

// ─── Reminders ──────────────────────────────────────────────────────────────

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "2026-10-19" → "Mon 19". */
export function shortDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
  return `${DAYS[day] ?? ''} ${Number(m[3])}`
}

/** The local calendar date of an instant, given the machine's offset from UTC in minutes. */
export function localIsoDate(nowMs: number, offsetMin: number): string {
  return new Date(nowMs + offsetMin * 60_000).toISOString().slice(0, 10)
}

/** "-0600" → -360. */
export function parseTzOffset(text: string): number | undefined {
  const m = /^([+-])(\d{2})(\d{2})/.exec(text.trim())
  if (!m) return undefined
  const minutes = Number(m[2]) * 60 + Number(m[3])
  return m[1] === '-' ? -minutes : minutes
}

const shortLabel = (text: string): string => {
  const words = plain(text).replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, '$1').replace(/\[\[([^\]]*)\]\]/g, '$1').split(' ')
  const head = words.slice(0, 4).join(' ')
  return clip(words.length > 4 ? `${head}…` : head, 32)
}

/**
 * The soonest dated, open, not struck-through row of the joint ledger that owner owns,
 * on or after today: `{ date, label }`.
 */
export function nextReminder(markdown: string, todayIso: string): { date: string; label: string } | undefined {
  const text = `\n${markdown}`
  const openStart = text.indexOf('\n## Open')
  if (openStart < 0) return undefined
  const rest = text.slice(openStart + 1)
  const doneAt = rest.indexOf('\n## Done')
  const open = doneAt < 0 ? rest : rest.slice(0, doneAt)
  let best: { date: string; label: string } | undefined
  for (const line of open.split('\n')) {
    if (!line.startsWith('| ') || line.startsWith('| Trigger') || line.startsWith('|---')) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(' | ').map(c => c.trim())
    if (cells.length < 3 || cells[1] !== 'Date') continue
    const trigger = (cells[0] ?? '').replace(/`since [^`]*`/g, '').trim()
    if (trigger.startsWith('~~')) continue
    const date = /\b(20\d\d-\d\d-\d\d)\b/.exec(trigger)?.[1]
    if (!date || date < todayIso) continue
    const isOwners = /\bowner\b/i.test(trigger) || /\bowners?\b[^.|]*\bowner\b/i.test(line)
    if (!isOwners) continue
    const quoted = /"([^"]{3,40})"/.exec(trigger)?.[1]
    const bold = /\*\*([^*]+)\*\*/.exec(cells[2] ?? '')?.[1]
    const label = quoted ?? shortLabel(bold ?? cells[2] ?? '')
    if (!best || date < best.date) best = { date, label }
  }
  return best
}

// ─── GitHub Actions minutes ─────────────────────────────────────────────────

const OS_MULTIPLIER = (sku: string): number => (/mac/i.test(sku) ? 10 : /windows/i.test(sku) ? 2 : 1)

/** From the enhanced billing usage report: included minutes less this month's Actions minutes. */
export function ghLeftFromUsage(json: unknown, included = 3000): number | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const items = (json as { usageItems?: unknown }).usageItems
  if (!Array.isArray(items)) return undefined
  let used = 0
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) continue
    const item = raw as Record<string, unknown>
    if (asString(item.product).toLowerCase() !== 'actions') continue
    if (!/minute/i.test(asString(item.unitType))) continue
    const quantity = typeof item.quantity === 'number' ? item.quantity : 0
    used += quantity * OS_MULTIPLIER(asString(item.sku))
  }
  return Math.max(0, Math.round(included - used))
}

/** From the older Actions billing endpoint. */
export function ghLeftFromLegacy(json: unknown): number | undefined {
  if (typeof json !== 'object' || json === null) return undefined
  const j = json as Record<string, unknown>
  if (typeof j.included_minutes !== 'number' || typeof j.total_minutes_used !== 'number') return undefined
  return Math.max(0, Math.round(j.included_minutes - j.total_minutes_used))
}

// ─── Time ───────────────────────────────────────────────────────────────────

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} days`
}

export const clipText = clip
