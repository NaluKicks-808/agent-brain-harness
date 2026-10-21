// The inbox end to end: the mod watches ~/.claude/harness/inbox/ every 60 s, alerts on
// ship / break / needs owner, shows unread reports under their lead's card, counts them in the
// status line, and wakes the Manager with one prompt at most every five minutes, never while a
// turn runs or owner has a draft in the box. It never writes or moves an inbox file.
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'manager-console'
const NOW = Date.parse('2026-10-13T18:00:00Z')
const MIN = 60_000
const CFG = '/h/.claude'
const INBOX = `${CFG}/harness/inbox`
const SESSIONS = '/h/Library/Application Support/Claude-Work/claude-code-sessions'

for (const paused of [false, true]) {
test(`${paused ? 'paused 0/0 lead stays silent; ' : ''}inbox reports alert, show on the board, count in the status line and wake the Manager within the rules`, async ($, on) => {
  const inbox = new Map<string, { text: string; mtimeMs: number }>()
  const readInbox = new Map<string, { text: string; mtimeMs: number }>()
  const status: string[] = []
  const toasts: string[] = []
  const wakes: { text: string; kind: string }[] = []
  const writes: string[] = []
  let draft = ''

  mock.store(on)
  mock.env(on, { HOME: '/h', CLAUDE_CONFIG_DIR: CFG })
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'mgr' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 100_000, percent: 10 }, rateLimits: [] } }))
  on('ui.status', ($, e) => {
    if (e.text !== undefined) status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', ($, e) => {
    writes.push(e.path)
    return { deny: 'the mod must not write' }
  })
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  on('prompt.submit', ($, e) => {
    wakes.push({ text: e.text, kind: e.origin?.kind ?? 'none' })
    return { text: e.text }
  })
  on('fs.list', ($, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, size: number, mtimeMs: number) => ({ name, kind: 'file' as const, size, mtimeMs, isLink: false })
    if (e.path === INBOX) {
      return { value: [dir('read'), file('notes.txt', 5, NOW), ...[...inbox].map(([name, f]) => file(name, f.text.length, f.mtimeMs))] }
    }
    if (e.path === `${INBOX}/read`) return { value: [...readInbox].map(([name, f]) => file(name, f.text.length, f.mtimeMs)) }
    if (e.path === SESSIONS) return { value: [dir('acct')] }
    if (e.path === `${SESSIONS}/acct`) return { value: [dir('org')] }
    if (e.path === `${SESSIONS}/acct/org`) return { value: [file('local_l1.json', 100, NOW - 5000), file('local_mgr.json', 100, NOW)] }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', () => ({ deny: 'ENOENT' }))
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/harness/leads.json')) return { value: JSON.stringify({ leads: [{ title: 'Lead · Websites', slug: 'websites', codexPct: paused ? 0 : 4, claudePct: paused ? 0 : 3 }, { title: 'Lead · Design & Content websites', slug: 'design-content-websites', codexPct: 4, claudePct: 3 }, { title: 'Lead · Research phases 1–4', slug: 'research-phases-1-4', codexPct: 4, claudePct: 3 }], manager: { codexPct: 1, claudePct: 1 } }) }
    if (e.path.endsWith('/harness/config.json')) return { value: JSON.stringify({ remindersFile: '/proj/wiki/_reminders.md' }) }
    const isRead = e.path.startsWith(`${INBOX}/read/`)
    const name = e.path.slice((isRead ? `${INBOX}/read/` : `${INBOX}/`).length)
    const f = isRead ? readInbox.get(name) : inbox.get(name)
    return f ? { value: f.text } : { deny: `ENOENT ${e.path}` }
  })
  on('process.run', ($, e) => {
    const [cmd, , , script, ...rest] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === '/bin/date') return ok('-0600\n')
    if (String(script).includes('postTurnSummary')) {
      return ok(JSON.stringify(Object.fromEntries(rest.map(path => [String(path), String(path).endsWith('local_mgr.json')
        ? { sessionId: 'local_mgr', cliSessionId: 'mgr', title: 'Manager', cwd: '/proj', isArchived: false }
        : { sessionId: 'local_l1', cliSessionId: 'c-l1', title: 'Lead · Websites', cwd: '/proj', isArchived: false }]))))
    }
    if (String(script).includes("mode = 'step'")) return ok('0 0 seed\n')
    return { value: { exitCode: 1, stdout: '', stderr: 'no', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  inbox.set('2026-10-13-1159-Lead · Websites.md', { text: 'ship: the intake pack is in the brain\n- path: docs/x.md\n', mtimeMs: NOW - 2 * MIN })
  inbox.set('2026-10-13-1159-Lead · Research.md', { text: 'needs owner: book Tuesday? (default: Tuesday)\n', mtimeMs: NOW - MIN })
  inbox.set('2026-10-13-1200-Ops · checks.md', { text: 'FYI: digest posted\n', mtimeMs: NOW - 30_000 })

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await clock.advance(2600) // the first inbox pass (and the first board poll)

  expect(toasts).toEqual([
    'Console active · /board',
    'Shipped · Lead · Websites: ship: the intake pack is in the brain',
    'Needs you · Lead · Research: needs owner: book Tuesday? (default: Tuesday)',
  ])
  expect(wakes).toHaveLength(1)
  expect(wakes[0]?.kind).toBe('plugin') // framed as the mod's message, never as owner's words
  expect(wakes[0]?.text).toBe(
    'Inbox: needs owner: book Tuesday? (default: Tuesday) (2026-10-13-1159-Lead · Research.md)',
  )
  expect(status.at(-1)).toContain('3 reports')
  expect(status.at(-1)).toContain('1 needs you')

  const pane = await $.ui.mount({
    plugin: PLUGIN,
    surface: 'desktop',
    component: 'Pane',
    requestId: 'board',
    props: { title: 'Team board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  })
  expect(await pane.find({ text: /^Lead · Websites · Idle/ })).toBeDefined()
  await pane.press({ key: 'worker-details' })
  expect(await pane.find({ text: /^Inbox: ship: the intake pack is in the brain · \d+ min ago$/ })).toBeDefined()
  expect(await pane.find({ text: /Inbox, no matching card \(2\)/ })).toBeDefined()
  await pane.unmount()

  // The Manager reads two and moves them to read/; a new "break" lands a minute later.
  inbox.delete('2026-10-13-1159-Lead · Websites.md')
  inbox.delete('2026-10-13-1200-Ops · checks.md')
  inbox.set('2026-10-13-1201-Lead · Websites.md', { text: '**break** — the Drive upload was refused\n', mtimeMs: NOW + MIN })
  await clock.advance(MIN)
  expect(toasts.at(-1)).toBe('Problem · Lead · Websites: break — the Drive upload was refused')
  expect(wakes).toHaveLength(1) // under five minutes since the last wake
  expect(status.at(-1)).toContain('2 reports')

  // A turn is running when the five minutes are up: the wake waits for it to end.
  await $.turn.start({ text: 'go on', turnId: 't1' })
  await clock.advance(4 * MIN)
  expect(wakes).toHaveLength(1)
  draft = 'half a thought' // and owner is typing when it ends
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(3500)
  expect(wakes).toHaveLength(1)
  draft = ''
  await clock.advance(MIN) // the next inbox pass
  expect(wakes).toHaveLength(2)
  // Each report is named in one wake only: the Research one went in the first.
  expect(wakes[1]?.text).toBe('Inbox: break — the Drive upload was refused (2026-10-13-1201-Lead · Websites.md)')
  // Nothing new: no more wakes, no repeated alerts, and the mod never wrote a file.
  const toastCount = toasts.length
  await clock.advance(10 * MIN)
  expect(wakes).toHaveLength(2)
  expect(toasts).toHaveLength(toastCount)
  expect(writes).toEqual([])

  // The lead remains idle. The alarm appears after two hours of board observations.
  await clock.advance(105 * MIN)
  if (paused) {
    expect(wakes).toHaveLength(2)
    expect(status.at(-1)).not.toContain('lead ready 2h')
    await clock.advance(240 * MIN)
    expect(wakes).toHaveLength(2)
    return
  }
  // owner, 2026-10-14 22:43: the idle alarm no longer wakes the Manager; the status line still shows it.
  expect(wakes).toHaveLength(2)
  expect(status.at(-1)).toContain('lead ready 2h')
  await clock.advance(240 * MIN)
  expect(wakes).toHaveLength(2)
})
}
