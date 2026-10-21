// The manager-console mod's contract: every value it keeps in $.state.

/** One open question for owner, shown in the "Your turn" band. */
export type ManagerAsk = {
  id: string
  text: string
  /** One sentence explaining unfamiliar work in plain language. */
  meaning?: string
  /** What happens if owner does not answer. */
  default: string
  /** The answer buttons; Yes / No when the ask names none. */
  options: string[]
  /** The session the ask is about (title or local_ id), when given. */
  session?: string
  file?: string
  askedAt: number
  /** When the stated default takes effect, if a time was supplied. */
  deadlineAt?: number
  /** Legacy snooze timestamp; new surfaces show all open asks. */
  snoozedUntil?: number
}

/** A message that would go out in owner's name, waiting for Send / Edit / Skip. */
export type ManagerOutbound = {
  id: string
  channel: string
  to: string
  text: string
  queuedAt: number
  source?: 'draft'
}

export type ManagerReportKind = 'shipped' | 'broke' | null

/** The newest report one session sent the Manager. */
export type ManagerReport = {
  sessionId: string
  name: string
  line: string
  at: number
  kind: ManagerReportKind
  hasQuestion: boolean
}

export type ManagerCodexJob = {
  id: string
  label: string
  summary: string
  status: string
  phase: string
  startedAt: number
  /** The cli session id that launched it. */
  sessionId?: string
}

export type ManagerHelper = {
  id: string
  label: string
  status: 'running' | 'finished'
  startedAt: number
  lastActiveAt: number
}

export type ManagerCardState = 'working' | 'idle' | 'needs you' | 'running' | 'needs owner' | 'waiting on' | 'budget-paused' | 'ready'

export type ManagerCard = {
  sessionId: string
  cliSessionId: string
  title: string
  shortTitle: string
  role: string
  isLead: boolean
  state: ManagerCardState
  report?: ManagerReport
  /** The session's own last summary, shown when it has sent no report. */
  summary?: string
  lastActiveAt: number
  /** A lead's stated resume time that passed while it was idle. */
  overdueSince?: number
  codex: ManagerCodexJob[]
  helpers?: ManagerHelper[]
  /** Context fill from the newest assistant message in its transcript tail, 0-100. */
  ctxPercent?: number
  /** Its unread inbox reports, oldest first. */
  inbox?: ManagerInboxReport[]
}

export type ManagerInboxKind = 'ship' | 'break' | 'needs-owner' | 'fyi' | 'other'

/** One unread report a session dropped in ~/.claude/harness/inbox/. */
export type ManagerInboxReport = {
  file: string
  /** The session title the file name carries. */
  title: string
  kind: ManagerInboxKind
  /** The first line, as written. */
  line: string
  mtimeMs: number
  signal?: 'needs owner' | 'waiting on' | 'budget-paused'
}

/** When the mod last woke the Manager, and the reports still waiting to be named in a wake. */
export type ManagerWake = {
  lastAt: number
  pending: string[]
  /** File names already alerted on and queued, so none is announced twice. */
  seen: string[]
}

export type ManagerBoard = {
  cards: ManagerCard[]
  otherJobs: ManagerCodexJob[]
  finishedJobs?: ManagerCodexJob[]
  scannedAt: number
  /** Unread inbox reports no card claims. */
  inboxOther?: ManagerInboxReport[]
}

/** What the mod keeps from one desktop session record. */
export type ManagerRecordInfo = {
  mtimeMs: number
  archived: boolean
  title: string
  sessionId: string
  cliSessionId: string
  cwd: string
  lastActivityAt: number
  summary: string
}

/** The running read of the Manager's own transcript. */
export type ManagerTail = {
  offset: number
  /** Messages sent to other sessions since owner's last genuine prompt. */
  msgs: number
  reports: Record<string, ManagerReport>
  agentNames: string[]
  seededAt: number
}

export type ManagerExtras = {
  ghLeft?: number
  ghCheckedAt: number
  ghNote?: string
  next?: { date: string; label: string }
  nextCheckedAt: number
  tzOffsetMin?: number
}

declare module 'claude-code' {
  interface PluginState {
    'manager-console': {
      asks: ManagerAsk[]
      outbound: ManagerOutbound[]
      board: ManagerBoard | null
      tail: ManagerTail | null
      records: Record<string, ManagerRecordInfo>
      extras: ManagerExtras
      now: number
      autoOpened: boolean
      inbox: ManagerInboxReport[]
      wake: ManagerWake
      idleAlarm: { idleSince: number; lastAt: number }
      leadWake: ManagerWake
      gate: { status: 'manager' | 'lead' | 'worker' | 'off' | 'unknown'; firstCheckedAt: number; leadSlug?: string; workerSlug?: string }
      compactCycle: { nudgeAt: number; lastCompactAt: number; awaitDrop: boolean }
      openInstruction: string | null
      replyOpen: string[]
      bandOffset: number
      workerDetailsOpen: boolean
      boardOpen: boolean
      budget: { shares: Record<string, { codexPct: number; claudePct: number }>; days: Record<string, Record<string, { reserved: { codexPct: number; claudePct: number }; spent: { codexPct: number; claudePct: number }; jobs: Record<string, { side: 'codex' | 'claude'; reserved: number; spent: number }> }>> }
    }
  }
}
