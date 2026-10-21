import type { ManagerHelper, ManagerRecordInfo } from '../types'
import { projectSlug } from './lib'

export const HELPER_RUNNING_MS = 3 * 60_000
export const HELPER_HISTORY_MS = 2 * 60 * 60_000

type Entry = { name: string; kind: string; mtimeMs: number }
type HelperIO = {
  list(path: string): Promise<Entry[]>
  stat(path: string): Promise<{ mtimeMs: number }>
  readMany(paths: string[]): Promise<Record<string, string>>
}
type Row = { type?: string; timestamp?: string; message?: { stop_reason?: string; content?: any }; agentId?: string }
const rows = (text: string): Row[] => text.split('\n').flatMap(line => {
  try { const row = JSON.parse(line); return row && typeof row === 'object' ? [row] : [] } catch { return [] }
})
const blocks = (row: Row): any[] => Array.isArray(row.message?.content) ? row.message!.content : []
const textOf = (content: any): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(b => b?.type === 'text').map(b => b.text ?? '').join('\n') : ''
const label = (text: string): string => {
  const first = text.split('\n').find(line => line.trim())?.trim() ?? ''
  return first.length <= 60 ? first : `${first.slice(0, 59).trimEnd()}…`
}

/** Stream large transcripts in Python; return only fields the helper scan needs. No writes. */
export const HELPER_READ_PY = String.raw`
import json, re, sys
out = {}
for path in sys.argv[1:]:
    kept = []
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                try:
                    r = json.loads(line)
                    m = r.get('message') or {}
                    c = m.get('content')
                    parent = '/subagents/' not in path
                    if parent:
                        bs = []
                        for b in c if isinstance(c, list) else []:
                            if b.get('type') == 'tool_use' and b.get('name') == 'Agent':
                                bs.append({'type': 'tool_use', 'name': 'Agent', 'id': b.get('id'), 'input': {'description': (b.get('input') or {}).get('description')}})
                            elif b.get('type') == 'tool_result':
                                match = re.search(r'agentId:\s*([A-Za-z0-9_-]+)', str(b.get('content', '')))
                                if match:
                                    bs.append({'type': 'tool_result', 'tool_use_id': b.get('tool_use_id'), 'content': 'agentId: ' + match.group(1)})
                        if not bs:
                            continue
                        c = bs
                    elif r.get('type') not in ('user', 'assistant'):
                        continue
                    elif isinstance(c, list):
                        c = [{'type': b.get('type'), 'text': str(b.get('text') or '')[:240]} for b in c if isinstance(b, dict)]
                    elif isinstance(c, str):
                        c = c[:240]
                    kept.append(json.dumps({'type': r.get('type'), 'timestamp': r.get('timestamp'), 'message': {'content': c, 'stop_reason': m.get('stop_reason')}}))
                except (ValueError, TypeError, AttributeError):
                    continue
        out[path] = '\n'.join(kept)
    except OSError:
        pass
print(json.dumps(out))
`

/** Cache transcript parsing by mtime; reclassify inactivity on every scan. */
export function createHelperScanner() {
  const cache = new Map<string, { mtimeMs: number; rows: Row[] }>()
  return async (io: HelperIO, projectsRoot: string, records: readonly ManagerRecordInfo[], now: number,
    transcriptPaths: ReadonlyMap<string, string> = new Map()): Promise<Record<string, ManagerHelper[]>> => {
    const leads = records.filter(r => !r.archived && r.title.startsWith('Lead · ') && r.cliSessionId)
    const files: { cli: string; path: string; id: string; mtimeMs: number }[] = []
    const parents = new Map<string, string>()
    const wanted = new Map<string, number>()
    for (const lead of leads) {
      const parent = transcriptPaths.get(lead.cliSessionId) ?? `${projectsRoot}/${projectSlug(lead.cwd)}/${lead.cliSessionId}.jsonl`
      const dir = `${parent.slice(0, -6)}/subagents`
      const entries = (await io.list(dir).catch(() => [])).filter(f => f.kind === 'file' && /^agent-.+\.jsonl$/.test(f.name) && now - f.mtimeMs <= HELPER_HISTORY_MS)
      if (!entries.length) continue
      parents.set(lead.cliSessionId, parent)
      const stat = await io.stat(parent).catch(() => undefined)
      if (stat) wanted.set(parent, stat.mtimeMs)
      for (const f of entries) {
        const path = `${dir}/${f.name}`
        files.push({ cli: lead.cliSessionId, path, id: f.name.slice(6, -6), mtimeMs: f.mtimeMs })
        wanted.set(path, f.mtimeMs)
      }
    }
    const changed = [...wanted].filter(([path, mtime]) => cache.get(path)?.mtimeMs !== mtime).map(([path]) => path)
    if (changed.length) {
      const read = await io.readMany(changed)
      for (const path of changed) {
        if (typeof read[path] === 'string') cache.set(path, { mtimeMs: wanted.get(path)!, rows: rows(read[path]) })
        else cache.delete(path)
      }
    }
    for (const path of cache.keys()) if (!wanted.has(path)) cache.delete(path)
    const descriptions = new Map<string, Record<string, string>>()
    for (const [cli, parent] of parents) {
      const calls = new Map<string, string>()
      const names: Record<string, string> = {}
      for (const row of cache.get(parent)?.rows ?? []) for (const b of blocks(row)) {
        if (b.type === 'tool_use' && b.name === 'Agent' && typeof b.input?.description === 'string') calls.set(b.id, b.input.description)
        if (b.type === 'tool_result') {
          const id = /agentId:\s*([A-Za-z0-9_-]+)/.exec(textOf(b.content))?.[1]
          const task = calls.get(b.tool_use_id)
          if (id && task) names[id] = task
        }
      }
      descriptions.set(cli, names)
    }
    const result: Record<string, ManagerHelper[]> = Object.fromEntries(leads.map(r => [r.cliSessionId, []]))
    for (const f of files) {
      const transcript = cache.get(f.path)?.rows
      if (!transcript) continue
      const conversation = transcript.filter(r => r.type === 'user' || r.type === 'assistant')
      const first = conversation.find(r => r.type === 'user')
      const last = conversation.at(-1)
      const final = last?.type === 'assistant' && last.message?.stop_reason === 'end_turn' && blocks(last).every(b => b.type !== 'tool_use') && textOf(last.message?.content).trim() !== ''
      const started = Date.parse(first?.timestamp ?? '')
      result[f.cli].push({ id: f.id, label: label(descriptions.get(f.cli)?.[f.id] || textOf(first?.message?.content)) || 'Helper',
        status: !final && now - f.mtimeMs < HELPER_RUNNING_MS ? 'running' : 'finished',
        startedAt: Number.isFinite(started) ? started : f.mtimeMs, lastActiveAt: f.mtimeMs })
    }
    for (const helpers of Object.values(result)) helpers.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.lastActiveAt - a.lastActiveAt)
    return result
  }
}
