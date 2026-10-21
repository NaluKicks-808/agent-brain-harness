// The start-up and poll path end to end, over a faked file system and faked processes:
// session start, tools and /board, the Manager transcript tail, session records, transcript
// times, context fill, Codex jobs, GitHub minutes (failing, as it does without the "user" scope),
// the next reminder, the status line, the board pane, and a "broke" alert on a new report.
import { expect, mock, test } from 'claude-code/testing'
import * as L from '../hooks/lib'
import { HELPER_READ_PY } from '../hooks/helpers'

const PLUGIN = 'manager-console'
const NOW = Date.parse('2026-10-13T18:00:00Z') // 12:00 MDT, Tuesday 13 October
const HOME = '/h'
const CFG = '/h/.claude'
const SESSIONS = `${HOME}/Library/Application Support/Claude-Work/claude-code-sessions`
const OWN = `${CFG}/projects/-proj/mgr.jsonl`
const L1 = `${CFG}/projects/-proj/c-l1.jsonl`
const W1 = `${CFG}/projects/-proj/c-w1.jsonl`
const CODEX = `${CFG}/plugins/data/codex-openai-codex/state`

const records: Record<string, unknown> = {
  [`${SESSIONS}/acct/org/local_l1.json`]: { sessionId: 'local_l1', cliSessionId: 'c-l1', title: 'Lead · Websites', cwd: '/proj', isArchived: false, lastActivityAt: NOW - 60_000 },
  [`${SESSIONS}/acct/org/local_w1.json`]: {
    sessionId: 'local_w1',
    cliSessionId: 'c-w1',
    title: 'Builder · retry fix',
    cwd: '/proj',
    isArchived: false,
    lastActivityAt: NOW - 600_000,
    postTurnSummary: { status_detail: 'stage 1 running' },
  },
  [`${SESSIONS}/acct/org/local_mgr.json`]: { sessionId: 'local_mgr', cliSessionId: 'mgr', title: 'Manager', cwd: '/proj', isArchived: false },
  [`${SESSIONS}/acct/org/local_old.json`]: { sessionId: 'local_old', cliSessionId: 'c-old', title: 'Ops · old work', cwd: '/proj', isArchived: true },
}

const peer = (from: string, name: string, body: string) =>
  JSON.stringify({
    type: 'user',
    isMeta: true,
    timestamp: new Date(NOW - 120_000).toISOString(),
    origin: { kind: 'peer', fromSession: from, name },
    message: { content: `Another Claude session sent a message:\n<cross-session-message from-session="${from}" from-name="${name}">\n${body}\n</cross-session-message>` },
  })

const SEED = [
  JSON.stringify({ type: 'user', origin: { kind: 'human' }, message: { content: 'check on everyone' } }),
  ...Array.from({ length: 9 }, (_, i) =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: `local_${i}`, message: 'status?' } }] } }),
  ),
  peer('local_l1', 'Lead · Websites', 'The intake pack is ready.\n\n**Question for owner:** book Tuesday?'),
  peer('local_w1', 'Builder · retry fix', 'Merged the retry fix on main.'),
].join('\n') + '\n'

const STEP = `${peer('local_w1', 'Builder · retry fix', 'The deploy failed on step 2. Rolling back.')}\n`

const REMINDERS = [
  '## Open',
  '| Trigger | Type | What to surface | Why it matters |',
  '|---|---|---|---|',
  '| **Monday 2026-10-19, owner** `since 2026-10-12` | Date | **Add a payment card to the GitHub account** | x |',
  '| **Friday 2026-10-09, owner** | Date | **Past.** | x |',
  '## Done',
].join('\n')

test('start-up, one full poll, the board and the status line, then a new report alerts', async ($, on) => {
  const status: string[] = []
  const toasts: string[] = []
  const sounds: number[] = []
  const logs: string[] = []
  const tools: string[] = []
  const commands: string[] = []
  const opened: string[] = []
  const ran: string[] = []
  let tailReads = 0
  let draftStatus = 'awaiting-owner'
  let gitFailure = ''
  const gitCalls: string[][] = []

  const saved: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: saved[e.key] }))
  on('store.set', ($, e) => { saved[e.key] = e.value; return { value: undefined } })
  mock.env(on, { HOME, CLAUDE_CONFIG_DIR: CFG })
  const clock = mock.clock(on, { now: NOW })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('tool.register', ($, e) => {
    tools.push(e.name)
    return { value: { tool: `mcp__${PLUGIN}__${e.name}` } }
  })
  on('command.register', ($, e) => {
    commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.id', () => ({ value: 'mgr' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, tokens: 410_000, percent: 41 }, rateLimits: [] } }))
  on('ui.status', ($, e) => {
    if (e.text !== undefined) status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('audio.play', () => {
    sounds.push(1)
    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('fs.exists', ($, e) => ({ value: e.path === OWN }))
  on('fs.list', ($, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string, mtimeMs: number) => ({ name, kind: 'file' as const, size: 100, mtimeMs, isLink: false })
    const listing: Record<string, unknown[]> = {
      [SESSIONS]: [dir('acct')],
      [`${SESSIONS}/acct`]: [dir('org')],
      [`${SESSIONS}/acct/org`]: Object.keys(records).map(p => file(p.split('/').at(-1) ?? '', NOW - 5000)),
      [`${CFG}/projects/-proj/c-l1/subagents`]: [file('agent-live.jsonl', NOW - 30_000), file('agent-done.jsonl', NOW - 60_000)],
      [CODEX]: [dir('proj-1')],
      [`${CODEX}/proj-1/jobs`]: [file('task-1.json', NOW - 1000), file('task-0.json', NOW - 2000), file('task-1.log', NOW)],
    }
    const value = listing[e.path]
    return value ? { value: value as never } : { deny: `ENOENT ${e.path}` }
  })
  on('fs.stat', ($, e) => {
    const mtimes: Record<string, number> = { [L1]: NOW - 30_000, [W1]: NOW - 600_000 }
    const mtimeMs = mtimes[e.path]
    return mtimeMs === undefined ? { deny: `ENOENT ${e.path}` } : { value: { kind: 'file', size: 1, mtimeMs, isLink: false } }
  })
  on('fs.read', ($, e) => {
    if (e.path.endsWith('/harness/leads.json')) return { value: JSON.stringify({ leads: [{ title: 'Lead · Websites', slug: 'websites', codexPct: 4, claudePct: 3 }, { title: 'Lead · Design & Content websites', slug: 'design-content-websites', codexPct: 4, claudePct: 3 }, { title: 'Lead · Research phases 1–4', slug: 'research-phases-1-4', codexPct: 4, claudePct: 3 }], manager: { codexPct: 1, claudePct: 1 } }) }
    if (e.path.endsWith('/harness/config.json')) return { value: JSON.stringify({ remindersFile: '/proj/wiki/_reminders.md', sourceOfTruthRepo: '/vault' }) }
    if (e.path in records) return { value: JSON.stringify(records[e.path]) }
    if (e.path === `${CODEX}/proj-1/jobs/task-1.json`) {
      return { value: JSON.stringify({ id: 'task-1', kindLabel: 'rescue', status: 'running', phase: 'editing', sessionId: 'c-w1', startedAt: new Date(NOW - 240_000).toISOString() }) }
    }
    if (e.path === `${CODEX}/proj-1/jobs/task-0.json`) return { value: JSON.stringify({ id: 'task-0', kindLabel: 'review', status: 'completed', phase: 'done', sessionId: 'c-w1' }) }
    if (e.path.endsWith('/wiki/_reminders.md')) return { value: REMINDERS }
    return { deny: `ENOENT ${e.path}` }
  })
  on('process.run', ($, e) => {
    const [cmd, , , script, ...rest] = e.argv
    ran.push(String(cmd))
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === '/usr/bin/git') {
      gitCalls.push([...e.argv])
      expect(e.argv.slice(1, 3)).toEqual(['-C', '/vault'])
      if (e.argv[3] === gitFailure) return { value: { exitCode: 1, stdout: '', stderr: 'remote unavailable', isStdoutTruncated: false, isStderrTruncated: false } }
      if (e.argv[3] === 'fetch') return ok('')
      if (e.argv[3] === 'ls-tree') return ok('drafts/test-draft.md\0drafts/archive\0')
      if (e.argv[3] === 'show') {
        expect(e.argv[4]).toBe('origin/main:drafts/test-draft.md')
        return ok(`---\nchannel: email\nto: Alex\nstatus: ${draftStatus}\n---\n**Subject:** Hello\n\nA draft from origin/main.\n\n_Why: test._`)
      }
      return { deny: 'unexpected git command' }
    }
    if (cmd === '/usr/bin/python3' && script === HELPER_READ_PY) return ok(JSON.stringify({
      [L1]: '',
      [`${CFG}/projects/-proj/c-l1/subagents/agent-live.jsonl`]: JSON.stringify({ type: 'user', timestamp: new Date(NOW - 120_000).toISOString(), message: { content: 'Check the helper scan' } }),
      [`${CFG}/projects/-proj/c-l1/subagents/agent-done.jsonl`]: [
        JSON.stringify({ type: 'user', timestamp: new Date(NOW - 180_000).toISOString(), message: { content: 'Review the helper scan' } }),
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn' } }),
      ].join('\n'),
    }))
    if (cmd === '/bin/date') return ok('-0600\n')
    if (cmd === '/usr/bin/python3' && String(script).includes("mode = 'step'")) {
      tailReads += 1
      const offset = Number(rest[1])
      if (offset < 0) return ok(`${SEED.length} ${SEED.length} seed\n${SEED}`)
      if (tailReads === 2) return ok(`${SEED.length + STEP.length} ${SEED.length + STEP.length} step\n${STEP}`)
      return ok(`${offset} ${offset} step\n`)
    }
    if (cmd === '/usr/bin/python3' && String(script).includes('postTurnSummary')) {
      const paths = e.argv.slice(3)
      return ok(JSON.stringify(Object.fromEntries(paths.map(p => [p, records[p] ?? null]))))
    }
    if (cmd === '/usr/bin/python3' && String(script).includes('cache_read_input_tokens')) {
      return ok(JSON.stringify({ [L1]: { tokens: L.HANDOFF_AT * 10_000, model: 'claude-opus-5-5' }, [W1]: { tokens: L.COMPACT_AT * 10_000, model: 'claude-opus-5-5' } }))
    }
    if (String(cmd).endsWith('gh') && e.argv[2] === 'user') return ok('example-owner\n')
    if (String(cmd).endsWith('gh')) {
      return { value: { exitCode: 1, stdout: '', stderr: 'gh: This API operation needs the "user" scope.', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { deny: `unexpected process ${String(cmd)}` }
  })

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  expect(tools).toEqual(['manager_ask', 'manager_ask_resolve', 'manager_queue_outbound', 'manager_outbound_remove', 'manager_budget_reserve', 'manager_budget_spent'])
  expect(commands).toEqual(['board'])
  expect(opened).toEqual(['board'])

  await clock.advance(1600) // the first full poll
  expect(logs).toEqual(['manager-console: compaction: percent=41% action=none skip=below handoff'])
  const line = status.at(-1) ?? ''
  expect(line).toStartWith('Team board: /board · 1 lead · 3 workers · 1 working · 1 needs you · ⚠ msgs 9/10 · ctx 41% · last compact unknown · next threshold 88% handoff · next: Mon 19 Add a payment card… · Budget today')
  expect(ran.filter(cmd => cmd.endsWith('gh'))).toHaveLength(3) // account lookup, usage report, then older endpoint
  expect(toasts).toEqual(['Console active · /board']) // the seed read never alerts

  for (const surface of ['desktop', 'terminal'] as const) {
    const pane = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: 'board',
      props: { title: 'Team board', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    })
    expect(await pane.find({ text: /^Lead · Websites · Working/ })).toBeDefined()
    expect(await pane.find({ text: /^1 lead · 3 workers/ })).toBeDefined()
    expect(await pane.find({ text: /Helper Check the helper scan/ })).toBeUndefined()
    expect(await pane.find({ text: 'Builder · retry fix' })).toBeUndefined()
    expect(await pane.find({ text: /Codex review/ })).toBeUndefined()
    await pane.press({ key: 'worker-details' })
    expect(await pane.find({ text: /Helper Check the helper scan: running/ })).toBeDefined()
    expect(await pane.find({ text: /Helper Review the helper scan: finished/ })).toBeDefined()
    expect(await pane.find({ text: `Context ${L.HANDOFF_AT}% full · handoff due` })).toBeDefined()
    expect(await pane.find({ text: 'Builder · retry fix' })).toBeDefined()
    expect(await pane.find({ text: `Context ${L.COMPACT_AT}% full · compacting` })).toBeDefined()
    expect(await pane.find({ text: /Codex rescue: editing · started 4 min ago/ })).toBeDefined()
    expect(await pane.find({ text: /Codex review: completed/ })).toBeDefined()
    expect(await pane.find({ text: /"user" scope/ })).toBeDefined()
    expect(await pane.find({ text: /old work/ })).toBeUndefined()
    await pane.press({ key: 'worker-details' })
    await pane.unmount()
  }

  await clock.advance(30_000) // the next poll reads one new report
  expect(toasts).toEqual(['Console active · /board', 'Problem · Builder · retry fix: The deploy failed on step 2. Rolling back.'])
  expect(sounds).toHaveLength(1)
  expect(ran.filter(cmd => cmd.endsWith('gh'))).toHaveLength(3) // not again within 30 minutes
  expect(logs).toEqual(['manager-console: compaction: percent=41% action=none skip=below handoff'])
  const cards = () => saved.outbound
  expect(await cards()).toEqual([{
    id: 'test-draft', channel: 'Gmail', to: 'Alex', text: '**Subject:** Hello\n\nA draft from origin/main.',
    queuedAt: NOW + 2000, source: 'draft',
  }])
  expect(gitCalls[0]?.slice(3)).toEqual(['fetch', '-q', 'origin', 'main'])
  expect(gitCalls[1]?.slice(3)).toEqual(['ls-tree', '-z', '--name-only', 'origin/main', 'drafts/'])

  for (const command of ['fetch', 'ls-tree', 'show']) {
    const before = await cards()
    gitFailure = command
    await clock.advance(5 * 60_000)
    expect(await cards()).toEqual(before)
    // A failed fetch still reads the last fetched origin/main; a failed read changes nothing.
    const said = command === 'fetch' ? 'drafts fetch failed: git fetch failed' : `drafts failed: git ${command} failed`
    expect(logs.some(line => line.includes(said))).toBe(true)
  }
  gitFailure = ''

  // Removed by Send, Don't send or the remove tool: stays off while the draft still says awaiting-owner.
  await $.tool.call({ tool: 'mcp__manager-console__manager_outbound_remove', id: 'test-draft' } as never)
  expect(await cards()).toEqual([])
  await clock.advance(5 * 60_000)
  expect(await cards()).toEqual([])
  expect(saved.draftsHandled).toEqual(['test-draft'])

  // Once the draft leaves awaiting-owner the memory is dropped, so a later re-draft shows again.
  draftStatus = 'sent'
  await clock.advance(5 * 60_000)
  expect(await cards()).toEqual([])
  expect(saved.draftsHandled).toEqual([])
  draftStatus = 'awaiting-owner'
  await clock.advance(5 * 60_000)
  expect((await cards()).map(card => card.id)).toEqual(['test-draft'])

  draftStatus = 'sent'
  await clock.advance(5 * 60_000)
  expect(await cards()).toEqual([])
})
