// manager-console: the Manager chat's console for owner.
//   1. "Your turn" band above the prompt (one ask or send card at a time)
//   2. Team board pane (/board): one card per lead and worker
//   3. Status line: leads, working, needs you, messages sent, GitHub minutes, next reminder
//   4. One-tap send cards for messages that would go out in owner's name (the mod never sends)
//   5. Alerts (toast + soft sound) for shipped, broke and needs-you only
// File reads stay read-only outside this folder; budget reservations use $.store.
// The only process it runs besides a transcript tail reader and `date` is `gh api`
// (read-only), at most every 30 minutes.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  ManagerAsk,
  ManagerBoard,
  ManagerCard,
  ManagerCodexJob,
  ManagerExtras,
  ManagerHelper,
  ManagerInboxReport,
  ManagerOutbound,
  ManagerRecordInfo,
  ManagerTail,
} from '../types'
import * as L from './lib'
import { createHelperScanner, HELPER_READ_PY } from './helpers'

type Dollar = EngineInterface

const PANE = 'board'
const INSTRUCTION_PANE = 'instructions'
const TOOL_ASK = 'mcp__manager-console__manager_ask'
const TOOL_RESOLVE = 'mcp__manager-console__manager_ask_resolve'
const TOOL_OUTBOUND = 'mcp__manager-console__manager_queue_outbound'
const TOOL_OUTBOUND_REMOVE = 'mcp__manager-console__manager_outbound_remove'
const TOOL_BUDGET_RESERVE = 'mcp__manager-console__manager_budget_reserve'
const TOOL_BUDGET_SPENT = 'mcp__manager-console__manager_budget_spent'
const SOUND = 'sounds/alert.wav'
const PYTHON = '/usr/bin/python3'

const POLL_MS = 30_000
const GH_EVERY_MS = 30 * 60_000
const GH_RETRY_MS = 6 * 60 * 60_000
const REMINDERS_EVERY_MS = 60 * 60_000
const RECORD_READS_PER_POLL = 40
const JOB_READS_PER_POLL = 25
// A running job rewrites its file as it goes: one silent this long is taken as gone.
const JOB_WINDOW_MS = 6 * 60 * 60_000
const SEED_BYTES = 3_000_000
const STEP_BYTES = 2_000_000
const INBOX_EVERY_MS = 60_000
const DRAFTS_EVERY_MS = 5 * 60_000
const INBOX_MAX_BYTES = 256_000
const INSTRUCTION_MAX_BYTES = 200 * 1024
const COMPACT_INSTRUCTIONS = 'Keep: the role card, the handoff file path and what it says, open asks to owner, jobs in flight and their ids.'

const asksAtom = atom({ plugin: 'manager-console', key: 'asks' } as const, [])
const outboundAtom = atom({ plugin: 'manager-console', key: 'outbound' } as const, [])
const boardAtom = atom({ plugin: 'manager-console', key: 'board' } as const, null)
const tailAtom = atom({ plugin: 'manager-console', key: 'tail' } as const, null)
const recordsAtom = atom({ plugin: 'manager-console', key: 'records' } as const, {})
const extrasAtom = atom({ plugin: 'manager-console', key: 'extras' } as const, { ghCheckedAt: 0, nextCheckedAt: 0 })
const nowAtom = atom({ plugin: 'manager-console', key: 'now' } as const, 0)
const autoOpenedAtom = atom({ plugin: 'manager-console', key: 'autoOpened' } as const, false)
const inboxAtom = atom({ plugin: 'manager-console', key: 'inbox' } as const, [])
const wakeAtom = atom({ plugin: 'manager-console', key: 'wake' } as const, { lastAt: 0, pending: [], seen: [] })
const idleAlarmAtom = atom({ plugin: 'manager-console', key: 'idleAlarm' } as const, L.emptyIdleAlarm())
const leadWakeAtom = atom({ plugin: 'manager-console', key: 'leadWake' } as const, { lastAt: 0, pending: [], seen: [] })
const gateAtom = atom({ plugin: 'manager-console', key: 'gate' } as const, { status: 'unknown', firstCheckedAt: 0 } as L.Gate)
const compactCycleAtom = atom({ plugin: 'manager-console', key: 'compactCycle' } as const, L.emptyCompactCycle())
const openInstructionAtom = atom({ plugin: 'manager-console', key: 'openInstruction' } as const, null as string | null)
const replyOpenAtom = atom({ plugin: 'manager-console', key: 'replyOpen' } as const, [] as string[])
const bandOffsetAtom = atom({ plugin: 'manager-console', key: 'bandOffset' } as const, 0)
const workerDetailsAtom = atom({ plugin: 'manager-console', key: 'workerDetailsOpen' } as const, false)
const boardOpenAtom = atom({ plugin: 'manager-console', key: 'boardOpen' } as const, false)
const budgetAtom = atom({ plugin: 'manager-console', key: 'budget' } as const, L.emptyBudget())
let configuredShares: Record<string, L.BudgetPct> = {}
let configuredLeadSlugs: string[] = []

// Reads the Manager transcript from a byte offset, whole lines only. Prints "<end> <size> <mode>"
// then the lines. Mode "seed" (no offset yet, or the file shrank) reads the last `cap` bytes.
const TAIL_PY = [
  'import os, sys',
  'path, off, cap = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])',
  'size = os.path.getsize(path)',
  "mode = 'step'",
  "with open(path, 'rb') as f:",
  '    if off < 0 or off > size:',
  "        mode = 'seed'",
  '        start = max(0, size - cap)',
  '        f.seek(start)',
  '        if start > 0:',
  '            f.readline()',
  '    else:',
  '        f.seek(off)',
  '    pos = f.tell()',
  '    data = f.read(cap)',
  "    cut = data.rfind(b'\\n')",
  '    if cut >= 0:',
  '        data = data[:cut + 1]',
  '        end = pos + len(data)',
  '    elif len(data) >= cap:',
  '        end = pos + len(data) + len(f.readline())',
  "        data = b''",
  '    else:',
  '        end = pos',
  "        data = b''",
  "sys.stdout.write('%d %d %s\\n' % (end, size, mode))",
  'sys.stdout.flush()',
  'sys.stdout.buffer.write(data)',
].join('\n')

// For each transcript named, the newest main-thread assistant message's usage in its last `cap`
// bytes: input + cache read + cache creation tokens, and the model. Prints one JSON object.
const CTX_PY = [
  'import json, os, sys',
  'cap = int(sys.argv[1])',
  'out = {}',
  'for path in sys.argv[2:]:',
  '    found = None',
  '    try:',
  '        size = os.path.getsize(path)',
  "        with open(path, 'rb') as f:",
  '            f.seek(max(0, size - cap))',
  '            data = f.read(cap)',
  "        for line in reversed(data.split(b'\\n')):",
  `            if b'"usage"' not in line or b'"assistant"' not in line:`,
  '                continue',
  '            try:',
  '                row = json.loads(line)',
  '            except Exception:',
  '                continue',
  "            if row.get('type') != 'assistant' or row.get('isSidechain'):",
  '                continue',
  "            msg = row.get('message') or {}",
  "            u = msg.get('usage') or {}",
  "            total = sum(int(u.get(k) or 0) for k in ('input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'))",
  '            if total > 0:',
  "                found = {'tokens': total, 'model': msg.get('model') or ''}",
  '                break',
  '    except Exception:',
  '        found = None',
  '    out[path] = found',
  'print(json.dumps(out))',
].join('\n')
const CTX_TAIL_BYTES = 1_000_000

// For each session record named, only the fields the board uses. Prints one JSON object.
const RECORD_PY = [
  'import json, sys',
  'out = {}',
  'for path in sys.argv[1:]:',
  '    try:',
  "        with open(path, 'rb') as f:",
  '            r = json.load(f)',
  "        s = r.get('postTurnSummary')",
  "        keep = {k: r.get(k) for k in ('sessionId', 'cliSessionId', 'title', 'cwd', 'isArchived', 'lastActivityAt')}",
  "        keep['postTurnSummary'] = {'status_detail': str(s.get('status_detail') or '')[:300]} if isinstance(s, dict) else {}",
  '        out[path] = keep',
  '    except Exception:',
  '        out[path] = None',
  'print(json.dumps(out))',
].join('\n')

type Paths = {
  sessionsRoot: string
  projectsRoot: string
  codexState: string
  reminders: string
  sourceOfTruthRepo: string
  managerTranscript: string
  managerCliId: string
  inbox: string
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 200)

let idCounter = 0
const makeId = (prefix: string) => (): string => {
  idCounter += 1
  return `${prefix}${Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')}${idCounter.toString(36)}`
}

// Module memory: a reload starts it over; it is rebuilt from $.state, $.store and the next poll.
let paths: Paths | undefined
let isBusy = false
let isQuickWanted = false
let lastQuickAt = 0
let lastSoundAt = 0
let lastStatus = ''
/** The cmux footer stats the prompt hint carries; undefined until the first refresh. */
let hintStats: string | undefined
let transcriptMtimes: Record<string, number> = {}
let jobs: ManagerCodexJob[] = []
let helpers: Record<string, ManagerHelper[]> = {}
const helperScanner = createHelperScanner()
const transcriptPaths = new Map<string, string>()
const searchedTranscripts = new Set<string>()
const jobCache = new Map<string, { mtimeMs: number; job?: ManagerCodexJob }>()
const ctxCache = new Map<string, { mtimeMs: number; tokens?: number; model?: string }>()
let selfModel = ''
let selfWindow: number | undefined
let selfCtxPercent: number | undefined
/** The main loop's running turn, from turn.start to turn.complete. */
let runningTurnId: string | undefined
let turnStartedAt = 0
/** A turn "running" this long without its end being seen is taken as over (a missed event). */
const TURN_STUCK_MS = 30 * 60_000
let isInboxBusy = false
let isDraftsBusy = false
let isWakeBusy = false
let isLeadInboxBusy = false
let isCompactBusy = false
const askInputs = new Map<string, string>()
const inboxCache = new Map<string, { mtimeMs: number; report: ManagerInboxReport }>()
const readInboxCache = new Map<string, { mtimeMs: number; report: ManagerInboxReport }>()
let latestInboxReports: ManagerInboxReport[] = []
let hasScannedInbox = false

/** The context window for a session's model: the Manager's own when it is the same model, else 1M. */
const windowFor = (model: string | undefined): number =>
  selfWindow !== undefined && sameModelAsSelf(model) ? selfWindow : L.DEFAULT_WINDOW
const sameModelAsSelf = (model: string | undefined): boolean => L.sameModel(model ?? '', selfModel)

const log = ($: Dollar, text: string) => $.ui.log(`manager-console: ${text}`, { to: 'debug' })
const isManager = async ($: Dollar) => (await read($, gateAtom)).status === 'manager'
const isLead = async ($: Dollar) => (await read($, gateAtom)).status === 'lead'
const canCompact = async ($: Dollar) => ['manager', 'lead', 'worker'].includes((await read($, gateAtom)).status)
const OFF_MESSAGE = 'Manager console is available only in the Manager session.'

const safeInstructionFile = async ($: Dollar, path: string): Promise<boolean> => {
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const roots = [await $.session.cwd(), `${config}/harness`]
  if (!L.allowedInstructionFile(path, roots)) return false
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return stat?.kind === 'file' && stat.size <= INSTRUCTION_MAX_BYTES &&
    typeof stat.realPath === 'string' && L.allowedInstructionFile(stat.realPath, roots)
}

const compactPass = async ($: Dollar) => {
  if (isCompactBusy) {
    log($, 'compaction: percent=unknown action=none skip=pass busy')
    return
  }
  isCompactBusy = true
  let percent: number | undefined
  let action: L.CompactAction = 'none'
  let skip = 'none'
  try {
    if (!(await canCompact($))) {
      skip = 'role unavailable'
      return
    }
    const now = await $.clock.now()
    if (runningTurnId && now - turnStartedAt < TURN_STUCK_MS) {
      skip = 'turn running'
      return
    }
    const usage = await $.session.usage()
    percent = usage.context.percent
    selfCtxPercent = percent
    selfWindow = usage.context.window > 0 ? usage.context.window : selfWindow
    let cycle = await read($, compactCycleAtom)
    if (cycle.awaitDrop && percent !== undefined && percent < L.HANDOFF_AT) {
      cycle = { ...cycle, awaitDrop: false, nudgeAt: 0 }
      await update($, compactCycleAtom, () => cycle)
    }
    action = L.compactAction(cycle, percent, now, true)
    if (action === 'none') {
      skip = percent === undefined ? 'usage unavailable' : cycle.awaitDrop ? 'awaiting context drop'
        : now - cycle.lastCompactAt < L.COMPACT_SPACING_MS ? 'spacing'
          : percent < L.HANDOFF_AT ? 'below handoff' : 'below post handoff'
      return
    }
    const gate = await read($, gateAtom)
    const path = L.handoffPath(gate, await $.session.cwd(), (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`)
    if (!path) {
      skip = 'handoff path unavailable'
      return
    }
    if (action === 'nudge') {
      await update($, compactCycleAtom, () => ({ ...cycle, nudgeAt: now }))
      await $.prompt.submit({ text: `Context at ${percent}%: rewrite your handoff now (${path}), then reply "handoff written". Compaction follows.` })
      return
    }
    if (action === 'check-file') {
      const stat = await $.fs.stat(path).catch(() => undefined)
      if (!stat || stat.mtimeMs <= cycle.nudgeAt) {
        skip = 'handoff unchanged'
        return
      }
    }
    // Recheck just before the call, because a timer can overlap a newly started turn.
    if (runningTurnId && await $.clock.now() - turnStartedAt < TURN_STUCK_MS) {
      skip = 'turn running'
      return
    }
    action = 'compact'
    const result = await $.session.compact({ instructions: COMPACT_INSTRUCTIONS })
    if (!result.skip) {
      const compactedAt = await $.clock.now()
      await update($, compactCycleAtom, () => ({ nudgeAt: 0, lastCompactAt: compactedAt, awaitDrop: true }))
    } else skip = 'session skipped'
  } catch (err) {
    skip = `error: ${errText(err)}`
  } finally {
    log($, `compaction: percent=${percent === undefined ? 'unknown' : `${percent}%`} action=${action} skip=${skip}`)
    isCompactBusy = false
  }
}

// ─── Alerts ────────────────────────────────────────────────────────────────

const raise = async ($: Dollar, text: string) => {
  $.ui.toast(L.clipText(text, 240), { timeoutMs: 8000 })
  const now = await $.clock.now()
  if (now - lastSoundAt < 4000) return
  lastSoundAt = now
  $.audio.play({ asset: SOUND }, { gain: 0.6 }).catch(() => undefined)
}

const openBoard = async ($: Dollar) => {
  const opened = await $.ui.open({ id: PANE, title: 'Team board' })
  await update($, boardOpenAtom, () => true)
  await $.store.set('boardOpen', true)
  return opened
}

// ─── Derived views: the board and the status line ──────────────────────────

const refreshStatus = async ($: Dollar) => {
  const storedBudget = await $.store.get('budget')
  if (storedBudget && typeof storedBudget === 'object') await update($, budgetAtom, () => ({ ...(storedBudget as L.BudgetLedger), shares: configuredShares }))
  const [board, asks, tail, extras, inbox, compactCycle, idleAlarm, budget] = await Promise.all([
    read($, boardAtom),
    read($, asksAtom),
    read($, tailAtom),
    read($, extrasAtom),
    read($, inboxAtom),
    read($, compactCycleAtom),
    read($, idleAlarmAtom),
    read($, budgetAtom),
  ])
  const now = await $.clock.now()
  if (selfModel === '') selfModel = await $.session.model().catch(() => '')
  const text = L.statusLine({
    board,
    asks,
    msgs: tail?.msgs,
    ghLeft: extras.ghLeft,
    next: extras.next,
    selfCtx: selfCtxPercent,
    reports: inbox.length,
    idleAlarm: L.idleAlarmPlan(board, idleAlarm, now, configuredShares).holds,
    lastCompactAt: compactCycle.lastCompactAt,
    now,
    nextCompactAt: compactCycle.nudgeAt ? L.POST_HANDOFF_COMPACT_AT : L.HANDOFF_AT,
  })
  const budgetText = L.budgetSummary(budget, L.budgetDate(now, extras.tzOffsetMin ?? 0))
  // In cmux the Dock board (a terminal board-view dock) shows the team, so the line is context and plan usage only,
  // drawn on the prompt hint's row beside the permission mode: one footer row (owner, 2026-10-20 16:2x).
  if (await inCmux($)) {
    const stats = await cmuxStatusText($)
    if (stats === hintStats) return
    if (hintStats === undefined) $.ui.status(undefined)
    hintStats = stats
    $.ui.invalidate('ui.render')
    return
  }
  const fullText = `${text} · Budget today ${budgetText}`
  if (fullText === lastStatus) return
  lastStatus = fullText
  $.ui.status(fullText)
}

let compactLimit: number | undefined
/** The auto-compact window: CLAUDE_CODE_AUTO_COMPACT_WINDOW, else settings autoCompactWindow, else the model window. */
const autoCompactLimit = async ($: Dollar): Promise<number> => {
  if (compactLimit !== undefined) return compactLimit
  let limit = Number((await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW').catch(() => undefined)) ?? '')
  if (!(limit > 0)) {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
    try {
      limit = Number((JSON.parse(await $.fs.read(`${config}/settings.json`)) as { autoCompactWindow?: unknown }).autoCompactWindow)
    } catch { limit = NaN }
  }
  if (limit > 0) compactLimit = limit
  return limit > 0 ? limit : selfWindow ?? L.DEFAULT_WINDOW
}

const cmuxStatusText = async ($: Dollar): Promise<string> => {
  const usage = await $.session.usage().catch(() => undefined)
  const rate = (kind: string) => usage?.rateLimits.find(one => one.kind === kind)?.percentUsed
  return L.cmuxStatus({
    ctxTokens: usage?.context.tokens,
    ctxLimit: await autoCompactLimit($),
    fiveHour: rate('five_hour'),
    week: rate('seven_day'),
  })
}

let cmuxFlag: boolean | undefined
/** True when this session runs inside a cmux terminal (cmux sets CMUX_WORKSPACE_ID). The desktop app never does. */
const inCmux = async ($: Dollar): Promise<boolean> => {
  if (cmuxFlag === undefined) cmuxFlag = Boolean((await $.env.get('CMUX_WORKSPACE_ID').catch(() => undefined))?.trim())
  return cmuxFlag
}

const rebuild = async ($: Dollar) => {
  const [records, tail, asks, inbox] = await Promise.all([
    read($, recordsAtom),
    read($, tailAtom),
    read($, asksAtom),
    read($, inboxAtom),
  ])
  const now = await $.clock.now()
  const ctx: Record<string, number> = {}
  for (const [cli, seen] of ctxCache) {
    const percent = seen.tokens === undefined ? undefined : L.contextPercent(seen.tokens, windowFor(seen.model))
    if (percent !== undefined) ctx[cli] = percent
  }
  const board = L.buildBoard({
    records: Object.values(records),
    transcriptMtimes,
    reports: tail?.reports ?? {},
    asks,
    jobs,
    helpers,
    managerCliId: paths?.managerCliId ?? '',
    now,
    ctx,
    inbox,
    latestInbox: latestInboxReports,
  })
  await update($, boardAtom, () => board)
  await update($, nowAtom, () => now)
  const alarm = await read($, idleAlarmAtom)
  const nextAlarm = L.idleAlarmPlan(board, alarm, now, configuredShares).alarm
  if (JSON.stringify(nextAlarm.readySince) !== JSON.stringify(alarm.readySince)) {
    await update($, idleAlarmAtom, () => nextAlarm)
    await $.store.set('idleAlarm', nextAlarm)
  }
  await refreshStatus($)
  await maybeWake($)
}

// ─── The ask queue and send cards (state + store, then the views) ──────────

const setAsks = async ($: Dollar, change: (queue: ManagerAsk[]) => ManagerAsk[]) => {
  const queue = await update($, asksAtom, change)
  await $.store.set('asks', queue)
  await rebuild($)
  return queue
}

const setOutbound = async ($: Dollar, change: (list: ManagerOutbound[]) => ManagerOutbound[], fromDrafts = false) => {
  const before = await read($, outboundAtom)
  const list = await update($, outboundAtom, change)
  await $.store.set('outbound', list)
  // A draft card taken off by Send, Don't send or the remove tool stays off until its draft changes status,
  // or the next drafts pass would put it straight back.
  if (!fromDrafts) {
    const gone = before.filter(card => card.source === 'draft' && !list.some(one => one.id === card.id)).map(card => card.id)
    if (gone.length > 0) await $.store.set('draftsHandled', [...new Set([...(await handledDrafts($)), ...gone])])
  }
  return list
}

const handledDrafts = async ($: Dollar): Promise<string[]> => {
  const kept = await $.store.get('draftsHandled')
  return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : []
}

const submitAsOwner = ($: Dollar, text: string) => {
  $.prompt
    .submit({ text, asUser: true })
    .catch(() => $.prompt.fill({ text, mode: 'replace' }))
    .catch(() => undefined)
}

const closeAsk = async ($: Dollar, ask: ManagerAsk) => {
  askInputs.delete(ask.id)
  await update($, replyOpenAtom, ids => ids.filter(id => id !== ask.id))
  await setAsks($, queue => L.resolveAsk(queue, ask.id).queue)
}

const answer = async ($: Dollar, ask: ManagerAsk, option: string) => {
  await closeAsk($, ask)
  submitAsOwner($, L.answerPrompt(ask, option))
}

const dismissAsk = async ($: Dollar, ask: ManagerAsk) => {
  await closeAsk($, ask)
  submitAsOwner($, L.dismissPrompt(ask))
}

const dropCard = async ($: Dollar, card: ManagerOutbound) => {
  await setOutbound($, list => list.filter(one => one.id !== card.id))
  submitAsOwner($, `Don't send: ${card.id} (${card.channel} to ${card.to}). Removed from the board.`)
}

const nextBand = async ($: Dollar) => { await update($, bandOffsetAtom, offset => offset + 1) }

const sendTypedAsk = async ($: Dollar, ask: ManagerAsk, value: string) => {
  const words = value.trim()
  if (!words) return
  askInputs.delete(ask.id)
  if (L.matchAnswer(words, ask) || !words.endsWith('?')) await closeAsk($, ask)
  else await update($, nowAtom, now => now + 1)
  submitAsOwner($, L.typedAskPrompt(ask, words))
}

const openInstruction = async ($: Dollar, path: string) => {
  if (!(await safeInstructionFile($, path))) return
  await update($, openInstructionAtom, () => path)
  await $.ui.open({ id: INSTRUCTION_PANE, title: path.slice(path.lastIndexOf('/') + 1) })
}

const sendCard = async ($: Dollar, card: ManagerOutbound) => {
  await setOutbound($, list => list.filter(one => one.id !== card.id))
  // owner's own prompt carries the exact words; the Manager does the send.
  submitAsOwner($, L.sendPrompt(card))
}

const editCard = async ($: Dollar, card: ManagerOutbound) => {
  const box = await $.prompt.read()
  const text = L.sendPrompt(card)
  await $.prompt.fill(box.text.trim() === '' ? { text, mode: 'replace' } : { text: `\n${text}`, mode: 'append' })
}

// ─── Reading the world (read-only) ─────────────────────────────────────────

const loadLeads = async ($: Dollar, keepPreviousOnFailure = false) => {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
    const leads = JSON.parse(await $.fs.read(`${config}/harness/leads.json`)) as L.LeadsConfig
    const shares = L.sharesFromConfig(leads)
    const slugs = leads.leads.filter(one => shares[L.budgetLeadName(one.title)]).map(one => one.slug)
    await update($, budgetAtom, current => ({ ...current, shares }))
    configuredShares = shares
    configuredLeadSlugs = slugs
  } catch {
    if (!keepPreviousOnFailure) {
      configuredShares = {}
      configuredLeadSlugs = []
    }
  }
}

const resolvePaths = async ($: Dollar): Promise<Paths> => {
  const home = (await $.env.get('HOME')) ?? ''
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  await loadLeads($)
  let reminders = ''
  let sourceOfTruthRepo = ''
  try {
    const kit = JSON.parse(await $.fs.read(`${config}/harness/config.json`)) as { remindersFile?: string; sourceOfTruthRepo?: string }
    reminders = kit.remindersFile ?? ''
    sourceOfTruthRepo = typeof kit.sourceOfTruthRepo === 'string' ? kit.sourceOfTruthRepo : ''
  } catch { /* Optional until adapted. */ }
  const appBase = `${home}/Library/Application Support`
  const app = await $.fs.exists(`${appBase}/Claude/claude-code-sessions`).catch(() => false) ? 'Claude' : 'Claude-Work'
  const projectsRoot = `${config}/projects`
  const selfId = await $.session.id().catch(() => '')
  const cwd = await $.session.cwd().catch(() => '')
  const own = selfId !== '' && cwd !== '' ? `${projectsRoot}/${L.projectSlug(cwd)}/${selfId}.jsonl` : ''
  return {
    sessionsRoot: `${appBase}/${app}/claude-code-sessions`,
    projectsRoot,
    codexState: `${config}/plugins/data/codex-openai-codex/state`,
    reminders,
    sourceOfTruthRepo,
    managerTranscript: own,
    managerCliId: selfId,
    inbox: `${config}/harness/inbox`,
  }
}

/** New lines of the Manager transcript: reports, alerts, and the message count. */
const readTail = async ($: Dollar, p: Paths) => {
  const prev = await read($, tailAtom)
  const base: ManagerTail = prev ?? L.emptyTail()
  const cap = base.offset < 0 ? SEED_BYTES : STEP_BYTES
  const run = await $.process.run([PYTHON, '-I', '-c', TAIL_PY, p.managerTranscript, String(base.offset), String(cap)], {
    timeoutMs: 20_000,
  })
  if (run.exitCode !== 0) {
    log($, `tail read failed (${run.exitCode}): ${run.stderr.slice(0, 200)}`)
    return
  }
  const newline = run.stdout.indexOf('\n')
  const [endText, sizeText, mode] = run.stdout.slice(0, newline).split(' ')
  const end = Number(endText)
  const size = Number(sizeText)
  if (!Number.isFinite(end)) return
  const isSeed = mode === 'seed'
  const now = await $.clock.now()
  const alerts: L.Alert[] = []
  const start = isSeed ? { ...L.emptyTail(), agentNames: base.agentNames } : base
  const applied = L.applyChunk(start, run.stdout.slice(newline + 1), now, isSeed ? undefined : alerts)
  await update($, tailAtom, () => ({ ...applied, offset: end, seededAt: isSeed ? now : base.seededAt }))
  for (const one of alerts.slice(-3)) {
    await raise($, `${one.kind === 'shipped' ? 'Shipped' : 'Problem'} · ${one.name}: ${one.line}`)
  }
  if (end < size) isQuickWanted = true
}

const sessionFiles = async ($: Dollar, root: string) => {
  const files: { path: string; mtimeMs: number; size: number }[] = []
  for (const a of await $.fs.list(root).catch(() => [])) {
    if (a.kind !== 'dir') continue
    for (const b of await $.fs.list(`${root}/${a.name}`).catch(() => [])) {
      if (b.kind !== 'dir') continue
      const dir = `${root}/${a.name}/${b.name}`
      for (const f of await $.fs.list(dir).catch(() => [])) {
        if (f.kind === 'file' && /^local_.+\.json$/.test(f.name)) files.push({ path: `${dir}/${f.name}`, mtimeMs: f.mtimeMs, size: f.size })
      }
    }
  }
  return files
}

/** Find this CLI session's desktop title using the board's compact record reader. */
const ownDesktopTitle = async ($: Dollar, p: Paths, cliId: string): Promise<string | undefined> => {
  if (!cliId) return undefined
  const files = (await sessionFiles($, p.sessionsRoot)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (let i = 0; i < files.length; i += RECORD_READS_PER_POLL) {
    const batch = files.slice(i, i + RECORD_READS_PER_POLL)
    const run = await $.process.run([PYTHON, '-I', '-c', RECORD_PY, ...batch.map(f => f.path)], { timeoutMs: 20_000 }).catch(() => undefined)
    if (!run || run.exitCode !== 0) continue
    const found = JSON.parse(run.stdout) as Record<string, unknown>
    for (const f of batch) {
      const info = L.recordInfo(found[f.path], f.mtimeMs)
      if (info?.cliSessionId === cliId) return info.title
    }
  }
  return undefined
}

/** The newest /rename or `-n` title in this session's own transcript. */
const ownTranscriptTitle = async ($: Dollar, p: Paths | undefined): Promise<string | undefined> => {
  if (!p?.managerTranscript) return undefined
  const run = await $.process.run(['/usr/bin/grep', '-o', '"customTitle":"[^"]*"', p.managerTranscript], { timeoutMs: 10_000 }).catch(() => undefined)
  const last = run?.exitCode === 0 ? run.stdout.trim().split('\n').at(-1) : undefined
  if (!last) return undefined
  try {
    return (JSON.parse(`{${last}}`) as { customTitle?: string }).customTitle?.trim() || undefined
  } catch { return undefined }
}

const scanRecords = async ($: Dollar, p: Paths) => {
  const cache: Record<string, ManagerRecordInfo> = { ...(await read($, recordsAtom)) }
  const files = await sessionFiles($, p.sessionsRoot)
  let isChanged = false
  const present = new Set(files.map(f => f.path))
  for (const key of Object.keys(cache)) {
    if (!present.has(key)) {
      delete cache[key]
      isChanged = true
    }
  }
  const stale: typeof files = []
  for (const f of files) {
    const known = cache[f.path]
    if (known && known.mtimeMs === f.mtimeMs) continue
    if (known && known.cliSessionId === p.managerCliId) {
      cache[f.path] = { ...known, mtimeMs: f.mtimeMs } // the Manager's own record: no card, no reread
      isChanged = true
      continue
    }
    stale.push(f)
  }
  stale.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const batch = stale.slice(0, RECORD_READS_PER_POLL)
  if (batch.length > 0) {
    // The records are 0.5-1 MB each: a small reader hands back only the fields the board uses.
    const run = await $.process.run([PYTHON, '-I', '-c', RECORD_PY, ...batch.map(f => f.path)], { timeoutMs: 20_000 })
    if (run.exitCode !== 0) log($, `record read failed (${run.exitCode})`)
    else {
      const found = JSON.parse(run.stdout) as Record<string, unknown>
      for (const f of batch) {
        const info = L.recordInfo(found[f.path], f.mtimeMs)
        if (!info) continue
        cache[f.path] = info
        isChanged = true
      }
    }
  }
  if (!isChanged) return
  await update($, recordsAtom, () => cache)
  await $.store.set('records', cache)
}

const statTranscripts = async ($: Dollar, p: Paths) => {
  const records = Object.values(await read($, recordsAtom))
  const next: Record<string, number> = {}
  let projectDirs: string[] | undefined
  for (const r of records) {
    if (r.archived || r.cliSessionId === '' || r.cliSessionId === p.managerCliId || !L.roleOf(r.title)) continue
    const guess = transcriptPaths.get(r.cliSessionId) ?? `${p.projectsRoot}/${L.projectSlug(r.cwd)}/${r.cliSessionId}.jsonl`
    try {
      next[r.cliSessionId] = (await $.fs.stat(guess)).mtimeMs
      transcriptPaths.set(r.cliSessionId, guess)
      continue
    } catch {
      // not under its working directory's folder: look once in every project folder
    }
    if (searchedTranscripts.has(r.cliSessionId)) continue
    searchedTranscripts.add(r.cliSessionId)
    projectDirs ??= (await $.fs.list(p.projectsRoot).catch(() => [])).filter(d => d.kind === 'dir').map(d => d.name)
    for (const dir of projectDirs) {
      const candidate = `${p.projectsRoot}/${dir}/${r.cliSessionId}.jsonl`
      const stat = await $.fs.stat(candidate).catch(() => undefined)
      if (!stat) continue
      transcriptPaths.set(r.cliSessionId, candidate)
      next[r.cliSessionId] = stat.mtimeMs
      break
    }
  }
  transcriptMtimes = next
  // Context fill: reread the tail only of transcripts that changed since the last reading.
  const changed = Object.keys(next)
    .filter(cli => ctxCache.get(cli)?.mtimeMs !== next[cli])
    .slice(0, 12)
  for (const cli of [...ctxCache.keys()]) if (next[cli] === undefined) ctxCache.delete(cli)
  if (changed.length === 0) return
  const byPath = new Map(changed.map(cli => [transcriptPaths.get(cli) ?? '', cli] as const))
  const run = await $.process.run([PYTHON, '-I', '-c', CTX_PY, String(CTX_TAIL_BYTES), ...byPath.keys()], { timeoutMs: 20_000 })
  if (run.exitCode !== 0) {
    log($, `context read failed (${run.exitCode})`)
    return
  }
  const found = JSON.parse(run.stdout) as Record<string, { tokens?: number; model?: string } | null>
  for (const [path, cli] of byPath) {
    const reading = found[path]
    const before = ctxCache.get(cli)
    // A tail with no assistant message yet keeps the last reading.
    ctxCache.set(cli, reading ? { mtimeMs: next[cli] ?? 0, tokens: reading.tokens, model: reading.model } : { ...before, mtimeMs: next[cli] ?? 0 })
  }
}

const scanCodex = async ($: Dollar, p: Paths, now: number) => {
  const candidates: { path: string; mtimeMs: number }[] = []
  for (const d of await $.fs.list(p.codexState).catch(() => [])) {
    if (d.kind !== 'dir') continue
    const dir = `${p.codexState}/${d.name}/jobs`
    for (const f of await $.fs.list(dir).catch(() => [])) {
      if (f.kind === 'file' && f.name.endsWith('.json') && now - f.mtimeMs < JOB_WINDOW_MS) {
        candidates.push({ path: `${dir}/${f.name}`, mtimeMs: f.mtimeMs })
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let reads = 0
  for (const c of candidates) {
    if (jobCache.get(c.path)?.mtimeMs === c.mtimeMs) continue
    if (reads >= JOB_READS_PER_POLL) break
    reads += 1
    try {
      jobCache.set(c.path, { mtimeMs: c.mtimeMs, job: L.codexJobInfo(JSON.parse(await $.fs.read(c.path))) })
    } catch {
      jobCache.set(c.path, { mtimeMs: c.mtimeMs })
    }
  }
  const keep = new Set(candidates.map(c => c.path))
  for (const key of [...jobCache.keys()]) if (!keep.has(key)) jobCache.delete(key)
  jobs = [...jobCache.values()].flatMap(entry => (entry.job ? [entry.job] : []))
}

const ghBinary = async ($: Dollar): Promise<string> => {
  for (const candidate of ['/opt/homebrew/bin/gh', '/usr/local/bin/gh']) {
    if (await $.fs.exists(candidate).catch(() => false)) return candidate
  }
  return 'gh'
}

/** GitHub Actions minutes left this month: `gh api`, read-only, at most every 30 minutes. */
const maybeGh = async ($: Dollar, now: number) => {
  const extras = await read($, extrasAtom)
  const wait = extras.ghNote !== undefined && extras.ghLeft === undefined ? GH_RETRY_MS : GH_EVERY_MS
  if (now - extras.ghCheckedAt < wait) return
  await setExtras($, { ...extras, ghCheckedAt: now })
  const gh = await ghBinary($)
  let account: string
  try {
    const identity = await $.process.run([gh, 'api', 'user', '--jq', '.login'], { timeoutMs: 20_000 })
    account = identity.stdout.trim()
    if (identity.exitCode !== 0 || !/^[A-Za-z0-9-]+$/.test(account)) throw new Error('No authenticated account')
  } catch {
    await setExtras($, { ...(await read($, extrasAtom)), ghLeft: undefined, ghCheckedAt: now, ghNote: 'GitHub minutes could not be read: sign in with gh first.' })
    return
  }
  const month = L.localIsoDate(now, extras.tzOffsetMin ?? 0)
  const [year, mon] = month.split('-')
  const tries: [string, (json: unknown) => number | undefined][] = [
    [`/users/${account}/settings/billing/usage?year=${year}&month=${Number(mon)}`, json => L.ghLeftFromUsage(json)],
    [`/users/${account}/settings/billing/actions`, L.ghLeftFromLegacy],
  ]
  let note = ''
  for (const [endpoint, parse] of tries) {
    try {
      const run = await $.process.run([gh, 'api', '-H', 'Accept: application/vnd.github+json', endpoint], { timeoutMs: 20_000 })
      if (run.exitCode !== 0) {
        note = /"user" scope/.test(run.stderr)
          ? 'GitHub minutes need the "user" scope on gh (gh auth refresh -h github.com -s user).'
          : 'GitHub minutes could not be read.'
        continue
      }
      const left = parse(JSON.parse(run.stdout))
      if (left === undefined) {
        note = 'GitHub minutes: the billing answer had no Actions minutes.'
        continue
      }
      await setExtras($, { ...(await read($, extrasAtom)), ghLeft: left, ghCheckedAt: now, ghNote: undefined })
      return
    } catch (err) {
      note = `GitHub minutes could not be read (${errText(err)}).`
    }
  }
  await setExtras($, { ...(await read($, extrasAtom)), ghLeft: undefined, ghCheckedAt: now, ghNote: note })
}

const maybeReminders = async ($: Dollar, p: Paths, now: number) => {
  const extras = await read($, extrasAtom)
  if (now - extras.nextCheckedAt < REMINDERS_EVERY_MS) return
  let next: ManagerExtras['next']
  try {
    if (!p.reminders) return
    next = L.nextReminder(await $.fs.read(p.reminders), L.localIsoDate(now, extras.tzOffsetMin ?? 0))
  } catch (err) {
    log($, `reminders unreadable: ${errText(err)}`)
  }
  await setExtras($, { ...(await read($, extrasAtom)), next, nextCheckedAt: now })
}

const setExtras = async ($: Dollar, value: ManagerExtras) => {
  await update($, extrasAtom, () => value)
  await $.store.set('extras', value)
}

const step = async (name: string, $: Dollar, run: () => Promise<void>) => {
  try {
    await run()
  } catch (err) {
    log($, `${name} failed: ${errText(err)}`)
  }
}

/** One pass. `isFull`: everything (every 30 s); otherwise the Manager transcript alone. */
const poll = async ($: Dollar, isFull: boolean) => {
  const p = paths
  if (!p) return
  if (isBusy) {
    isQuickWanted = true
    return
  }
  isBusy = true
  try {
    const now = await $.clock.now()
    await step('transcript', $, () => readTail($, p))
    if (isFull) {
      await step('records', $, () => scanRecords($, p))
      await step('transcripts', $, () => statTranscripts($, p))
      await step('helpers', $, async () => {
        helpers = await helperScanner({
          list: path => $.fs.list(path),
          stat: path => $.fs.stat(path),
          readMany: async files => {
            const run = await $.process.run([PYTHON, '-I', '-c', HELPER_READ_PY, ...files], { timeoutMs: 20_000 })
            if (run.exitCode !== 0 || run.isStdoutTruncated) throw new Error('helper transcript read failed')
            return JSON.parse(run.stdout)
          },
        }, p.projectsRoot, Object.values(await read($, recordsAtom)), now, transcriptPaths)
      })
      await step('codex', $, () => scanCodex($, p, now))
      await step('github', $, () => maybeGh($, now))
      await step('reminders', $, () => maybeReminders($, p, now))
    }
    await step('board', $, () => rebuild($))
  } finally {
    isBusy = false
  }
  if (isQuickWanted) {
    isQuickWanted = false
    $.clock.after(1500, () => void poll($, false))
  }
}

/** A quick read of the Manager transcript soon (a report arrived, a message went out). */
const soon = ($: Dollar, ms: number) => {
  if (!paths) return
  $.clock.after(ms, () => {
    void (async () => {
      const now = await $.clock.now()
      if (now - lastQuickAt < 3000) return
      lastQuickAt = now
      await poll($, false)
    })()
  })
}

// ─── The inbox: files leads drop when their messages to the Manager run out ──

/** Wakes the Manager with one prompt naming the waiting reports, when the rules allow. */
const maybeWake = async ($: Dollar) => {
  if (isWakeBusy || !(await isManager($))) return
  isWakeBusy = true
  try {
    const [wake, unread, board, alarm] = await Promise.all([
      read($, wakeAtom), read($, inboxAtom), read($, boardAtom), read($, idleAlarmAtom),
    ])
    const now = await $.clock.now()
    const idle = L.idleAlarmPlan(board, alarm, now, configuredShares)
    const overdueAlarm = board?.cards.some(card => card.overdueSince !== undefined && idle.leads.includes(card.title)) ?? false
    if (wake.pending.length === 0 && !(hasScannedInbox && idle.due && (L.IDLE_ALARM_WAKES || overdueAlarm))) return
    const box = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
    const isTurnRunning = runningTurnId !== undefined && now - turnStartedAt < TURN_STUCK_MS
    const plan = L.planWake(wake, unread, now, isTurnRunning, box.text.trim() !== '')
    await update($, wakeAtom, () => plan.wake)
    await $.store.set('wake', plan.wake)
    let text = plan.text
    if (text === undefined && (L.IDLE_ALARM_WAKES || overdueAlarm) && hasScannedInbox && idle.due && runningTurnId === undefined && box.text.trim() === '') {
      text = L.idleAlarmText(idle.leads)
      const sent = { ...idle.alarm, lastAt: now }
      await update($, idleAlarmAtom, () => sent)
      await $.store.set('idleAlarm', sent)
    }
    if (text === undefined) return
    if (!(await isManager($))) return
    // Framed as this mod's message (not owner's words); it starts a turn once the session is idle.
    $.prompt.submit({ text }).catch(err => log($, `wake not submitted: ${errText(err)}`))
  } finally {
    isWakeBusy = false
  }
}

/** Reads the inbox folder (never writes it): unread reports, alerts for new ones, then a wake. */
const scanInbox = async ($: Dollar, p: Paths) => {
  const entries = await $.fs.list(p.inbox).catch(() => [])
  const files = entries.filter(f => f.kind === 'file' && /\.md$/i.test(f.name))
  const unread: ManagerInboxReport[] = []
  for (const f of files) {
    const known = inboxCache.get(f.name)
    if (known && known.mtimeMs === f.mtimeMs) {
      unread.push(known.report)
      continue
    }
    let text = ''
    try {
      text = f.size > INBOX_MAX_BYTES ? '' : await $.fs.read(`${p.inbox}/${f.name}`)
    } catch {
      continue // moved to read/ between the listing and the read
    }
    const report = L.inboxReport(f.name, text, f.mtimeMs)
    inboxCache.set(f.name, { mtimeMs: f.mtimeMs, report })
    unread.push(report)
  }
  const names = new Set(unread.map(one => one.file))
  for (const name of [...inboxCache.keys()]) if (!names.has(name)) inboxCache.delete(name)
  unread.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const readEntries = await $.fs.list(`${p.inbox}/read`).catch(() => [])
  const readReports: ManagerInboxReport[] = []
  for (const f of readEntries.filter(one => one.kind === 'file' && /\.md$/i.test(one.name))) {
    const known = readInboxCache.get(f.name)
    if (known && known.mtimeMs === f.mtimeMs) {
      readReports.push(known.report)
      continue
    }
    try {
      const body = f.size > INBOX_MAX_BYTES ? '' : await $.fs.read(`${p.inbox}/read/${f.name}`)
      const report = L.inboxReport(f.name, body, f.mtimeMs)
      readInboxCache.set(f.name, { mtimeMs: f.mtimeMs, report })
      readReports.push(report)
    } catch {
      continue
    }
  }
  const readNames = new Set(readReports.map(one => one.file))
  for (const name of [...readInboxCache.keys()]) if (!readNames.has(name)) readInboxCache.delete(name)
  latestInboxReports = [...readReports, ...unread]
  hasScannedInbox = true
  const before = await read($, inboxAtom)
  if (JSON.stringify(before) !== JSON.stringify(unread)) await update($, inboxAtom, () => unread)
  const noted = L.noteInbox(await read($, wakeAtom), unread, L.wakesManager)
  await update($, wakeAtom, () => noted.wake)
  await $.store.set('wake', noted.wake)
  for (const one of noted.fresh.slice(-3)) {
    const alert = L.inboxAlert(one)
    if (alert) await raise($, alert)
  }
  await maybeWake($)
  await rebuild($)
}

/** Read a complete remote snapshot before changing cards; failed reads preserve the queue. */
const draftsPass = async ($: Dollar) => {
  if (!paths?.sourceOfTruthRepo || isDraftsBusy) return
  isDraftsBusy = true
  try {
    if (!(await isManager($))) return
    const git = async (...args: string[]) => {
      const run = await $.process.run(['/usr/bin/git', '-C', paths!.sourceOfTruthRepo, ...args], { timeoutMs: 30_000 })
      if (run.exitCode !== 0 || run.isStdoutTruncated) throw new Error(`git ${args[0]} failed: ${run.stderr}`)
      return run.stdout
    }
    // Offline or a busy ref lock: read the last fetched origin/main rather than skip the pass.
    await git('fetch', '-q', 'origin', 'main').catch(err => log($, `drafts fetch failed: ${errText(err)}`))
    const listing = await git('ls-tree', '-z', '--name-only', 'origin/main', 'drafts/')
    const files: L.DraftFile[] = []
    for (const path of listing.split('\0')) {
      if (!/^drafts\/[^/]+\.md$/i.test(path)) continue
      files.push({ path, text: await git('show', `origin/main:${path}`) })
    }
    const all = L.draftCards(files, await $.clock.now())
    const handled = await handledDrafts($)
    const stillWaiting = handled.filter(id => all.some(card => card.id === id))
    if (stillWaiting.length !== handled.length) await $.store.set('draftsHandled', stillWaiting)
    const drafts = all.filter(card => !stillWaiting.includes(card.id))
    await setOutbound($, current => L.syncDrafts(current, drafts), true)
  } catch (err) {
    log($, `drafts failed: ${errText(err)}`)
  } finally {
    isDraftsBusy = false
  }
}

const inboxPass = async ($: Dollar) => {
  const p = paths
  if (!p || isInboxBusy) return
  isInboxBusy = true
  try {
    await scanInbox($, p)
  } catch (err) {
    log($, `inbox failed: ${errText(err)}`)
  } finally {
    isInboxBusy = false
  }
}

/** Leads read only the files directly in their own folder. */
const leadInboxPass = async ($: Dollar) => {
  if (isLeadInboxBusy) return
  const gate = await read($, gateAtom)
  if (gate.status !== 'lead' || !gate.leadSlug) return
  isLeadInboxBusy = true
  try {
    const p = await resolvePaths($)
    const folder = `${p.inbox}/for-leads/${gate.leadSlug}`
    const entries = await $.fs.list(folder).catch(() => [])
    const unread: ManagerInboxReport[] = []
    for (const f of entries) {
      if (f.kind !== 'file' || !/\.md$/i.test(f.name)) continue
      try {
        const body = f.size > INBOX_MAX_BYTES ? '' : await $.fs.read(`${folder}/${f.name}`)
        unread.push(L.inboxReport(f.name, body, f.mtimeMs))
      } catch {
        // The file was moved to read/ after the listing.
      }
    }
    const noted = L.noteInbox(await read($, leadWakeAtom), unread)
    await update($, leadWakeAtom, () => noted.wake)
    if (noted.wake.pending.length === 0) return
    const box = await $.prompt.read().catch(() => ({ text: '', cursor: 0 }))
    const now = await $.clock.now()
    const isTurnRunning = runningTurnId !== undefined && now - turnStartedAt < TURN_STUCK_MS
    const plan = L.planWake(noted.wake, unread, now, isTurnRunning, box.text.trim() !== '', L.leadWakeText)
    await update($, leadWakeAtom, () => plan.wake)
    if (plan.text && await isLead($)) {
      $.prompt.submit({ text: plan.text }).catch(err => log($, `lead wake not submitted: ${errText(err)}`))
    }
  } catch (err) {
    log($, `lead inbox failed: ${errText(err)}`)
  } finally {
    isLeadInboxBusy = false
  }
}

const boardText = (board: ManagerBoard | null, asks: readonly ManagerAsk[], cards: readonly ManagerOutbound[], now: number): string => {
  const items = L.bandQueue(asks, cards, now)
  const lines = [`Needs you (${items.length}):`]
  for (const item of items) lines.push(item.kind === 'ask'
    ? `- ${item.ask.text}${item.ask.meaning ? ` What this means: ${item.ask.meaning}` : ''} (if no answer: ${item.ask.default})`
    : `- To ${item.card.to} on ${item.card.channel}: "${item.card.text}"`)
  if (!board) return [...lines, 'The board is still reading the sessions.'].join('\n')
  lines.push('Leads:')
  for (const card of L.sortedLeads(board.cards)) lines.push(`- ${L.leadSummary(card)}`)
  lines.push(`Details: ${L.workerCount(board)} workers; ${board.finishedJobs?.length ?? 0} finished jobs. Open the board pane for details.`)
  return lines.join('\n')
}

let managerStarted = false
let leadStarted = false
let compactStarted = false
let gateTimerPending = false

const activateLead = ($: Dollar) => {
  if (leadStarted) return
  leadStarted = true
  $.clock.every(INBOX_EVERY_MS, () => void leadInboxPass($))
  $.clock.after(2500, () => void leadInboxPass($))
}

const activateCompact = ($: Dollar) => {
  if (compactStarted) return
  compactStarted = true
  $.clock.every(60_000, () => void compactPass($))
  $.clock.after(1500, () => void compactPass($))
}

const activateManager = async ($: Dollar) => {
  if (managerStarted) return
  managerStarted = true
  try {
    await $.command.register({
      name: 'board',
      description: 'Open the team board: every lead and worker, what they last said, and running Codex jobs.',
      immediate: true,
    })
    // After a restart the session's values are empty: bring back what was kept.
    if ((await $.state.get({ plugin: 'manager-console', key: 'asks' })).version === 0) {
      const kept = await $.store.get('asks')
      if (Array.isArray(kept)) await update($, asksAtom, () => kept as ManagerAsk[])
    }
    if ((await $.state.get({ plugin: 'manager-console', key: 'outbound' })).version === 0) {
      const kept = await $.store.get('outbound')
      if (Array.isArray(kept)) await update($, outboundAtom, () => kept as ManagerOutbound[])
    }
    if ((await $.state.get({ plugin: 'manager-console', key: 'records' })).version === 0) {
      const kept = await $.store.get('records')
      if (typeof kept === 'object' && kept !== null) await update($, recordsAtom, () => kept as Record<string, ManagerRecordInfo>)
    }
    if ((await $.state.get({ plugin: 'manager-console', key: 'wake' })).version === 0) {
      const kept = await $.store.get('wake')
      if (typeof kept === 'object' && kept !== null) await update($, wakeAtom, () => kept as L.WakePlan['wake'])
    }
    if ((await $.state.get({ plugin: 'manager-console', key: 'idleAlarm' })).version === 0) {
      const kept = await $.store.get('idleAlarm')
      if (typeof kept === 'object' && kept !== null &&
          typeof (kept as L.IdleAlarm).idleSince === 'number' && typeof (kept as L.IdleAlarm).lastAt === 'number') {
        await update($, idleAlarmAtom, () => kept as L.IdleAlarm)
      }
    }
    if ((await $.state.get({ plugin: 'manager-console', key: 'extras' })).version === 0) {
      const kept = await $.store.get('extras')
      if (typeof kept === 'object' && kept !== null) await update($, extrasAtom, () => kept as ManagerExtras)
    }
    const lastCompactAt = await $.store.get(`lastCompactAt:${await $.session.id()}`)
    if (typeof lastCompactAt === 'number' && Number.isFinite(lastCompactAt) && lastCompactAt > 0) {
      await update($, compactCycleAtom, cycle => ({ ...cycle, lastCompactAt: Math.max(cycle.lastCompactAt, lastCompactAt) }))
    }
    const extras = await read($, extrasAtom)
    if (extras.tzOffsetMin === undefined) {
      const run = await $.process.run(['/bin/date', '+%z'], { timeoutMs: 5000 }).catch(() => undefined)
      const offset = run ? L.parseTzOffset(run.stdout) : undefined
      if (offset !== undefined) await setExtras($, { ...extras, tzOffsetMin: offset })
    }
    await refreshStatus($)
    $.clock.every(POLL_MS, () => void poll($, true))
    $.clock.after(1500, () => void poll($, true))
    $.clock.every(INBOX_EVERY_MS, () => void inboxPass($))
    $.clock.after(2500, () => void inboxPass($))
    $.clock.every(DRAFTS_EVERY_MS, () => void draftsPass($))
    $.clock.after(2000, () => void draftsPass($))
    if (!(await read($, autoOpenedAtom))) {
      await update($, autoOpenedAtom, () => true)
      const saved = await $.store.get('boardOpen')
      const shouldOpen = saved === undefined ? true : saved === true
      await update($, boardOpenAtom, () => shouldOpen)
      if (shouldOpen) void $.ui.open({ id: PANE, title: 'Team board' }).catch(() => undefined)
      $.ui.toast('Console active · /board')
    }
  } catch (err) {
    log($, `start failed: ${errText(err)}`)
  }
}

const checkGate = async ($: Dollar) => {
  let current = await read($, gateAtom)
  if (current.status === 'off') {
    // A gate that timed out before a restored session's title was readable gets one more look on each start or reload.
    const title = await ownTranscriptTitle($, await resolvePaths($).catch(() => undefined))
    if (title === undefined || L.gateForTitle(title, 0, 0, configuredLeadSlugs).status === 'off') return
    current = { status: 'unknown', firstCheckedAt: 0 }
  }
  if (current.status === 'manager') {
    activateCompact($)
    paths = await resolvePaths($)
    await activateManager($)
    return
  }
  if (current.status === 'lead') {
    activateCompact($)
    activateLead($)
    return
  }
  if (current.status === 'worker') {
    activateCompact($)
    return
  }
  const now = await $.clock.now()
  const firstCheckedAt = current.firstCheckedAt || now
  let title: string | undefined
  let candidate: Paths | undefined
  try {
    candidate = await resolvePaths($)
    title = await ownDesktopTitle($, candidate, await $.session.id())
  } catch {
    // A new desktop record may not have appeared yet.
  }
  if (title === undefined) title = (await $.env.get('HARNESS_TITLE').catch(() => undefined))?.trim() || undefined
  // A session cmux restored after a restart keeps its `-n` title but not the launcher's env (2026-10-20).
  if (title === undefined) title = await ownTranscriptTitle($, candidate)
  if (title === 'Manager') {
    candidate ??= await resolvePaths($).catch(() => undefined)
    if (candidate) paths = candidate
  }
  const decision = L.gateForTitle(title, firstCheckedAt, now, configuredLeadSlugs)
  await update($, gateAtom, () => decision)
  if (decision.status === 'manager') {
    activateCompact($)
    await activateManager($)
  } else if (decision.status === 'lead') {
    activateCompact($)
    activateLead($)
  } else if (decision.status === 'worker') {
    activateCompact($)
  } else if (decision.status === 'unknown' && !gateTimerPending) {
    gateTimerPending = true
    $.clock.after(L.GATE_RECHECK_MS, () => {
      gateTimerPending = false
      void checkGate($)
    })
  }
}

// Both surfaces render the same card and call the same actions.
const decisionCard = ($: Dollar, e: Parameters<Dollar['ui']['resolve']>[0], item: L.BandItem,
  now: number, replyOpen: readonly string[], bandCount?: number) => {
  const { Box, Text, Button, Input } = $.ui.resolve(e)
  const prefix = bandCount === undefined ? 'pane-' : ''
  const ask = item.kind === 'ask' ? item.ask : undefined
  const card = item.kind === 'send' ? item.card : undefined
  const at = ask?.askedAt ?? card!.queuedAt
  return (
    <Box key={`${prefix}${L.bandKey(item)}`} flexDirection="column" gap={1} paddingX={e.surface === 'desktop' ? 1 : 0} borderStyle={e.surface === 'desktop' ? 'round' : undefined} borderColor="subtle" width="100%">
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
        <Text bold color="warning">Your turn</Text>
        <Text dimColor>{`${L.ago(now - at)} ago`}</Text>
        {ask?.file && <Button key={`${prefix}open-${ask.id}`} label="Open file" plain dimColor onPress={() => void openInstruction($, ask.file!)} />}
        {bandCount !== undefined && <Text dimColor>{`1 of ${bandCount}`}</Text>}
        {bandCount !== undefined && <Button key="open-board" label="Team board" plain dimColor onPress={() => void openBoard($)} />}
      </Box>
      {ask ? (
        <Box flexDirection="column" gap={1}>
          <Text wrap="wrap">{ask.text}</Text>
          {ask.meaning && <Text dimColor wrap="wrap">{`What this means: ${ask.meaning}`}</Text>}
          <Text dimColor wrap="wrap">{`If no answer: ${ask.default}`}</Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            {L.askAnswers(ask).map((option, i) => (
              <Button key={`${prefix}ask-${ask.id}-${i}`} label={option}
                {...(e.surface === 'terminal' && bandCount !== undefined ? { hotkey: String(i + 1) } : {})}
                variant={i === 0 ? 'primary' : 'secondary'} onPress={() => void answer($, ask, option)} />
            ))}
            <Button key={`${prefix}reply-${ask.id}`} label="Reply" variant="secondary" onPress={() => void update($, replyOpenAtom, ids => ids.includes(ask.id) ? ids : [...ids, ask.id])} />
            {bandCount === undefined ? <>
              <Button key={`${prefix}skip-${ask.id}`} label="Skip" plain dimColor onPress={() => void answer($, ask, L.SKIP_ANSWER)} />
              <Button key={`${prefix}dismiss-${ask.id}`} label="Dismiss" plain dimColor onPress={() => void dismissAsk($, ask)} />
            </> : <Button key={`${prefix}next-${ask.id}`} label="Next" plain dimColor onPress={() => void nextBand($)} />}
          </Box>
          {replyOpen.includes(ask.id) && <Input key={`${prefix}ask-input-${ask.id}`} placeholder="Reply…" value={askInputs.get(ask.id) ?? ''} submitLabel="Send"
            onInput={value => { askInputs.set(ask.id, value); void update($, nowAtom, now => now + 1) }}
            onSubmit={value => void sendTypedAsk($, ask, value)} />}
        </Box>
      ) : card ? (
        <Box flexDirection="column" gap={1}>
          <Text wrap="wrap">{`Send to ${card.to} (${card.channel})`}</Text>
          <Text wrap="wrap">{card.text}</Text>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button key={`${prefix}send-${card.id}`} label="Send" variant="primary" onPress={() => void sendCard($, card)} />
            <Button key={`${prefix}edit-${card.id}`} label="Edit" variant="secondary" onPress={() => void editCard($, card)} />
            {bandCount === undefined
              ? <Button key={`${prefix}skip-${card.id}`} label="Don't send" plain dimColor onPress={() => void dropCard($, card)} />
              : <Button key={`${prefix}next-${card.id}`} label="Next" plain dimColor onPress={() => void nextBand($)} />}
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}


export const register: Register = on => {
  // ─── Session start: tools, command, saved state, timers ────────────────────

  on('session.start', async ($, e, next) => {
    try {
      await $.tool.register({
        name: 'manager_ask',
        isDeferred: false,
        description:
          "Put a question for owner in the 'Your turn' band above his prompt. Questions due within an hour appear in deadline order, followed by send cards and other questions, shortest first within each group. His press, or a typed reply that starts with one of the answers, reaches you as his prompt and closes the ask. Dismiss closes it as dismissed by owner and tells you in his prompt. A new ask raises a 'needs you' alert.",
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The question, in plain words.' },
            meaning: { type: 'string', description: 'Optional one sentence for What this means, explaining unfamiliar work in plain language.' },
            default: { type: 'string', description: "What happens if he doesn't answer." },
            deadlineAt: { type: 'string', description: 'Optional ISO date and time with a time zone when the default takes effect. Questions due within an hour appear first.' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Two to six short answers, one per button. Leave it out for Yes / No. Reply and Dismiss are always provided; do not include Later.',
            },
            id: { type: 'string', description: 'Optional. Reuse an id to update that ask in place.' },
            session: {
              type: 'string',
              description: "Optional. The session the ask is about (its title or local_ id), so its board card says 'needs you'.",
            },
            file: { type: 'string', description: 'Optional absolute .md or .txt instruction file under owner’s Claude Projects or harness folder.' },
          },
          required: ['text', 'default'],
        },
      })
      await $.tool.register({
        name: 'manager_ask_resolve',
        isDeferred: false,
        description:
          "Close an ask in owner's 'Your turn' band once it is answered some other way or no longer applies. Asks he answers by button or by a reply starting with an answer close themselves.",
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'The id manager_ask returned.' },
            answer: { type: 'string', description: 'What he decided, or why it closed.' },
          },
          required: ['id', 'answer'],
        },
      })
      await $.tool.register({
        name: 'manager_queue_outbound',
        isDeferred: false,
        description:
          "Queue a message that would go out in owner's name (Chat, Gmail, ...) as a card on the board and above the prompt. Don't send removes it; Next moves to another card in the band. Send reaches you as his prompt: 'Send it — <channel> to <to>, exactly: \"<text>\"'. Only then send it, word for word. This tool never sends anything.",
        inputSchema: {
          type: 'object',
          properties: {
            channel: { type: 'string', description: 'Where it goes: Chat, Gmail, ...' },
            to: { type: 'string', description: 'Who receives it.' },
            text: { type: 'string', description: 'The exact message, word for word.' },
            id: { type: 'string', description: 'Optional. Reuse an id to replace that card.' },
          },
          required: ['channel', 'to', 'text'],
        },
      })
      await $.tool.register({
        name: 'manager_outbound_remove',
        isDeferred: false,
        description: 'Remove a send card from owner\'s board (sent another way, or no longer needed).',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'The id manager_queue_outbound returned.' } },
          required: ['id'],
        },
      })
      for (const action of ['reserve', 'spent'] as const) {
        await $.tool.register({
          name: `manager_budget_${action}`,
          isDeferred: false,
          description: action === 'reserve'
            ? 'Before every lead job launch, reserve the estimated percent of the daily Codex or Claude allowance. Refuses a reservation beyond the lead share. Reuse the job id when reporting spend. Shares are configurable in the stored ledger; shares are read from harness/leads.json. Returns today\'s reservation and spend.'
            : 'After a job runs, record its actual percent spent on Codex or Claude using the same lead, side, and job id as its reservation. Spend reconciles against that reservation. Returns today\'s reservation and spend; record overruns too.',
          inputSchema: {
            type: 'object',
            properties: {
              lead: { type: 'string', description: 'Lead title or configured lead name.' },
              side: { type: 'string', enum: ['codex', 'claude'], description: 'Allowance account used.' },
              pct: { type: 'number', description: action === 'reserve' ? 'Estimated percentage of the daily account allowance.' : 'Actual percentage used by this job; additional calls add spend.' },
              job: { type: 'string', description: 'Stable job identifier, shared by reserve and spent calls.' },
            },
            required: ['lead', 'side', 'pct', 'job'],
          },
        })
      }
    } catch (err) {
      log($, `registration failed: ${errText(err)}`)
    }
    await checkGate($)
    return next(e)
  })

  // ─── The model's tools ─────────────────────────────────────────────────────

  on('tool.call', { tool: TOOL_ASK }, async ($, e) => {
    if (!(await isManager($))) return { deny: OFF_MESSAGE }
    const input = e as unknown as L.AskInput
    if (input.file !== undefined && !(await safeInstructionFile($, String(input.file)))) return { deny: 'manager_ask: file must be an existing .md or .txt file under the approved folders, at most 200 KB.' }
    const now = await $.clock.now()
    let outcome = { error: 'not added' } as L.AddAskResult
    const newId = makeId('a')
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
    const roots = [await $.session.cwd(), `${configDir}/harness`]
    await setAsks($, queue => {
      outcome = L.addAsk(queue, input, now, newId, roots)
      return 'error' in outcome ? queue : outcome.queue
    })
    if ('error' in outcome) return { deny: `manager_ask: ${outcome.error}` }
    const { ask, isNew, queue } = outcome
    if (isNew) await raise($, `Needs you: ${ask.text}`)
    const ordered = L.bandQueue(queue, await read($, outboundAtom), now)
    const place = ordered.findIndex(one => one.kind === 'ask' && one.ask.id === ask.id) + 1
    return {
      result: `${isNew ? 'Added' : 'Updated'} ask ${ask.id}: number ${place} of ${ordered.length} in owner's band. Answers: ${ask.options.join(' / ')}.`,
    }
  })

  on('tool.call', { tool: TOOL_RESOLVE }, async ($, e) => {
    if (!(await isManager($))) return { deny: OFF_MESSAGE }
    const id = String((e as unknown as { id?: unknown }).id ?? '')
    const said = String((e as unknown as { answer?: unknown }).answer ?? '')
    let found: ManagerAsk | undefined
    await setAsks($, queue => {
      const out = L.resolveAsk(queue, id)
      found = out.ask
      return out.queue
    })
    return {
      result: found ? `Closed ask ${id} (${L.clipText(said, 80)}).` : `No open ask ${id}; nothing to close (it may have been answered already).`,
    }
  })

  on('tool.call', { tool: TOOL_OUTBOUND }, async ($, e) => {
    if (!(await isManager($))) return { deny: OFF_MESSAGE }
    const input = e as unknown as L.OutboundInput
    const now = await $.clock.now()
    let outcome = { error: 'not added' } as L.AddOutboundResult
    const newId = makeId('m')
    await setOutbound($, list => {
      outcome = L.addOutbound(list, input, now, newId)
      return 'error' in outcome ? list : outcome.list
    })
    if ('error' in outcome) return { deny: `manager_queue_outbound: ${outcome.error}` }
    const { card, isNew } = outcome
    return {
      result: `${isNew ? 'Queued' : 'Replaced'} send card ${card.id} for ${card.to} on ${card.channel}. Nothing was sent. If owner presses Send you will get his prompt with the exact text.`,
    }
  })

  on('tool.call', { tool: TOOL_OUTBOUND_REMOVE }, async ($, e) => {
    if (!(await isManager($))) return { deny: OFF_MESSAGE }
    const id = String((e as unknown as { id?: unknown }).id ?? '')
    const before = await read($, outboundAtom)
    await setOutbound($, list => list.filter(one => one.id !== id))
    return { result: before.some(one => one.id === id) ? `Removed send card ${id}.` : `No send card ${id}.` }
  })

  for (const [tool, action] of [[TOOL_BUDGET_RESERVE, 'reserve'], [TOOL_BUDGET_SPENT, 'spent']] as const) {
    on('tool.call', { tool }, async ($, e) => {
      await loadLeads($, true)
      const gate = await read($, gateAtom)
      if (gate.status !== 'manager' && gate.status !== 'lead') return { deny: 'Budget tools are available to Manager and leads only.' }
      const input = e as unknown as L.BudgetInput
      if (gate.status === 'lead' && L.budgetLeadName(String(input.lead ?? '')) !== L.budgetLeadName((gate.leadSlug ?? '').replace(/-/g, ' '))) {
        return { deny: 'A lead can record only its own budget.' }
      }
      const stored = await $.store.get('budget')
      const ledger = stored && typeof stored === 'object' ? { ...(stored as L.BudgetLedger), shares: configuredShares } : L.emptyBudget(configuredShares)
      const now = await $.clock.now()
      const savedExtras = await $.store.get('extras') as ManagerExtras | undefined
      const date = L.budgetDate(now, savedExtras?.tzOffsetMin ?? (await read($, extrasAtom)).tzOffsetMin ?? 0)
      const result = L.budgetChange(ledger, date, input, action)
      if (result.error) return { deny: result.message }
      await $.store.set('budget', result.ledger)
      await update($, budgetAtom, () => result.ledger)
      if (gate.status === 'manager') await refreshStatus($)
      return { result: result.message }
    })
  }

  // Messages to other sessions: re-count from the transcript a moment later.
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const result = await next(e)
    if (await isManager($)) soon($, 1500)
    return result
  })

  on('tool.call', { tool: 'mcp__ccd_session_mgmt__send_message' }, async ($, e, next) => {
    const result = await next(e)
    if (await isManager($)) soon($, 1500)
    return result
  })

  // The Manager's own context fill moves with every turn: refresh the status line then.
  on('turn.start', async ($, e, next) => {
    if (!(await canCompact($))) return next(e)
    if ((e as { agentId?: string }).agentId !== undefined) return next(e)
    runningTurnId = e.turnId
    turnStartedAt = await $.clock.now()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if ((e as { agentId?: string }).agentId === undefined && await canCompact($)) {
      if (runningTurnId === e.turnId) runningTurnId = undefined
      $.clock.after(3000, () => void compactPass($))
    }
    if (await isLead($)) {
      if ((e as { agentId?: string }).agentId === undefined) {
        if (runningTurnId === e.turnId) runningTurnId = undefined
        $.clock.after(3000, () => void leadInboxPass($))
      }
      return result
    }
    if (!(await isManager($))) return result
    if ((e as { agentId?: string }).agentId !== undefined) return result
    if (runningTurnId === e.turnId) runningTurnId = undefined
    await refreshStatus($).catch(() => undefined)
    // A wake held back while the turn ran goes out once the session has settled.
    $.clock.after(3000, () => void maybeWake($).catch(() => undefined))
    return result
  })

  // ─── owner's prompts: an answer that starts with a button's label closes the top ask ──

  on('prompt.submit', async ($, e, next) => {
    if (!(await isManager($))) return next(e)
    try {
      const kind = e.origin?.kind ?? ''
      const fromOwner = L.isPersonOrigin(kind) // Card actions already resolve their specific ask.
      if (fromOwner && L.isGenuinePromptText(e.text)) {
        const now = await $.clock.now()
        const first = L.bandQueue(await read($, asksAtom), await read($, outboundAtom), now)[0]
        const top = first?.kind === 'ask' ? first.ask : undefined
        const option = top ? L.matchAnswer(e.text, top) : undefined
        if (top && option) {
          await closeAsk($, top)
        }
        const cards = await read($, outboundAtom)
        const sent = cards.find(card => L.isSendPromptFor(e.text, card))
        if (sent) await setOutbound($, list => list.filter(one => one.id !== sent.id))
        soon($, 2000)
      } else if (kind === 'peer' || kind === 'peer-send-message') {
        soon($, 2500)
      }
    } catch (err) {
      log($, `prompt bookkeeping failed: ${errText(err)}`)
    }
    return next(e)
  })

  // ─── /board ────────────────────────────────────────────────────────────────

  on('command.run', { command: 'board' }, async $ => {
    if (!(await isManager($))) return { text: OFF_MESSAGE }
    const opened = await openBoard($)
    const board = await read($, boardAtom)
    const now = await $.clock.now()
    if (!board || now - board.scannedAt >= POLL_MS) soon($, 50)
    if (opened.isPlaced) return { text: 'Team board opened.' }
    const asks = await read($, asksAtom)
    const text = boardText(board, asks, await read($, outboundAtom), now)
    return { text: `This window can't show the board as a pane (${opened.reason}). Here it is as text:\n\n${text}` }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind === 'person' || e.origin.kind === 'plugin') {
      await update($, boardOpenAtom, () => false)
      await $.store.set('boardOpen', false)
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (!result.skip && e.agentId === undefined && e.trigger !== 'precompute' && await canCompact($)) {
      const at = await $.clock.now()
      await update($, compactCycleAtom, cycle => ({ ...cycle, nudgeAt: 0, lastCompactAt: at, awaitDrop: true }))
      await $.store.set(`lastCompactAt:${await $.session.id()}`, at)
      if (await isManager($)) await refreshStatus($)
    }
    return result
  })

  // cmux: the stats ride on the prompt hint's row, after the engine's permission-mode pill.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (hintStats === undefined || !(await isManager($))) return next(e)
    return next({ ...e, props: { ...e.props, hint: L.hintWithStats(e.props.hint, hintStats) } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // In cmux the Dock board carries the asks and send cards, so the band would only repeat them (owner, 2026-10-20).
    if (!(await isManager($)) || e.props.hasSurvey || (await inCmux($))) return next(e)
    const queue = await read($, asksAtom)
    const cards = await read($, outboundAtom)
    const replyOpen = await read($, replyOpenAtom)
    await read($, nowAtom)
    const now = await $.clock.now()
    const ordered = L.bandQueue(queue, cards, now)
    const offset = await read($, bandOffsetAtom)
    const { Box, Button } = $.ui.resolve(e)
    return <Box flexDirection="column" width="100%">
      {ordered.length ? decisionCard($, e, ordered[offset % ordered.length]!, now, replyOpen, ordered.length)
        : <Button key="open-board" label="Team board" plain dimColor onPress={() => void openBoard($)} />}
    </Box>
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!(await isManager($))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const board = await read($, boardAtom)
    const queue = await read($, asksAtom)
    const cards = await read($, outboundAtom)
    const replyOpen = await read($, replyOpenAtom)
    const detailsOpen = await read($, workerDetailsAtom)
    const extras = await read($, extrasAtom)
    const budget = await read($, budgetAtom)
    await read($, nowAtom)
    const now = await $.clock.now()
    const ordered = L.bandQueue(queue, cards, now)
    const leads = L.sortedLeads(board?.cards ?? [])
    const workers = board?.cards.filter(card => !card.isLead) ?? []
    const inboxLine = (one: ManagerInboxReport) => <Text wrap="wrap" dimColor>{`Inbox: ${one.line} · ${L.ago(now - one.mtimeMs)} ago`}</Text>
    const detailCard = (card: ManagerCard) => <Box flexDirection="column" gap={1}>
      <Text bold>{card.title}</Text>
      <Text wrap="wrap">{card.report ? `${card.report.line} · ${L.ago(now - card.report.at)} ago` : card.summary || 'No update yet'}</Text>
      {card.ctxPercent !== undefined && <Text dimColor>{`Context ${card.ctxPercent}% full${L.isHandoffDue(card.ctxPercent) ? ` · ${card.ctxPercent >= L.COMPACT_AT ? 'compacting' : 'handoff due'}` : ''}`}</Text>}
      {card.codex.map(job => <Text dimColor wrap="wrap">{`Codex ${job.label}: ${job.phase || job.status} · started ${L.ago(now - job.startedAt)} ago`}</Text>)}
      {(card.helpers ?? []).map(helper => <Text dimColor wrap="wrap">{`Helper ${helper.label}: ${helper.status} · active ${L.ago(now - helper.lastActiveAt)} ago`}</Text>)}
      {card.isLead && <Text dimColor>{L.budgetSummary(budget, L.budgetDate(now, extras.tzOffsetMin ?? 0), card.shortTitle)}</Text>}
      {(card.inbox ?? []).map(inboxLine)}
    </Box>
    return <Box flexDirection="column" gap={1}>
      <Text key="needs-you-heading" bold color="warning">{`Needs you (${ordered.length})`}</Text>
      {ordered.length ? ordered.map(item => decisionCard($, e, item, now, replyOpen)) : <Text dimColor>Nothing waiting on you.</Text>}
      <Text key="leads-heading" bold>Leads</Text>
      <Text dimColor>{board ? `${leads.length} lead${leads.length === 1 ? '' : 's'} · ${L.workerCount(board)} workers · updated ${L.ago(now - board.scannedAt)} ago` : 'Reading the team’s sessions…'}</Text>
      {leads.map(card => <Text key={`lead-${card.cliSessionId}`} wrap="wrap" color={L.leadDisplayState(card) === 'Broke' ? 'error' : undefined}>{L.leadSummary(card)}</Text>)}
      {board && leads.length === 0 && <Text dimColor>No leads open.</Text>}
      <Button key="worker-details" label={detailsOpen ? 'Hide details' : 'Details'} plain dimColor onPress={() => void update($, workerDetailsAtom, open => !open)} />
      {detailsOpen && <Box flexDirection="column" gap={1}>
        {leads.map(detailCard)}
        {workers.length > 0 && <Text bold>{`Workers (${workers.length})`}</Text>}
        {workers.map(detailCard)}
        {(board?.otherJobs ?? []).map(job => <Text dimColor wrap="wrap">{`Codex ${job.label}: ${job.phase || job.status} · ${job.summary}`}</Text>)}
        {(board?.finishedJobs ?? []).map(job => <Text dimColor wrap="wrap">{`Codex ${job.label}: ${job.status} · ${job.summary}`}</Text>)}
        {(board?.inboxOther?.length ?? 0) > 0 && <Text bold>{`Inbox, no matching card (${board!.inboxOther!.length})`}</Text>}
        {(board?.inboxOther ?? []).map(inboxLine)}
        {extras.ghNote && <Text dimColor wrap="wrap">{extras.ghNote}</Text>}
      </Box>}
    </Box>
  })

  on('ui.render', { component: 'Pane', requestId: INSTRUCTION_PANE }, async ($, e, next) => {
    if (!(await isManager($))) return next(e)
    const path = await read($, openInstructionAtom)
    if (!path) return next(e)
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    let body = 'The file could not be read.'
    if (await safeInstructionFile($, path)) body = await $.fs.read(path).catch(() => body)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>{path.slice(path.lastIndexOf('/') + 1)}</Text>
          <Button key="instruction-close" label="Close" onPress={() => void $.ui.close({ id: INSTRUCTION_PANE })} />
        </Box>
        {Markdown ? <Markdown text={body} /> : <Text wrap="wrap">{body}</Text>}
      </Box>
    )
  })
}
