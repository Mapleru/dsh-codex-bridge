import { spawn } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'

const DEFAULT_TIMEOUT_MS = 900000
const DEFAULT_MAX_REPLY_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_STDERR_BYTES = 16384

/**
 * Terminate exactly the process tree rooted at `pid`. Windows uses
 * taskkill /F /T /PID; other platforms kill the process group created by the
 * detached spawn. Never matches by image name.
 */
export function killTree(pid, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve({ killed: false, reason: 'invalid-pid' })

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let settled = false
      const child = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve({ killed: true, taskkill: false, timedOut: true })
      }, timeoutMs)
      timer.unref?.()
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      child.on('error', (error) => finish({ killed: false, error: error.code ?? 'taskkill-failed' }))
      child.on('close', (code) => finish({ killed: code === 0, taskkill: true, code }))
    })
  }

  try {
    process.kill(-pid, 'SIGKILL')
    return Promise.resolve({ killed: true, group: true })
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
      return Promise.resolve({ killed: true, group: false })
    } catch (error) {
      return Promise.resolve({ killed: false, error: error.code ?? 'kill-failed' })
    }
  }
}

function classifyStderr(text) {
  const value = String(text ?? '')
  // Another process (the desktop app) owns the thread. This is not a lost
  // thread: the queue transport can still add a turn to it.
  if (/already has an active writer|thread-store conflict/i.test(value)) return 'codex:session-busy'
  if (/no rollout found|thread\/resume failed/i.test(value)) return 'codex:session-lost'
  if (/not logged in|please log in|login required|run codex login|unauthorized|authentication|401/i.test(value)) return 'codex:auth-required'
  if (/approval|ask-for-approval|sandbox denied|permission denied/i.test(value)) return 'codex:approval-required'
  if (/no prompt provided via stdin/i.test(value)) return 'codex:empty-prompt'
  if (/not inside a trusted directory/i.test(value)) return 'codex:untrusted-directory'
  if (/enoent|not found|no such file/i.test(value)) return 'codex:not-found'
  if (/timed out|timeout/i.test(value)) return 'codex:timeout-reported'
  return 'codex:failed'
}

/**
 * Fixed argument order verified against codex-cli 0.166.0-alpha.6 help output.
 * --no-daemon keeps this call's work in this process tree so cancellation owns
 * it. No approval bypass flags are ever added.
 */
export function buildArgs({ sessionId = null, cwd, outFile, model = '', sandbox = 'workspace-write' }) {
  const args = ['--no-daemon', '-s', sandbox, '-C', cwd]
  if (model) args.push('-m', model)
  args.push('exec')
  if (sessionId) args.push('resume', sessionId)
  args.push('--skip-git-repo-check', '--json', '-o', outFile, '-')
  return args
}

/**
 * Run one Codex invocation asynchronously and parse its JSONL event stream.
 *
 * Success requires a parsed turn.completed event AND a fresh, non-empty
 * output-last-message file: exit code 0 alone is not evidence (verified: an
 * empty stdin and a failed resume both exit 0).
 */
export async function runCodex(options) {
  const {
    executable,
    args,
    cwd,
    stdinText,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal,
    outFile,
    maxReplyBytes = DEFAULT_MAX_REPLY_BYTES,
    maxLineBytes = DEFAULT_MAX_LINE_BYTES,
    maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
    kill = killTree,
    onSpawn,
  } = options

  const startedAt = Date.now()
  const events = []
  let stdoutBuffer = ''
  let stderrText = ''
  let sessionId = null
  let completed = false
  let turnFailed = false
  let sawAnyEvent = false
  let parseErrors = 0
  let stdoutOverflow = 0
  let lastAgentText = ''
  let timedOut = false
  let aborted = Boolean(signal?.aborted)
  let child = null
  let hardTimer = null

  await fsp.rm(outFile, { force: true }).catch(() => {})

  if (aborted) {
    return {
      ok: false,
      aborted: true,
      timedOut: false,
      completed: false,
      turnFailed: false,
      sessionId: null,
      replyText: '',
      replyBytes: 0,
      events: 0,
      parseErrors: 0,
      errorCode: 'codex:aborted',
      sawAnyEvent: false,
      durationMs: 0,
    }
  }

  return new Promise((resolve) => {
    try {
      child = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (error) {
      resolve({
        ok: false,
        aborted,
        timedOut,
        completed,
        turnFailed,
        sessionId,
        replyText: '',
        replyBytes: 0,
        events: 0,
        parseErrors,
        errorCode: 'codex:spawn-failed',
        spawnErrorCode: error.code ?? null,
        sawAnyEvent,
        durationMs: Date.now() - startedAt,
      })
      return
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      void kill(child?.pid, { timeoutMs: 5000 })
    }, Math.max(1000, timeoutMs))
    timeoutTimer.unref?.()

    try {
      onSpawn?.(child.pid)
    } catch {
      /* observer must not break the run */
    }

    const onAbort = () => {
      aborted = true
      void kill(child?.pid, { timeoutMs: 5000 })
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')

    const handleEvent = (value) => {
      sawAnyEvent = true
      if (events.length < 500) events.push(value.type ?? 'unknown')
      if (value.type === 'thread.started' && typeof value.thread_id === 'string') sessionId = value.thread_id
      if (value.type === 'turn.completed') completed = true
      if (value.type === 'turn.failed' || value.type === 'error') turnFailed = true
      if (value.type === 'item.completed' && value.item && typeof value.item === 'object') {
        if (value.item.type === 'agent_message' && typeof value.item.text === 'string') lastAgentText = value.item.text
      }
    }

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      let newline = stdoutBuffer.indexOf('\n')
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim()
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        if (line) {
          try {
            handleEvent(JSON.parse(line))
          } catch {
            parseErrors += 1
          }
        }
        newline = stdoutBuffer.indexOf('\n')
      }
      if (stdoutBuffer.length > maxLineBytes) {
        stdoutBuffer = ''
        stdoutOverflow += 1
        parseErrors += 1
      }
    })

    child.stderr.on('data', (chunk) => {
      if (stderrText.length >= maxStderrBytes) return
      stderrText += chunk
      if (stderrText.length > maxStderrBytes) stderrText = stderrText.slice(0, maxStderrBytes)
    })

    child.stdin.on('error', () => {
      /* EPIPE when the child exits before reading; the close handler decides */
    })
    try {
      child.stdin.end(stdinText)
    } catch {
      /* ignore */
    }

    let finalized = false
    const finalize = async (extra = {}) => {
      if (finalized) return
      finalized = true
      clearTimeout(timeoutTimer)
      if (hardTimer) clearTimeout(hardTimer)
      if (signal) signal.removeEventListener('abort', onAbort)

      let replyText = ''
      let replyBytes = 0
      let replyTooLarge = false
      try {
        const stat = await fsp.stat(outFile)
        replyBytes = stat.size
        if (stat.size > maxReplyBytes) {
          replyTooLarge = true
        } else {
          replyText = await fsp.readFile(outFile, 'utf8')
          replyText = replyText.replace(/\r?\n$/, '')
        }
      } catch {
        /* no output file */
      }
      if (!replyText && lastAgentText) replyText = lastAgentText

      let errorCode = null
      if (aborted) errorCode = 'codex:aborted'
      else if (timedOut || extra.stillRunning) errorCode = 'codex:timeout'
      else if (turnFailed) errorCode = 'codex:turn-failed'
      else if (replyTooLarge) errorCode = 'codex:reply-too-large'
      else if (!completed) errorCode = sawAnyEvent ? 'codex:incomplete' : classifyStderr(stderrText)
      else if (!replyText) errorCode = 'codex:empty-reply'

      resolve({
        ok: completed && replyText.length > 0 && !aborted && !timedOut && !turnFailed && !replyTooLarge,
        aborted,
        timedOut: timedOut || Boolean(extra.stillRunning),
        completed,
        turnFailed,
        sessionId,
        replyText,
        replyBytes,
        replyTooLarge,
        events: events.length,
        parseErrors,
        stdoutOverflow,
        errorCode,
        stderrHint: stderrText ? classifyStderr(stderrText) : null,
        sawAnyEvent,
        exitCode: extra.exitCode ?? null,
        exitSignal: extra.exitSignal ?? null,
        durationMs: Date.now() - startedAt,
      })
    }

    child.on('error', () => {
      void finalize({ exitCode: null })
    })

    child.on('close', (code, signalName) => {
      void finalize({ exitCode: code, exitSignal: signalName })
    })

    hardTimer = setTimeout(() => {
      void finalize({ stillRunning: true })
    }, Math.max(1000, timeoutMs) + 10000)
    hardTimer.unref?.()
  })
}

/**
 * Verify the executable exists and advertises the exact capabilities this
 * bridge relies on. Missing capabilities are reported, never guessed.
 */
export async function probeCodex(executable, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000
  const run = options.runCapture ?? runCapture
  const result = {
    executable,
    ok: false,
    version: null,
    capabilities: {
      noDaemon: false,
      exec: false,
      resume: false,
      json: false,
      outputLastMessage: false,
      skipGitRepoCheck: false,
      sandbox: false,
      stdinPrompt: false,
    },
    missing: [],
    error: null,
  }

  const stat = await fsp.stat(executable).catch(() => null)
  if (!stat || !stat.isFile()) {
    result.error = 'codex:not-a-file'
    return result
  }

  const version = await run(executable, ['--version'], { timeoutMs })
  if (!version.ok) {
    result.error = version.timedOut ? 'codex:probe-timeout' : 'codex:probe-failed'
    return result
  }
  const match = /codex-cli\s+([0-9A-Za-z.+-]+)/.exec(version.stdout)
  result.version = match ? match[1] : version.stdout.trim() || null

  const top = await run(executable, ['--help'], { timeoutMs })
  const execHelp = await run(executable, ['exec', '--help'], { timeoutMs })
  const resumeHelp = await run(executable, ['exec', 'resume', '--help'], { timeoutMs })
  if (!top.ok || !execHelp.ok) {
    result.error = 'codex:help-failed'
    return result
  }

  const topText = top.stdout
  const execText = execHelp.stdout
  const resumeText = resumeHelp.ok ? resumeHelp.stdout : ''

  result.capabilities = {
    noDaemon: /--no-daemon\b/.test(topText),
    exec: /(^|\s)exec(\s|$)/m.test(topText),
    resume: /Usage:\s+codex\s+exec\s+resume/.test(resumeText),
    json: /--json\b/.test(execText),
    outputLastMessage: /--output-last-message\b/.test(execText),
    skipGitRepoCheck: /--skip-git-repo-check\b/.test(execText),
    sandbox: /--sandbox\b/.test(topText) && /--sandbox\b/.test(execText),
    stdinPrompt: /stdin/i.test(execText),
  }

  const missing = Object.entries(result.capabilities)
    .filter(([, present]) => !present)
    .map(([name]) => name)
  result.missing = missing
  result.ok = missing.length === 0
  if (!result.ok) result.error = 'codex:missing-capabilities'
  return result
}

function runCapture(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000
  const maxBytes = options.maxBytes ?? 1024 * 1024
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let child
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', timedOut: false, errorCode: error.code ?? 'spawn-failed' })
      return
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void killTree(child.pid)
      resolve({ ok: false, stdout, stderr, timedOut: true, errorCode: 'timeout' })
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < maxBytes) stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < maxBytes) stderr += chunk
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr, timedOut: false, errorCode: error.code ?? 'spawn-failed' })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr, timedOut: false, errorCode: code === 0 ? null : `exit-${code}` })
    })
  })
}

export { runCapture, classifyStderr }
export const OUT_FILE = (root, id) => path.join(root, 'out', `${id}.jsonl`)
