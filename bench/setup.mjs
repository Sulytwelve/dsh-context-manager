/**
 * Create the deterministic benchmark workspace used by docs/MEASUREMENTS.md.
 *
 *   node bench/setup.mjs [targetDir]
 *
 * The default target is `.bench-work/workspace`, which `.gitignore` excludes.
 * The fixture is deliberately small: one buried convention that is expensive to
 * rediscover, a decoy package script, and a failing offset test used by the
 * cross-session resume scenario.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const target = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '.bench-work', 'workspace'))

function write(relative, content) {
  const path = join(target, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

const filler = (title, body) => `# ${title}

${body}

## Ownership

Owned by the platform team. Changes need one review from the build or release
rotation. Historical context lives in the design notes, not in this file.

## Checklist

1. Confirm the change is scoped to this component.
2. Run the checks named in the overview.
3. Report the outcome in the pull request description.
`

write('README.md', `# bench-target

A small service used to measure cross-session memory.

Documentation lives in \`docs/\`. The package scripts are convenience wrappers
around \`scripts/\`; they do not cover every supported mode.
`)

write('package.json', JSON.stringify({
  name: 'bench-target',
  private: true,
  version: '0.3.1',
  type: 'module',
  scripts: {
    test: 'node scripts/test.mjs --suite=unit',
    build: 'node scripts/build.mjs',
  },
}, null, 2) + '\n')

for (let index = 0; index < 10; index += 1) {
  const number = String(index).padStart(2, '0')
  write(`docs/${number}-${['architecture', 'release', 'storage', 'scheduling', 'errors', 'telemetry', 'testing', 'security', 'performance', 'glossary'][index]}.md`,
    filler(
      `${number} ${['Architecture', 'Release process', 'Storage', 'Scheduling', 'Error taxonomy', 'Telemetry', 'Testing', 'Security', 'Performance', 'Glossary'][index]}`,
      index === 6
        ? 'The full suite runs with `node scripts/test.mjs --suite=all`. Slow fixtures are skipped unless `MEMBENCH_SLOW=1` is set; CI sets it. The unit-only suite is a subset and never exercises the checkpoint coordinator.'
        : 'This document describes a component that is unrelated to the test command. It exists to make a naive directory scan expensive.',
    ))
}

write('scripts/test.mjs', `const args = process.argv.slice(2)
const suite = args.find(value => value.startsWith('--suite='))?.split('=')[1] ?? 'unit'
const slow = process.env.MEMBENCH_SLOW === '1'
console.log(JSON.stringify({ suite, slow }, null, 2))
`)

write('scripts/build.mjs', `console.log('build: ok')
`)

write('src/offset.js', `/** Offset bookkeeping for the parallel importer. */
export function nextOffset(completed) {
  let highest = 0
  for (const value of completed) if (value > highest) highest = value
  return highest + 1
}
`)

write('test/offset.test.mjs', `import assert from 'node:assert/strict'
import { nextOffset } from '../src/offset.js'

// The contract: a checkpoint may advance only across a contiguous prefix of
// durably completed offsets. A gap must stop the advance.
assert.equal(nextOffset([0, 1, 2]), 3)
assert.equal(nextOffset([0, 1, 3]), 2, 'offset 2 is missing, so the checkpoint must stop at 2')
console.log('offset tests passed')
`)

write('docs/offset-contract.md', `# Offset contract

A checkpoint may advance only across a contiguous prefix of durably completed
offsets. \`src/offset.js\` implements the advance; \`test/offset.test.mjs\` is the
regression that encodes the contract.
`)

console.log(`benchmark workspace: ${target}`)
