/**
 * 가상 드라이브 검증 — 실제 사용자 컴퓨터에서 마운트가 되는지 찍어 보는 최소 경로.
 *
 * 전체 배선(서버 백엔드·UI·에이전트 부착)은 전부 **검증되지 않은 가정 하나**
 * 위에 얹혀 있다: "OS 내장 WebDAV 클라이언트가 인증 없이, 사용자 홈 아래
 * 마운트 지점에, 관리자 권한 없이 실제로 붙는가". 이건 개발 환경에서 확인할
 * 수 없고, 틀리면 그 위에 쌓은 것이 전부 무의미해진다.
 *
 * 그래서 이 모듈은 그 가정만 찍는다: 데모 파일 몇 개를 담은 WebDAV 서버를
 * 띄우고 마운트한 뒤, 결과와 진단 로그를 돌려준다.
 */

import { diag, diagHeader, diagText } from './diag-log'
import { mountWebdav, unmountWebdav, defaultRootPath } from './mount-runner'
import { startDavServer, type DavNode, type DavServerHandle, type WebdavBackend } from './webdav-server'

/** 데모 내용 — 한글·공백·기호를 일부러 섞는다 (인코딩 문제를 여기서 잡는다). */
const DEMO: Record<string, string> = {
  '/읽어보세요.txt':
    'XGEN 가상 드라이브가 정상 동작합니다.\n' +
    '이 폴더는 XGEN Connector 가 만든 것이며, 앱을 끄면 사라집니다.\n',
  '/샘플 문서 & 메모.md': '# 샘플\n\n한글·공백·기호가 든 이름이 제대로 보이면 성공입니다.\n',
}
const DEMO_DIR = '/하위 폴더'

class DemoBackend implements WebdavBackend {
  private files = new Map<string, Buffer>()
  private dirs = new Set<string>(['/', DEMO_DIR])

  constructor() {
    for (const [p, body] of Object.entries(DEMO)) this.files.set(p, Buffer.from(body, 'utf8'))
    this.files.set(`${DEMO_DIR}/안에 있는 파일.txt`, Buffer.from('하위 폴더도 열립니다.\n', 'utf8'))
  }

  private node(p: string, isDir: boolean, size: number): DavNode {
    return {
      name: p === '/' ? '' : p.slice(p.lastIndexOf('/') + 1),
      isDir,
      size,
      mtime: new Date(),
      etag: `${size}`,
    }
  }

  async stat(p: string): Promise<DavNode | null> {
    if (this.dirs.has(p)) return this.node(p, true, 0)
    const f = this.files.get(p)
    return f ? this.node(p, false, f.length) : null
  }

  async readdir(p: string): Promise<DavNode[]> {
    const prefix = p === '/' ? '/' : `${p}/`
    const out: DavNode[] = []
    for (const d of this.dirs) {
      if (d === p || !d.startsWith(prefix) || d.slice(prefix.length).includes('/')) continue
      out.push(this.node(d, true, 0))
    }
    for (const [f, body] of this.files) {
      if (!f.startsWith(prefix) || f.slice(prefix.length).includes('/')) continue
      out.push(this.node(f, false, body.length))
    }
    return out
  }

  async read(p: string): Promise<Buffer> {
    return this.files.get(p) ?? Buffer.alloc(0)
  }
  async write(p: string, d: Buffer): Promise<void> {
    // 쓰기도 받아야 클라이언트가 "읽기 전용"으로 붙지 않는다 (검증 목적).
    this.files.set(p, d)
    diag('probe', `쓰기 수신 ${p} (${d.length}B)`)
  }
  async mkdir(p: string): Promise<void> {
    this.dirs.add(p)
  }
  async remove(p: string): Promise<void> {
    this.files.delete(p)
    this.dirs.delete(p)
  }
  async move(from: string, to: string): Promise<void> {
    const f = this.files.get(from)
    if (f) {
      this.files.delete(from)
      this.files.set(to, f)
    }
  }
}

export interface ProbeResult {
  ok: boolean
  /** 마운트된 경로 (또는 Windows 드라이브 문자). */
  path?: string
  error?: string
  hint?: string
  /** 사용자가 복사해 보낼 진단 텍스트 (마스킹 완료). */
  log: string
}

let active: { handle: DavServerHandle; path: string } | null = null

/** 현재 검증 마운트가 살아 있는가. */
export function probeActive(): { mounted: boolean; path?: string } {
  return active ? { mounted: true, path: active.path } : { mounted: false }
}

/** 데모 WebDAV 서버를 띄우고 마운트한다. 실패해도 던지지 않는다. */
export async function runMountProbe(): Promise<ProbeResult> {
  await stopMountProbe() // 재실행 시 이전 것을 먼저 정리
  const root = defaultRootPath()
  diag('probe', '─── 가상 드라이브 검증 시작 ───')
  diag('probe', diagHeader({ root }))

  let handle: DavServerHandle
  try {
    handle = await startDavServer(new DemoBackend())
  } catch (e) {
    const msg = `WebDAV 서버를 띄우지 못했습니다: ${(e as Error).message}`
    diag('probe', msg)
    return { ok: false, error: msg, log: diagText() }
  }
  diag('probe', `서버 기동 port=${handle.port}`)

  const res = await mountWebdav(handle.url(), root)
  if (!res.ok) {
    await handle.close()
    diag('probe', `마운트 실패: ${res.error ?? ''}`)
    return { ok: false, error: res.error, hint: res.hint, log: diagText() }
  }

  active = { handle, path: res.path ?? root }
  diag('probe', `마운트 성공 → ${active.path}`)
  return { ok: true, path: active.path, log: diagText() }
}

/** 검증 마운트를 걷어낸다 (앱 종료·로그아웃 시에도 호출). */
export async function stopMountProbe(): Promise<void> {
  if (!active) return
  const { handle, path } = active
  active = null
  try {
    await unmountWebdav(path)
  } catch (e) {
    diag('probe', `언마운트 실패: ${(e as Error).message}`)
  }
  try {
    await handle.close()
  } catch {
    /* 이미 닫혔다 */
  }
  diag('probe', '검증 마운트 정리 완료')
}
