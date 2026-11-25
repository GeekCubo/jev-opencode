// Process-safe shared accounting file. All plugin instances (any project, any process of the same user)
// serialise read-modify-write through an exclusive lock file (O_EXCL create), so updates are never lost.
// Holds numbers only: spend, reservations, per-session counters and per-session mode overrides.
// Never conversation content, credentials or tool output.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface Reservation {
  usd: number
  day: string
  sessionID: string
  pid: number
  /** Epoch ms; reservations older than `reservationTtlMs` are treated as abandoned and dropped. */
  at: number
}

export interface SessionRecord {
  spentUSD: number
  /** Numeric per-session statistics (see Counters) plus lastEvaluationAt / resets. */
  counters: Record<string, number>
  lastEvaluationAt?: number
  resets?: number
  /** Persistent per-session mode override; absent = inherit the global mode. */
  override?: "off" | "dry-run" | "active"
  /** Epoch ms of last update, for pruning old sessions. */
  updatedAt: number
}

export interface LedgerData {
  version: 1
  days: Record<string, number>
  sessions: Record<string, SessionRecord>
  reservations: Record<string, Reservation>
  /** Global counters (all sessions). */
  counters: Record<string, number>
}

const empty = (): LedgerData => ({ version: 1, days: {}, sessions: {}, reservations: {}, counters: {} })

export interface FileLedgerOptions {
  path: string
  lockTimeoutMs?: number
  /** Lock files older than this are considered abandoned (holder crashed). */
  staleLockMs?: number
  reservationTtlMs?: number
  /** Sessions not updated for this long are pruned from the file. */
  sessionRetentionMs?: number
  now?: () => number
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export class FileLedger {
  readonly path: string
  private lockPath: string
  private opts: Required<Omit<FileLedgerOptions, "path">>

  constructor(options: FileLedgerOptions) {
    this.path = options.path
    this.lockPath = `${options.path}.lock`
    this.opts = {
      lockTimeoutMs: options.lockTimeoutMs ?? 5_000,
      staleLockMs: options.staleLockMs ?? 30_000,
      reservationTtlMs: options.reservationTtlMs ?? 10 * 60_000,
      sessionRetentionMs: options.sessionRetentionMs ?? 90 * 86_400_000,
      now: options.now ?? Date.now,
    }
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
  }

  private acquire(): number {
    // Lock timing always uses the real clock (file mtimes are real time; an injected clock may not advance).
    const deadline = Date.now() + this.opts.lockTimeoutMs
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(this.lockPath, "wx", 0o600)
        writeFileSync(fd, String(process.pid))
        return fd
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > this.opts.staleLockMs) rmSync(this.lockPath, { force: true })
        } catch {}
        if (Date.now() > deadline) throw new Error("accounting lock timeout")
        sleepSync(Math.min(2 + attempt, 25))
      }
    }
  }

  private release(fd: number) {
    try {
      closeSync(fd)
    } finally {
      rmSync(this.lockPath, { force: true })
    }
  }

  private load(): LedgerData {
    try {
      const data = JSON.parse(readFileSync(this.path, "utf8")) as LedgerData
      return data?.version === 1 ? { ...empty(), ...data } : empty()
    } catch {
      return empty()
    }
  }

  private save(data: LedgerData) {
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    renameSync(tmp, this.path)
  }

  private housekeep(data: LedgerData) {
    const now = this.opts.now()
    for (const [id, r] of Object.entries(data.reservations)) if (now - r.at > this.opts.reservationTtlMs) delete data.reservations[id]
    for (const [id, s] of Object.entries(data.sessions)) if (now - s.updatedAt > this.opts.sessionRetentionMs && !s.override) delete data.sessions[id]
    const days = Object.keys(data.days).sort()
    for (const d of days.slice(0, Math.max(0, days.length - 60))) delete data.days[d]
  }

  /** Read-only snapshot (consistent: taken under the lock). */
  read(): LedgerData {
    const fd = this.acquire()
    try {
      return this.load()
    } finally {
      this.release(fd)
    }
  }

  /** Atomic read-modify-write. */
  update<T>(fn: (data: LedgerData) => T): T {
    const fd = this.acquire()
    try {
      const data = this.load()
      this.housekeep(data)
      const result = fn(data)
      this.save(data)
      return result
    } finally {
      this.release(fd)
    }
  }
}

export const session = (data: LedgerData, id: string, now: number): SessionRecord =>
  (data.sessions[id] ??= { spentUSD: 0, counters: {}, updatedAt: now })

export const reservedFor = (data: LedgerData, pred: (r: Reservation) => boolean) =>
  Object.values(data.reservations).reduce((a, r) => (pred(r) ? a + r.usd : a), 0)
