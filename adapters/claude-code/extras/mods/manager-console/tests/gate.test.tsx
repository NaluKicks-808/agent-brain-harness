import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { LeadsConfig } from '../hooks/lib'
import { COMPACT_AT, HANDOFF_AT, POST_HANDOFF_COMPACT_AT, gateForTitle, leadSlug } from '../hooks/lib'

const ROOT = '/h/Library/Application Support/Claude-Work/claude-code-sessions'
const RECORD = `${ROOT}/acct/org/local_self.json`
const MIN = 60_000
const INBOX = '/h/.claude/harness/inbox'

test('lead titles use the requested folder slugs', () => {
  expect(leadSlug('Lead · Research phases 1–4')).toBe('research-phases-1-4')
  expect(leadSlug('Lead · Design & Content websites')).toBe('design-content-websites')
  expect(leadSlug('Lead · helper-style meeting agent')).toBe('helper-style-meeting-agent')
  expect(gateForTitle('Lead · !!!', 1, 1).status).toBe('off')
})

const world = (on: On, $: unknown, initialTitle: string | undefined, options: { envTitle?: string; noDesktop?: boolean; brokenDesktop?: boolean } = {}) => {
  let leadsOverride: LeadsConfig | null | undefined
  let title = initialTitle
  let recordReads = 0
  const status: string[] = []
  const toasts: string[] = []
  const sounds: string[] = []
  const opened: string[] = []
  const submitted: string[] = []
  const commands: string[] = []
  const listed: string[] = []
  const readFiles: string[] = []
  const compacted: string[] = []
  const logs: string[] = []
  let percent: number | undefined
  let handoffMtime = 0
  const folders = new Map<string, Map<string, string>>()
  mock.store(on)
  mock.env(on, { HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude', HARNESS_TITLE: options.envTitle ?? '' })
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.id', () => ({ value: 'self' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.usage', () => percent === undefined ? { deny: 'unavailable' } : { value: { startedAt: 1, context: { window: 100, percent }, rateLimits: [] } })
  on('session.compact', ($, e) => { compacted.push(e.instructions ?? ''); return { messages: [{ role: 'user', text: 'summary', toolUses: [] }] } })
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__manager-console__${e.name}` } }))
  on('command.register', ($, e) => { commands.push(e.name); return { value: { command: e.name } } })
  on('ui.status', ($, e) => { status.push(e.text ?? ''); return { value: undefined } })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } })
  on('audio.play', () => { sounds.push('played'); return { value: undefined } })
  on('ui.open', ($, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.submit', ($, e) => { submitted.push(e.text); return { text: e.text } })
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', ($, e) => e.path.includes('HANDOFF-') || e.path.includes('/handoffs/')
    ? { value: { kind: 'file', size: 10, mtimeMs: handoffMtime, isLink: false } }
    : { deny: 'ENOENT' })
  on('fs.list', ($, e) => {
    listed.push(e.path)
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string) => ({ name, kind: 'file' as const, size: 100, mtimeMs: 0, isLink: false })
    if (e.path === ROOT) return { value: options.noDesktop ? [] : [dir('acct')] }
    if (e.path === `${ROOT}/acct`) return { value: [dir('org')] }
    if (e.path === `${ROOT}/acct/org`) return { value: [file('local_self.json')] }
    const folder = folders.get(e.path)
    if (folder) return { value: [...folder].map(([name, body]) => ({ ...file(name), size: body.length })) }
    return { value: [] }
  })
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/harness/leads.json') && leadsOverride !== undefined) return leadsOverride === null ? { deny: 'ENOENT' } : { value: JSON.stringify(leadsOverride) }
    if (e.path.endsWith('/harness/leads.json')) return { value: JSON.stringify({ leads: [{ title: 'Lead · Websites', slug: 'websites', codexPct: 4, claudePct: 3 }, { title: 'Lead · Design & Content websites', slug: 'design-content-websites', codexPct: 4, claudePct: 3 }, { title: 'Lead · Research phases 1–4', slug: 'research-phases-1-4', codexPct: 4, claudePct: 3 }], manager: { codexPct: 1, claudePct: 1 } }) }
    if (e.path.endsWith('/harness/config.json')) return { value: JSON.stringify({ remindersFile: '/proj/wiki/_reminders.md' }) }
    readFiles.push(e.path)
    const at = e.path.lastIndexOf('/')
    const body = folders.get(e.path.slice(0, at))?.get(e.path.slice(at + 1))
    return body === undefined ? { deny: 'ENOENT' } : { value: body }
  })
  on('process.run', ($, e) => {
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (String(e.argv[3]).includes('postTurnSummary')) {
      recordReads += 1
      if (options.brokenDesktop) return ok('invalid JSON')
      return ok(JSON.stringify({ [RECORD]: { sessionId: 'local_self', cliSessionId: 'self', title } }))
    }
    if (e.argv[0] === '/bin/date') return ok('-0600\n')
    if (String(e.argv[3]).includes("mode = 'step'")) return ok('0 0 seed\n')
    return { deny: 'unavailable' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return {
    clock, status, toasts, sounds, opened, submitted, commands, listed, readFiles, folders, compacted, logs,
    setLeads: (value: LeadsConfig | null) => { leadsOverride = value },
    setPercent: (value: number) => { percent = value },
    setHandoffMtime: (value: number) => { handoffMtime = value },
    get recordReads() { return recordReads },
    setTitle: (value: string | undefined) => { title = value },
    start: (surface: 'desktop' | 'terminal' = 'desktop') => ($ as { session: { start: (args: { cwd: string; surface: 'desktop' | 'terminal'; isInteractive: boolean }) => Promise<unknown> } }).session.start({ cwd: '/proj', surface, isInteractive: true }),
  }
}

const ask = { tool: 'mcp__manager-console__manager_ask', text: 'Question?', default: 'Wait' } as never

test('exact Manager title turns the console on', async ($, on) => {
  const w = world(on, $, 'Manager')
  await w.start()
  expect(w.opened).toEqual(['board'])
  expect(w.commands).toEqual(['board'])
  expect(String((await $.tool.call(ask) as { result?: unknown }).result)).toContain('Added ask')
  await w.start() // the state decision is reused on another start
  expect(w.recordReads).toBe(1)
})

test('the Manager status records a successful compaction', async ($, on) => {
  const w = world(on, $, 'Manager')
  await w.start()
  w.setPercent(COMPACT_AT)
  await w.clock.advance(1600)
  expect(w.compacted).toHaveLength(1)
  expect(w.status.at(-1)).toContain('compacted 0 s ago · next threshold 88% handoff')
})

for (const title of ['Worker · retry fix', 'Builder · retry fix', 'Other']) {
  test(`${title} stays off and never submits an inbox wake`, async ($, on) => {
    const w = world(on, $, title)
    await w.start()
    await w.clock.advance(12 * MIN)
    expect(w.recordReads).toBe(1)
    expect(w.status).toEqual([])
    expect(w.toasts).toEqual([])
    expect(w.sounds).toEqual([])
    expect(w.opened).toEqual([])
    expect(w.commands).toEqual([])
    expect(w.submitted).toEqual([])
    expect(String((await $.tool.call(ask) as { deny?: unknown }).deny)).toContain('only in the Manager session')
    const band = await $.ui.mount({ plugin: 'manager-console', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns: 90, scroll: { offset: 0, bodyRows: 24 }, view: {} } })
    expect(await band.find({ text: 'engine band' })).toBeDefined()
    await band.unmount()
  })
}

test('a lead wakes for its own direct markdown files only, batches them, and stays quiet otherwise', async ($, on) => {
  const w = world(on, $, 'Lead · Design & Content websites')
  const own = `${INBOX}/for-leads/design-content-websites`
  const other = `${INBOX}/for-leads/research-phases-1-4`
  w.folders.set(own, new Map([
    ['a.md', 'First worker result\nmore'],
    ['b.md', 'Second worker result'],
    ['notes.txt', 'ignore'],
  ]))
  w.folders.set(other, new Map([['secret.md', 'Other lead result']]))
  await w.start()
  await w.clock.advance(2600)
  expect(w.submitted).toEqual(['Worker report: First worker result (a.md) · Second worker result (b.md)'])
  expect(w.listed).toContain(own)
  expect(w.listed).not.toContain(other)
  expect(w.listed).not.toContain(INBOX)
  expect(w.readFiles).toEqual([`${own}/a.md`, `${own}/b.md`])
  expect(w.status).toEqual([])
  expect(w.toasts).toEqual([])
  expect(w.sounds).toEqual([])
  expect(w.opened).toEqual([])
  expect(w.commands).toEqual([])
  expect(String((await $.tool.call(ask) as { deny?: unknown }).deny)).toContain('only in the Manager session')
  w.folders.get(own)?.delete('a.md') // moved to read/
  w.folders.get(own)?.delete('b.md')
  w.folders.get(own)?.set('c.md', 'Third worker result')
  await w.clock.advance(4 * MIN)
  expect(w.submitted).toHaveLength(1)
  await $.turn.start({ text: 'working', turnId: 'lead-turn' })
  await w.clock.advance(2 * MIN)
  expect(w.submitted).toHaveLength(1)
  w.folders.get(own)?.delete('c.md') // moved to read/ before the turn finishes
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'lead-turn', reason: 'answer' })
  await w.clock.advance(3500)
  expect(w.submitted).toHaveLength(1)
  w.folders.get(own)?.set('d.md', 'Fourth worker result')
  await w.clock.advance(MIN)
  expect(w.submitted.at(-1)).toBe('Worker report: Fourth worker result (d.md)')
})

test('worker nudges once, waits for idle and the rewritten handoff, then compacts once', async ($, on) => {
  const w = world(on, $, 'Builder · Retry Fix')
  await w.start()
  w.setPercent(HANDOFF_AT)
  await w.clock.advance(MIN)
  expect(w.submitted).toEqual([`Context at ${HANDOFF_AT}%: rewrite your handoff now (/h/.claude/harness/handoffs/builder-retry-fix.md), then reply "handoff written". Compaction follows.`])
  await w.clock.advance(MIN)
  expect(w.submitted).toHaveLength(1)
  expect(w.compacted).toEqual([])
  await $.turn.start({ text: 'working', turnId: 'worker-turn' })
  w.setHandoffMtime(1_760_000_100_000)
  await w.clock.advance(MIN)
  expect(w.compacted).toEqual([])
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'worker-turn', reason: 'answer' })
  await w.clock.advance(3500)
  expect(w.compacted).toEqual([])
  w.setPercent(POST_HANDOFF_COMPACT_AT)
  await w.clock.advance(30_000)
  expect(w.compacted).toEqual([])
  await w.clock.advance(MIN)
  expect(w.compacted).toHaveLength(1)
  await w.clock.advance(31 * MIN)
  expect(w.compacted).toHaveLength(1)
})

test('hard trigger compacts at idle, with thirty-minute spacing', async ($, on) => {
  const w = world(on, $, 'Lead · Websites')
  await w.start()
  w.setPercent(COMPACT_AT)
  await $.turn.start({ text: 'working', turnId: 'lead-turn' })
  await w.clock.advance(MIN)
  expect(w.compacted).toEqual([])
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 'lead-turn', reason: 'answer' })
  await w.clock.advance(3500)
  expect(w.compacted).toHaveLength(1)
  expect(w.submitted).toEqual([])
  w.setPercent(20)
  await w.clock.advance(MIN)
  w.setPercent(COMPACT_AT)
  await w.clock.advance(30 * MIN)
  expect(w.compacted).toHaveLength(2)
})

test('a turn missing its completion event stops blocking compaction after thirty minutes', async ($, on) => {
  const w = world(on, $, 'Lead · Websites')
  await w.start()
  w.setPercent(COMPACT_AT)
  await $.turn.start({ text: 'working', turnId: 'stuck-turn' })
  await w.clock.advance(29 * MIN)
  expect(w.compacted).toEqual([])
  expect(w.logs.some(line => line.includes(`percent=unknown action=none skip=turn running`))).toBe(true)
  await w.clock.advance(MIN)
  expect(w.compacted).toHaveLength(1)
  expect(w.logs.some(line => line.includes(`percent=${COMPACT_AT}% action=compact skip=none`))).toBe(true)
})

test('handoff timeout compacts after ten minutes at the post-handoff threshold without a file', async ($, on) => {
  const w = world(on, $, 'Builder · Retry Fix')
  await w.start()
  w.setPercent(HANDOFF_AT)
  await w.clock.advance(MIN)
  expect(w.submitted).toHaveLength(1)
  await w.clock.advance(8 * MIN)
  expect(w.compacted).toEqual([])
  w.setPercent(POST_HANDOFF_COMPACT_AT)
  await w.clock.advance(30_000)
  expect(w.compacted).toEqual([])
  await w.clock.advance(2 * MIN)
  expect(w.compacted).toHaveLength(1)
})

test('the Manager never lists or reads lead folders', async ($, on) => {
  const w = world(on, $, 'Manager')
  const other = `${INBOX}/for-leads/design-content-websites`
  w.folders.set(other, new Map([['secret.md', 'Lead only']]))
  await w.start()
  await w.clock.advance(2600)
  expect(w.listed).toContain(INBOX)
  expect(w.listed).not.toContain(other)
  expect(w.readFiles).not.toContain(`${other}/secret.md`)
  expect(w.submitted).toEqual([])
})

test('unknown title stays off, checks once per minute, then turns on when Manager appears', async ($, on) => {
  const w = world(on, $, undefined)
  await w.start()
  expect(w.opened).toEqual([])
  expect(String((await $.tool.call(ask) as { deny?: unknown }).deny)).toContain('only in the Manager session')
  await w.clock.advance(MIN)
  expect(w.recordReads).toBe(2)
  expect(w.submitted).toEqual([])
  w.setTitle('Manager')
  await w.clock.advance(MIN)
  expect(w.recordReads).toBe(3)
  expect(w.opened).toEqual(['board'])
})

test('unknown title stops checking after ten minutes and never submits a prompt', async ($, on) => {
  const w = world(on, $, undefined)
  await w.start()
  await w.clock.advance(11 * MIN)
  expect(w.recordReads).toBe(11)
  expect(w.opened).toEqual([])
  expect(w.status).toEqual([])
  expect(w.submitted).toEqual([])
  w.setTitle('Manager')
  await w.clock.advance(2 * MIN)
  expect(w.recordReads).toBe(11)
  expect(String((await $.tool.call(ask) as { deny?: unknown }).deny)).toContain('only in the Manager session')
})


for (const brokenDesktop of [false, true]) {
  test(`CLI Manager uses HARNESS_TITLE with ${brokenDesktop ? 'an unreadable' : 'no'} desktop record`, async ($, on) => {
    const w = world(on, $, undefined, { envTitle: '  Manager  ', noDesktop: !brokenDesktop, brokenDesktop })
    await w.start('terminal')
    expect(w.opened).toEqual(['board'])
    expect(String((await $.tool.call(ask) as { result?: unknown }).result)).toContain('Added ask')
  })
}

for (const [title, envTitle, manager] of [['Other', 'Manager', false], ['Manager', 'Other', true]] as const) {
  test(`desktop title ${title} wins over HARNESS_TITLE=${envTitle}`, async ($, on) => {
    const w = world(on, $, title, { envTitle })
    await w.start()
    expect(w.opened).toEqual(manager ? ['board'] : [])
    const result = await $.tool.call(ask) as { result?: unknown; deny?: unknown }
    expect(String(manager ? result.result : result.deny)).toContain(manager ? 'Added ask' : 'only in the Manager session')
  })
}

const terminalLeads: LeadsConfig = { leads: [{ title: 'Lead · Terminal', slug: 'terminal', codexPct: 4, claudePct: 3 }] }
const terminalBudget = (action: 'reserve' | 'spent') => ({ tool: `mcp__manager-console__manager_budget_${action}`, lead: 'terminal', side: 'codex', pct: 1, job: 'terminal-1' }) as never

test('CLI Terminal lead uses its configured slug and inbox', async ($, on) => {
  const w = world(on, $, undefined, { envTitle: 'Lead · Terminal', noDesktop: true })
  w.setLeads(terminalLeads)
  w.folders.set(`${INBOX}/for-leads/terminal`, new Map([['result.md', 'Terminal result']]))
  await w.start('terminal')
  await w.clock.advance(2600)
  expect(w.submitted).toEqual(['Worker report: Terminal result (result.md)'])
  expect(w.opened).toEqual([])
  expect(String((await $.tool.call(terminalBudget('reserve')) as { result?: unknown }).result)).toContain('Reserved 1%')
})

for (const action of ['reserve', 'spent'] as const) {
  test(`budget ${action} reloads leads added after Manager starts`, async ($, on) => {
    const w = world(on, $, 'Manager')
    await w.start()
    expect(String((await $.tool.call(terminalBudget(action)) as { deny?: unknown }).deny)).toContain('No daily share configured')
    w.setLeads(terminalLeads)
    expect(String((await $.tool.call(terminalBudget(action)) as { result?: unknown }).result)).toContain(action === 'reserve' ? 'Reserved 1%' : 'Recorded 1%')
  })
}

test('budget calls preserve previous shares when leads.json cannot be read', async ($, on) => {
  const w = world(on, $, 'Manager')
  w.setLeads(terminalLeads)
  await w.start()
  w.setLeads(null)
  expect(String((await $.tool.call(terminalBudget('reserve')) as { result?: unknown }).result)).toContain('Reserved 1%')
  expect(String((await $.tool.call(terminalBudget('spent')) as { result?: unknown }).result)).toContain('Recorded 1%')
})
