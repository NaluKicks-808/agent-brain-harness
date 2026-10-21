import { expect, test } from 'claude-code/testing'
import { transcripts } from './fixtures/helpers/data'
import { createHelperScanner, HELPER_HISTORY_MS } from '../hooks/helpers'
import * as L from '../hooks/lib'

const NOW = Date.parse('2026-10-13T18:00:00Z')
const ROOT = '/fixtures/helpers'
const parent = `${ROOT}/-proj/lead.jsonl`
const dir = `${ROOT}/-proj/lead/subagents`
const running = `${dir}/agent-running.jsonl`
const finished = `${dir}/agent-finished.jsonl`
const records = ['lead', 'empty'].map(id => L.recordInfo({ sessionId: `local_${id}`, cliSessionId: id, title: `Lead · ${id}`, cwd: '/proj' }, 0)!)

function fixture() {
  let reads = 0
  const data: Record<string, string> = Object.fromEntries(Object.entries(transcripts).map(([path, text]) => [`${ROOT}/${path}`, text]))
  const io = {
    list: async (path: string) => path === dir ? [
      { name: 'agent-running.jsonl', kind: 'file', mtimeMs: NOW - 30_000 },
      { name: 'agent-finished.jsonl', kind: 'file', mtimeMs: NOW - 20_000 },
      { name: 'agent-old.jsonl', kind: 'file', mtimeMs: NOW - HELPER_HISTORY_MS - 1 },
      { name: 'notes.jsonl', kind: 'file', mtimeMs: NOW },
    ] : [],
    stat: async () => ({ mtimeMs: NOW }),
    readMany: async (paths: string[]) => { reads++; return Object.fromEntries(paths.map(path => [path, data[path]])) },
  }
  return { io, data, reads: () => reads }
}

test('fixture scan finds running and finished helpers, matches Agent descriptions, and leaves an empty lead empty', async () => {
  const f = fixture()
  const scan = createHelperScanner()
  const helpers = await scan(f.io, ROOT, records, NOW)
  expect(helpers.lead.map(h => [h.label, h.status])).toEqual([['Check the retry behavior', 'running'], ['Write the review', 'finished']])
  expect(helpers.lead[0].startedAt).toBe(NOW - 5 * 60_000)
  expect(helpers.empty).toEqual([])
  const board = L.buildBoard({ records, transcriptMtimes: {}, reports: {}, asks: [], jobs: [], managerCliId: 'manager', now: NOW, helpers })
  expect(board.cards.find(c => c.cliSessionId === 'lead')?.state).toBe('running')
  expect(L.workerCount(board)).toBe(1)
  await scan(f.io, ROOT, records, NOW + 60_000)
  expect(f.reads()).toBe(1)
  const idle = await scan(f.io, ROOT, records, NOW + 3 * 60_000)
  expect(idle.lead.every(h => h.status === 'finished')).toBe(true)
  expect((await scan(f.io, ROOT, records, NOW + HELPER_HISTORY_MS)).lead).toEqual([])
})

test('a resumed helper is running again; malformed lines and missing files are tolerated', async () => {
  const f = fixture()
  f.data[finished] += '\nnot json\n' + JSON.stringify({ type: 'user', message: { content: 'Continue with the next check' } })
  delete f.data[parent]
  const helpers = await createHelperScanner()(f.io, ROOT, records, NOW)
  expect(helpers.lead.every(h => h.status === 'running')).toBe(true)
  expect(helpers.lead.find(h => h.id === 'running')?.label).toBe('Fallback task name')
  delete f.data[running]
  expect((await createHelperScanner()(f.io, ROOT, records, NOW)).lead).toHaveLength(1)
})
