/**
 * WebDAV 백엔드 — 마운트된 드라이브가 보여주는 것의 실체.
 *
 *     Finder / 탐색기
 *          ↕ WebDAV(로컬 루프백) 또는 FUSE
 *     이 백엔드  ── 트리 캐시 ──  XGEN workspace REST API
 *
 * ── 계층 ─────────────────────────────────────────────────────────────
 *
 * 루트는 **사용자의 클라우드 스토리지**이고, 연결된 에이전트가 그 안에 폴더로
 * 나타난다:
 *
 *     /                      ← 사용자 클라우드 스토리지 (내 파일)
 *     /메모.md                ← 에이전트에 속하지 않는 내 파일
 *     /마케팅 리서치/         ← 연결된 에이전트의 workspace
 *     /XGeny_copy/보고서.md
 *
 * 즉 [커넥터 로컬] ↔ [사용자 클라우드] ↔ [에이전트 workspace] 가 그대로 폴더
 * 계층이 된다. 이름이 겹치면 **에이전트가 사용자 폴더를 가린다** — 연결한
 * 에이전트가 안 보이는 편이 더 혼란스럽다.
 *
 * ── 왜 트리를 캐시하나 ───────────────────────────────────────────────
 *
 * Finder 는 폴더 하나를 열 때 **항목마다 PROPFIND 를 따로 쏜다**. 매번 서버를
 * 왕복하면 폴더 열기가 수 초씩 걸린다. 스페이스별 스냅샷을 짧게 캐시하고,
 * 쓰기가 나면 그 스페이스만 무효화한다.
 *
 * ── 쓰기 ─────────────────────────────────────────────────────────────
 *
 * 편집기는 보통 "임시 파일 쓰기 → rename" 을 한다. 서버 API 에 rename 이
 * 없으므로 MOVE 는 **복사 후 삭제**로 처리한다 (WebDAV 는 MOVE 의 원자성을
 * 요구하지 않는다).
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { diag } from './diag-log'
import { SyncConflictError } from './sync-core'
import type { DavNode, WebdavBackend } from './webdav-server'

/**
 * 서버가 "네가 아는 상태와 다르다"고 말한 것인가 (HTTP 409).
 *
 * ⚠ 타입과 상태코드를 **둘 다** 본다. 예전에는 `(e as {status?}).status !== 409`
 * 하나로만 걸렀는데, 전송 계층이 던지는 `SyncConflictError` 에는 status 가
 * 없어서 늘 `undefined !== 409` 가 됐다. 그래서 **409 재시도가 한 번도
 * 실행되지 않았고**, 드라이브에 파일을 복사하면 close() 에서 EIO 로 끝났다.
 */
function isConflict(e: unknown): boolean {
  return e instanceof SyncConflictError || (e as { status?: number })?.status === 409
}

/** 이 백엔드가 필요로 하는 최소 전송 계약 (HttpSyncTransport 부분집합). */
export interface WorkspaceApi {
  /** since=0 스냅샷: 살아 있는 항목 전부. */
  changes(since: number): Promise<{
    changes: Array<{
      path: string
      is_dir: boolean
      size: number
      mtime_ns: number
      sha256: string
      deleted: boolean
    }>
  }>
  download(path: string, toAbs: string): Promise<void>
  put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }>
  /** `force` = 사용자가 직접 지웠다 (드라이브에서의 삭제). 레플리카는 안 켠다. */
  del(path: string, baseSha?: string, opts?: { force?: boolean }): Promise<void>
  mkdir(path: string): Promise<void>
}

/** 루트에 연결된 에이전트 하나. */
export interface BackendAgent {
  /** 루트 아래 폴더명 (유일). */
  folder: string
  api: WorkspaceApi
}

interface Entry {
  isDir: boolean
  size: number
  mtime: Date
  sha: string
}

/** 하나의 저장 공간 — 사용자 클라우드(루트) 또는 에이전트 workspace. */
interface Space {
  /** 캐시 키. 사용자 스페이스는 빈 문자열(폴더명이 될 수 없다). */
  key: string
  api: WorkspaceApi
  /** 사용자 스페이스인가 (에이전트 폴더 보호 규칙에 쓰인다). */
  isUser: boolean
}

/** 트리 스냅샷 유효 시간 — 폴더 열기가 왕복으로 느려지지 않을 만큼만. */
const TREE_TTL_MS = 4000

export class WorkspaceDavBackend implements WebdavBackend {
  private agents = new Map<string, BackendAgent>()
  /** 사용자 클라우드 스토리지 = 루트 그 자체. 없으면 에이전트만 보인다. */
  private userApi: WorkspaceApi | null = null
  private trees = new Map<string, { at: number; entries: Map<string, Entry> }>()
  private tmp = mkdtempSync(join(tmpdir(), 'xgen-dav-'))

  /**
   * 임시 디렉터리가 살아 있게 한다.
   *
   * `/tmp` 청소기(systemd-tmpfiles 등)는 오래된 디렉터리를 지운다. 앱이 며칠
   * 떠 있으면 캐시/스테이징 디렉터리가 사라지고, 그때부터 **모든 읽기와 쓰기가
   * ENOENT 로 죽는다** — 드라이브가 통째로 먹통이 된다. 쓰기 직전에 한 번씩
   * 확인하는 비용은 무시할 만하다.
   */
  private ensureTmp(): string {
    if (!existsSync(this.tmp)) {
      mkdirSync(this.tmp, { recursive: true })
      // 디렉터리가 사라졌다면 캐시 파일도 같이 사라졌다 — 장부를 비운다.
      this.cache.clear()
      this.cacheBytes = 0
    }
    return this.tmp
  }

  /** 루트가 될 사용자 클라우드 스토리지를 배선한다 (null = 미사용). */
  setUserStorage(api: WorkspaceApi | null): void {
    this.userApi = api
    this.trees.delete('')
    diag('dav', `사용자 클라우드 스토리지 ${api ? '배선' : '해제'}`)
  }

  setAgents(list: BackendAgent[]): void {
    this.agents = new Map(list.map((a) => [a.folder, a]))
    for (const key of [...this.trees.keys()]) {
      if (key !== '' && !this.agents.has(key)) this.trees.delete(key)
    }
    diag('dav', `에이전트 ${this.agents.size}개 배선: ${[...this.agents.keys()].join(', ')}`)
  }

  dispose(): void {
    try {
      rmSync(this.tmp, { recursive: true, force: true })
    } catch {
      /* 임시 디렉터리 정리 실패는 무해 */
    }
  }

  private userSpace(): Space | null {
    return this.userApi ? { key: '', api: this.userApi, isUser: true } : null
  }

  /**
   * 경로 → [스페이스, 그 안의 상대 경로].
   *
   * 첫 조각이 연결된 에이전트 폴더면 그 에이전트, 아니면 사용자 스토리지다
   * (= 에이전트가 같은 이름의 사용자 폴더를 가린다).
   */
  private resolve(p: string): [Space | null, string] {
    const parts = p.split('/').filter(Boolean)
    if (parts.length === 0) return [this.userSpace(), '']
    const agent = this.agents.get(parts[0])
    if (agent) return [{ key: agent.folder, api: agent.api, isUser: false }, parts.slice(1).join('/')]
    return [this.userSpace(), parts.join('/')]
  }

  /** 이 경로의 첫 조각이 에이전트 폴더인가 (드라이브에서 만들거나 지울 수 없다). */
  private isAgentRoot(p: string): boolean {
    const parts = p.split('/').filter(Boolean)
    return parts.length === 1 && this.agents.has(parts[0])
  }

  private async tree(space: Space): Promise<Map<string, Entry>> {
    const hit = this.trees.get(space.key)
    if (hit && Date.now() - hit.at < TREE_TTL_MS) return hit.entries
    const entries = new Map<string, Entry>()
    try {
      const snap = await space.api.changes(0)
      for (const c of snap.changes) {
        if (c.deleted) continue
        entries.set(c.path, {
          isDir: c.is_dir,
          size: c.size ?? 0,
          // mtime_ns 는 나노초 — Date 는 밀리초를 받는다.
          mtime: new Date(Math.floor((c.mtime_ns ?? 0) / 1e6) || Date.now()),
          sha: c.sha256 ?? '',
        })
      }
    } catch (e) {
      diag('dav', `트리 조회 실패 (${space.key || '사용자'}): ${(e as Error).message}`)
      // 실패 시 **이전 캐시를 유지**한다 — 빈 목록을 돌려주면 "파일이 전부
      // 사라졌다"로 보인다.
      if (hit) return hit.entries
    }
    this.trees.set(space.key, { at: Date.now(), entries })
    return entries
  }

  private invalidate(space: Space): void {
    this.trees.delete(space.key)
  }

  /**
   * 서버가 "이 저장소가 바뀌었다"고 알려왔을 때 캐시를 버린다.
   *
   * 이게 없으면 드라이브는 TTL(4초)이 지나고 **누군가 폴더를 다시 열어야만**
   * 새 파일을 본다. 웹에서 올린 파일이 탐색기에 안 나타나는 것처럼 보인다.
   *
   * @param key 사용자 스토리지는 빈 문자열, 에이전트는 폴더명.
   */
  invalidateSpace(key: string): void {
    this.trees.delete(key)
  }

  /** 사용자가 [동기화]를 눌렀을 때 — 전부 다시 읽는다. */
  invalidateAll(): void {
    this.trees.clear()
  }

  private node(name: string, e: Entry): DavNode {
    return { name, isDir: e.isDir, size: e.size, mtime: e.mtime, etag: e.sha || undefined }
  }

  private dirNode(name: string): DavNode {
    return { name, isDir: true, size: 0, mtime: new Date() }
  }

  async stat(p: string): Promise<DavNode | null> {
    if (p === '/') return this.dirNode('')
    if (this.isAgentRoot(p)) return this.dirNode(p.slice(1))
    const [space, rel] = this.resolve(p)
    if (!space || !rel) return null
    const e = (await this.tree(space)).get(rel)
    return e ? this.node(rel.slice(rel.lastIndexOf('/') + 1), e) : null
  }

  async readdir(p: string): Promise<DavNode[]> {
    const out: DavNode[] = []
    const seen = new Set<string>()

    // 루트에서는 연결된 에이전트가 먼저다 (같은 이름의 사용자 폴더를 가린다).
    if (p === '/') {
      for (const folder of this.agents.keys()) {
        out.push(this.dirNode(folder))
        seen.add(folder)
      }
    }

    const [space, rel] = this.resolve(p)
    if (!space) return out
    const prefix = rel ? `${rel}/` : ''
    for (const [path, e] of await this.tree(space)) {
      if (!path.startsWith(prefix)) continue
      const tail = path.slice(prefix.length)
      if (!tail || tail.includes('/')) continue // 직계 자식만
      if (seen.has(tail)) continue
      out.push(this.node(tail, e))
    }
    return out
  }

  /**
   * 콘텐츠 주소 디스크 캐시 — **같은 내용은 한 번만 내려받는다.**
   *
   * ⚠ 이게 없으면 macOS/Windows 에서 사실상 못 쓴다. 두 OS 의 내장 WebDAV
   * 클라이언트는 큰 파일을 **조각(Range)으로 나눠 읽는데**, 조각마다 서버에서
   * 파일 전체를 내려받으면 100MB 파일 한 번 여는 데 수십 GB 가 오간다.
   * Linux 는 FUSE 가 열 때 한 번 통째로 읽어 버퍼에 들고 있어서 이 결함이
   * 드러나지 않았다.
   *
   * 키는 sha(내용)다 — 내용이 바뀌면 키가 바뀌므로 무효화가 저절로 된다.
   */
  private cache = new Map<string, { file: string; size: number; at: number }>()
  private cacheBytes = 0
  private inflight = new Map<string, Promise<{ file: string; size: number } | null>>()

  /** 디스크 캐시 예산. 넘으면 오래 안 쓴 것부터 지운다. */
  private static readonly CACHE_BUDGET = 512 * 1024 * 1024

  private evict(): void {
    if (this.cacheBytes <= WorkspaceDavBackend.CACHE_BUDGET) return
    const byAge = [...this.cache.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [key, v] of byAge) {
      if (this.cacheBytes <= WorkspaceDavBackend.CACHE_BUDGET) break
      this.cache.delete(key)
      this.cacheBytes -= v.size
      try {
        rmSync(v.file, { force: true })
      } catch {
        /* 무해 */
      }
    }
  }

  /** 이 경로의 내용을 디스크 캐시에 확보한다 (이미 있으면 재사용). */
  private async ensureCached(p: string): Promise<{ file: string; size: number } | null> {
    const [space, rel] = this.resolve(p)
    if (!space || !rel) return null
    const entry = (await this.tree(space)).get(rel)
    if (!entry || entry.isDir) return null
    // sha 가 없으면(구서버·빈 파일) stat 로 대신 키를 만든다.
    const key = `${space.key}\u0000${rel}\u0000${entry.sha || `${entry.size}:${entry.mtime.getTime()}`}`
    const hit = this.cache.get(key)
    if (hit && existsSync(hit.file)) {
      hit.at = Date.now()
      return { file: hit.file, size: hit.size }
    }
    const running = this.inflight.get(key)
    if (running) return running // 같은 파일을 동시에 여러 번 읽어도 한 번만 받는다
    const task = (async () => {
      const file = join(this.ensureTmp(), `c-${createHash('sha1').update(key).digest('hex')}`)
      try {
        await space.api.download(rel, file)
        const size = statSync(file).size
        this.cache.set(key, { file, size, at: Date.now() })
        this.cacheBytes += size
        this.evict()
        return { file, size }
      } catch (e) {
        diag('dav', `읽기 실패 ${p}: ${(e as Error).message}`)
        try {
          rmSync(file, { force: true })
        } catch {
          /* 무해 */
        }
        throw e
      } finally {
        this.inflight.delete(key)
      }
    })()
    this.inflight.set(key, task)
    return task
  }

  async read(p: string): Promise<Buffer> {
    const c = await this.ensureCached(p)
    return c ? readFileSync(c.file) : Buffer.alloc(0)
  }

  /**
   * 부분 읽기 — 캐시된 파일에서 **필요한 조각만** 꺼낸다.
   *
   * 전체를 메모리에 올리지 않는다: 1GB 파일의 64KB 조각을 읽으려고 1GB 를
   * 버퍼에 담으면 앱이 죽는다.
   */
  async readRange(p: string, start: number, end: number): Promise<Buffer> {
    const c = await this.ensureCached(p)
    if (!c) return Buffer.alloc(0)
    const len = Math.max(0, Math.min(end, c.size - 1) - start + 1)
    if (len === 0) return Buffer.alloc(0)
    const buf = Buffer.alloc(len)
    const fd = openSync(c.file, 'r')
    try {
      const n = readSync(fd, buf, 0, len, start)
      return n === len ? buf : buf.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  }

  async write(p: string, data: Buffer): Promise<void> {
    const [space, rel] = this.resolve(p)
    if (!space) throw new Error('클라우드 스토리지가 연결되어 있지 않습니다')
    if (!rel) throw new Error('루트에는 쓸 수 없습니다')
    const local = join(this.ensureTmp(), `w-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    writeFileSync(local, data)
    try {
      // base_sha 는 현재 알고 있는 값 — 서버의 낙관적 동시성 검사에 쓰인다.
      const cur = (await this.tree(space)).get(rel)
      try {
        await space.api.put(rel, local, cur?.sha ?? '')
      } catch (e) {
        // 409 = 우리 캐시가 서버와 다르다. 사용자가 드라이브에 넣은 파일은
        // **명시적 의사**이므로 여기서 포기하면 안 된다 — 실기에서 이 실패로
        // 앞서 만들어 둔 0바이트 파일만 서버에 남았다.
        if (!isConflict(e)) {
          // 충돌이 아니면 여기서 끝난다. 이유를 남기지 않으면 사용자에게는
          // 커널의 EIO 한 줄만 도착한다.
          diag('dav', `쓰기 실패 ${p}: ${(e as Error).message}`)
          throw e
        }
        diag('dav', `쓰기 충돌 — 최신 상태로 재시도 ${p}`)
        this.invalidate(space)
        const fresh = (await this.tree(space)).get(rel)
        await space.api.put(rel, local, fresh?.sha ?? '')
      }
      diag('dav', `쓰기 ${p} (${data.length}B)`)
    } finally {
      try {
        rmSync(local, { force: true })
      } catch {
        /* 무해 */
      }
      this.invalidate(space)
    }
  }

  async mkdir(p: string): Promise<void> {
    // 에이전트 폴더는 앱에서 연결/해제한다 — 드라이브에서 만들면 그게 연결이
    // 되는 것처럼 보여 실제와 어긋난다.
    if (this.isAgentRoot(p)) throw new Error('에이전트 폴더는 앱에서 연결/해제합니다')
    const [space, rel] = this.resolve(p)
    if (!space) throw new Error('클라우드 스토리지가 연결되어 있지 않습니다')
    if (!rel) throw new Error('루트는 만들 수 없습니다')
    await space.api.mkdir(rel)
    this.invalidate(space)
  }

  async remove(p: string): Promise<void> {
    if (this.isAgentRoot(p)) throw new Error('에이전트 폴더는 앱에서 연결/해제합니다')
    const [space, rel] = this.resolve(p)
    if (!space) throw new Error('클라우드 스토리지가 연결되어 있지 않습니다')
    if (!rel) throw new Error('루트는 지울 수 없습니다')
    const cur = (await this.tree(space)).get(rel)
    // 파일은 base_sha 를 실어 보낸다 (서버의 낙관적 동시성 검사).
    const baseSha = cur && !cur.isDir ? cur.sha : undefined
    // ⚠ **드라이브에서의 삭제는 사용자의 명시적 의사다 — force 를 보낸다.**
    //
    // 이걸 안 보내면 서버는 이 요청을 "동기화 레플리카의 추론"으로 보고
    // fail-closed 가드를 건다: 파일은 base_sha 필수(409 base_sha_required),
    // 폴더는 비어 있을 때만(409 dir_not_empty). 그래서 실기에서
    //
    //   * 캐시에 없는 파일을 지우면 → 409 → 삭제 실패
    //   * 내용이 있는 폴더를 지우면 → 409 → **항상** 삭제 실패
    //
    // 였고, 사용자에게는 "드라이브에서 지워도 그대로 남는다"로 보였다.
    // 가드는 리컨사일 엔진을 위한 것이지 사람 손을 위한 게 아니다.
    const opts = { force: true }
    try {
      await space.api.del(rel, baseSha, opts)
    } catch (e) {
      // 409 = base_sha 가 어긋났다(그 사이 누가 고쳤다). 캐시를 버리고 지금
      // 값으로 한 번 더 — 사용자의 삭제를 조용히 포기하지 않는다.
      if (!isConflict(e)) {
        diag('dav', `삭제 실패 ${p}: ${(e as Error).message}`)
        throw e
      }
      diag('dav', `삭제 충돌 — 최신 상태로 재시도 ${p}`)
      this.invalidate(space)
      const fresh = (await this.tree(space)).get(rel)
      if (!fresh) return // 이미 없어졌다 = 원하는 결과
      await space.api.del(rel, fresh.isDir ? undefined : fresh.sha, opts)
    }
    this.invalidate(space)
  }

  async move(from: string, to: string): Promise<void> {
    if (this.isAgentRoot(from) || this.isAgentRoot(to)) {
      throw new Error('에이전트 폴더는 앱에서 연결/해제합니다')
    }
    const [sFrom, relFrom] = this.resolve(from)
    const [sTo, relTo] = this.resolve(to)
    if (!sFrom || !relFrom || !sTo || !relTo) throw new Error('이동할 수 없는 경로입니다')
    // 서버 API 에 rename 이 없다 — 복사 후 삭제. 스페이스를 가로지르는 이동
    // (사용자 ↔ 에이전트)도 같은 방식으로 자연스럽게 동작한다.
    const entry = (await this.tree(sFrom)).get(relFrom)
    if (entry?.isDir) {
      await sTo.api.mkdir(relTo)
    } else {
      await this.write(to, await this.read(from))
    }
    await this.remove(from)
    this.invalidate(sFrom)
    this.invalidate(sTo)
  }
}
