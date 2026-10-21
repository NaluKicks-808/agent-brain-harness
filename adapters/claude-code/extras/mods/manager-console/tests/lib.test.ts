import { describe, expect, test } from 'claude-code/testing'

import type { ManagerAsk, ManagerBoard, ManagerOutbound } from '../types'
import * as L from '../hooks/lib'

const MIN = 60_000

let counter = 0
const ids = (): string => `t${++counter}`

const mustAsk = (out: L.AddAskResult) => {
  if ('error' in out) throw new Error(out.error)
  return out
}

const ASK: ManagerAsk = { id: 'q1', text: 'Merge the retry fix?', default: 'Wait', options: ['Yes', 'No'], askedAt: 0 }

describe('the ask queue', () => {
  test('adds an ask with Yes / No unless it names its own answers', () => {
    const out = mustAsk(L.addAsk([], { text: 'Merge it?', default: 'Wait until Friday' }, 1000, ids))
    expect(out.isNew).toBe(true)
    expect(out.ask.options).toEqual(['Yes', 'No'])
    expect(out.ask.askedAt).toBe(1000)
    const own = mustAsk(L.addAsk([], { text: 'Which day?', default: 'Friday', options: ['Monday', 'Friday', 'friday', ''] }, 1, ids))
    expect(own.ask.options).toEqual(['Monday', 'Friday'])
  })

  test('refuses an ask without its question or its default', () => {
    expect('error' in L.addAsk([], { text: '  ', default: 'x' }, 1, ids)).toBe(true)
    expect('error' in L.addAsk([], { text: 'Go?' }, 1, ids)).toBe(true)
  })

  test('keeps a short optional explanation with the ask', () => {
    const out = mustAsk(L.addAsk([], { text: 'Approve it?', default: 'Wait', meaning: '  The weekly report   lists our customer promises. ' }, 1000, ids))
    expect(out.ask.meaning).toBe('The weekly report lists our customer promises.')
  })

  test('legacy snoozes no longer hide pending asks', () => {
    expect(L.bandQueue([{ ...ASK, snoozedUntil: 9000 }], [], 5000).map(L.bandKey)).toEqual(['ask:q1'])
  })

  test('band orders near deadlines, sends, then older asks', () => {
    const now = Date.parse('2026-10-13T12:00:00Z')
    const asks: ManagerAsk[] = [
      { ...ASK, id: 'older', askedAt: 1 },
      { ...ASK, id: 'near', askedAt: 4, deadlineAt: now + 30_000 },
      { ...ASK, id: 'later', askedAt: 2, deadlineAt: now + 2 * L.NEAR_DEADLINE_MS },
      { ...ASK, id: 'overdue', askedAt: 3, deadlineAt: now - 1 },
    ]
    const sends: ManagerOutbound[] = [{ id: 'send', channel: 'Gmail', to: 'A', text: 'Hi', queuedAt: 0 }]
    expect(L.bandQueue(asks, sends, now).map(L.bandKey)).toEqual(['ask:overdue', 'ask:near', 'send:send', 'ask:older', 'ask:later'])
  })

  test('short sends first and imminent asks use deadline order, even when the later ask is older', () => {
    const now = 10_000_000
    const asks = [{ ...ASK, id: 'later', deadlineAt: now + 2000, askedAt: 1 }, { ...ASK, id: 'soon', deadlineAt: now + 1000, askedAt: 2 }]
    const sends = [{ id: 'long', channel: 'Gmail', to: 'A', text: 'Longer message', queuedAt: 0 }, { id: 'short', channel: 'Gmail', to: 'A', text: 'Hi', queuedAt: 1 }]
    expect(L.bandQueue(asks, sends, now).map(L.bandKey)).toEqual(['ask:soon', 'ask:later', 'send:short', 'send:long'])
    expect(L.askAnswers({ ...ASK, options: ['Yes', 'Later', 'Reply', 'Dismiss'] })).toEqual(['Yes'])
  })

  test('re-adding an id updates it in place and keeps its age', () => {
    const first = mustAsk(L.addAsk([], { id: 'x', text: 'old', default: 'd' }, 1000, ids))
    const again = mustAsk(L.addAsk(first.queue, { id: 'x', text: 'new', default: 'd2' }, 5000, ids))
    expect(again.isNew).toBe(false)
    expect(again.queue).toHaveLength(1)
    expect(again.ask.text).toBe('new')
    expect(again.ask.askedAt).toBe(1000)
  })

  test('resolve removes the ask by id and says which it was', () => {
    const out = L.resolveAsk([ASK, { ...ASK, id: 'q2' }], 'q1')
    expect(out.ask?.id).toBe('q1')
    expect(out.queue.map(a => a.id)).toEqual(['q2'])
    expect(L.resolveAsk(out.queue, 'nope').ask).toBeUndefined()
  })

  test('a prompt that starts with a button answer matches it: whole word, any case', () => {
    expect(L.matchAnswer('yes, go ahead', ASK)).toBe('Yes')
    expect(L.matchAnswer('  NO.', ASK)).toBe('No')
    expect(L.matchAnswer('later please', ASK)).toBeUndefined()
    expect(L.matchAnswer('Yesterday you said', ASK)).toBeUndefined()
    expect(L.matchAnswer('Not now', ASK)).toBeUndefined()
    expect(L.matchAnswer('what does that mean?', ASK)).toBeUndefined()
    const days: ManagerAsk = { ...ASK, options: ['Ship', 'Ship Friday'] }
    expect(L.matchAnswer('ship friday please', days)).toBe('Ship Friday')
    expect(L.matchAnswer('ship it', days)).toBe('Ship')
  })

  test('the prompt a button submits starts with its answer', () => {
    for (const option of ASK.options) {
      const prompt = L.answerPrompt(ASK, option)
      expect(L.matchAnswer(prompt, ASK)).toBe(option)
      expect(prompt).toContain(ASK.text)
    }
  })
})

describe('genuine prompts and the message counter', () => {
  test('only owner’s own words are genuine', () => {
    expect(L.isGenuinePromptText('go ahead with it')).toBe(true)
    expect(L.isGenuinePromptText('<cross-session-message from="local_a">done</cross-session-message>')).toBe(false)
    expect(L.isGenuinePromptText('Another Claude session sent a message:\n<cross-session-message from="x">hi')).toBe(false)
    expect(L.isGenuinePromptText('<task-notification>\n<task-id>a1</task-id>')).toBe(false)
    expect(L.isGenuinePromptText('<system-reminder>a note</system-reminder>')).toBe(false)
    expect(L.isGenuinePromptText('<system-reminder>a note</system-reminder>\nyes please')).toBe(true)
    expect(L.isGenuinePromptText('Stop hook feedback: run the tests')).toBe(false)
  })

  test('a send to another session counts, a genuine prompt starts the count over', () => {
    const rows = [
      { type: 'user', origin: { kind: 'human' }, message: { content: 'check on the leads' } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'local_abc', message: 'status?' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { name: 'helper', prompt: 'x' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'helper', message: 'x' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'main', message: 'x' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__ccd_session_mgmt__send_message', input: { session_id: 'local_x', message: 'x' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      {
        type: 'user',
        isMeta: true,
        origin: { kind: 'peer', fromSession: 'local_abc', name: 'Lead · A' },
        message: { content: 'Another Claude session sent a message:\n<cross-session-message from-session="local_abc">All fine.</cross-session-message>' },
      },
      { type: 'user', origin: { kind: 'task-notification' }, message: { content: '<task-notification>\n<task-id>1</task-id>' } },
    ]
    const chunk = rows.map(r => JSON.stringify(r)).join('\n')
    const tail = L.applyChunk(L.emptyTail(), `${chunk}\n{broken json\n`, 0, undefined)
    expect(tail.msgs).toBe(2)
    const reset = L.applyChunk(tail, JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'thanks' } }), 0, undefined)
    expect(reset.msgs).toBe(0)
    const typedAsk = L.applyChunk(tail, JSON.stringify({ type: 'user', origin: { kind: 'plugin', name: 'manager-console', asUser: true }, message: { content: 'Re: Next ask? (ask q2): Go ahead' } }), 0, undefined)
    expect(typedAsk.msgs).toBe(0)
    expect(L.isSessionTarget('local_1', [])).toBe(true)
    expect(L.isSessionTarget('helper', ['helper'])).toBe(false)
    expect(L.isSessionTarget('Lead · Research', [])).toBe(true)
  })
})

describe('report classification', () => {
  test('shipped, broke, or neither, from the first lines', () => {
    expect(L.classifyReport("**shipped: every workflow now runs on GitHub's hosted runners.**")).toBe('shipped')
    expect(L.classifyReport('Pull request 36 merged on main, woven onto the pages.')).toBe('shipped')
    expect(L.classifyReport("The gates passed; Ops' lint fix had already landed.")).toBe('shipped')
    expect(L.classifyReport('The new page is live.')).toBe('shipped')
    expect(L.classifyReport('The Drive upload of the Phase 1 marking sheet was blocked a second time.')).toBe('broke')
    expect(L.classifyReport('The nightly build failed on step 3.')).toBe('broke')
    expect(L.classifyReport('GitHub refused the push.')).toBe('broke')
    expect(L.classifyReport('The runner is broken again.')).toBe('broke')
    expect(L.classifyReport('Landed on main, but the Drive retry failed.')).toBe('broke')
    expect(L.classifyReport('Stage 1 is running as a Codex job.')).toBeNull()
    expect(L.classifyReport('Done: nothing failed and nothing was blocked.')).toBeNull()
    expect(L.classifyReport('Launching stage 1 now. Stage 1 covers sorting failures into outage versus bad answer.')).toBeNull()
    expect(L.classifyReport('Starting the upload; if the first file fails I stop there.')).toBeNull()
    expect(L.classifyReport('All good.\nStill fine.\nA third line says the tests failed.')).toBeNull()
  })

  test('reads both envelope shapes and turns a report into a card line and an alert', () => {
    const old = L.parseCrossSession('<cross-session-message from="local_aa" name="Lead · Sites">\nHi there.\n</cross-session-message>')
    expect(old).toEqual({ sessionId: 'local_aa', name: 'Lead · Sites', body: 'Hi there.' })
    const now = L.parseCrossSession(
      '<cross-session-message from="uds:/tmp/x.sock" from-session="local_bb" from-name="Ops · checks" from-mode="bypass">\nok</cross-session-message>',
    )
    expect(now?.sessionId).toBe('local_bb')
    expect(now?.name).toBe('Ops · checks')
    const alerts: L.Alert[] = []
    const row = {
      type: 'user',
      isMeta: true,
      timestamp: '2026-10-12T21:26:00.000Z',
      origin: { kind: 'peer', fromSession: 'local_bb', name: 'Lead · Research' },
      message: {
        content:
          'Another Claude session sent a message:\n<cross-session-message from-session="local_bb">\n**Shipped: the runners moved.** Ops did it.\n\n**Question for owner:** keep the old one?</cross-session-message>',
      },
    }
    const tail = L.applyRow(L.emptyTail(), row, 0, alerts)
    expect(tail.reports.local_bb?.line).toBe('Shipped: the runners moved.')
    expect(tail.reports.local_bb?.hasQuestion).toBe(true)
    expect(tail.reports.local_bb?.at).toBe(Date.parse('2026-10-12T21:26:00.000Z'))
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.kind).toBe('shipped')
    const quiet: L.Alert[] = []
    L.applyRow(L.emptyTail(), { ...row, message: { content: row.message.content.replace('Shipped', 'Drafted') } }, 0, quiet)
    expect(quiet).toHaveLength(0)
  })
})

describe('send cards', () => {
  test('Send and Edit carry the full exact text', () => {
    const text = 'Hi Alex, the "retry fix" is live.\nCan you check example account tomorrow?  Thanks!'
    const out = L.addOutbound([], { channel: 'Chat', to: 'Alex Example', text }, 1, ids)
    if ('error' in out) throw new Error(out.error)
    expect(out.card.text).toBe(text)
    const prompt = L.sendPrompt(out.card)
    expect(prompt).toStartWith('Send it — Chat to Alex Example, exactly: "')
    expect(prompt).toContain(text)
    expect(prompt).toEndWith(`${text}"`)
    expect(L.isSendPromptFor(prompt, out.card)).toBe(true)
    const other: ManagerOutbound = { ...out.card, to: 'Sam Example' }
    expect(L.isSendPromptFor(prompt, other)).toBe(false)
  })

  test('a card needs its channel, recipient and text', () => {
    expect('error' in L.addOutbound([], { to: 'a', text: 'b' }, 1, ids)).toBe(true)
    expect('error' in L.addOutbound([], { channel: 'Gmail', text: 'b' }, 1, ids)).toBe(true)
    expect('error' in L.addOutbound([], { channel: 'Gmail', to: 'a', text: '   ' }, 1, ids)).toBe(true)
  })
})

describe('the board, the status line and the reminders', () => {
  const record = (title: string, cli: string, extra: Partial<{ archived: boolean; summary: string }> = {}) => ({
    mtimeMs: 0,
    archived: extra.archived ?? false,
    title,
    sessionId: `local_${cli}`,
    cliSessionId: cli,
    cwd: '/x',
    lastActivityAt: 0,
    summary: extra.summary ?? '',
  })

  test('cards: leads first, needs you, working, idle; archived and the Manager left out', () => {
    const now = 10_000_000
    const board = L.buildBoard({
      records: [
        record('Manager', 'mgr'),
        record('Builder · retry fix', 'b1'),
        record('Lead · Research phases 1–4', 'l1'),
        record('Lead · Websites', 'l2'),
        record('Ops · old', 'o1', { archived: true }),
        record('Untitled thing', 'u1'),
      ],
      transcriptMtimes: { b1: now - 30_000, l1: now - 600_000, l2: now - 10_000 },
      reports: {},
      asks: [{ ...ASK, text: 'Should Research phases 1–4 wait for Alex?' }],
      jobs: [
        { id: 'j1', label: 'rescue', summary: '', status: 'running', phase: 'running', startedAt: 0, sessionId: 'b1' },
        { id: 'j2', label: 'review', summary: '', status: 'completed', phase: 'done', startedAt: 0, sessionId: 'b1' },
      ],
      managerCliId: 'mgr',
      now,
      ctx: { l2: L.HANDOFF_AT },
    })
    expect(board.cards.map(c => c.cliSessionId)).toEqual(['l2', 'l1', 'b1'])
    expect(board.cards.map(c => c.state)).toEqual(['running', 'ready', 'working'])
    expect(board.cards[2]?.codex.map(j => j.id)).toEqual(['j1'])
    expect(board.cards[0]?.ctxPercent).toBe(L.HANDOFF_AT)
    expect(L.isHandoffDue(board.cards[0]?.ctxPercent)).toBe(true)
  })

  test('urgent and stalled cards precede leads and workers; finished jobs stay separate', () => {
    const now = 10_000_000
    const board = L.buildBoard({
      records: [
        record('Builder · needs answer', 'w1'),
        record('Lead · normal', 'l1'),
        record('Builder · stalled', 'w2'),
        record('Builder · normal', 'w3'),
      ],
      transcriptMtimes: { w1: now - 1_000, l1: now - 1_000, w2: now - 600_000, w3: now - 1_000 },
      reports: {},
      asks: [{ ...ASK, text: 'Builder · needs answer: continue?' }],
      jobs: [
        { id: 'running', label: 'rescue', summary: '', status: 'running', phase: 'editing', startedAt: now, sessionId: 'w2' },
        { id: 'done', label: 'review', summary: '', status: 'completed', phase: 'done', startedAt: now, sessionId: 'w3' },
      ],
      managerCliId: 'mgr',
      now,
    })
    expect(board.cards.map(L.boardGroup)).toEqual(['needs-you', 'stalled', 'leads', 'workers'])
    expect(board.finishedJobs?.map(job => job.id)).toEqual(['done'])
  })

  test('the status line', () => {
    const board: ManagerBoard = {
      cards: [
        { sessionId: 'a', cliSessionId: 'a', title: 'Lead · A', shortTitle: 'A', role: 'Lead', isLead: true, state: 'working', lastActiveAt: 0, codex: [] },
        { sessionId: 'b', cliSessionId: 'b', title: 'Lead · B', shortTitle: 'B', role: 'Lead', isLead: true, state: 'idle', lastActiveAt: 0, codex: [] },
        { sessionId: 'c', cliSessionId: 'c', title: 'Ops · C', shortTitle: 'C', role: 'Ops', isLead: false, state: 'working', lastActiveAt: 0, codex: [] },
      ],
      otherJobs: [],
      scannedAt: 0,
    }
    expect(L.statusLine({ board, asks: [ASK], msgs: 6, ghLeft: 2140, next: { date: '2026-10-19', label: 'card' }, selfCtx: 41 })).toBe(
      'Team board: /board · 2 leads · 1 worker · 2 working · 1 needs you · msgs 6/10 · ctx 41% · GH 2,140 min left · next: Mon 19 card',
    )
    expect(L.statusLine({ board: null, asks: [], msgs: 8, ghLeft: undefined, next: undefined })).toBe('Team board: /board · ⚠ msgs 8/10')
    expect(L.statusLine({ board: null, asks: [], msgs: 12, ghLeft: undefined, next: undefined, selfCtx: L.HANDOFF_AT })).toBe(
      `Team board: /board · ⚠ msgs 10+/10 · ⚠ ctx ${L.HANDOFF_AT}% handoff due`,
    )
    expect(L.contextPercent(657_644 + 392 + 2, L.DEFAULT_WINDOW)).toBe(66)
    expect(L.contextPercent(0, L.DEFAULT_WINDOW)).toBeUndefined()
    expect(L.statusLine({ board: null, asks: [], msgs: undefined, ghLeft: undefined, next: undefined, now: 10_000, lastCompactAt: 5_000, nextCompactAt: 92 })).toBe('Team board: /board · compacted 5 s ago · next threshold 92% compact')
  })

  test('a single ready lead alarms after two hours while another lead runs', () => {
    const now = 1_000_000_000
    const board: ManagerBoard = { cards: [
      { sessionId: 'a', cliSessionId: 'a', title: 'Lead · A', shortTitle: 'A', role: 'Lead', isLead: true, state: 'ready', lastActiveAt: 0, codex: [] },
      { sessionId: 'b', cliSessionId: 'b', title: 'Lead · B', shortTitle: 'B', role: 'Lead', isLead: true, state: 'running', lastActiveAt: now, codex: [] },
    ], otherJobs: [], scannedAt: now }
    const first = L.idleAlarmPlan(board, L.emptyIdleAlarm(), now)
    expect(first.due).toBe(false)
    expect(L.idleAlarmPlan(board, first.alarm, now + 120 * MIN - 1).due).toBe(false)
    const due = L.idleAlarmPlan(board, first.alarm, now + 120 * MIN)
    expect(due).toMatchObject({ holds: true, due: true, leads: ['Lead · A'] })
    expect(L.idleAlarmText(due.leads)).toContain('Ready for 2 h: Lead · A')
    expect(L.statusLine({ board, asks: [], msgs: undefined, ghLeft: undefined, next: undefined, idleAlarm: true })).toContain('lead ready 2h')
    const sent = { ...due.alarm, lastAt: now + 120 * MIN }
    expect(L.idleAlarmPlan(board, sent, now + 360 * MIN - 1).due).toBe(false)
    expect(L.idleAlarmPlan(board, sent, now + 360 * MIN).due).toBe(true)
    board.cards[0]!.state = 'running'
    expect(L.idleAlarmPlan(board, sent, now + 360 * MIN)).toMatchObject({ holds: false, due: false, alarm: { idleSince: 0 } })
  })

  test('zero shares on both sides exclude a lead and clear its ready timer', () => {
    const now = 1_000_000_000
    const board: ManagerBoard = { cards: [
      { sessionId: 'a', cliSessionId: 'a', title: 'Lead · Agency', shortTitle: 'Agency', role: 'Lead', isLead: true, state: 'ready', lastActiveAt: 0, codex: [] },
    ], otherJobs: [], scannedAt: now }
    const alarm = { idleSince: now, lastAt: 0, readySince: { a: now } }
    const shares = L.sharesFromConfig({ leads: [{ title: 'Lead · Agency', slug: 'agency', codexPct: 0, claudePct: 0 }] })
    expect(L.idleAlarmPlan(board, alarm, now + 8 * 60 * MIN, shares)).toMatchObject({
      holds: false, due: false, leads: [], alarm: { idleSince: 0, readySince: {} },
    })
    for (const share of [{ codexPct: 1, claudePct: 0 }, { codexPct: 0, claudePct: 1 }]) {
      expect(L.idleAlarmPlan(board, alarm, now + 120 * MIN, { agency: share }).due).toBe(true)
    }
  })

  test('latest report and open ask set exactly one lead state', () => {
    const now = 10_000_000
    const needs = L.inboxReport('2026-10-13-1200-Lead · A.md', 'needs owner: choose one', now)
    const older = L.inboxReport('2026-10-13-1159-Lead · A.md', 'waiting on Design', now - 1)
    const inputs = {
      records: [record('Lead · A', 'a')], transcriptMtimes: {}, reports: {}, jobs: [], managerCliId: 'mgr', now,
      inbox: [older, needs], latestInbox: [older, needs], asks: [{ ...ASK, text: 'Lead · A: choose one' }],
    }
    expect(L.buildBoard(inputs).cards[0]?.state).toBe('needs owner')
    expect(L.buildBoard({ ...inputs, asks: [] }).cards[0]?.state).toBe('ready')
    expect(L.buildBoard({ ...inputs, latestInbox: [older], asks: [] }).cards[0]?.state).toBe('waiting on')
    expect(L.reportSignal('Queued for 14:00 tomorrow')).toBe('budget-paused')
    expect(L.reportSignal('Budget spent for today')).toBe('budget-paused')
    expect(L.reportSignal('ship: complete')).toBeUndefined()
  })

  test('a lead past its stated resume time becomes ready and alarms immediately', () => {
    const at = (iso: string) => Date.parse(iso)
    const report = L.inboxReport('2026-10-16-2206-Lead · A.md', 'budget-paused until 00:10 UTC', at('2026-10-16T22:06:00Z'))
    expect(L.statedWakeAt(report.line, report.mtimeMs)).toBe(at('2026-10-17T00:10:00Z'))
    expect(L.statedWakeAt('until 25:10 UTC', report.mtimeMs)).toBeUndefined()
    const inputs = (now: number) => ({ records: [record('Lead · A', 'a')], transcriptMtimes: { a: report.mtimeMs },
      reports: {}, jobs: [], managerCliId: 'mgr', now, inbox: [report], latestInbox: [report], asks: [] })
    expect(L.buildBoard(inputs(at('2026-10-17T00:12:00Z'))).cards[0]?.state).toBe('budget-paused')
    const late = at('2026-10-17T00:16:00Z')
    const board = L.buildBoard(inputs(late))
    expect(board.cards[0]?.state).toBe('ready')
    expect(L.idleAlarmPlan(board, { ...L.emptyIdleAlarm(), lastAt: at('2026-10-17T00:09:00Z') }, late)).toMatchObject({ due: true, leads: ['Lead · A'] })
  })

  test('only a break or question enters the Manager wake queue', () => {
    const lines = ['ship: complete', 'FYI: digest posted', 'waiting on budget reset', 'break: check failed', 'needs owner: choose one', 'Can we proceed?']
    const reports = lines.map((line, i) => L.inboxReport(`${i}.md`, line, i))
    const noted = L.noteInbox({ lastAt: 0, pending: [], seen: [] }, reports, L.wakesManager)
    expect(noted.wake.pending).toEqual(['3.md', '4.md', '5.md'])
    expect(noted.wake.seen).toHaveLength(6)
  })

  test('the next reminder: the soonest dated open row owner owns, from today', () => {
    const md = [
      '# Reminders',
      '## Open',
      '| Trigger | Type | What to surface | Why it matters |',
      '|---|---|---|---|',
      '| **Monday 2026-10-19, owner** `since 2026-10-12` | Date | **Add a payment card to the GitHub account** at github.com | x |',
      '| **Tuesday 2026-10-13, 13:00, "Website Intake" with Sam** `since 2026-10-12` | Date | **The website intake.** owner owner. | x |',
      '| **Thursday 2026-10-15, IFN with Taylor** `since 2026-10-12` | Date | **Prep.** owner Alex. | x |',
      '| ~~**Wednesday 2026-10-14, owner**~~ `since 2026-10-05` | Date | **Closed.** | x |',
      '| **When owner decides** `since 2026-10-07` | Condition | **Not dated.** | x |',
      '| **Friday 2026-10-09, owner** | Date | **Past.** | x |',
      '## Done',
      '| **Saturday 2026-10-17, owner** | Date | **Done row.** | x |',
    ].join('\n')
    expect(L.nextReminder(md, '2026-10-12')).toEqual({ date: '2026-10-13', label: 'Website Intake' })
    expect(L.nextReminder(md, '2026-10-14')).toEqual({ date: '2026-10-19', label: 'Add a payment card…' })
    expect(L.shortDay('2026-10-19')).toBe('Mon 19')
    expect(L.localIsoDate(Date.parse('2026-10-13T03:00:00Z'), -360)).toBe('2026-10-12')
    expect(L.parseTzOffset('-0600\n')).toBe(-360)
  })

  test('GitHub minutes left from either billing answer', () => {
    const usage = {
      usageItems: [
        { product: 'actions', sku: 'Actions Linux', unitType: 'Minutes', quantity: 800 },
        { product: 'actions', sku: 'Actions macOS 3-core', unitType: 'Minutes', quantity: 5 },
        { product: 'actions', sku: 'Actions storage', unitType: 'GigabyteHours', quantity: 99 },
        { product: 'packages', sku: 'Packages', unitType: 'Minutes', quantity: 50 },
      ],
    }
    expect(L.ghLeftFromUsage(usage)).toBe(3000 - 800 - 50)
    expect(L.ghLeftFromLegacy({ total_minutes_used: 860, included_minutes: 3000 })).toBe(2140)
    expect(L.ghLeftFromLegacy({ message: 'Not Found' })).toBeUndefined()
    expect(L.formatCount(2140)).toBe('2,140')
  })
})

describe('daily budget ledger', () => {
  test('accepts a reservation, reconciles spend, and refuses an excess reservation', () => {
    const date = '2026-10-13'
    const first = L.budgetChange(L.emptyBudget({ websites: { codexPct: 4, claudePct: 3 } }), date, { lead: 'Lead · Websites', side: 'codex', pct: 3, job: 'site-1' }, 'reserve')
    expect(first.error).toBeUndefined()
    expect(first.ledger.days[date]?.websites?.reserved.codexPct).toBe(3)
    const spent = L.budgetChange(first.ledger, date, { lead: 'websites', side: 'codex', pct: 2, job: 'site-1' }, 'spent')
    expect(spent.ledger.days[date]?.websites?.spent.codexPct).toBe(2)
    const accepted = L.budgetChange(spent.ledger, date, { lead: 'websites', side: 'codex', pct: 1, job: 'site-2' }, 'reserve')
    expect(accepted.error).toBeUndefined()
    const refused = L.budgetChange(accepted.ledger, date, { lead: 'websites', side: 'codex', pct: 0.1, job: 'site-3' }, 'reserve')
    expect(refused.error).toBe('share exceeded')
    expect(refused.ledger).toBe(accepted.ledger)
    expect(L.budgetSummary(accepted.ledger, date, 'websites')).toContain('Codex 4/2/4%')
  })
})

describe('the inbox', () => {
  const report = (file: string, line: string, mtimeMs: number) => L.inboxReport(file, `${line}\n- detail one\n- detail two\n`, mtimeMs)

  test('reads the file name and the first line: ship / break / needs owner / FYI', () => {
    expect(L.parseInboxName('2026-10-12-1641-Lead · Research phases 1–4.md')).toEqual({ stamp: '2026-10-12-1641', title: 'Lead · Research phases 1–4' })
    expect(L.parseInboxName('notes.md')).toEqual({ title: 'notes' })
    expect(L.parseInboxFirstLine('ship: the retry fix is on main').kind).toBe('ship')
    expect(L.parseInboxFirstLine('\n\n# Shipped — runners moved').kind).toBe('ship')
    expect(L.parseInboxFirstLine('**break** — Drive upload refused').kind).toBe('break')
    expect(L.parseInboxFirstLine('Broke: nightly sync').kind).toBe('break')
    expect(L.parseInboxFirstLine('needs owner: pick Tuesday or Wednesday (default Tuesday)').kind).toBe('needs-owner')
    expect(L.parseInboxFirstLine('- Needs-owner: one ask').kind).toBe('needs-owner')
    expect(L.parseInboxFirstLine('FYI: digest #39 posted').kind).toBe('fyi')
    expect(L.parseInboxFirstLine('[ship] done').kind).toBe('ship')
    expect(L.parseInboxFirstLine('Shipping soon, not yet').kind).toBe('other')
    expect(L.parseInboxFirstLine('').kind).toBe('other')
    expect(L.parseInboxFirstLine('ship: **the fix** is `live`').line).toBe('ship: the fix is live')
  })

  test('a report sits under the card its file name names; only three kinds alert', () => {
    const card = { title: 'Lead · Research phases 1–4', shortTitle: 'Research phases 1–4' }
    expect(L.inboxMatchesCard(report('2026-10-12-1641-Lead · Research phases 1–4.md', 'ship: x', 0), card)).toBe(true)
    expect(L.inboxMatchesCard(report('2026-10-12-1641-Lead-Research-phases-1-4.md', 'ship: x', 0), card)).toBe(true)
    expect(L.inboxMatchesCard(report('2026-10-12-1641-Research phases 1–4.md', 'ship: x', 0), card)).toBe(true)
    expect(L.inboxMatchesCard(report('2026-10-12-1641-Lead · Websites.md', 'ship: x', 0), card)).toBe(false)
    expect(L.inboxMatchesCard(report('2026-10-12-1641-Lead-Example-eval.md', 'waiting on review', 0),
      { title: 'Lead · Example eval (script vs AI)', shortTitle: 'Example eval (script vs AI)' })).toBe(true)
    expect(L.inboxAlert(report('a.md', 'ship: on main', 0))).toBe('Shipped · a: ship: on main')
    expect(L.inboxAlert(report('2026-10-12-1641-Ops · checks.md', 'break: lint red', 0))).toBe('Problem · Ops · checks: break: lint red')
    expect(L.inboxAlert(report('b.md', 'needs owner: which day?', 0))).toBe('Needs you · b: needs owner: which day?')
    expect(L.inboxAlert(report('c.md', 'FYI: posted', 0))).toBeUndefined()
    expect(L.inboxAlert(report('d.md', 'misc', 0))).toBeUndefined()
  })

  test('the wake: one per five minutes, batching what waits, never mid-turn or over a draft', () => {
    const MIN = 60_000
    const a = report('2026-10-12-1600-Lead · A.md', 'ship: A landed', 1)
    const b = report('2026-10-12-1601-Lead · B.md', 'break: B failed', 2)
    const c = report('2026-10-12-1602-Lead · C.md', 'FYI: C note', 3)
    let wake = L.noteInbox({ lastAt: 0, pending: [], seen: [] }, [a, b]).wake
    expect(wake.pending).toEqual([a.file, b.file])

    expect(L.planWake(wake, [a, b], 10 * MIN, true, false).heldBy).toBe('a turn is running')
    expect(L.planWake(wake, [a, b], 10 * MIN, false, true).heldBy).toBe('owner is typing')
    const first = L.planWake(wake, [a, b], 10 * MIN, false, false)
    expect(first.text).toBe(`Inbox: ship: A landed (${a.file}) · break: B failed (${b.file})`)
    expect(first.wake.lastAt).toBe(10 * MIN)
    expect(first.wake.pending).toEqual([])
    wake = first.wake

    // Seen files never queue twice; a new one waits out the five minutes.
    const noted = L.noteInbox(wake, [a, b, c])
    expect(noted.fresh.map(one => one.file)).toEqual([c.file])
    wake = noted.wake
    const early = L.planWake(wake, [a, b, c], 14 * MIN, false, false)
    expect(early.text).toBeUndefined()
    expect(early.heldBy).toBe('woke under five minutes ago')
    const later = L.planWake(wake, [a, b, c], 15 * MIN, false, false)
    expect(later.text).toBe(`Inbox: FYI: C note (${c.file})`)

    // A report the Manager already read (moved to read/) is dropped from the wake.
    const gone = L.planWake(L.noteInbox(later.wake, [a, b, c]).wake, [a, b], 30 * MIN, false, false)
    expect(gone.text).toBeUndefined()
    expect(L.noteInbox(later.wake, [a]).wake.seen).toEqual([a.file])

    const many = Array.from({ length: 7 }, (_, i) => report(`f${i}.md`, `FYI ${i}`, i))
    expect(L.wakeText(many)).toEndWith(' · and 2 more')
  })

  test('the status line counts unread reports, and a needs-owner report needs you', () => {
    const r = report('2026-10-12-1641-Lead · A.md', 'needs owner: pick one', 0)
    const board = L.buildBoard({
      records: [{ mtimeMs: 0, archived: false, title: 'Lead · A', sessionId: 'local_a', cliSessionId: 'a', cwd: '/x', lastActivityAt: 0, summary: '' }],
      transcriptMtimes: {},
      reports: {},
      asks: [],
      jobs: [],
      managerCliId: 'mgr',
      now: 10_000_000,
      inbox: [r, report('2026-10-12-1642-Somebody else.md', 'FYI: x', 1)],
    })
    expect(board.cards[0]?.state).toBe('ready')
    expect(board.cards[0]?.inbox?.map(one => one.file)).toEqual([r.file])
    expect(board.inboxOther?.map(one => one.file)).toEqual(['2026-10-12-1642-Somebody else.md'])
    expect(L.statusLine({ board, asks: [], msgs: undefined, ghLeft: undefined, next: undefined, reports: 2 })).toBe(
      'Team board: /board · 1 lead · 0 working · 1 needs you · 2 reports',
    )
    expect(L.isGenuinePromptText('Inbox: ship: A landed (a.md)')).toBe(false)
    expect(L.isGenuinePromptText('The manager-console plugin sent a message: Inbox: x')).toBe(false)
  })
})


test('lead presentation sorts broke, working, waiting, idle without changing lead states', () => {
  const card = (id: string, state: 'ready' | 'waiting on' | 'running', more = {}) => ({ sessionId: id, cliSessionId: id, title: `Lead · ${id}`, role: 'Lead', shortTitle: id, isLead: true, state, lastActiveAt: 0, codex: [], ...more })
  const cards = [card('Idle', 'ready'), card('Waiting', 'waiting on'), card('Working', 'running'),
    card('Broken', 'ready', { report: { sessionId: 'Broken', name: 'Broken', line: 'Build failed', at: 1, kind: 'broke', hasQuestion: false } })]
  expect(L.sortedLeads(cards).map(c => c.shortTitle)).toEqual(['Broken', 'Working', 'Waiting', 'Idle'])
  expect(L.sortedLeads(cards).map(L.leadDisplayState)).toEqual(['Broke', 'Working', 'Waiting', 'Idle'])
  expect(cards.map(c => c.state)).toEqual(['ready', 'waiting on', 'running', 'ready'])
  expect(L.leadSummary(cards[2]!)).toBe('Lead · Working · Working · No update yet · 0 helpers')
})

describe('cmux status line', () => {
  test('pie by quarter: empty only at 0, full only at 100', () => {
    expect([0, 7, 30, 50, 93, 100].map(L.pieGlyph).join('')).toBe('○◔◔◑◕●')
  })
  test('context against the auto-compact window, then week and 5h', () => {
    expect(L.cmuxStatus({ ctxTokens: 123_000, ctxLimit: 300_000, week: 93, fiveHour: 7 })).toBe('ctx ▓▓▓░░░░ 41% · ◕ wk 93% · ◔ 5h 7%')
    expect(L.cmuxStatus({ ctxLimit: 300_000 })).toBe('ctx …')
  })
  test('stats join the prompt hint; the shift+tab reminder makes room', () => {
    expect(L.hintWithStats('(shift+tab to cycle)', 'ctx …')).toBe('ctx …')
    expect(L.hintWithStats('esc to interrupt', 'ctx …')).toBe('esc to interrupt · ctx …')
  })
})
