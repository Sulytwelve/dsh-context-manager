/**
 * Summarize one or more DSH session logs.
 *
 *   node bench/analyze.mjs <session.v4.jsonl[.zstd]> [...]
 *
 * Reads the durable log directly (independent of the memory plugin) and prints
 * per-session counts and provider-reported token usage, plus how many injected
 * `memory-recall` context messages the session received.
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

function linesOf(path) {
  const raw = readFileSync(path)
  const text = path.endsWith('.zstd') ? zstdDecompressSync(raw).toString('utf8') : raw.toString('utf8')
  return text.split('\n').filter(line => line.trim() !== '')
}

function summarize(path) {
  const events = []
  for (const line of linesOf(path)) {
    try {
      events.push(JSON.parse(line))
    } catch {
      // A torn trailing line is normal while a session is being written.
    }
  }

  let turns = 0
  let steps = 0
  let input = 0
  let output = 0
  let cacheRead = 0
  let recalls = 0
  let toolCalls = 0
  // Latency runs from the admitted prompt, not from the first recorded event:
  // a session carries seeded rows such as `permission/preset` whose timestamp
  // predates it by days and would otherwise dominate the span.
  let first = null
  let last = null
  const tools = new Map()

  for (const entry of events) {
    const type = entry.type ?? entry.event?.type
    const time = entry.time ?? entry.event?.time
    if (typeof time === 'number') {
      if (type === 'user/message' && (first === null || time < first)) first = time
      if (last === null || time > last) last = time
    }
    const data = entry.data ?? entry.event?.data ?? {}
    if (type === 'turn/end') turns += 1
    else if (type === 'assistant/message') {
      steps += 1
      const usage = data.usage ?? {}
      input += usage.inputTokens ?? 0
      output += usage.outputTokens ?? 0
      cacheRead += usage.cacheReadTokens ?? 0
    } else if (type === 'tool/call') {
      toolCalls += 1
      tools.set(data.name, (tools.get(data.name) ?? 0) + 1)
    } else if (type === 'user/message') {
      if (data.source?.kind === 'memory-recall') recalls += 1
    }
  }

  return {
    session: path,
    turns,
    steps,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    toolCalls,
    recallMessages: recalls,
    wallMs: first !== null && last !== null ? last - first : 0,
    tools: Object.fromEntries([...tools.entries()].sort((left, right) => right[1] - left[1])),
  }
}

const paths = process.argv.slice(2)
if (paths.length === 0) {
  console.error('usage: node bench/analyze.mjs <session log> [...]')
  process.exit(2)
}

const rows = paths.map(summarize)
for (const row of rows) {
  const tools = Object.entries(row.tools).map(([name, count]) => `${name}×${count}`).join(', ')
  console.log(`${row.session}`)
  console.log(`  turns=${row.turns} steps=${row.steps} toolCalls=${row.toolCalls} `
    + `tok=${row.inputTokens}/${row.outputTokens} cache=${row.cacheReadTokens} `
    + `recallMsgs=${row.recallMessages} wall=${(row.wallMs / 1000).toFixed(1)}s`)
  if (tools !== '') console.log(`  tools: ${tools}`)
}

if (rows.length > 1) {
  const total = rows.reduce((sum, row) => {
    sum.steps += row.steps
    sum.toolCalls += row.toolCalls
    sum.input += row.inputTokens
    sum.output += row.outputTokens
    sum.recalls += row.recallMessages
    sum.wall += row.wallMs
    return sum
  }, { steps: 0, toolCalls: 0, input: 0, output: 0, recalls: 0, wall: 0 })
  console.log(`TOTAL sessions=${rows.length} steps=${total.steps} toolCalls=${total.toolCalls} `
    + `tok=${total.input}/${total.output} recallMsgs=${total.recalls} wall=${(total.wall / 1000).toFixed(1)}s`)
}
