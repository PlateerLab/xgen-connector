/**
 * 플랫폼별 마운트 실행기 — "이 WebDAV URL 을 이 경로에 붙여라".
 *
 * 서버는 공통이고 여기서 하는 일은 OS 에게 마운트를 시키는 것뿐이다:
 *
 *     macOS    mount_webdav -S -i <url> <mountpoint>
 *     Windows  net use <drive> <url> /persistent:no
 *     Linux    (FUSE — 별도 제공자)
 *
 * **모든 단계를 진단 로그에 남긴다.** 마운트 실패는 사용자 컴퓨터에서만
 * 재현되는 대표적인 문제라, 그 순간의 명령·종료코드·stderr 가 없으면 원인을
 * 추측할 수밖에 없다.
 */

import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, rmdirSync } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { diag } from './diag-log'

export interface MountResult {
  ok: boolean
  /** 실제로 붙은 경로 (Windows 는 드라이브 문자). */
  path?: string
  error?: string
  /** 사용자에게 보여줄 다음 행동. */
  hint?: string
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** 명령 실행 + 로깅. 절대 throw 하지 않는다 — 실패도 결과다. */
export async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<RunResult> {
  diag('mount', `exec ${cmd} ${args.join(' ')}`)
  return new Promise<RunResult>((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 30_000, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout, stderr) => {
        const res: RunResult = {
          code: err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        }
        diag('mount', `exit=${res.code}`, {
          stdout: res.stdout.slice(0, 500),
          stderr: res.stderr.slice(0, 500),
        })
        resolve(res)
      },
    )
  })
}

// ── macOS ────────────────────────────────────────────────────────────

/**
 * macOS: `mount_webdav`.
 *
 * 옵션 근거:
 *   `-S` 인증 대화상자를 띄우지 않는다 (우리는 비밀 경로를 쓰므로 인증이
 *        없고, 대화상자가 뜨면 마운트가 사용자 응답을 기다리며 멈춘다).
 *   `-i` 필요 시 대화형 — `-S` 와 함께 쓰면 실패를 즉시 돌려준다.
 *
 * 마운트포인트는 **미리 존재해야** 하고 비어 있어야 한다.
 */
export async function mountMacos(url: string, mountpoint: string): Promise<MountResult> {
  await unmountMacos(mountpoint) // 스테일 정리 (아래 설명)
  try {
    mkdirSync(mountpoint, { recursive: true })
  } catch (e) {
    return { ok: false, error: `마운트 지점을 만들지 못했습니다: ${(e as Error).message}` }
  }
  const r = await run('/sbin/mount_webdav', ['-S', '-i', url, mountpoint])
  if (r.code === 0) {
    diag('mount', `macOS 마운트 성공: ${mountpoint}`)
    return { ok: true, path: mountpoint }
  }
  const err = (r.stderr || r.stdout).trim()
  return {
    ok: false,
    error: err || `mount_webdav 가 코드 ${r.code} 로 실패했습니다`,
    hint:
      'Finder 에서 "이동 > 서버에 연결"로 같은 주소가 열리는지 확인해 보세요. ' +
      '계속 실패하면 진단 로그를 보내 주세요.',
  }
}

export async function unmountMacos(mountpoint: string): Promise<void> {
  if (!existsSync(mountpoint)) return
  // 마운트돼 있지 않아도 umount 는 무해하게 실패한다 — 상태 조회보다 싸다.
  await run('/sbin/umount', ['-f', mountpoint], { timeoutMs: 10_000 })
  try {
    // 빈 디렉터리만 정리 (사용자 파일이 남아 있으면 건드리지 않는다).
    if (existsSync(mountpoint) && readdirSync(mountpoint).length === 0) rmdirSync(mountpoint)
  } catch {
    /* 정리는 실패해도 무방 */
  }
}

// ── Windows ──────────────────────────────────────────────────────────

/** 쓸 수 있는 드라이브 문자를 고른다 (Z 부터 거꾸로 — 흔한 문자를 피한다). */
export async function pickDriveLetter(): Promise<string | null> {
  const used = new Set<string>()
  const r = await run('cmd.exe', ['/d', '/s', '/c', 'net use'])
  for (const m of r.stdout.matchAll(/^\s*\S*\s+([A-Z]):/gim)) used.add(m[1].toUpperCase())
  for (const c of 'ZYXWVUTSRQPONMLKJIH') {
    if (!used.has(c) && !existsSync(`${c}:\\`)) return `${c}:`
  }
  return null
}

/**
 * Windows: 내장 WebClient 로 드라이브를 붙인다.
 *
 * ⚠ WebClient 는 기본 **50MB 파일 상한**이 있다 (FileSizeLimitInBytes).
 * 이건 레지스트리(HKLM) 조정이라 설치 프로그램에서 다루고, 여기서는 상한에
 * 걸렸을 때 사용자가 원인을 알 수 있도록 로그에 남긴다.
 */
export async function mountWindows(url: string): Promise<MountResult> {
  // WebClient 가 꺼져 있으면 net use 가 "시스템 오류 67" 로 실패한다 —
  // 시작을 시도하고, 안 되면 사용자에게 그대로 알린다.
  await run('cmd.exe', ['/d', '/s', '/c', 'sc start WebClient'], { timeoutMs: 15_000 })
  const drive = await pickDriveLetter()
  if (!drive) {
    return { ok: false, error: '사용 가능한 드라이브 문자가 없습니다.' }
  }
  const r = await run('cmd.exe', ['/d', '/s', '/c', `net use ${drive} ${url} /persistent:no`])
  if (r.code === 0) {
    diag('mount', `Windows 마운트 성공: ${drive}`)
    return { ok: true, path: drive }
  }
  const err = (r.stdout || r.stderr).trim()
  return {
    ok: false,
    error: err || `net use 가 코드 ${r.code} 로 실패했습니다`,
    hint: /67|WebClient/i.test(err)
      ? 'Windows 의 "WebClient" 서비스가 필요합니다. 서비스 관리자에서 시작한 뒤 다시 시도하세요.'
      : undefined,
  }
}

export async function unmountWindows(drive: string): Promise<void> {
  if (!drive) return
  await run('cmd.exe', ['/d', '/s', '/c', `net use ${drive} /delete /y`], { timeoutMs: 15_000 })
}

// ── Linux (FUSE 제공자가 별도로 처리) ────────────────────────────────

/**
 * 스테일 FUSE 마운트 정리.
 *
 * 프로세스가 죽으면 마운트포인트가 "Transport endpoint is not connected"
 * 상태로 남아 **이후 모든 접근을 막는다** (실기에서 확인). 기동 시 이걸
 * 걷어내지 않으면 한 번 크래시한 사용자는 폴더가 영구히 먹통이 된다.
 */
export async function clearStaleFuse(mountpoint: string): Promise<boolean> {
  if (!existsSync(mountpoint)) return false
  try {
    readdirSync(mountpoint)
    return false // 정상 — 건드리지 않는다
  } catch (e) {
    const msg = (e as Error).message
    diag('mount', `스테일 마운트 감지: ${mountpoint} (${msg})`)
    for (const bin of ['/usr/bin/fusermount3', '/usr/bin/fusermount', '/bin/fusermount']) {
      if (!existsSync(bin)) continue
      const r = await run(bin, ['-uz', mountpoint], { timeoutMs: 10_000 })
      if (r.code === 0) {
        diag('mount', '스테일 마운트 정리됨')
        return true
      }
    }
    diag('mount', '스테일 마운트를 정리하지 못했다 — 사용자 개입 필요')
    return false
  }
}

// ── 통합 진입점 ──────────────────────────────────────────────────────

export function defaultMountpoint(root: string): string {
  // macOS 는 /Volumes 대신 사용자 홈 아래를 쓴다 — /Volumes 쓰기는 권한이
  // 걸리고, 홈 아래면 Finder 사이드바에도 자연스럽게 붙는다.
  return process.platform === 'darwin' ? root : root
}

export async function mountWebdav(
  url: string,
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<MountResult> {
  diag('mount', `마운트 시작 platform=${platform} root=${basename(root)}`)
  if (platform === 'darwin') return mountMacos(url, defaultMountpoint(root))
  if (platform === 'win32') return mountWindows(url)
  return {
    ok: false,
    error: `${platform} 에서는 WebDAV 마운트를 지원하지 않습니다.`,
    hint: 'Linux 는 FUSE 제공자를 사용합니다.',
  }
}

export async function unmountWebdav(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  diag('mount', `언마운트 ${path}`)
  if (platform === 'darwin') return unmountMacos(path)
  if (platform === 'win32') return unmountWindows(path)
}

/** 기본 루트 (마운트 지점). */
export function defaultRootPath(home = homedir()): string {
  return join(home, 'XGEN-Workspace')
}
