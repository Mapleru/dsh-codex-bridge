import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { buildArgs, classifyStderr, OUT_FILE } from '../lib/codex-cli.js'

test('buildArgs always disables the daemon, pins the sandbox and reads the prompt from stdin', () => {
  const args = buildArgs({ cwd: 'C:/work/collab', outFile: 'C:/work/collab/mailbox/out/a.jsonl' })
  assert.deepEqual(args, [
    '--no-daemon',
    '-s',
    'workspace-write',
    '-C',
    'C:/work/collab',
    'exec',
    '--skip-git-repo-check',
    '--json',
    '-o',
    'C:/work/collab/mailbox/out/a.jsonl',
    '-',
  ])
})

test('buildArgs resumes a known thread and never uses --last or --ephemeral', () => {
  const args = buildArgs({
    sessionId: '99999999-8888-4777-8666-555555555555',
    cwd: '/tmp/collab',
    outFile: '/tmp/collab/out/b.jsonl',
    model: 'test-model',
  })
  const resumeAt = args.indexOf('resume')
  assert.ok(resumeAt > args.indexOf('exec'))
  assert.equal(args[resumeAt + 1], '99999999-8888-4777-8666-555555555555')
  assert.equal(args.includes('--last'), false)
  assert.equal(args.includes('--ephemeral'), false)
  assert.equal(args.includes('dangerously-bypass-approvals-and-sandbox'), false)
  assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'test-model'])
  assert.equal(args.at(-1), '-')
})

test('classifyStderr turns known CLI failures into stable codes', () => {
  const cases = [
    ['Error: thread/resume: thread/resume failed: no rollout found for thread id x', 'codex:session-lost'],
    ['Please run codex login first', 'codex:auth-required'],
    ['approval required for this command', 'codex:approval-required'],
    ['No prompt provided via stdin.', 'codex:empty-prompt'],
    ['Not inside a trusted directory and --skip-git-repo-check was not specified.', 'codex:untrusted-directory'],
  ]
  for (const [stderr, code] of cases) {
    assert.equal(classifyStderr(stderr), code, stderr)
  }
  assert.equal(classifyStderr('some unrelated noise'), 'codex:failed')
  assert.equal(classifyStderr(''), 'codex:failed')
})

test('each call gets its own output file path', () => {
  const root = path.join('C:', 'collab', 'mailbox')
  const first = OUT_FILE(root, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  const second = OUT_FILE(root, 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff')
  assert.notEqual(first, second)
  assert.equal(first, path.join(root, 'out', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl'))
})
