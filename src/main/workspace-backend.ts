/**
 * WebDAV 백엔드 — 마운트된 드라이브가 **실제 에이전트 워크스페이스**를 보여준다.
 *
 * 구조:
 *
 *     Finder / 탐색기
 *          ↕ WebDAV (로컬 루프백)
 *     이 백엔드  ── 트리 캐시 ──  XGEN workspace REST API
 *
 * 루트는 에이전트 목록이고, 각 에이전트가 하나의 폴더다:
 *
 *     /                      ← 붙어 있는 에이전트들
 *     /마케팅 리서치/         ← 그 에이전트의 workspace
 *     /XGeny_copy/보고서.md
 *
 * ── 왜 트리를 캐시하나 ───────────────────────────────────────────────
 *
 * Finder 는 폴더 하나를 열 때 **항목마다 PROPFIND 를 따로 쏜다**. 매번
 * 서버를 왕복하면 폴더 열기가 수 초씩 걸린다. 그래서 에이전트별 스냅샷을
 * 짧게 캐시하고(`TREE_TTL_MS`), 쓰기가 일어나면 그 에이전트만 무효화한다.
 *
 * ── 쓰기 ─────────────────────────────────────────────────────────────
 *
 * 편집기는 보통 "임시 파일 쓰기 → rename" 을 한다. 서버 API 에 rename 이
 * 없으므로 MOVE 는 **복사 후 삭제**로 처리한다 (WebDAV 계약상 원자성이
 * 요구되지 않는다).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { diag } from './diag-log'
import type { DavNode, WebdavBackend } from './webdav-server'

/** 이 백엔드가 필요로 하는 최소 전송 계약 (HttpSyncTransport 부분집합). */
export interface WorkspaceApi {
  /** since=0 스냅샷: 살아 있는 항목 전부. */
  changes(since: number): Promise<{
    changes: Array<{ path: string; is_dir: boolean; size: number; mtime_ns: number; sha256: string; deleted: boolean }>
  }>
  download(path: string, toAbs: string): Promise<void>
  put(path: string, fromAbs: string, baseSha: string): Promise<{ sha256: string }>
  del(path: string, baseSha?: string): Promise<void>
  mkdir(path: string): Promise<void>
}

/** 워크스페이스에 붙어 있는 에이전트 하나. */
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

/** 트리 스냅샷 유효 시간 — 폴더 열기가 왕복으로 느려지지 않을 만큼만. */
const TREE_TTL_MS = 4000

export class WorkspaceDavBackend implements WebdavBackend {
  private agents = new Map<string, BackendAgent>()
  private trees = new Map<string, { at: number; entries: Map<string, Entry> }>()
  private tmp = mkdtempSync(join(tmpdir(), 'xgen-dav-'))

  setAgents(list: BackendAgent[]): void {
    this.agents = new Map(list.map((a) => [a.folder, a]))
    for (const key of [...this.trees.keys()]) {
      if (!this.agents.has(key)) this.trees.delete(key)
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

  /** '/폴더/안의/경로' → [에이전트, 'workspace 기준 상대 경로'] */
  private split(p: string): [BackendAgent | null, string] {
    const parts = p.split('/').filter(Boolean)
    if (parts.length === 0) return [null, '']
    const agent = this.agents.get(parts[0])
    return [agent ?? null, parts.slice(1).join('/')]
  }

  private async tree(agent: BackendAgent): Promise<Map<string, Entry>> {
    const hit = this.trees.get(agent.folder)
    if (hit && Date.now() - hit.at < TREE_TTL_MS) return hit.entries
    const entries = new Map<string, Entry>()
    try {
      const snap = await agent.api.changes(0)
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
      diag('dav', `트리 조회 실패 (${agent.folder}): ${(e as Error).message}`)
      // 실패 시 **이전 캐시를 유지**한다 — 빈 목록을 돌려주면 Finder 에
      // "파일이 전부 사라졌다"로 보인다.
      if (hit) return hit.entries
    }
    this.trees.set(agent.folder, { at: Date.now(), entries })
    return entries
  }

  private invalidate(agent: BackendAgent): void {
    this.trees.delete(agent.folder)
  }

  private node(name: string, e: Entry): DavNode {
    return { name, isDir: e.isDir, size: e.size, mtime: e.mtime, etag: e.sha || undefined }
  }

  async stat(p: string): Promise<DavNode | null> {
    if (p === '/') return { name: '', isDir: true, size: 0, mtime: new Date() }
    const [agent, rel] = this.split(p)
    if (!agent) return null
    // 에이전트 폴더 자체
    if (!rel) return { name: agent.folder, isDir: true, size: 0, mtime: new Date() }
    const e = (await this.tree(agent)).get(rel)
    return e ? this.node(rel.slice(rel.lastIndexOf('/') + 1), e) : null
  }

  async readdir(p: string): Promise<DavNode[]> {
    if (p === '/') {
      return [...this.agents.keys()].map((folder) => ({
        name: folder,
        isDir: true,
        size: 0,
        mtime: new Date(),
      }))
    }
    const [agent, rel] = this.split(p)
    if (!agent) return []
    const prefix = rel ? `${rel}/` : ''
    const out: DavNode[] = []
    for (const [path, e] of await this.tree(agent)) {
      if (!path.startsWith(prefix)) continue
      const tail = path.slice(prefix.length)
      if (!tail || tail.includes('/')) continue // 직계 자식만
      out.push(this.node(tail, e))
    }
    return out
  }

  async read(p: string): Promise<Buffer> {
    const [agent, rel] = this.split(p)
    if (!agent || !rel) return Buffer.alloc(0)
    const local = join(this.tmp, `r-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      await agent.api.download(rel, local)
      return readFileSync(local)
    } catch (e) {
      diag('dav', `읽기 실패 ${p}: ${(e as Error).message}`)
      throw e
    } finally {
      try {
        rmSync(local, { force: true })
      } catch {
        /* 무해 */
      }
    }
  }

  async write(p: string, data: Buffer): Promise<void> {
    const [agent, rel] = this.split(p)
    if (!agent || !rel) throw new Error('에이전트 폴더 밖에는 쓸 수 없습니다')
    const local = join(this.tmp, `w-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    writeFileSync(local, data)
    try {
      // base_sha 는 현재 알고 있는 값 — 서버의 낙관적 동시성 검사에 쓰인다.
      const cur = (await this.tree(agent)).get(rel)
      await agent.api.put(rel, local, cur?.sha ?? '')
      diag('dav', `쓰기 ${p} (${data.length}B)`)
    } finally {
      try {
        rmSync(local, { force: true })
      } catch {
        /* 무해 */
      }
      this.invalidate(agent)
    }
  }

  async mkdir(p: string): Promise<void> {
    const [agent, rel] = this.split(p)
    if (!agent || !rel) throw new Error('에이전트 폴더는 앱에서 추가/제거합니다')
    await agent.api.mkdir(rel)
    this.invalidate(agent)
  }

  async remove(p: string): Promise<void> {
    const [agent, rel] = this.split(p)
    if (!agent || !rel) throw new Error('에이전트 폴더는 앱에서 추가/제거합니다')
    const cur = (await this.tree(agent)).get(rel)
    // 파일은 base_sha 를 주고(서버의 fail-closed 계약), 디렉터리는 sha 가 없다.
    await agent.api.del(rel, cur && !cur.isDir ? cur.sha : undefined)
    this.invalidate(agent)
  }

  async move(from: string, to: string): Promise<void> {
    const [aFrom, relFrom] = this.split(from)
    const [aTo, relTo] = this.split(to)
    if (!aFrom || !relFrom || !aTo || !relTo) throw new Error('이동할 수 없는 경로입니다')
    // 서버 API 에 rename 이 없다 — 복사 후 삭제. WebDAV 는 MOVE 의 원자성을
    // 요구하지 않으므로 계약 위반이 아니다. (편집기의 "임시파일→rename"
    // 저장 패턴이 이 경로를 탄다.)
    const entry = (await this.tree(aFrom)).get(relFrom)
    if (entry?.isDir) {
      await aTo.api.mkdir(relTo)
    } else {
      await this.write(to, await this.read(from))
    }
    await this.remove(from)
    this.invalidate(aFrom)
    this.invalidate(aTo)
  }
}
