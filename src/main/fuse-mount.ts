/**
 * Linux FUSE 마운트 — 같은 `WebdavBackend` 를 파일시스템으로 노출한다.
 *
 * 리눅스에는 데스크톱 환경에 독립적인 내장 WebDAV 클라이언트가 없다
 * (davfs2 는 별도 설치 + 대개 root, gvfs 는 GNOME 전용). 그래서 리눅스만
 * FUSE 로 직접 붙인다 — 백엔드는 macOS/Windows 와 **완전히 동일**하고,
 * 여기서는 커널이 요구하는 POSIX 의미론만 얹는다.
 *
 * ── 실기에서 확인한 두 가지 제약 ─────────────────────────────────────
 *
 * 1. **같은 프로세스에서 마운트를 동기 IO 로 읽으면 데드락**이다. FUSE 콜백이
 *    이 이벤트 루프에 올라오는데 `readFileSync` 가 루프를 막아 서로를
 *    기다린다. 그래서 이 파일의 모든 백엔드 호출은 비동기이고, 커넥터의
 *    다른 코드는 절대 자기 마운트를 만지지 않는다.
 *
 * 2. **프로세스가 죽으면 스테일 마운트가 남는다** ("Transport endpoint is not
 *    connected"). 그 상태의 디렉터리는 이후 모든 접근을 거부하므로, 마운트
 *    전에 반드시 걷어내야 한다. 안 그러면 한 번 크래시한 사용자는 폴더가
 *    영구히 먹통이 된다.
 *
 * ── 쓰기 모델 ────────────────────────────────────────────────────────
 *
 * 커널은 write 를 오프셋 단위로 잘게 보낸다. 매 조각을 서버에 올리면 파일
 * 하나 저장에 수십 번 왕복한다. 그래서 **열린 파일마다 메모리 버퍼**를 두고
 * release/flush 에서 한 번만 올린다 (네트워크 파일시스템의 표준 방식).
 */

import { accessSync, constants, existsSync, mkdirSync, readdirSync, rmdirSync, statSync } from 'fs'
import { diag } from './diag-log'
import type { WebdavBackend } from './webdav-server'

/** FUSE 바인딩 (optionalDependency — 없으면 이 플랫폼은 미지원). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FuseModule = any

const S_IFDIR = 0o040000
const S_IFREG = 0o100000

interface OpenFile {
  path: string
  buf: Buffer
  dirty: boolean
}

export interface FuseMountHandle {
  mountpoint: string
  unmount(): Promise<void>
}

/**
 * FUSE 바인딩을 불러온다.
 *
 * 프로덕션(번들된 CJS main)에서는 `require` 가 있다. 테스트는 ESM 이라
 * `require` 가 없으므로 **모듈을 주입**할 수 있게 열어 둔다 — 그래야 실제
 * 마운트를 거는 검증을 돌릴 수 있다.
 */
function loadFuse(injected?: FuseModule): FuseModule | null {
  if (injected) return injected
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('@cocalc/fuse-native')
  } catch (e) {
    diag('fuse', `바인딩 로드 실패: ${(e as Error).message}`)
    return null
  }
}

/**
 * 스테일 마운트를 걷어낸다. 정상 마운트는 건드리지 않는다.
 *
 * 판정: 디렉터리를 읽어 보고 ENOTCONN/EIO 가 나면 스테일이다.
 */
export async function clearStale(mountpoint: string, exec: typeof runCmd = runCmd): Promise<void> {
  if (!existsSync(mountpoint)) return
  try {
    readdirSync(mountpoint)
    return // 정상 (또는 아예 마운트가 아님)
  } catch (e) {
    diag('fuse', `스테일 마운트 감지 ${mountpoint}: ${(e as Error).message}`)
  }
  for (const bin of ['/usr/bin/fusermount3', '/usr/bin/fusermount', '/bin/fusermount']) {
    if (!existsSync(bin)) continue
    const r = await exec(bin, ['-uz', mountpoint])
    if (r.code === 0) {
      diag('fuse', '스테일 마운트 정리됨')
      return
    }
  }
  diag('fuse', '스테일 마운트를 정리하지 못했다')
}

async function runCmd(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  const { execFile } = await import('child_process')
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 10_000 }, (err, _o, stderr) => {
      resolve({ code: err ? 1 : 0, stderr: String(stderr ?? '') })
    })
  })
}

/**
 * 백엔드를 FUSE 연산으로 옮긴다.
 *
 * 별도 함수로 뺀 이유: FUSE 바인딩 없이도 **연산 자체를 테스트**할 수 있어야
 * 한다 (네이티브 모듈은 CI 플랫폼마다 있고 없다).
 */
export function buildOps(backend: WebdavBackend, errno: Record<string, number>): Record<string, unknown> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  const gid = typeof process.getgid === 'function' ? process.getgid() : 0
  const open = new Map<number, OpenFile>()
  let nextFd = 10

  const ENOENT = errno.ENOENT ?? -2
  const EIO = errno.EIO ?? -5
  const EISDIR = errno.EISDIR ?? -21

  const stat = (isDir: boolean, size: number, mtime: Date) => ({
    mtime,
    atime: mtime,
    ctime: mtime,
    size: isDir ? 4096 : size,
    // 소유자만 읽기/쓰기 — 워크스페이스는 이 사용자만의 것이다.
    mode: isDir ? S_IFDIR | 0o700 : S_IFREG | 0o600,
    uid,
    gid,
    nlink: 1,
  })

  /** 콜백 규약: 실패는 errno 를 돌려주고 **절대 던지지 않는다** (던지면 커널이 멈춘다). */
  const guard =
    <A extends unknown[]>(name: string, fn: (...a: A) => Promise<void>) =>
    (...args: A): void => {
      // 마지막 인자가 콜백이라는 FUSE 규약.
      const cb = args[args.length - 1] as (code: number, ...rest: unknown[]) => void
      fn(...args).catch((e) => {
        diag('fuse', `${name} 실패: ${(e as Error).message}`)
        try {
          cb(EIO)
        } catch {
          /* 이미 응답했다 */
        }
      })
    }

  return {
    readdir: guard('readdir', async (path: string, cb: (c: number, names?: string[]) => void) => {
      const node = await backend.stat(path)
      if (!node) return cb(ENOENT)
      const kids = await backend.readdir(path)
      cb(0, ['.', '..', ...kids.map((k) => k.name)])
    }),

    getattr: guard('getattr', async (path: string, cb: (c: number, s?: unknown) => void) => {
      const node = await backend.stat(path)
      if (!node) return cb(ENOENT)
      cb(0, stat(node.isDir, node.size, node.mtime))
    }),

    open: guard('open', async (path: string, _flags: number, cb: (c: number, fd?: number) => void) => {
      const node = await backend.stat(path)
      if (!node) return cb(ENOENT)
      if (node.isDir) return cb(EISDIR)
      // 전체를 한 번 읽어 버퍼에 둔다 — 커널의 잘게 쪼갠 read/write 를
      // 매번 서버로 보내면 파일 하나에 수십 번 왕복한다.
      // **복사해서** 들고 있어야 한다. 백엔드가 내부 버퍼를 그대로 돌려주는
      // 구현이면(캐시 등) write 가 그 원본을 제자리에서 훼손해, flush 전인데도
      // 서버 쪽 내용이 바뀐 것처럼 보인다.
      const buf = Buffer.from(await backend.read(path))
      const fd = nextFd++
      open.set(fd, { path, buf, dirty: false })
      cb(0, fd)
    }),

    create: guard(
      'create',
      async (path: string, _mode: number, cb: (c: number, fd?: number) => void) => {
        // ⚠ 백엔드에 **즉시** 빈 파일을 만들어야 한다. 안 그러면 커널이 바로
        // 이어서 하는 getattr 이 ENOENT 로 실패하고, 셸/편집기는 "Directory
        // nonexistent" 로 열기를 포기한다 (실기에서 확인).
        await backend.write(path, Buffer.alloc(0))
        const fd = nextFd++
        open.set(fd, { path, buf: Buffer.alloc(0), dirty: false })
        cb(0, fd)
      },
    ),

    read: guard(
      'read',
      async (
        path: string,
        fd: number,
        buffer: Buffer,
        length: number,
        position: number,
        cb: (n: number) => void,
      ) => {
        const f = open.get(fd)
        const src = f ? f.buf : await backend.read(path)
        const slice = src.subarray(position, position + length)
        slice.copy(buffer)
        cb(slice.length)
      },
    ),

    write: guard(
      'write',
      async (
        _path: string,
        fd: number,
        buffer: Buffer,
        length: number,
        position: number,
        cb: (n: number) => void,
      ) => {
        const f = open.get(fd)
        if (!f) return cb(EIO)
        if (position + length > f.buf.length) {
          const grown = Buffer.alloc(position + length)
          f.buf.copy(grown)
          f.buf = grown
        }
        buffer.subarray(0, length).copy(f.buf, position)
        f.dirty = true
        cb(length)
      },
    ),

    truncate: guard(
      'truncate',
      async (path: string, size: number, cb: (c: number) => void) => {
        const cur = await backend.read(path).catch(() => Buffer.alloc(0))
        const next = Buffer.alloc(size)
        cur.copy(next, 0, 0, Math.min(size, cur.length))
        await backend.write(path, next)
        cb(0)
      },
    ),

    ftruncate: guard(
      'ftruncate',
      async (_path: string, fd: number, size: number, cb: (c: number) => void) => {
        const f = open.get(fd)
        if (!f) return cb(EIO)
        const next = Buffer.alloc(size)
        f.buf.copy(next, 0, 0, Math.min(size, f.buf.length))
        f.buf = next
        f.dirty = true
        cb(0)
      },
    ),

    // flush 는 close() 마다 온다 — 여기서 올려야 편집기의 저장이 즉시 반영된다.
    flush: guard('flush', async (_path: string, fd: number, cb: (c: number) => void) => {
      const f = open.get(fd)
      if (f?.dirty) {
        await backend.write(f.path, f.buf)
        f.dirty = false
      }
      cb(0)
    }),

    release: guard('release', async (_path: string, fd: number, cb: (c: number) => void) => {
      const f = open.get(fd)
      if (f?.dirty) await backend.write(f.path, f.buf)
      open.delete(fd)
      cb(0)
    }),

    unlink: guard('unlink', async (path: string, cb: (c: number) => void) => {
      await backend.remove(path)
      cb(0)
    }),

    mkdir: guard('mkdir', async (path: string, _mode: number, cb: (c: number) => void) => {
      await backend.mkdir(path)
      cb(0)
    }),

    rmdir: guard('rmdir', async (path: string, cb: (c: number) => void) => {
      await backend.remove(path)
      cb(0)
    }),

    rename: guard('rename', async (src: string, dest: string, cb: (c: number) => void) => {
      await backend.move(src, dest, true)
      cb(0)
    }),

    // 커널이 크기를 물어본다 — 0 을 주면 "디스크 꽉 참"으로 보여 쓰기가 막힌다.
    statfs: guard('statfs', async (_path: string, cb: (c: number, s?: unknown) => void) => {
      const bsize = 4096
      const blocks = 2 ** 30 // 4TiB 상당 — 클라우드라 실제 상한은 서버가 정한다
      cb(0, { bsize, frsize: bsize, blocks, bfree: blocks, bavail: blocks, files: 1e6, ffree: 1e6, namemax: 255 })
    }),

    // 소유자 변경/권한 변경은 받아만 준다 — 거부하면 편집기가 저장에 실패한다.
    chmod: (_p: string, _m: number, cb: (c: number) => void) => cb(0),
    chown: (_p: string, _u: number, _g: number, cb: (c: number) => void) => cb(0),
    utimens: (_p: string, _a: unknown, _m: unknown, cb: (c: number) => void) => cb(0),
  }
}

/**
 * 마운트 전 점검 — 바인딩이 "fuse failed" 한 줄만 주므로 여기서 원인을 짚는다.
 *
 * 실기에서 확인한 필수 조건: setuid-root `fusermount` (비루트 마운트),
 * 비어 있는 마운트 지점, `/dev/fuse` 접근 권한.
 */
export function preflight(mountpoint: string): { error: string; hint?: string } | null {
  const helper = ['/usr/bin/fusermount3', '/usr/bin/fusermount', '/bin/fusermount3', '/bin/fusermount']
    .map((p) => {
      try {
        return { p, st: statSync(p) }
      } catch {
        return null
      }
    })
    .find(Boolean)
  if (!helper) {
    return {
      error: 'FUSE 도우미(fusermount)가 없습니다.',
      hint: 'sudo apt install fuse3   (설치 후 앱을 다시 시작하세요)',
    }
  }
  // 비루트 마운트는 setuid-root 헬퍼가 있어야 한다.
  const mode = helper.st.mode
  if ((mode & 0o4000) === 0 || helper.st.uid !== 0) {
    return {
      error: `${helper.p} 에 setuid 권한이 없어 마운트할 수 없습니다.`,
      hint: `sudo chmod u+s ${helper.p}`,
    }
  }
  try {
    accessSync('/dev/fuse', constants.R_OK | constants.W_OK)
  } catch {
    return {
      error: '/dev/fuse 에 접근할 수 없습니다.',
      hint: '컨테이너/스냅 환경이면 FUSE 가 막혀 있을 수 있습니다. 일반 데스크톱 세션에서 실행해 보세요.',
    }
  }
  try {
    const left = readdirSync(mountpoint)
    if (left.length > 0) {
      return {
        error: `마운트 지점에 파일이 남아 있습니다 (${left.length}개): ${mountpoint}`,
        hint: '이전 설치의 잔재일 수 있습니다. 내용을 확인한 뒤 폴더를 비우고 다시 시도하세요.',
      }
    }
  } catch (e) {
    return { error: `마운트 지점을 읽을 수 없습니다: ${(e as Error).message}` }
  }
  return null
}

/** 백엔드를 mountpoint 에 FUSE 로 붙인다. */
export async function mountFuse(
  backend: WebdavBackend,
  mountpoint: string,
  fuseModule?: FuseModule,
): Promise<{ ok: boolean; handle?: FuseMountHandle; error?: string; hint?: string }> {
  const Fuse = loadFuse(fuseModule)
  if (!Fuse) {
    return {
      ok: false,
      error: '이 빌드에 FUSE 지원이 포함되어 있지 않습니다.',
      hint: 'libfuse2 를 설치한 뒤 다시 시도하세요 (sudo apt install libfuse2 fuse3).',
    }
  }
  await clearStale(mountpoint)
  try {
    mkdirSync(mountpoint, { recursive: true })
  } catch (e) {
    return { ok: false, error: `마운트 지점을 만들지 못했습니다: ${(e as Error).message}` }
  }

  // 바인딩의 실패 메시지는 "fuse failed" 한 줄이라 원인을 알 수 없다.
  // 미리 짚어서 **무엇이 막혔는지** 말한다.
  const pre = preflight(mountpoint)
  if (pre) {
    diag('fuse', `사전 점검 실패: ${pre.error}`)
    return { ok: false, ...pre }
  }

  const ops = buildOps(backend, Fuse as unknown as Record<string, number>)
  const fuse = new Fuse(mountpoint, ops, { force: true, mkdir: true, displayFolder: 'XGEN Workspace' })

  return new Promise((resolve) => {
    fuse.mount((err: Error | null) => {
      if (err) {
        diag('fuse', `마운트 실패: ${err.message}`)
        // 바인딩은 대개 "fuse failed" 한 줄만 준다 — 사전 점검을 통과했는데도
        // 실패했다는 사실 자체가 정보다.
        resolve({
          ok: false,
          error: `마운트 실패: ${err.message}`,
          hint:
            '사전 점검(fusermount setuid / /dev/fuse / 빈 폴더)은 통과했습니다. ' +
            '진단 로그를 보내 주세요.',
        })
        return
      }
      diag('fuse', `마운트 성공 → ${mountpoint}`)
      resolve({
        ok: true,
        handle: {
          mountpoint,
          unmount: () =>
            new Promise<void>((done) => {
              fuse.unmount(() => {
                try {
                  if (existsSync(mountpoint) && readdirSync(mountpoint).length === 0) {
                    rmdirSync(mountpoint)
                  }
                } catch {
                  /* 정리 실패는 무해 */
                }
                diag('fuse', '언마운트 완료')
                done()
              })
            }),
        },
      })
    })
  })
}
