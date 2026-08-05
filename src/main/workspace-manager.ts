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
  /** 로그인한 사용자의 클라우드 스토리지 API (루트). 없으면 에이전트만. */
  userApi?: () => WorkspaceApi | null
  /** 현재 로그인한 사용자의 owner key (`user:<id>`). 없으면 null. */
  userOwner?: () => string | null
  /**
   * 저장소 하나에 대한 **접속 표시(presence)**. 서버에 "이 PC 가 이 저장소에
   * 붙어 있다"를 알리고, 변경 알림을 받는다.
   *
   * 이게 없으면 두 가지가 조용히 빠진다:
   *   1. 웹의 "PC N대 동기화 중" 칩이 영영 안 뜬다 (기기 등록이 hello 로만 된다)
   *   2. 서버 변경을 못 받아, 웹에서 올린 파일이 드라이브에 늦게/안 나타난다
   */
  presenceFor?: (owner: string, onChanged: () => void) => WorkspacePresence
  onStatus?: (s: WorkspaceStatus) => void
}

/** 저장소 하나에 대한 서버 접속 표시. */
export interface WorkspacePresence {
  start(): Promise<void>
  stop(): void
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
  /** 오류를 사용자가 직접 풀 수 있는 방법 (설치 명령 등). */
  errorHint?: string
  /**
   * 클라우드 스토리지가 **꺼져 있어서** 루트가 없는 경우의 사유.
   *
   * 관리자가 조직 전체에서 껐거나, 사용자가 자기 설정에서 껐다는 뜻이다.
   * 오류가 아니므로 error 와 구분한다 — "실패"로 보이면 사용자가 고치려
   * 든다. 서버 문구를 그대로 실어 무엇을 켜야 하는지 알린다.
   */
  storageOff?: string
  agents: Array<{ workflowId: string; label: string; folder: string }>
}

/**
 * ⚠ **이 프로세스는 자기 마운트를 절대 동기 IO 로 만지면 안 된다.**
 *
 * FUSE 콜백이 이 이벤트 루프에 올라온다. 루프를 막는 동기 호출이 마운트를
 * 향하면 콜백이 응답하지 못하고 **서로를 기다리는 데드락**이 된다 (실기:
 * shell.openPath 로 "폴더 열기"를 누르는 순간 앱이 응답 없음).
 *
 * 그래서 마운트 경로를 다루는 일은 전부 자식 프로세스나 비동기로 한다.
 */
export class WorkspaceManager {
  private backend = new WorkspaceDavBackend()
  private handle: DavServerHandle | null = null
  /** Linux 는 WebDAV 서버 없이 FUSE 로 직접 붙는다 (내장 클라이언트가 없다). */
  private fuse: FuseMountHandle | null = null
  private mountedPath: string | null = null
  // ⚠ **기동 시점에 만들지 않는다.** 판정은 네이티브 FUSE 바인딩을 require
  // 하는데, ABI 가 어긋난 .node 의 dlopen 은 JS 예외가 아니라 **프로세스를
  // 통째로 죽일 수 있다**. 앱이 켜지자마자 죽으면 사용자는 원인을 알 길이
  // 없으므로, 워크스페이스가 실제로 필요해질 때까지 미룬다.
  private supportCache: MountSupport | null = null

  private get support(): MountSupport {
    if (!this.supportCache) this.supportCache = detectMountSupport()
    return this.supportCache
  }
  private lastError: string | undefined
  private lastHint: string | undefined
  /** 클라우드 스토리지가 꺼져 있을 때의 사유 (오류가 아니다). */
  private storageOff: string | undefined
  /** owner → 접속 표시. 마운트되어 있는 동안만 살아 있다. */
  private presence = new Map<string, WorkspacePresence>()
  private busy: Promise<void> | null = null

  constructor(private deps: WorkspaceManagerDeps) {}

  status(): WorkspaceStatus {
    const cfg = this.deps.config()
    // 불변식: **연결되지 않았다면 반드시 이유가 있어야 한다.**
    // 이유 없이 안 붙어 있으면 사용자는 (마운트가 아닌) 빈 폴더에 파일을 넣고
    // 그 파일은 아무 데도 가지 않는다. 원인을 못 밝히더라도 "모른다"고는
    // 말해야 한다 — 침묵이 가장 나쁘다.
    const attached = (cfg?.agents ?? []).length > 0
    const wants = attached || !!this.deps.userApi?.()
    if (
      wants &&
      this.mountedPath === null &&
      this.support.supported &&
      !this.lastError &&
      !this.storageOff
    ) {
      this.lastError = '드라이브를 연결하지 못했습니다 (원인 미상 — 진단 로그를 확인하세요)'
    }
    return {
      supported: this.support.supported,
      reason: this.support.reason,
      hint: this.support.hint,
      mounted: this.mountedPath !== null,
      path: this.mountedPath ?? undefined,
      error: this.lastError,
      errorHint: this.lastHint,
      storageOff: this.storageOff,
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
    this.busy = prev
      .then(() => this.reconcileInner())
      .catch((e) => {
        // 진단 로그에만 남기면 화면에는 **아무 이유 없이 연결 안 됨**으로
        // 보인다. 사용자는 폴더가 있으니 파일을 넣고, 그 파일은 아무 데도
        // 가지 않는다 — 실제로 그렇게 잃어버렸다. 반드시 화면까지 올린다.
        this.lastError = `연결하지 못했습니다: ${(e as Error).message}`
        diag('workspace', `리컨사일 실패: ${(e as Error).message}`)
        this.emit()
      })
    return this.busy
  }

  /**
   * 사용자 클라우드 스토리지를 실제로 쓸 수 있는지 서버에 물어본다.
   *
   * on/off 는 **두 곳**에 있다 — 관리자 전역 설정과 사용자 개인 설정. 어느
   * 쪽이 껐는지 커넥터가 따로 알 필요는 없다. 서버가 403 으로 거절하면
   * 그것이 곧 "꺼짐"이고, 사유 문구도 서버가 준다 (게이트 판정을 여기서
   * 흉내내면 서버와 어긋난다).
   *
   * 403 이 아닌 실패(네트워크 등)는 **꺼짐이 아니다**. 잠깐 끊겼다고 루트를
   * 떼면 파일이 전부 사라진 것처럼 보인다 — 그때는 그대로 붙여 둔다.
   */
  private async probeUserStorage(api: WorkspaceApi | null): Promise<WorkspaceApi | null> {
    if (!api) {
      this.storageOff = undefined
      return null
    }
    try {
      await api.changes(0)
      this.storageOff = undefined
      return api
    } catch (e) {
      const status = (e as { status?: number }).status
      if (status === 403) {
        const why = (e as Error).message || '클라우드 스토리지가 꺼져 있습니다'
        if (this.storageOff !== why) diag('workspace', `사용자 클라우드 스토리지 꺼짐: ${why}`)
        this.storageOff = why
        return null
      }
      // 일시적 실패 — 백엔드의 트리 캐시가 알아서 버틴다.
      diag('workspace', `사용자 스토리지 확인 실패(무시): ${(e as Error).message}`)
      this.storageOff = undefined
      return api
    }
  }

  private async reconcileInner(): Promise<void> {
    const cfg = this.deps.config()
    const agents = cfg?.agents ?? []

    // 붙은 에이전트가 없으면 **플랫폼 판정조차 하지 않는다** — 판정이
    // 네이티브 바인딩을 로드하므로, 갓 설치한 사용자가 앱을 켜자마자
    // 그것 때문에 죽는 일이 없어야 한다.
    // 에이전트가 하나도 없어도 **사용자 클라우드 스토리지가 있으면 마운트**한다
    // — 내 스토리지를 쓰는 데 에이전트 연결이 전제일 이유가 없다.
    // 로그인 상태에서만 서버에 물어본다 (로그아웃이면 어차피 걷는다).
    const userApi = this.deps.loggedIn()
      ? await this.probeUserStorage(this.deps.userApi?.() ?? null)
      : null
    const hasUser = !!userApi
    if ((agents.length === 0 && !hasUser) || !this.deps.loggedIn()) {
      if (this.mountedPath) await this.teardown()
      this.deps.onStatus?.({
        supported: this.supportCache?.supported ?? true,
        reason: this.supportCache?.reason,
        hint: this.supportCache?.hint,
        mounted: false,
        error: this.lastError,
        storageOff: this.storageOff,
        agents: [],
      })
      return
    }

    if (!this.support.supported) {
      if (this.mountedPath) await this.teardown()
      this.emit()
      return
    }

    // 백엔드는 마운트 유무와 무관하게 항상 최신 목록을 들고 있어야 한다.
    // 루트 = 사용자 클라우드 스토리지, 그 안에 연결된 에이전트가 폴더로.
    this.backend.setUserStorage(userApi)
    const wired: BackendAgent[] = agents.map((a) => ({
      folder: a.folder,
      api: this.deps.apiFor(a.workflowId),
    }))
    this.backend.setAgents(wired)

    if (this.mountedPath) {
      this.syncPresence(userApi, agents)
      this.emit() // 이미 붙어 있다 — 목록만 갱신되면 된다
      return
    }
    await this.setup()
    if (this.mountedPath) this.syncPresence(userApi, agents)
    this.emit()
  }

  /**
   * 지금 드라이브가 서빙하는 저장소들에 접속 표시를 맞춘다.
   *
   * 마운트되어 있는 동안만 유지한다 — 드라이브가 없는데 "이 PC 가 붙어 있다"고
   * 알리면 웹에서 연결된 것처럼 보이는데 실제로는 아무것도 동기화되지 않는다.
   */
  private syncPresence(
    userApi: WorkspaceApi | null,
    agents: Array<{ workflowId: string; folder: string }>,
  ): void {
    if (!this.deps.presenceFor) return
    const want = new Map<string, string>() // owner → 캐시 키
    const userOwner = userApi ? (this.deps.userOwner?.() ?? null) : null
    if (userOwner) want.set(userOwner, '')
    for (const a of agents) want.set(a.workflowId, a.folder)

    for (const [owner, p] of [...this.presence]) {
      if (!want.has(owner)) {
        p.stop()
        this.presence.delete(owner)
      }
    }
    for (const [owner, key] of want) {
      if (this.presence.has(owner)) continue
      const p = this.deps.presenceFor(owner, () => this.backend.invalidateSpace(key))
      this.presence.set(owner, p)
      void p.start().catch((e) => diag('workspace', `접속 표시 실패 ${owner}: ${(e as Error).message}`))
    }
  }

  private stopPresence(): void {
    for (const p of this.presence.values()) p.stop()
    this.presence.clear()
  }

  private async setup(): Promise<void> {
    const cfg = this.deps.config()
    const root = rootOf(cfg)
    this.lastError = undefined
    this.lastHint = undefined

    // Linux: FUSE 로 직접 붙는다. WebDAV 서버를 띄우지 않는다 — 같은 백엔드를
    // 커널이 바로 호출하므로 루프백 HTTP 를 한 겹 더 거칠 이유가 없다.
    if (this.support.kind === 'fuse') {
      const r = await mountFuse(this.backend, root)
      if (!r.ok) {
        this.lastError = r.error
        this.lastHint = r.hint
        diag('workspace', `FUSE 마운트 실패: ${r.error ?? ''} / ${r.hint ?? ''}`)
        return
      }
      this.lastHint = undefined
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
    // 드라이브가 걷히면 접속 표시도 같이 내린다 — 안 그러면 웹에는 연결된
    // 것처럼 남아 있는데 실제로는 아무것도 동기화되지 않는다.
    this.stopPresence()
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
