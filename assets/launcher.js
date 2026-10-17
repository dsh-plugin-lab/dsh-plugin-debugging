// dsh-plugin-debugging - relaunch launcher.
//
// Runs AFTER the old host has exited (or is about to). It is started by the task
// scheduler through `launcher.vbs`, which exists only because `wscript.exe` is a
// GUI-subsystem binary: a task that runs `node.exe` directly gets a visible console
// window, and hiding that window is the whole reason the VBS shim survives.
//
// Why the task scheduler at all (measured 2026-10-17): the host runs inside a Windows
// Job Object, and children inherit job membership. A detached child therefore dies with
// the host when the job is closed. A task is started by the scheduler service, not by
// the host, so it is outside that job and can outlive it.
//
// Everything here is plain Node so it can be unit tested; the VBS shim holds no logic.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

/** Reads the `key=value` job file the tool writes before scheduling the task. */
export function parseJobFile(text) {
  const job = {}
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    job[line.slice(0, at)] = line.slice(at + 1)
  }
  return job
}

/** Appends one timestamped line to a log file; never throws (this runs unattended). */
export function say(logPath, message) {
  try {
    appendFileSync(logPath, `${new Date().toISOString()}  ${message}\r\n`, 'utf8')
  } catch {
    // A launcher that cannot log still has to try to relaunch; losing the trace is worse
    // than losing the run, but refusing to run is worst of all.
  }
}

/**
 * Waits for a pid to disappear, polling instead of sleeping a fixed time.
 *
 * Polling rather than a fixed delay is what makes the common path fast: the old host
 * usually exits within a second, so the wait is ~150 ms instead of the full budget.
 *
 * Known limit (deliberate, direction-safe): this only asks "is there a process with this
 * id". If the id is recycled the wait continues until the cap and then launches anyway -
 * that is slower, never "refuses to launch".
 */
export async function waitForExit(pid, capMs, isAlive, sleep) {
  let waited = 0
  const step = 150
  while (waited < capMs) {
    if (!isAlive(pid)) return { gone: true, waited }
    await sleep(step)
    waited += step
  }
  return { gone: !isAlive(pid), waited }
}

/** Default liveness probe: does a process with this id still exist? */
export function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * Starts the new host with no console window and a `DSH_HOME` of our choosing.
 *
 * `windowsHide` maps to CREATE_NO_WINDOW for a console program, so the child gets no
 * console at all - which is what lets the old `cmd /c set ... && cd /d ... & node ...`
 * pipeline (and its quoting rules) go away entirely.
 */
export function startHost(job, spawnImpl = spawn) {
  const args = job.args === undefined || job.args === '' ? [] : JSON.parse(job.args)
  const child = spawnImpl(job.command, args, {
    cwd: job.cwd === undefined || job.cwd === '' ? undefined : job.cwd,
    env: { ...process.env, DSH_HOME: job.dshHome, DSH_DEBUG_WINDOWLESS: '1' },
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  child.unref()
  return child
}

/**
 * Makes sure exactly one stop window exists for this port.
 *
 * Creates nothing itself when the recorded window process is still alive, which is what
 * keeps N restarts at one window rather than N.
 *
 * Two hops, both unavoidable (measured 2026-10-17):
 * 1. `wscript show-window.vbs "<job file>"` - Node cannot request a NEW VISIBLE console:
 *    `detached` means DETACHED_PROCESS (no console at all) and a plain child inherits
 *    this process's hidden console. The VBS hop is the only way to get one.
 * 2. PowerShell runs the static stop-window script, which holds the job handle.
 *
 * CAUTION: only a PATH is passed to the VBS hop, never the command line: Node escapes `"` as
 * `\"` inside arguments and wscript does not undo it, so a quoted command arrives
 * corrupted and `Shell.Run` fails silently - the symptom is simply "no window".
 */
export function ensureStopWindow(job, isAlive, spawnImpl = spawn, deps = {}) {
  const readPid = deps.readPid ?? readPidFile
  const recorded = readPid(job.stopWindowPid)
  if (recorded !== 0 && isAlive(recorded)) {
    return { launched: false, existing: recorded }
  }
  spawnImpl(job.wscript, [job.showWindow, job.job], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  return { launched: true, existing: 0 }
}

/** Reads a pid file, returning 0 when it is missing or unreadable. */
export function readPidFile(path) {
  try {
    if (!existsSync(path)) return 0
    const text = readFileSync(path, 'utf8').trim()
    const value = Number(text)
    return Number.isInteger(value) && value > 0 ? value : 0
  } catch {
    return 0
  }
}

/**
 * Runs the whole relaunch ritual: wait, start the host, ensure the stop window.
 *
 * @param job the parsed job file.
 * @param deps injectable side effects (tests pass recording doubles).
 */
export async function runLauncher(job, deps = {}) {
  const isAlive = deps.isAlive ?? defaultIsAlive
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const spawnImpl = deps.spawn ?? spawn
  const sayImpl = deps.say ?? say
  const readPid = deps.readPid ?? readPidFile
  const capMs = Number(job.capMs ?? 0)

  sayImpl(job.log, `launcher started; waiting up to ${String(capMs)} ms for pid ${job.oldPid}`)
  const waited = await waitForExit(Number(job.oldPid), capMs, isAlive, sleep)
  sayImpl(
    job.log,
    waited.gone
      ? `pid ${job.oldPid} gone after ${String(waited.waited)} ms`
      : `pid ${job.oldPid} still alive after ${String(capMs)} ms; launching anyway`,
  )

  try {
    const child = startHost(job, spawnImpl)
    sayImpl(job.log, `launched hidden (pid ${String(child.pid ?? 'unknown')})`)
  } catch (error) {
    sayImpl(job.log, `LAUNCH FAILED: ${error?.message ?? String(error)}`)
    return { launched: false }
  }

  const window = ensureStopWindow(job, isAlive, spawnImpl, { readPid })
  sayImpl(
    job.log,
    window.launched
      ? `stop window launched on port ${job.stopWindowPort}`
      : `stop window already up (pid ${String(window.existing)}); created no window`,
  )
  return { launched: true, stopWindow: window }
}

// Only run when executed directly, not when imported by a test.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const jobPath = process.argv[2]
  const job = parseJobFile(readFileSync(jobPath, 'utf8'))
  await runLauncher(job)
}
