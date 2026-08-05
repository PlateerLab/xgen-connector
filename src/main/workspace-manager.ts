/**
 * 워크스페이스 매니저 — 가상 드라이브 하나의 수명을 통째로 소유한다.
 *
 *     설정(부착된 에이전트) → 백엔드 배선 → WebDAV 서버 → OS 마운트
 *
 * 로그인하면 붙고, 로그아웃/종료하면 걷힌다. 구글 드라이브처럼 **앱이 켜져
 * 있을 때만 존재하는 폴더**다.
 *
 * 여기가 유일한 소유자인 이유: 서버·마운트·백엔드는 항상 같이 살고 같이
 * 죽어야 한다. 셋을 따로 두면 "서버는 떴는데 마운트가 없다", "마운트는 남았는데
 * 서버가 죽었다"(= 스테일 마운트로 폴더가 먹통) 같은 상태가 생긴다.
 */

import { diag } from './diag-log'
import { mountFuse, type FuseMountHandle } from './fuse-mount'
import { mountWebdav, unmountWebdav } from './mount-runner'
import { WorkspaceDavBackend, type BackendAgent, type WorkspaceApi } from './workspace-backend'
import { startDavServer, type DavServerHandle } from './webdav-server'
import { detectMountSupport, type MountSupport } from './workspace-mounts'
import { rootOf, type WorkspaceConfig } from './workspace'

export interface WorkspaceManagerDeps {
  /** 현재 설정 (부착된 에이전트 목록 + 루트). */
  config: () => WorkspaceConfig | undefined
  /** 에이전트 하나의 워크스페이스 API 를 만든다 (전송 계층 어댑터). */
  apiFor: (workflowId: string) => WorkspaceApi
  /** 로그인 상태 — 꺼져 있으면 마운트하지 않는다. */
  loggedIn: () => boolean
  onStatus?: (s: WorkspaceStatus) => void
}

export interface WorkspaceStatus {
  supported: boolean
  /** 미지원 사유 (macOS 미지원 등). */
  reason?: string
  hint?: string
  mounted: boolean
  /** 마운트된 경로 또는 드라이브 문자. */
  path?: string
  error?: string
  agents: Array<{ workflowId: string; label: string; folder: string }>
}

export class WorkspaceManager {
  private backend = new WorkspaceDavBackend()
  private handle: DavServerHandle | null = null
  /** Linux 는 WebDAV 서버 없이 FUSE 로 직접 붙는다 (내장 클라이언트가 없다). */
  private fuse: FuseMountHandle | null = null
  private mountedPath: string | null = null
  private support: MountSupport = detectMountSupport()
  private lastError: string | undefined
  private busy: Promise<void> | null = null

  constructor(private deps: WorkspaceManagerDeps) {}

  status(): WorkspaceStatus {
    const cfg = this.deps.config()
    return {
      supported: this.support.supported,
      reason: this.support.reason,
      hint: this.support.hint,
      mounted: this.mountedPath !== null,
      path: this.mountedPath ?? undefined,
      error: this.lastError,
      agents: (cfg?.agents ?? []).map((a) => ({
        workflowId: a.workflowId,
        label: a.label,
        folder: a.folder,
      })),
    }
  }

  private emit(): void {
    this.deps.onStatus?.(this.status())
  }

  /** 설정/로그인 상태에 맞춰 실제 상태를 맞춘다. 연속 호출은 직렬화된다. */
  async reconcile(): Promise<void> {
    // 마운트/언마운트가 겹치면 스테일 마운트가 남는다 — 항상 한 줄로 세운다.
    const prev = this.busy ?? Promise.resolve()
    this.busy = prev.then(() => this.reconcileInner()).catch((e) => {
      diag('workspace', `리컨사일 실패: ${(e as Error).message}`)
    })
    return this.busy
  }

  private async reconcileInner(): Promise<void> {
    const cfg = this.deps.config()
    const agents = cfg?.agents ?? []
    const want = this.support.supported && this.deps.loggedIn() && agents.length > 0

    if (!want) {
      if (this.mountedPath) await this.teardown()
      this.emit()
      return
    }

    // 백엔드는 마운트 유무와 무관하게 항상 최신 목록을 들고 있어야 한다.
    const wired: BackendAgent[] = agents.map((a) => ({
      folder: a.folder,
      api: this.deps.apiFor(a.workflowId),
    }))
    this.backend.setAgents(wired)

    if (this.mountedPath) {
      this.emit() // 이미 붙어 있다 — 목록만 갱신되면 된다
      return
    }
    await this.setup()
    this.emit()
  }

  private async setup(): Promise<void> {
    const cfg = this.deps.config()
    const root = rootOf(cfg)
    this.lastError = undefined

    // Linux: FUSE 로 직접 붙는다. WebDAV 서버를 띄우지 않는다 — 같은 백엔드를
    // 커널이 바로 호출하므로 루프백 HTTP 를 한 겹 더 거칠 이유가 없다.
    if (this.support.kind === 'fuse') {
      const r = await mountFuse(this.backend, root)
      if (!r.ok) {
        this.lastError = r.error
        if (r.hint) this.lastError += ` (${r.hint})`
        diag('workspace', `FUSE 마운트 실패: ${r.error ?? ''}`)
        return
      }
      this.fuse = r.handle ?? null
      this.mountedPath = root
      diag('workspace', `워크스페이스 마운트(FUSE) → ${root}`)
      return
    }

    try {
      this.handle = await startDavServer(this.backend)
      diag('workspace', `WebDAV 서버 기동 port=${this.handle.port}`)
    } catch (e) {
      this.lastError = `WebDAV 서버를 띄우지 못했습니다: ${(e as Error).message}`
      diag('workspace', this.lastError)
      return
    }
    const res = await mountWebdav(this.handle.url(), root)
    if (!res.ok) {
      this.lastError = res.error
      diag('workspace', `마운트 실패: ${res.error ?? ''}`)
      await this.handle.close().catch(() => undefined)
      this.handle = null
      return
    }
    this.mountedPath = res.path ?? root
    diag('workspace', `워크스페이스 마운트 → ${this.mountedPath}`)
  }

  private async teardown(): Promise<void> {
    const path = this.mountedPath
    this.mountedPath = null
    if (this.fuse) {
      const f = this.fuse
      this.fuse = null
      try {
        await f.unmount()
      } catch (e) {
        diag('workspace', `FUSE 언마운트 실패: ${(e as Error).message}`)
      }
    } else if (path) {
      try {
        await unmountWebdav(path)
      } catch (e) {
        diag('workspace', `언마운트 실패: ${(e as Error).message}`)
      }
    }
    if (this.handle) {
      await this.handle.close().catch(() => undefined)
      this.handle = null
    }
    diag('workspace', '워크스페이스 해제 완료')
  }

  /** 앱 종료/로그아웃 — 마운트를 반드시 걷어낸다. */
  async stop(): Promise<void> {
    await this.reconcile().catch(() => undefined)
    await this.teardown()
    this.backend.dispose()
    this.emit()
  }
}

let instance: WorkspaceManager | null = null

export function initWorkspaceManager(deps: WorkspaceManagerDeps): WorkspaceManager {
  instance = new WorkspaceManager(deps)
  return instance
}
export function getWorkspaceManager(): WorkspaceManager | null {
  return instance
}
