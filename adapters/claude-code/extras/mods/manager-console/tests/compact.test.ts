import { expect, test } from 'claude-code/testing'
import * as L from '../hooks/lib'

test('handoff threshold nudges once; post-handoff threshold compacts after a file or timeout', () => {
  const start = 1_000_000_000
  const cycle = L.emptyCompactCycle()
  expect(L.compactAction(cycle, L.HANDOFF_AT - 1, start, true)).toBe('none')
  expect(L.compactAction(cycle, L.HANDOFF_AT, start, true)).toBe('nudge')
  const nudged = { ...cycle, nudgeAt: start }
  expect(L.compactAction(nudged, L.POST_HANDOFF_COMPACT_AT - 1, start + L.HANDOFF_WAIT_MS, true)).toBe('none')
  expect(L.compactAction(nudged, L.POST_HANDOFF_COMPACT_AT, start + L.HANDOFF_WAIT_MS - 1, true)).toBe('check-file')
  expect(L.compactAction(nudged, L.POST_HANDOFF_COMPACT_AT, start + L.HANDOFF_WAIT_MS, true)).toBe('compact')
  expect(L.compactAction(nudged, L.POST_HANDOFF_COMPACT_AT, start + L.HANDOFF_WAIT_MS, false)).toBe('none')
})

test('hard trigger and thirty-minute spacing', () => {
  const now = 1_000_000_000
  expect(L.compactAction(L.emptyCompactCycle(), L.COMPACT_AT - 1, now, true)).toBe('nudge')
  expect(L.compactAction(L.emptyCompactCycle(), L.COMPACT_AT, now, true)).toBe('compact')
  expect(L.compactAction(L.emptyCompactCycle(), L.COMPACT_AT, now, false)).toBe('none')
  const recent = { nudgeAt: 0, lastCompactAt: now, awaitDrop: false }
  expect(L.compactAction(recent, L.COMPACT_AT, now + L.COMPACT_SPACING_MS - 1, true)).toBe('none')
  expect(L.compactAction(recent, L.COMPACT_AT, now + L.COMPACT_SPACING_MS, true)).toBe('compact')
  expect(L.compactAction({ ...recent, awaitDrop: true }, L.COMPACT_AT, now + L.COMPACT_SPACING_MS, true)).toBe('none')
})

test('role paths and worker slug', () => {
  expect(L.handoffPath(L.gateForTitle('Manager', 1, 1), '/proj', '/h/.claude')).toBe('/h/.claude/harness/handoffs/manager.md')
  expect(L.handoffPath(L.gateForTitle('Lead · Web Sites', 1, 1, ['web-sites']), '/proj', '/h/.claude')).toBe('/h/.claude/harness/handoffs/web-sites.md')
  const worker = L.gateForTitle('Builder · Retry & Fix!', 1, 1)
  expect(worker.status).toBe('worker')
  expect(worker.workerSlug).toBe('builder-retry-fix')
  expect(L.handoffPath(worker, '/proj', '/h/.claude')).toBe('/h/.claude/harness/handoffs/builder-retry-fix.md')
  expect(L.gateForTitle('Other', 1, 1).status).toBe('off')
})

test('instruction paths stay under approved folders', () => {
  expect(L.allowedInstructionFile('/projects/a/readme.md', ['/projects', '/h/.claude/harness'])).toBe(true)
  expect(L.allowedInstructionFile('/h/.claude/harness/notes.txt', ['/projects', '/h/.claude/harness'])).toBe(true)
  for (const path of ['/tmp/a.md', '/h/.claude/harness/../secret.md', '/h/.claude/harnessed/a.md', '/h/.claude/harness/a.pdf']) {
    expect(L.allowedInstructionFile(path, ['/projects', '/h/.claude/harness'])).toBe(false)
  }
})
