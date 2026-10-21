// Standalone read-only check: node tests/readback-helpers.mjs [--fixtures]
// The mod's test runner forbids Node imports, so this exercises its real stream reader separately.
import { readFile, readdir, stat } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const here = fileURLToPath(new URL('.', import.meta.url))
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`
const libUrl = moduleUrl(await readFile(`${here}../hooks/lib.ts`, 'utf8'))
const helperSource = (await readFile(`${here}../hooks/helpers.ts`, 'utf8')).replace("from './lib'", `from '${libUrl}'`)
const { createHelperScanner, HELPER_READ_PY } = await import(moduleUrl(helperSource))
const { recordInfo, projectSlug, ago } = await import(libUrl)
const io = {
  list: async path => Promise.all((await readdir(path, { withFileTypes: true })).map(async f => ({ name: f.name, kind: f.isFile() ? 'file' : f.isDirectory() ? 'dir' : 'other', mtimeMs: (await stat(`${path}/${f.name}`)).mtimeMs }))),
  stat,
  readMany: async paths => JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-c', HELPER_READ_PY, ...paths], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })),
}
if (process.argv.includes('--fixtures')) {
  const root = `${here}fixtures/helpers`
  const now = Date.parse('2026-10-13T18:00:00Z')
  const fixtureIO = { ...io, list: async path => (await io.list(path)).map(f => ({ ...f, mtimeMs: now - 30_000 })) }
  const records = ['lead', 'empty'].map(id => recordInfo({ sessionId: id, cliSessionId: id, title: `Lead · ${id}`, cwd: '/proj' }, 0))
  const found = await createHelperScanner()(fixtureIO, root, records, now)
  assert.deepEqual(found.lead.map(h => [h.label, h.status]), [['Check the retry behavior', 'running'], ['Write the review', 'finished']])
  assert.deepEqual(found.empty, [])
  console.log('Real fixture directories and Python stream reader: passed')
} else {
  const home = homedir()
  const root = `${home}/.claude/projects`
  const records = []
  for (const app of ['Claude', 'Claude-Work']) {
    const sessions = `${home}/Library/Application Support/${app}/claude-code-sessions`
    for (const a of await io.list(sessions).catch(() => [])) if (a.kind === 'dir') {
      for (const b of await io.list(`${sessions}/${a.name}`).catch(() => [])) if (b.kind === 'dir') {
        for (const f of await io.list(`${sessions}/${a.name}/${b.name}`).catch(() => [])) if (f.kind === 'file' && /^local_.+\.json$/.test(f.name)) {
          const r = recordInfo(JSON.parse(await readFile(`${sessions}/${a.name}/${b.name}/${f.name}`, 'utf8')), f.mtimeMs)
          if (r && !r.archived && r.title.startsWith('Lead · ')) records.push(r)
        }
      }
    }
  }
  const paths = new Map()
  const dirs = await io.list(root)
  for (const r of records) {
    const guess = `${root}/${projectSlug(r.cwd)}/${r.cliSessionId}.jsonl`
    if (await stat(guess).catch(() => undefined)) paths.set(r.cliSessionId, guess)
    else for (const d of dirs) if (d.kind === 'dir') {
      const path = `${root}/${d.name}/${r.cliSessionId}.jsonl`
      if (await stat(path).catch(() => undefined)) { paths.set(r.cliSessionId, path); break }
    }
  }
  const now = Date.now()
  const found = await createHelperScanner()(io, root, records, now, paths)
  let total = 0, running = 0
  for (const r of records) {
    console.log(r.title)
    for (const h of found[r.cliSessionId] ?? []) {
      console.log(`  ${h.label}: ${h.status}, ${ago(now - h.startedAt)}`)
      total++; if (h.status === 'running') running++
    }
  }
  console.log(`Found ${total} helpers (${running} running) across ${records.length} current leads.`)
  assert.ok(total > 0, 'Expected at least one real helper')
}
