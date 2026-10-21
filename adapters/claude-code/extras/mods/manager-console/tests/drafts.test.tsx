import { expect, test } from 'claude-code/testing'
import type { ManagerOutbound } from '../types'
import { draftCards, syncDrafts } from '../hooks/lib'

const file = (body: string, header = '') => ({
  path: 'drafts/check-in.md',
  text: `---\nchannel: text\nto: 'Alex'\nto_handle: '+15551234567'\nstatus: awaiting-owner\n${header}---\n${body}`,
})
const draft = (): ManagerOutbound => draftCards([file('Hello Alex.\n\nCan we meet next Tuesday?')], 123)[0]!

test('draft parsing reads scalar frontmatter, maps channels, strips rationale and keeps email subject', () => {
  expect(draftCards([file('Hello Alex.\n\n_Why now: follow up._')], 123)).toEqual([{
    id: 'check-in', channel: 'Text', to: "Alex (+15551234567)",
    text: 'Hello Alex.', queuedAt: 123, source: 'draft',
  }])
  const email = file('**Subject:** Tuesday\n\nCan we meet?\n\n_Why: scheduling._', 'channel: "email"\nto: "Alex"\nto_handle: \n')
  expect(draftCards([email], 1)[0]).toEqual({
    id: 'check-in', channel: 'Gmail', to: 'Alex', text: '**Subject:** Tuesday\n\nCan we meet?', queuedAt: 1, source: 'draft',
  })
  expect(draftCards([file('Body', 'channel: Slack\n')], 1)[0]?.channel).toBe('Slack')
  expect(draftCards([file('First.\n\n\nSecond.\n\n_Why: follow up._')], 1)[0]?.text).toBe('First.\n\n\nSecond.')
})

test('draft parsing ignores other statuses, missing frontmatter, nested archives and empty messages', () => {
  expect(draftCards([
    file('Body', 'status: sent\n'), file('Body', 'status: superseded\n'),
    { path: 'bad.md', text: 'Body' }, { ...file('Body'), path: 'drafts/archive/check-in.md' },
    file('_Why: nothing to send._'),
  ], 1)).toEqual([])
  expect(draftCards([{ ...file('Body'), text: file('Body').text.replace(/\n/g, '\r\n') }], 1)[0]?.text).toBe('Body')
})

test('draft sync adds missing cards and deduplicates by id without editing a hand-queued card', () => {
  const card = draft()
  expect(syncDrafts([], [card])).toEqual([card])
  const manual = [{ ...card, source: undefined, text: 'Owner edited this.' }]
  expect(syncDrafts(manual, [card])).toBe(manual)
})

test('draft sync deduplicates using the longest paragraph with normalized whitespace', () => {
  const card = draft()
  const manual = [{ ...card, id: 'manual', source: undefined, text: 'Hand queued:\nCan we  meet\nnext Tuesday?\nThanks.' }]
  expect(syncDrafts(manual, [card])).toBe(manual)
  expect(syncDrafts([{ ...manual[0]!, text: 'Hello Alex.' }], [card])).toHaveLength(2)
})

test('draft sync removes only its own missing or sent drafts', () => {
  const card = draft()
  const manual = { ...card, id: 'manual', source: undefined }
  expect(syncDrafts([manual, card], [])).toEqual([manual])
  expect(syncDrafts([manual, card], draftCards([file('Body', 'status: sent\n')], 456))).toEqual([manual])
})

test('draft sync updates its cards, preserves queue age, and returns the same array when unchanged', () => {
  const current = [draft()]
  expect(syncDrafts(current, [{ ...draft(), queuedAt: 456 }])).toBe(current)
  const changed = syncDrafts(current, [{ ...draft(), text: 'New message.', to: 'Another recipient', channel: 'Gmail', queuedAt: 456 }])
  expect(changed[0]).toEqual({ ...current[0], text: 'New message.', to: 'Another recipient', channel: 'Gmail' })
  expect(current[0]?.text).toBe('Hello Alex.\n\nCan we meet next Tuesday?')
  const empty: ManagerOutbound[] = []
  expect(syncDrafts(empty, [])).toBe(empty)
})
