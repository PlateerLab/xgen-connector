/**
 * sync-fs — real LocalFs implementation over the user's paired folder.
 *
 * Safety posture mirrors the server's: everything resolves under the
 * replica root (no `..`, no symlink following), ignored trees are never
 * entered, and destructive ops touch only tracked paths.
 */

import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from 'fs/promises'
import { dirname, join, resolve, sep } from 'path'
import picomatch from 'picomatch'
import { conflictName, LocalFs, LocalStat } from './sync-core'

/** Mirror of the server DEFAULT_IGNORE heavy-library set + junk. Keep in
 *  rough parity with backend/service/utils/file_storage.py. */
export const DEFAULT_IGNORES = [
  'node_modules', '.npm', '.yarn', '.pnpm-store', 'bower_components',
  '.venv', 'venv', 'env', '__pycache__', '.tox', '.nox',
  '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'build', 'dist', 'out', 'target', '.eggs',
  '.git', '.hg', '.svn',
  '.idea', '.vscode',
  '.gradle', '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo',
  '.geny-sync', '.geny-sync-tmp', '.canvas-preview',
]

export const DEFAULT_IGNORE_GLOBS = [
  '**/*.pyc', '**/*.pyo', '**/*.pyd', '**/*.class', '**/*.o',
  '**/.DS_Store', '**/Thumbs.db', '**/desktop.ini',
  '**/*.crdownload', '**/*.partial', '**/*.tmp', '**/~$*', '**/.~lock.*#',
  '**/*.egg-info/**',
]

const WIN_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

export class ReplicaFs implements LocalFs {
  private root: string
  private rootPrefix: string
  private isIgnoredGlob: (p: string) => boolean
  /** NFC rel → 디스크의 실제(raw, 비-NFC) rel. NTFS/ext4 는 바이트-단위 조회라
   *  NFD 로 저장된 이름을 NFC 경로로 열면 ENOENT — 스캔에서 매핑을 채워
   *  absPath 가 실제 이름으로 접근하게 한다 (macOS 외 플랫폼의 NFD 파일이
   *  영구 미동기되던 결함 수정). */
  private rawByNfc = new Map<string, string>()

  constructor(root: string, extraGlobs: string[] = []) {
    this.root = resolve(root)
    // 드라이브 루트('C:\')는 resolve 가 구분자를 남긴다 — startsWith 검사가
    // 'C:\\' 를 요구해 전 경로가 탈출 판정되는 것을 방지.
    this.rootPrefix = this.root.endsWith(sep) ? this.root : this.root + sep
    this.isIgnoredGlob = picomatch([...DEFAULT_IGNORE_GLOBS, ...extraGlobs], { dot: true })
  }

  absPath(rel: string): string {
    // NFC-normalize so macOS (NFD on disk) and the server (NFC) agree on
    // one spelling of every Korean/accented path. 디스크 실명이 다르면
    // (rawByNfc) 그 이름으로 접근한다.
    const nfc = rel.normalize('NFC')
    const abs = resolve(this.root, this.rawByNfc.get(nfc) ?? nfc)
    if (abs !== this.root && !abs.startsWith(this.rootPrefix)) {
      throw new Error(`path escapes replica root: ${rel}`)
    }
    return abs
  }

  /** 이 플랫폼에서 합법적으로 만들 수 있는 이름인가 — win32 는 예약 문자/
   *  디바이스명/끝 점·공백이 불법이다. 리모트(리눅스 서버)가 만든 이런
   *  경로는 정책 스킵되어야 한다 (다운로드 시도는 매 라운드 실패 + 커서
   *  홀드백 = 영구 웨지). */
  isNameLegal(rel: string): boolean {
    if (process.platform !== 'win32') return true
    for (const seg of rel.split('/')) {
      if (!seg) continue
      if (/[<>:"|?*\x00-\x1f]/.test(seg)) return false
      if (/[. ]$/.test(seg)) return false
      if (WIN_RESERVED_NAMES.test(seg)) return false
    }
    return true
  }

  /** Case-insensitive fs detection (Windows/macOS default) — probed once
   *  with a marker file in the sync temp dir. */
  private _caseInsensitive: boolean | null = null

  async isCaseInsensitive(): Promise<boolean> {
    if (this._caseInsensitive !== null) return this._caseInsensitive
    try {
      const probeDir = join(this.root, '.geny-sync-tmp')
      await mkdir(probeDir, { recursive: true })
      const probe = join(probeDir, 'CaseProbe.tmp')
      await writeFile(probe, 'x')
      let insensitive = false
      try {
        await lstat(join(probeDir, 'caseprobe.tmp'))
        insensitive = true
      } catch {
        insensitive = false
      }
      await rm(probe, { force: true })
      this._caseInsensitive = insensitive
    } catch {
      this._caseInsensitive = false
    }
    return this._caseInsensitive
  }

  /** Guarded atomic apply of a downloaded temp: place only if the target
   *  still matches the scan-time stat (fresh local edits win). */
  async finalizeDownload(tmpRel: string, rel: string, expected: LocalStat | null): Promise<boolean> {
    const tmpAbs = this.absPath(tmpRel)
    const targetAbs = this.absPath(rel)
    const cur = await this.stat(rel)
    const matches =
      (cur === null && expected === null) ||
      (cur !== null && expected !== null &&
        cur.isDir === expected.isDir && cur.size === expected.size &&
        cur.mtimeMs === expected.mtimeMs)
    if (!matches) {
      await rm(tmpAbs, { force: true })
      return false
    }
    await mkdir(dirname(targetAbs), { recursive: true })
    await rename(tmpAbs, targetAbs)
    return true
  }

  private ignoredName(name: string): boolean {
    return DEFAULT_IGNORES.includes(name)
  }

  /** Same rules the scan applies — exposed so the engine can filter
   *  REMOTE paths too (ignore-asymmetry must never delete server files
   *  the client simply doesn't scan). */
  isIgnored(rel: string): boolean {
    const parts = rel.split('/')
    return parts.some((seg) => this.ignoredName(seg)) || this.isIgnoredGlob(rel)
  }

  async scan(): Promise<Map<string, LocalStat>> {
    const out = new Map<string, LocalStat>()
    this.rawByNfc.clear()
    const walk = async (dirAbs: string, relPrefix: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(dirAbs, { withFileTypes: true })
      } catch (e) {
        // 루트가 사라졌으면(마운트 해제·이름변경) 빈 스캔으로 두고 엔진의
        // fail-closed 가드가 라운드를 중단하게 한다. 그 외(EMFILE/EACCES/
        // 안티바이러스 잠금)의 **부분 실패는 조용히 넘기면 안 된다** — 그
        // 하위 트리가 통째로 '로컬에서 삭제됨'으로 해석돼 서버 파일이
        // 파괴된다. 라운드를 실패시키고 다음 라운드에 재시도한다.
        const code = (e as NodeJS.ErrnoException)?.code
        if (dirAbs === this.root && (code === 'ENOENT' || code === 'ENOTDIR')) return
        throw new Error(`scan failed at ${relPrefix || '.'}: ${code ?? e}`)
      }
      for (const ent of entries) {
        // NFC-normalize names so macOS NFD spellings match server NFC paths
        const name = ent.name.normalize('NFC')
        const rel = relPrefix ? `${relPrefix}/${name}` : name
        if (this.ignoredName(ent.name) || this.isIgnoredGlob(rel)) continue
        if (ent.isSymbolicLink()) continue
        const abs = join(dirAbs, ent.name)
        if (name !== ent.name) {
          // 디스크 실명이 NFD — NFC 키로 접근할 때 쓸 실명 매핑 기록.
          const rawRel = relPrefix
            ? `${this.rawByNfc.get(relPrefix) ?? relPrefix}/${ent.name}`
            : ent.name
          this.rawByNfc.set(rel, rawRel)
        } else if (relPrefix && this.rawByNfc.has(relPrefix)) {
          // 부모가 NFD 인 트리 아래의 NFC 자식도 실경로는 raw 부모를 거친다.
          this.rawByNfc.set(rel, `${this.rawByNfc.get(relPrefix)}/${ent.name}`)
        }
        if (ent.isDirectory()) {
          try {
            const st = await stat(abs)
            out.set(rel, { isDir: true, size: 0, mtimeMs: st.mtimeMs })
          } catch {
            continue
          }
          await walk(abs, rel)
        } else if (ent.isFile()) {
          try {
            const st = await stat(abs)
            out.set(rel, { isDir: false, size: st.size, mtimeMs: st.mtimeMs })
          } catch {
            continue
          }
        }
      }
    }
    await mkdir(this.root, { recursive: true })
    await walk(this.root, '')
    return out
  }

  async hash(rel: string): Promise<string> {
    const abs = this.absPath(rel)
    return new Promise((res, rej) => {
      const h = createHash('sha256')
      createReadStream(abs)
        .on('data', (c) => h.update(c))
        .on('end', () => res(h.digest('hex')))
        .on('error', rej)
    })
  }

  async stat(rel: string): Promise<LocalStat | null> {
    try {
      const st = await lstat(this.absPath(rel))
      if (st.isSymbolicLink()) return null
      return { isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtimeMs: st.mtimeMs }
    } catch {
      return null
    }
  }

  async removeFile(rel: string): Promise<void> {
    await rm(this.absPath(rel), { force: true })
  }

  async removeDirIfEmpty(rel: string): Promise<boolean> {
    const abs = this.absPath(rel)
    try {
      await rmdir(abs)
      return true
    } catch {
      // Finder/탐색기가 흘린 정크(.DS_Store 등)만 남은 디렉터리는 비어 있는
      // 것으로 취급한다 — 안 그러면 서버 측 폴더 삭제가 mac/win 레플리카에
      // 영원히 전파되지 못한다 (스캔은 정크를 무시해 재시도 신호도 없다).
      try {
        const entries = await readdir(abs, { withFileTypes: true })
        const JUNK = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])
        if (entries.length === 0 || !entries.every((e) => e.isFile() && JUNK.has(e.name))) {
          return false
        }
        for (const e of entries) await rm(join(abs, e.name), { force: true })
        await rmdir(abs)
        return true
      } catch {
        return false
      }
    }
  }

  async mkdir(rel: string): Promise<void> {
    await mkdir(this.absPath(rel), { recursive: true })
  }

  async renameToConflict(rel: string, deviceName: string): Promise<string> {
    const parts = rel.split('/')
    const name = parts.pop() as string
    // NFC 정규화: deviceName(hostname)이 NFD 면 인덱스 키와 스캔 키가
    // 어긋나 다음 라운드가 유령 삭제+재업로드로 출렁인다.
    let candidate = conflictName(name, deviceName, new Date()).normalize('NFC')
    let candidateRel = [...parts, candidate].join('/')
    for (let i = 2; i < 100; i++) {
      try {
        await lstat(this.absPath(candidateRel))
        candidate = conflictName(name.replace(/(\.[^.]*)?$/, ` ${i}$1`), deviceName, new Date()).normalize('NFC')
        candidateRel = [...parts, candidate].join('/')
      } catch {
        break
      }
    }
    await rename(this.absPath(rel), this.absPath(candidateRel))
    return candidateRel
  }
}
