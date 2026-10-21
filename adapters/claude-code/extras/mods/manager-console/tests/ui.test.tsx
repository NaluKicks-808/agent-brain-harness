import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'manager-console'
const BAND = {
  component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: false, maxRows: 24, bodyColumns: 90, scroll: { offset: 0, bodyRows: 24 }, view: {} },
}
const PANE = {
  component: 'Pane' as const,
  requestId: 'board',
  props: { title: 'Team board', isFocused: false, bodyColumns: 60, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 40 }, view: {} },
}
const INSTRUCTION = { ...PANE, requestId: 'instructions', props: { ...PANE.props, title: 'instructions.md' } }
const FILE = '/h/.claude/harness/instructions.md'

/** The world beneath the plugin: memory store and clock, quiet UI calls, and a record of prompts. */
const world = (on: On, $: unknown, kept: Record<string, unknown> = {}) => {
  const saved: Record<string, unknown> = { ...kept }
  const submitted: { text: string; kind: string; asUser?: true }[] = []
  const filled: string[] = []
  const toasts: string[] = []
  const sounds: string[] = []
  const opened: string[] = []
  on('store.get', ($, e) => ({ value: saved[e.key] }))
  on('store.set', ($, e) => { saved[e.key] = e.value; return { value: undefined } })
  mock.env(on, { HOME: '/h', CLAUDE_CONFIG_DIR: '/h/.claude' })
  const clock = mock.clock(on, { now: 1_760_000_000_000 })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'mgr' }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__${PLUGIN}__${e.name}` } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', ($, e) => e.path === FILE
    ? { value: { kind: 'file', size: 18, mtimeMs: 1, isLink: false, realPath: FILE } }
    : { deny: 'ENOENT' })
  on('fs.read', ($, e) => e.path.endsWith('/harness/leads.json') ? { value: JSON.stringify({ leads: [{ title: 'Lead · Websites', slug: 'websites', codexPct: 4, claudePct: 3 }, { title: 'Lead · Design & Content websites', slug: 'design-content-websites', codexPct: 4, claudePct: 3 }, { title: 'Lead · Research phases 1–4', slug: 'research-phases-1-4', codexPct: 4, claudePct: 3 }], manager: { codexPct: 1, claudePct: 1 } }) } : e.path === FILE ? { value: '# Instructions\nProceed.' } : { deny: 'ENOENT' })
  on('fs.list', ($, e) => {
    const dir = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
    const file = (name: string) => ({ name, kind: 'file' as const, size: 100, mtimeMs: 0, isLink: false })
    if (e.path.endsWith('/claude-code-sessions')) return { value: [dir('acct')] }
    if (e.path.endsWith('/claude-code-sessions/acct')) return { value: [dir('org')] }
    if (e.path.endsWith('/claude-code-sessions/acct/org')) return { value: [file('local_mgr.json')] }
    return { value: [] }
  })
  on('process.run', ($, e) => {
    if (e.argv.includes('local_mgr.json' as never) || String(e.argv.at(-1)).endsWith('local_mgr.json')) {
      const path = String(e.argv.at(-1))
      return { value: { exitCode: 0, stdout: JSON.stringify({ [path]: { sessionId: 'local_mgr', cliSessionId: 'mgr', title: 'Manager' } }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { deny: 'unavailable' }
  })
  on('ui.open', ($, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('audio.play', ($, e) => {
    sounds.push('asset' in e.clip ? String(e.clip.asset) : 'clip')
    return { value: undefined }
  })
  on('session.usage', () => ({ deny: 'no usage in a test' }))
  on('prompt.submit', ($, e) => {
    submitted.push({ text: e.text, kind: e.origin?.kind ?? 'none', ...(e.origin?.kind === 'plugin' && e.origin.asUser ? { asUser: true as const } : {}) })
    return { text: e.text }
  })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  return { submitted, filled, toasts, sounds, opened, clock, saved, start: () => ($ as { session: { start: (args: { cwd: string; surface: 'desktop'; isInteractive: boolean }) => Promise<unknown> } }).session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true }) }
}

const ask = (args: Record<string, unknown>) => ({ tool: 'mcp__manager-console__manager_ask', ...args }) as never
const queueOut = (args: Record<string, unknown>) => ({ tool: 'mcp__manager-console__manager_queue_outbound', ...args }) as never

test('budget tools reserve, record spend, and refuse a job above the daily share', async ($, on) => {
  await world(on, $).start()
  const call = (name: string, pct: number, job: string) => $.tool.call({ tool: `mcp__manager-console__manager_budget_${name}`, lead: 'websites', side: 'codex', pct, job } as never)
  expect(String((await call('reserve', 3, 'site-1') as { result?: unknown }).result)).toContain('Reserved 3%')
  expect(String((await call('spent', 2, 'site-1') as { result?: unknown }).result)).toContain('2% spent')
  expect(String((await call('reserve', 1, 'site-2') as { result?: unknown }).result)).toContain('Reserved 1%')
  expect(String((await call('reserve', 0.1, 'site-3') as { deny?: unknown }).deny)).toContain('would be exceeded')
})


for (const surface of ['desktop', 'terminal'] as const) {
  for (const actionSurface of ['board'] as const) {
    test(`${surface} ${actionSurface}: Skip and Dismiss remove cards everywhere, persist, and tell Manager`, async ($, on) => {
      const w = world(on, $)
      await w.start()
      await $.tool.call(ask({ id: 'ordinary', text: 'Ordinary ask?', default: 'Wait' }))
      await $.tool.call(queueOut({ id: 'message', channel: 'Gmail', to: 'Alex', text: 'Hello' }))
      await $.tool.call(ask({ id: 'urgent', text: 'Urgent ask?', default: 'Wait', deadlineAt: '2025-10-09T09:00:00Z' }))
      const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
      const board = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
      const ui = actionSurface === 'band' ? band : board
      const prefix = actionSurface === 'band' ? '' : 'pane-'
      expect(await band.find({ text: 'Urgent ask?' })).toBeDefined()
      expect(await band.find({ text: '1 of 3' })).toBeDefined()
      await ui.press({ key: `${prefix}dismiss-urgent` })
      expect(w.submitted[0]).toEqual({ text: 'Dismissed — ask urgent: dismissed by owner — "Urgent ask?"', kind: 'plugin', asUser: true })
      expect(await band.find({ text: 'Urgent ask?' })).toBeUndefined()
      expect(await board.find({ text: 'Urgent ask?' })).toBeUndefined()
      expect(await band.find({ key: 'send-message' })).toBeDefined()
      await ui.press({ key: `${prefix}skip-message` })
      expect(w.submitted[1]).toEqual({ text: "Don't send: message (Gmail to Alex). Removed from the board.", kind: 'plugin', asUser: true })
      expect(await band.find({ key: 'send-message' })).toBeUndefined()
      expect(await board.find({ key: 'pane-send-message' })).toBeUndefined()
      expect(await band.find({ text: 'Ordinary ask?' })).toBeDefined()
      expect(w.saved.outbound).toEqual([])
      expect((w.saved.asks as { id: string }[]).map(a => a.id)).toEqual(['ordinary'])
      await w.clock.advance(61 * 60_000)
      expect(await board.find({ key: 'pane-send-message' })).toBeUndefined()
      expect(await board.find({ text: 'Urgent ask?' })).toBeUndefined()
      await band.unmount(); await board.unmount()
    })
  }

  test(`${surface}: both surfaces have the same ordered actions and one native reply field`, async ($, on) => {
    const w = world(on, $)
    await w.start()
    await $.tool.call(ask({ id: 'q1', text: 'Choose a plan?', meaning: 'This restores retries.', default: 'Wait', options: ['All hold', 'Some are wrong', 'Later'] }))
    const band = await $.ui.mount({ plugin: PLUGIN, surface, ...BAND })
    const board = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    const actions = async (ui: typeof band) => (await ui.findAll({ type: 'Button' })).map(b => b.props.label).filter(label => !['Team board', 'Details'].includes(String(label)))
    expect(await actions(band)).toEqual(['All hold', 'Some are wrong', 'Reply', 'Next'])
    expect(await actions(board)).toEqual(['All hold', 'Some are wrong', 'Reply', 'Skip', 'Dismiss'])
    expect(await band.find({ type: 'Input' })).toBeUndefined()
    await board.press({ key: 'pane-reply-q1' })
    for (const [ui, prefix] of [[band, ''], [board, 'pane-']] as const) {
      expect((await ui.find({ key: `${prefix}ask-input-q1` }))?.props.submitLabel).toBe('Send')
      expect(await ui.find({ text: /add line/i })).toBeUndefined()
      expect(await ui.findAll({ type: 'Input' })).toHaveLength(1)
      expect(await ui.findAll({ type: 'Button', text: 'Send' })).toHaveLength(0) // Input supplies native Send
      expect(await ui.find({ text: 'What this means: This restores retries.' })).toBeDefined()
      expect(await ui.find({ text: 'If no answer: Wait' })).toBeDefined()
    }
    await band.input({ key: 'ask-input-q1', text: 'My draft', kind: 'change' })
    expect((await board.find({ key: 'pane-ask-input-q1' }))?.props.value).toBe('My draft')
    await board.input({ key: 'pane-ask-input-q1', text: '  ' })
    expect(w.submitted).toHaveLength(0)
    await board.input({ key: 'pane-ask-input-q1', text: 'Why today?' })
    expect(w.submitted[0]?.text).toBe('Re: Choose a plan? (ask q1): Why today?')
    expect(await band.find({ key: 'ask-input-q1' })).toBeDefined()
    await band.input({ key: 'ask-input-q1', text: 'All hold, but why?' })
    expect(w.submitted).toHaveLength(2)
    expect(await board.find({ key: 'pane-reply-q1' })).toBeUndefined()
    await $.tool.call(queueOut({ id: 'm1', channel: 'Gmail', to: 'Alex', text: 'Hi' }))
    expect(await actions(band)).toEqual(['Send', 'Edit', 'Next'])
    expect(await actions(board)).toEqual(['Send', 'Edit', "Don't send"])
    await band.unmount(); await board.unmount()
  })

  test(`${surface}: Needs you is sorted before leads and Details`, async ($, on) => {
    const w = world(on, $)
    await w.start()
    await $.tool.call(ask({ id: 'ordinary', text: 'Ordinary ask?', default: 'Wait' }))
    await $.tool.call(queueOut({ id: 'long', channel: 'Gmail', to: 'Alex', text: 'A longer message' }))
    await $.tool.call(queueOut({ id: 'short', channel: 'Gmail', to: 'Alex', text: 'Hi' }))
    await $.tool.call(ask({ id: 'urgent', text: 'Urgent ask?', default: 'Wait', deadlineAt: '2025-10-09T09:00:00Z' }))
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    const labels = (await pane.findAll({ type: 'Text' })).map(t => t.text)
    expect(labels.indexOf('Needs you (4)')).toBeLessThan(labels.indexOf('Urgent ask?'))
    expect(labels.indexOf('Urgent ask?')).toBeLessThan(labels.indexOf('Hi'))
    expect(labels.indexOf('Hi')).toBeLessThan(labels.indexOf('A longer message'))
    expect(labels.indexOf('A longer message')).toBeLessThan(labels.indexOf('Ordinary ask?'))
    expect(labels.indexOf('Ordinary ask?')).toBeLessThan(labels.indexOf('Leads'))
    expect(await pane.find({ key: 'worker-details' })).toBeDefined()
    await pane.unmount()
  })
}

test('a button answer closes only its own ask; composer answers still close the top ask', async ($, on) => {
  const w = world(on, $)
  await w.start()
  for (const id of ['q1', 'q2']) await $.tool.call(ask({ id, text: `Question ${id}?`, default: 'Wait' }))
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  await band.press({ key: 'ask-q1-0' })
  expect(w.submitted[0]?.text).toStartWith('Yes — my answer to:')
  expect(await band.find({ text: 'Question q2?' })).toBeDefined()
  await $.prompt.submit({ text: 'yes, after lunch', origin: { kind: 'composer' }, wait: false })
  expect(await band.find({ text: 'Question q2?' })).toBeUndefined()
  await band.unmount()
})

test('legacy skips and snoozes do not hide pending cards, and closed board can reopen', async ($, on) => {
  const w = world(on, $, { boardOpen: false, asks: [
    { id: 'saved', text: 'Saved ask?', default: 'Wait', options: ['Yes', 'No', 'Later'], askedAt: 1, snoozedUntil: 9_999_999_999_999 },
  ], bandSkips: { 'ask:saved': { at: 1_760_000_000_000, order: 1 } } })
  await w.start()
  expect(w.opened).toEqual([])
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  expect(await band.find({ text: 'Saved ask?' })).toBeDefined()
  expect(await band.find({ text: 'Later' })).toBeUndefined()
  await band.press({ key: 'open-board' })
  expect(w.opened).toEqual(['board'])
  await band.unmount()
})

test('instruction file opens from either surface; other paths and missing defaults are refused', async ($, on) => {
  await world(on, $).start()
  expect(String((await $.tool.call(ask({ text: 'Go?' })) as { deny?: unknown }).deny)).toContain('default is required')
  for (const path of ['/tmp/secrets.md', '/h/.claude/harness/../secret.md']) {
    expect(String((await $.tool.call(ask({ text: 'Read?', default: 'Wait', file: path })) as { deny?: unknown }).deny)).toContain('file must be')
  }
  await $.tool.call(ask({ id: 'file', text: 'Read these?', default: 'Wait', file: FILE }))
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  await band.press({ key: 'open-file' })
  const board = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  expect((await board.find({ key: 'pane-open-file' }))?.props.label).toBe('Open file')
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...INSTRUCTION })
  expect(await pane.find({ type: 'Markdown', text: '# Instructions\nProceed.' })).toBeDefined()
  await pane.press({ key: 'instruction-close' })
  await pane.unmount(); await board.unmount(); await band.unmount()
})

for (const actionSurface of ['band', 'board'] as const) test(`${actionSurface}: long messages are fully displayed and Send and Edit use exact text`, async ($, on) => {
  const w = world(on, $)
  await w.start()
  const exact = 'Hi Alex — "retry fix".\n' + 'Details and more details. '.repeat(20)
  await $.tool.call(queueOut({ id: 'm1', channel: 'Gmail', to: 'Alex', text: exact }))
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  const board = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  expect(await band.find({ text: exact })).toBeDefined()
  expect(await board.find({ text: exact })).toBeDefined()
  const ui = actionSurface === 'band' ? band : board
  const prefix = actionSurface === 'band' ? '' : 'pane-'
  await ui.press({ key: `${prefix}edit-m1` })
  expect(w.filled[0]).toBe(`Send it — Gmail to Alex, exactly: "${exact}"`)
  expect(w.submitted).toHaveLength(0)
  await ui.press({ key: `${prefix}send-m1` })
  expect(w.submitted[0]?.text).toBe(w.filled[0])
  expect(await band.find({ key: 'send-m1' })).toBeUndefined()
  expect(await board.find({ key: 'pane-send-m1' })).toBeUndefined()
  await band.unmount(); await board.unmount()
})


test('Next cycles the band without removing a card', async ($, on) => {
  const w = world(on, $)
  await w.start()
  await $.tool.call(queueOut({ id: 'skip-only', channel: 'Gmail', to: 'Alex', text: 'Hello' }))
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...BAND })
  const board = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  await $.tool.call(ask({ id: 'another', text: 'Second question?', default: 'Wait' }))
  await band.press({ key: 'next-skip-only' })
  expect(await band.find({ text: 'Second question?' })).toBeDefined()
  expect(await board.find({ key: 'pane-send-skip-only' })).toBeDefined()
  expect(w.submitted).toEqual([])
  expect((w.saved.outbound as unknown[]).length).toBe(1)
  await band.unmount(); await board.unmount()
})

test('board Skip answers an ask with its default', async ($, on) => {
  const w = world(on, $)
  await w.start()
  await $.tool.call(ask({ id: 'choice', text: 'Choose a path?', default: 'Wait for review' }))
  const board = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  await board.press({ key: 'pane-skip-choice' })
  expect(w.submitted[0]?.text).toBe('Skip, use the default (Wait for review) — my answer to: "Choose a path?"')
  expect(await board.find({ key: 'pane-skip-choice' })).toBeUndefined()
  await board.unmount()
})
