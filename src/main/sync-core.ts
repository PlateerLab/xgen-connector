/**
 * sync-core — the pure reconcile engine of the workspace sync.
 *
 * Google-Drive model, star topology: the server workspace is the
 * authoritative hub, this replica converges toward it while pushing its
 * own edits. Everything here is dependency-injected (transport + local
 * fs + index store) so the whole convergence logic is unit-testable in
 * plain Node with fake replicas.
 *
 * Invariants:
 *  - `index.entries[path].lastSyncedSha` is the 3-way merge BASE: the
 *    content this replica and the server last agreed on.
 *  - Conflicts NEVER lose data: the server version keeps the path, the
 *    local version is preserved as "name (충돌-<device> <ts>).ext" and
 *    uploaded too.
 *  - Edit beats delete, in both directions.
 *  - A mass local deletion (server-side wipe propagating down) trips a
 *    safety valve and pauses the pair until the user confirms.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RemoteChange {
  path: string
  is_dir: boolean
  size: number
  mtime_ns: number
  sha256: string
  seq: number
  deleted: boolean
}

export interface ChangesResponse {
  latest_seq: number
  changes: RemoteChange[]
  max_file_bytes?: number
  /** Server signal: this cursor predates pruned tombstones / an index
   *  rebuild — deltas would silently miss deletions; re-bootstrap. */
  stale_cursor?: boolean
}

export interface Transport {
  changes(since: number): Promise<ChangesResponse>
  /** Download workspace-relative path into the local absolute file. */
  download(path: string, toAbs: string): Promise<void>
  /** PUT exact path. Returns new sha; throws SyncConflictError on 409. */
  put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }>
  del(path: string, baseSha?: string): Promise<void>
  mkdir(path: string): Promise<void>
}

export class SyncConflictError extends Error {
  currentSha?: string
  constructor(currentSha?: string) {
    super('sync conflict')
    this.currentSha = currentSha
  }
}

export interface LocalStat {
  isDir: boolean
  size: number
  mtimeMs: number
}

export interface LocalFs {
  /** Full scan of the replica root → workspace-relative path map.
   *  Must already exclude ignored paths and symlinks. */
  scan(): Promise<Map<string, LocalStat>>
  hash(path: string): Promise<string>
  absPath(path: string): string
  removeFile(path: string): Promise<void>
  removeDirIfEmpty(path: string): Promise<boolean>
  mkdir(path: string): Promise<void>
  /** Rename `path` to a conflict-preserving sibling; returns its rel path. */
  renameToConflict(path: string, deviceName: string): Promise<string>
  stat(path: string): Promise<LocalStat | null>
  /** Guarded atomic apply of a downloaded temp file: place tmpRel at
   *  `path` ONLY IF the path still matches `expected` (the stat captured
   *  at scan time; null = must not exist). Returns false — and drops the
   *  temp — when the user touched the file mid-round, so a fresh local
   *  edit is never clobbered by a stale download. */
  finalizeDownload(tmpRel: string, path: string, expected: LocalStat | null): Promise<boolean>
  /** True on case-insensitive filesystems (Windows/macOS default) —
   *  lets the engine skip case-colliding server paths instead of
   *  flip-flopping one local file between two server entries. */
  isCaseInsensitive?(): Promise<boolean>
  /** Client-side ignore predicate (same rules the scan applies). The
   *  engine filters REMOTE paths through it too, so ignore-asymmetry
   *  can never delete agent-side files the client simply doesn't scan. */
  isIgnored?(path: string): boolean
}

export interface IndexEntry {
  isDir: boolean
  size: number
  mtimeMs: number
  sha: string // local content sha at last sync
  lastSyncedSha: string // merge base ('' for dirs)
}

export interface SyncIndex {
  cursor: number
  entries: Record<string, IndexEntry>
}

export interface SyncStats {
  downloaded: number
  uploaded: number
  deletedLocal: number
  deletedRemote: number
  conflicts: number
  skippedLarge: number
  /** Actions postponed because the local file moved mid-round (fresh
   *  edits are never clobbered — the next round resolves them). */
  deferred: number
  errors: string[]
}

export interface SyncOptions {
  deviceName: string
  maxFileBytes: number
  /** Files modified more recently than this are left for the next round
   *  (they may still be mid-write). */
  stabilityMs: number
  now?: () => number
  /** Mass-delete valve: called when the plan wants to delete this many
   *  local entries at once; return false to abort the whole round. */
  confirmMassDelete?: (count: number, total: number) => Promise<boolean>
}

export class MassDeletePending extends Error {
  count: number
  total: number
  constructor(count: number, total: number) {
    super('mass delete requires confirmation')
    this.count = count
    this.total = total
  }
}

const MASS_DELETE_MIN = 50
const MASS_DELETE_RATIO = 0.3

/** One full convergence round. Mutates and returns `index`. */
export async function syncOnce(
  transport: Transport,
  fs: LocalFs,
  index: SyncIndex,
  opts: SyncOptions,
): Promise<{ index: SyncIndex; stats: SyncStats }> {
  const stats: SyncStats = {
    downloaded: 0, uploaded: 0, deletedLocal: 0, deletedRemote: 0,
    conflicts: 0, skippedLarge: 0, deferred: 0, errors: [],
  }
  const now = opts.now ?? (() => Date.now())

  // ── 1. gather both sides ────────────────────────────────────────────
  let isBootstrap = index.cursor <= 0
  let remote = await transport.changes(index.cursor)
  if (remote.latest_seq < index.cursor || remote.stale_cursor) {
    // The server's journal restarted (index rebuilt / session recreated)
    // or tombstones our cursor never saw were pruned: deltas can no
    // longer converge. Re-bootstrap — the snapshot becomes authoritative
    // (including deletions of snapshot-absent tracked paths, below).
    index.cursor = 0
    isBootstrap = true
    remote = await transport.changes(0)
  }
  const maxBytes = remote.max_file_bytes && remote.max_file_bytes > 0
    ? Math.min(remote.max_file_bytes, opts.maxFileBytes)
    : opts.maxFileBytes
  const remoteByPath = new Map<string, RemoteChange>()
  for (const c of remote.changes) remoteByPath.set(c.path, c) // later seq wins (ordered)

  // Case-insensitive filesystems can hold only ONE of "A.txt"/"a.txt".
  // Keep the first server path per casefold key; skip the rest loudly —
  // otherwise a single local file flip-flops between two server entries.
  if ((await fs.isCaseInsensitive?.()) ?? false) {
    const seen = new Map<string, string>()
    for (const [p, c] of [...remoteByPath]) {
      if (c.deleted) continue
      const key = p.toLowerCase()
      const first = seen.get(key)
      if (first === undefined) {
        seen.set(key, p)
      } else if (first !== p) {
        remoteByPath.delete(p)
        stats.errors.push(`case-collision skipped: ${p} (vs ${first})`)
      }
    }
  }

  // Client-side ignore filter on REMOTE paths: agent-side build junk
  // (.gradle, *.class …) that the client would never scan must not be
  // downloaded — and, critically, must never be REMOTE-DELETED because
  // the next scan doesn't see it (ignore-asymmetry destruction).
  if (fs.isIgnored) {
    for (const p of [...remoteByPath.keys()]) {
      if (fs.isIgnored(p)) remoteByPath.delete(p)
    }
  }

  const local = await fs.scan()

  // Fail-closed replica check: an EMPTY scan while the index tracks a
  // real tree means the folder is unavailable (unmounted share, renamed
  // root, transient FS error) — treating it as "user deleted everything"
  // would wipe the server workspace. Abort the round instead.
  if (local.size === 0 && Object.keys(index.entries).length > 5) {
    throw new Error('replica folder unavailable (empty scan over a tracked tree) — sync round aborted')
  }

  // Local content shas: hash only entries whose (size, mtimeMs) moved
  // vs the index — same shortcut the server uses.
  const localSha = new Map<string, string>()
  for (const [p, st] of local) {
    if (st.isDir) continue
    const known = index.entries[p]
    const age = now() - st.mtimeMs
    if (known && !known.isDir && known.size === st.size && known.mtimeMs === st.mtimeMs) {
      // Unchanged since last sync — sha known, no deferral needed (a
      // just-downloaded file has a fresh mtime but IS stable).
      localSha.set(p, known.sha)
    } else if (age >= 0 && age < opts.stabilityMs) {
      continue // genuinely fresh unknown write — may be mid-write, defer
      // (future mtimes — zip extraction, clock skew — count as stable)
    } else {
      try {
        localSha.set(p, await fs.hash(p))
      } catch {
        /* vanished mid-scan — treat as absent */
      }
    }
  }

  // ── 2. build the union of paths that may need action ────────────────
  const paths = new Set<string>([
    ...remoteByPath.keys(),
    ...local.keys(),
    ...Object.keys(index.entries),
  ])

  type Action =
    | { kind: 'download'; path: string; sha: string; isDir: boolean; expected: LocalStat | null }
    | { kind: 'deleteLocal'; path: string; isDir: boolean; expected: LocalStat | null }
    | { kind: 'upload'; path: string; baseSha: string; st: LocalStat | null }
    | { kind: 'deleteRemote'; path: string; baseSha: string; isDir: boolean; expected: LocalStat | null }
    | { kind: 'mkdirRemote'; path: string }
    | { kind: 'conflict'; path: string; serverSha: string }
    | { kind: 'dirOverFile'; path: string } // server dir now occupies a local file's path
    | { kind: 'fileOverDir'; path: string; sha: string } // server file now occupies a local dir's path
    | { kind: 'settle'; path: string; sha: string; st: LocalStat | null } // both ended up identical

  const plan: Action[] = []

  // Cursor holdback: a server change whose action FAILED or was deferred
  // must not be skipped past — otherwise the change is missed forever
  // (it never reappears in a later delta). Policy skips (too-large,
  // case-collision) deliberately advance.
  let minUnappliedSeq = Infinity
  const holdBack = (p: string): void => {
    const c = remoteByPath.get(p)
    if (c) minUnappliedSeq = Math.min(minUnappliedSeq, c.seq)
  }

  for (const p of paths) {
    // Locally-ignored path: never sync it in either direction; drop any
    // stale index entry so it can't masquerade as a local deletion.
    if (fs.isIgnored?.(p)) {
      delete index.entries[p]
      continue
    }
    const rc = remoteByPath.get(p)
    const st = local.get(p) ?? null
    const idx = index.entries[p]
    const base = idx?.lastSyncedSha ?? ''

    // Deferred unstable file: pretend we didn't look at it this round —
    // but hold the cursor if the server changed it, so the change is
    // redelivered once the file settles.
    if (st && !st.isDir && !localSha.has(p)) {
      stats.deferred += 1
      holdBack(p)
      continue
    }

    const localExists = st !== null
    const lsha = st && !st.isDir ? (localSha.get(p) as string) : ''

    // What does the server say? (only for paths in the delta)
    const serverChanged = rc !== undefined && (
      rc.deleted ? idx !== undefined || localExists
                 : rc.sha256 !== base || rc.is_dir !== (idx?.isDir ?? rc.is_dir) || idx === undefined
    )
    const serverDeleted = rc?.deleted === true

    // What changed locally since the base?
    const localNew = localExists && idx === undefined
    const localDeleted = !localExists && idx !== undefined
    const localModified = localExists && idx !== undefined && !st!.isDir && lsha !== base
    const localChanged = localNew || localDeleted || localModified

    if (!serverChanged && !localChanged) {
      // Bootstrap authority: on a since=0 round the snapshot IS the
      // server state — a tracked path absent from it was deleted while
      // our cursor was invalid (pruned tombstones). Apply the deletion
      // (the mass-delete valve below still guards the blast radius).
      if (isBootstrap && idx !== undefined && rc === undefined) {
        if (localExists) {
          plan.push({ kind: 'deleteLocal', path: p, isDir: st!.isDir, expected: st })
        } else {
          delete index.entries[p]
        }
      }
      continue
    }

    // ── directories ───────────────────────────────────────────────────
    if ((rc?.is_dir ?? st?.isDir ?? idx?.isDir) === true) {
      if (rc && rc.is_dir && !serverDeleted && st && !st.isDir) {
        // Type clash: the server path became a DIRECTORY but a local
        // FILE occupies it. Preserve the file as a conflict copy, then
        // materialise the dir.
        plan.push({ kind: 'dirOverFile', path: p })
      } else if (serverChanged && !serverDeleted && !localExists) {
        plan.push({ kind: 'download', path: p, sha: '', isDir: true, expected: null }) // mkdir local
      } else if (serverDeleted && localExists && !localChanged) {
        plan.push({ kind: 'deleteLocal', path: p, isDir: true, expected: st })
      } else if (localNew && rc === undefined) {
        plan.push({ kind: 'mkdirRemote', path: p })
      } else if (localDeleted && !serverChanged) {
        plan.push({ kind: 'deleteRemote', path: p, baseSha: '', isDir: true, expected: null })
      } else if (serverDeleted && localDeleted) {
        delete index.entries[p]
      } else if (localExists && rc && !serverDeleted) {
        // both have the dir — just settle the index
        plan.push({ kind: 'settle', path: p, sha: '', st })
      }
      continue
    }

    // ── files ─────────────────────────────────────────────────────────
    if (rc && !rc.is_dir && !rc.deleted && st?.isDir) {
      // Type clash mirror: the server path became a FILE but a local
      // DIRECTORY occupies it. Preserve/clear the dir, then place the file.
      plan.push({ kind: 'fileOverDir', path: p, sha: rc.sha256 })
      continue
    }

    const tooLarge = (st && st.size > maxBytes) || (rc && !rc.deleted && rc.size > maxBytes)
    if (tooLarge) {
      stats.skippedLarge += 1
      continue
    }

    if (serverChanged && !localChanged) {
      if (serverDeleted) {
        if (localExists) plan.push({ kind: 'deleteLocal', path: p, isDir: false, expected: st })
        else delete index.entries[p]
      } else if (rc!.sha256 === lsha && localExists) {
        plan.push({ kind: 'settle', path: p, sha: lsha, st }) // converged already
      } else {
        plan.push({ kind: 'download', path: p, sha: rc!.sha256, isDir: false, expected: st })
      }
      continue
    }

    if (localChanged && !serverChanged) {
      if (localDeleted) {
        plan.push({ kind: 'deleteRemote', path: p, baseSha: base, isDir: false, expected: null })
      } else {
        plan.push({ kind: 'upload', path: p, baseSha: localNew ? '' : base, st })
      }
      continue
    }

    // both changed
    if (serverDeleted && localDeleted) {
      delete index.entries[p]
    } else if (serverDeleted && localExists) {
      // edit wins over delete → resurrect our version
      plan.push({ kind: 'upload', path: p, baseSha: base, st })
    } else if (localDeleted && !serverDeleted) {
      // server edited what we deleted → edit wins, bring it back
      plan.push({ kind: 'download', path: p, sha: rc!.sha256, isDir: false, expected: null })
    } else if (rc!.sha256 === lsha) {
      plan.push({ kind: 'settle', path: p, sha: lsha, st }) // identical edits
    } else {
      plan.push({ kind: 'conflict', path: p, serverSha: rc!.sha256 })
    }
  }

  // ── 3. mass-delete safety valve ─────────────────────────────────────
  // Guards BOTH directions: a server wipe propagating down (deleteLocal)
  // AND a broken/emptied replica propagating up (deleteRemote — the
  // hub-destroying direction). min(tracked, …) makes a full wipe of a
  // small workspace trip it too.
  const localDeletions = plan.filter((a) => a.kind === 'deleteLocal').length
  const remoteDeletions = plan.filter((a) => a.kind === 'deleteRemote').length
  const deletions = Math.max(localDeletions, remoteDeletions)
  const tracked = Object.keys(index.entries).length
  const threshold = Math.min(
    Math.max(tracked, 1),
    Math.max(MASS_DELETE_MIN, Math.ceil(tracked * MASS_DELETE_RATIO)),
  )
  if (tracked > 20 && deletions >= threshold) {
    const ok = opts.confirmMassDelete
      ? await opts.confirmMassDelete(deletions, tracked)
      : false
    if (!ok) throw new MassDeletePending(deletions, tracked)
  }

  // ── 4. execute — creates parent-first, deletes child-first ──────────
  const depth = (p: string): number => p.split('/').length
  const creations = plan.filter((a) => a.kind !== 'deleteLocal' && a.kind !== 'deleteRemote')
    .sort((a, b) => depth((a as any).path) - depth((b as any).path))
  const deletionActions = plan.filter((a) => a.kind === 'deleteLocal' || a.kind === 'deleteRemote')
    .sort((a, b) => depth((b as any).path) - depth((a as any).path))

  for (const action of [...creations, ...deletionActions]) {
    try {
      await applyAction(action, transport, fs, index, stats, opts, holdBack)
    } catch (e: any) {
      const tag = e?.status ? `[${e.status}] ` : ''
      stats.errors.push(`${(action as any).kind} ${(action as any).path}: ${tag}${e?.message ?? e}`)
      holdBack((action as any).path)
    }
  }

  // Failed/deferred server changes keep the cursor behind them so the
  // next round redelivers; clean rounds advance to the tip.
  index.cursor = minUnappliedSeq === Infinity
    ? remote.latest_seq
    : Math.min(remote.latest_seq, minUnappliedSeq - 1)
  return { index, stats }
}

async function applyAction(
  action: any,
  transport: Transport,
  fs: LocalFs,
  index: SyncIndex,
  stats: SyncStats,
  opts: SyncOptions,
  holdBack: (p: string) => void = () => {},
): Promise<void> {
  const p: string = action.path
  switch (action.kind) {
    case 'settle': {
      // Scan-time stat, NOT a fresh stat: pairing a post-edit stat with a
      // pre-edit sha would make the scan shortcut reuse the wrong sha
      // forever and the edit would never upload.
      const st = action.st as LocalStat | null
      index.entries[p] = {
        isDir: action.sha === '' && (st?.isDir ?? false),
        size: st?.size ?? 0,
        mtimeMs: st?.mtimeMs ?? 0,
        sha: action.sha,
        lastSyncedSha: action.sha,
      }
      break
    }
    case 'download': {
      if (action.isDir) {
        await fs.mkdir(p)
        index.entries[p] = { isDir: true, size: 0, mtimeMs: 0, sha: '', lastSyncedSha: '' }
      } else {
        const applied = await guardedDownload(p, action.sha, action.expected, transport, fs, index)
        if (applied) stats.downloaded += 1
        else { stats.deferred += 1; holdBack(p) } // touched mid-round → redeliver
      }
      break
    }
    case 'deleteLocal': {
      if (action.isDir) {
        const removed = await fs.removeDirIfEmpty(p)
        if (removed || (await fs.stat(p)) === null) {
          delete index.entries[p]
        }
        // else: untracked junk still inside — KEEP the index entry so the
        // dir doesn't look locally-new next round and resurrect the
        // server-side deletion (ping-pong guard). It stays local-only.
      } else {
        // Never clobber a fresh edit: only delete if the file still
        // matches what the scan saw.
        const cur = await fs.stat(p)
        if (statsEqual(cur, action.expected)) {
          await fs.removeFile(p)
          stats.deletedLocal += 1
          delete index.entries[p]
        } else {
          stats.deferred += 1
          holdBack(p)
        }
      }
      break
    }
    case 'mkdirRemote': {
      try {
        await transport.mkdir(p)
      } catch {
        /* 409 already-exists is fine */
      }
      index.entries[p] = { isDir: true, size: 0, mtimeMs: 0, sha: '', lastSyncedSha: '' }
      break
    }
    case 'deleteRemote': {
      try {
        await transport.del(p, action.baseSha || undefined)
        stats.deletedRemote += 1
        delete index.entries[p]
      } catch (e) {
        if (e instanceof SyncConflictError) {
          // server changed it since → edit wins: pull the server version
          const applied = await guardedDownload(
            p, e.currentSha ?? '', action.expected, transport, fs, index,
          )
          if (applied) stats.downloaded += 1
          else { stats.deferred += 1; holdBack(p) }
        } else if ((e as any)?.status === 404) {
          delete index.entries[p] // already gone server-side
        } else {
          throw e
        }
      }
      break
    }
    case 'upload': {
      try {
        const res = await transport.put(p, fs.absPath(p), action.baseSha)
        // Scan-time stat: if the user edited after the scan, the stored
        // (size, mtime) won't match the disk next round → re-upload.
        // (The server hashed what was actually streamed, so sha is true.)
        const st = (action.st as LocalStat | null) ?? (await fs.stat(p))
        index.entries[p] = {
          isDir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0,
          sha: res.sha256, lastSyncedSha: res.sha256,
        }
        stats.uploaded += 1
      } catch (e) {
        if (e instanceof SyncConflictError) {
          // Raced with another replica. If the server already holds OUR
          // content (crash-recovered index, duplicate upload), settle
          // silently — no junk conflict copies.
          const st0 = await fs.stat(p) // stat BEFORE hashing (safe direction)
          const localSha = await fs.hash(p).catch(() => '')
          if (e.currentSha && localSha === e.currentSha) {
            index.entries[p] = {
              isDir: false, size: st0?.size ?? 0, mtimeMs: st0?.mtimeMs ?? 0,
              sha: localSha, lastSyncedSha: localSha,
            }
          } else {
            await resolveConflict(p, e.currentSha ?? '', transport, fs, index, stats, opts, holdBack)
          }
        } else {
          throw e
        }
      }
      break
    }
    case 'conflict': {
      // Identical edits masquerading as a conflict (e.g. the index was
      // lost and both sides already hold the same bytes) → settle.
      const st0 = await fs.stat(p)
      const localSha = await fs.hash(p).catch(() => '')
      if (localSha && localSha === action.serverSha) {
        index.entries[p] = {
          isDir: false, size: st0?.size ?? 0, mtimeMs: st0?.mtimeMs ?? 0,
          sha: localSha, lastSyncedSha: localSha,
        }
      } else {
        await resolveConflict(p, action.serverSha, transport, fs, index, stats, opts, holdBack)
      }
      break
    }
    case 'dirOverFile': {
      // Server made this path a directory; a local file sits there.
      // Unedited copy (sha == base) → safe to drop; else preserve as a
      // conflict copy (and push it). Then mkdir.
      const baseSha = index.entries[p]?.lastSyncedSha ?? ''
      const curSha = await fs.hash(p).catch(() => '')
      if (baseSha && curSha === baseSha) {
        await fs.removeFile(p)
        await fs.mkdir(p)
        index.entries[p] = { isDir: true, size: 0, mtimeMs: 0, sha: '', lastSyncedSha: '' }
        break
      }
      const conflictPath = await fs.renameToConflict(p, opts.deviceName)
      try {
        const res = await transport.put(conflictPath, fs.absPath(conflictPath), '')
        const cst = await fs.stat(conflictPath)
        index.entries[conflictPath] = {
          isDir: false, size: cst?.size ?? 0, mtimeMs: cst?.mtimeMs ?? 0,
          sha: res.sha256, lastSyncedSha: res.sha256,
        }
        stats.uploaded += 1
      } catch (e: any) {
        stats.errors.push(`dir-over-file copy upload ${conflictPath}: ${e?.message ?? e}`)
      }
      await fs.mkdir(p)
      index.entries[p] = { isDir: true, size: 0, mtimeMs: 0, sha: '', lastSyncedSha: '' }
      stats.conflicts += 1
      break
    }
    case 'fileOverDir': {
      // Server made this path a FILE; a local directory sits there.
      // Empty dir → drop it; else preserve the dir as a conflict-named
      // sibling (its untracked contents stay local-only). Then download.
      const removed = await fs.removeDirIfEmpty(p)
      if (!removed) {
        await fs.renameToConflict(p, opts.deviceName)
        stats.conflicts += 1
      }
      delete index.entries[p]
      const applied = await guardedDownload(p, action.sha, null, transport, fs, index)
      if (applied) stats.downloaded += 1
      else { stats.deferred += 1; holdBack(p) }
      break
    }
  }
}

function statsEqual(a: { isDir: boolean; size: number; mtimeMs: number } | null,
                    b: { isDir: boolean; size: number; mtimeMs: number } | null): boolean {
  if (a === null || b === null) return a === b
  return a.isDir === b.isDir && a.size === b.size && a.mtimeMs === b.mtimeMs
}

/** Download to a temp inside the replica, then atomically finalize ONLY
 *  if the local path still matches the scan-time stat. Returns whether
 *  the download was applied (false = deferred to the next round). */
async function guardedDownload(
  p: string,
  sha: string,
  expected: LocalStat | null,
  transport: Transport,
  fs: LocalFs,
  index: SyncIndex,
): Promise<boolean> {
  const tmpRel = `.geny-sync-tmp/apply-${Math.random().toString(36).slice(2)}`
  await transport.download(p, fs.absPath(tmpRel))
  if (sha) {
    // Integrity gate: truncated/corrupted transfers must never be
    // recorded as converged (the size+mtime shortcut would pin the
    // wrong sha forever).
    const got = await fs.hash(tmpRel).catch(() => '')
    if (got !== sha) {
      await fs.removeFile(tmpRel)
      throw new Error(`download integrity mismatch for ${p}`)
    }
  }
  const applied = await fs.finalizeDownload(tmpRel, p, expected)
  if (applied) {
    const st = await fs.stat(p)
    index.entries[p] = {
      isDir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0,
      sha, lastSyncedSha: sha,
    }
  }
  return applied
}

/** Both sides edited: server keeps the path; the local version survives
 *  as a conflict-named sibling and is uploaded as a new file. */
async function resolveConflict(
  p: string,
  serverSha: string,
  transport: Transport,
  fs: LocalFs,
  index: SyncIndex,
  stats: SyncStats,
  opts: SyncOptions,
  holdBack: (p: string) => void = () => {},
): Promise<void> {
  const conflictPath = await fs.renameToConflict(p, opts.deviceName)
  const applied = await guardedDownload(p, serverSha, null, transport, fs, index)
  if (applied) {
    stats.downloaded += 1
    if (!serverSha) {
      // sha unknown (409 without current_sha) — record the real one
      const sha = await fs.hash(p).catch(() => '')
      const st = await fs.stat(p)
      index.entries[p] = {
        isDir: false, size: st?.size ?? 0, mtimeMs: st?.mtimeMs ?? 0,
        sha, lastSyncedSha: sha,
      }
    }
  } else {
    stats.deferred += 1
    holdBack(p)
  }
  try {
    const res = await transport.put(conflictPath, fs.absPath(conflictPath), '')
    const cst = await fs.stat(conflictPath)
    index.entries[conflictPath] = {
      isDir: false, size: cst?.size ?? 0, mtimeMs: cst?.mtimeMs ?? 0,
      sha: res.sha256, lastSyncedSha: res.sha256,
    }
    stats.uploaded += 1
  } catch (e: any) {
    stats.errors.push(`conflict-copy upload ${conflictPath}: ${e?.message ?? e}`)
  }
  stats.conflicts += 1
}

/** Conflict sibling name: "report (충돌-PC-A 2026-07-30 14:22).md" */
export function conflictName(name: string, deviceName: string, when: Date): string {
  const ts = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${String(when.getHours()).padStart(2, '0')}${String(when.getMinutes()).padStart(2, '0')}`
  const i = name.lastIndexOf('.')
  const stem = i > 0 ? name.slice(0, i) : name
  const ext = i > 0 ? name.slice(i) : ''
  const dev = deviceName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 24) || 'device'
  return `${stem} (충돌-${dev} ${ts})${ext}`
}
