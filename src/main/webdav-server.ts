/**
 * 로컬 WebDAV 서버 — 가상 드라이브의 **공통 핵심**.
 *
 * 세 플랫폼이 같은 서버를 서로 다른 방식으로 마운트한다:
 *
 *     Windows  WebClient 내장 클라이언트 (`net use X: http://127.0.0.1:.../`)
 *     macOS    `mount_webdav` (내장)
 *     Linux    FUSE (내장 WebDAV 클라이언트가 DE 독립적으로는 없다)
 *
 * 그래서 **프로토콜 하나, 백엔드 하나**로 끝난다 — 파일시스템 의미론이 여기
 * 한 곳에만 있고, 플랫폼별 코드는 "이 URL 을 마운트해라" 뿐이다.
 *
 * ── 보안: 인증 대신 비밀 경로 ────────────────────────────────────────
 *
 * Windows WebClient 는 **HTTP 위의 Basic 인증을 기본 차단**한다
 * (BasicAuthLevel 기본값 = SSL 전용). 로컬 루프백에 TLS 를 붙이는 것도
 * 인증서 신뢰 문제로 깨끗하지 않다. 그래서:
 *
 *   * 서버는 **127.0.0.1 에만** 바인딩한다 (다른 기기에서 접근 불가).
 *   * 모든 경로 앞에 프로세스마다 새로 만드는 **비밀 토큰**을 붙인다.
 *     토큰이 틀리면 404 — 같은 컴퓨터의 다른 프로세스가 우연히 훑어도
 *     아무것도 못 본다.
 *
 * ── 클라이언트 요구사항 (이걸 빠뜨리면 마운트가 조용히 실패한다) ────
 *
 *   * ``DAV: 1, 2`` — macOS/Windows 는 **class 2(잠금)** 가 없으면 읽기
 *     전용으로 붙거나 아예 거부한다. 실제 잠금 의미론까지는 필요 없고
 *     LOCK/UNLOCK 에 형식만 맞는 응답을 주면 된다 (단일 사용자 로컬 마운트).
 *   * ``MS-Author-Via: DAV`` — Windows 가 이걸 안 보면 읽기 전용으로 붙는다.
 *   * OPTIONS 에 Allow 목록.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes } from 'crypto'

/** 백엔드가 다루는 항목 하나. */
export interface DavNode {
  /** 부모 기준 이름 (루트는 ''). */
  name: string
  isDir: boolean
  size: number
  mtime: Date
  /** 내용 식별자 — 있으면 ETag 로 그대로 나간다. */
  etag?: string
}

/**
 * 파일시스템 뒤편. 경로는 항상 ``/`` 로 시작하는 POSIX 형태이고 루트는 ``/``.
 * 없는 경로는 :meth:`stat` 이 null 을 돌려준다 (예외 아님).
 */
export interface WebdavBackend {
  stat(path: string): Promise<DavNode | null>
  readdir(path: string): Promise<DavNode[]>
  read(path: string): Promise<Buffer>
  write(path: string, data: Buffer): Promise<void>
  mkdir(path: string): Promise<void>
  remove(path: string): Promise<void>
  move(from: string, to: string, overwrite: boolean): Promise<void>
}

export interface DavServerHandle {
  server: Server
  port: number
  token: string
  /** 마운트에 쓸 URL (끝에 / 포함). */
  url(): string
  close(): Promise<void>
}

const ALLOW = 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, LOCK, UNLOCK'

/** XML 텍스트 이스케이프 — 파일명에 &, <, > 가 들어가면 응답이 깨진다. */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 경로 정규화 — 토큰 접두사를 떼고 POSIX 경로로.
 *
 * ``..`` 를 걷어내 백엔드가 루트 밖을 보지 못하게 한다 (경로 탈출 방어는
 * 백엔드가 아니라 **여기서** 끝낸다 — 백엔드 구현이 여러 개가 되어도
 * 방어가 한 곳에 남는다).
 */
export function decodePath(rawUrl: string, token: string): string | null {
  let p: string
  try {
    p = decodeURIComponent(new URL(rawUrl, 'http://127.0.0.1').pathname)
  } catch {
    return null
  }
  const prefix = `/${token}`
  if (p !== prefix && !p.startsWith(`${prefix}/`)) return null
  p = p.slice(prefix.length) || '/'
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  return `/${parts.join('/')}`.replace(/\/+$/, '') || '/'
}

function href(token: string, path: string, isDir: boolean): string {
  const enc = path
    .split('/')
    .filter(Boolean)
    .map((s) => encodeURIComponent(s))
    .join('/')
  const base = `/${token}${enc ? `/${enc}` : ''}`
  return xmlEscape(isDir && !base.endsWith('/') ? `${base}/` : base)
}

function propfindEntry(token: string, path: string, node: DavNode): string {
  const iso = node.mtime.toUTCString()
  const created = node.mtime.toISOString().replace(/\.\d+Z$/, 'Z')
  const resourceType = node.isDir ? '<D:collection/>' : ''
  // 디렉터리에는 getcontentlength 를 주지 않는다 — 일부 클라이언트가 이를
  // 파일 신호로 받아들여 폴더를 열지 못한다.
  const len = node.isDir ? '' : `<D:getcontentlength>${node.size}</D:getcontentlength>`
  const etag = node.etag ? `<D:getetag>"${xmlEscape(node.etag)}"</D:getetag>` : ''
  return (
    `<D:response><D:href>${href(token, path, node.isDir)}</D:href>` +
    `<D:propstat><D:prop>` +
    `<D:displayname>${xmlEscape(node.name)}</D:displayname>` +
    `<D:resourcetype>${resourceType}</D:resourcetype>` +
    `${len}${etag}` +
    `<D:getlastmodified>${iso}</D:getlastmodified>` +
    `<D:creationdate>${created}</D:creationdate>` +
    `<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>` +
    `<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>` +
    `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
  )
}

function multistatus(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<D:multistatus xmlns:D="DAV:">${body}</D:multistatus>`
  )
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

function send(res: ServerResponse, status: number, body = '', headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    // 모든 응답에 붙어야 하는 것들 — 빠지면 Windows 가 읽기 전용으로 붙는다.
    DAV: '1, 2',
    'MS-Author-Via': 'DAV',
    ...headers,
  })
  res.end(body)
}

/** 로컬 WebDAV 서버를 띄운다. 127.0.0.1 + 비밀 토큰 경로. */
export async function startDavServer(
  backend: WebdavBackend,
  opts: { token?: string; port?: number } = {},
): Promise<DavServerHandle> {
  const token = opts.token ?? randomBytes(18).toString('base64url')

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      try {
        send(res, 500, String((e as Error)?.message ?? e))
      } catch {
        /* 응답이 이미 나갔다 */
      }
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method || 'GET').toUpperCase()
    const path = decodePath(req.url || '/', token)
    // 토큰 불일치 = 존재 자체를 알리지 않는다 (401 은 존재를 알려준다).
    if (path === null) return send(res, 404)

    if (method === 'OPTIONS') {
      return send(res, 200, '', { Allow: ALLOW, 'Content-Length': '0' })
    }

    // 잠금: 형식만 맞춘다. 로컬 단일 사용자 마운트라 실제 경합이 없고,
    // 클라이언트는 **응답 형식**만 보고 쓰기 가능 여부를 판단한다.
    if (method === 'LOCK') {
      const t = `opaquelocktoken:${randomBytes(12).toString('hex')}`
      return send(
        res,
        200,
        `<?xml version="1.0" encoding="utf-8"?><D:prop xmlns:D="DAV:"><D:lockdiscovery>` +
          `<D:activelock><D:locktype><D:write/></D:locktype>` +
          `<D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth>` +
          `<D:timeout>Second-3600</D:timeout>` +
          `<D:locktoken><D:href>${t}</D:href></D:locktoken>` +
          `</D:activelock></D:lockdiscovery></D:prop>`,
        { 'Content-Type': 'application/xml; charset=utf-8', 'Lock-Token': `<${t}>` },
      )
    }
    if (method === 'UNLOCK') return send(res, 204)

    if (method === 'PROPFIND') {
      const node = await backend.stat(path)
      if (!node) return send(res, 404)
      const depth = String(req.headers.depth ?? '1')
      let body = propfindEntry(token, path, node)
      if (node.isDir && depth !== '0') {
        for (const child of await backend.readdir(path)) {
          const childPath = path === '/' ? `/${child.name}` : `${path}/${child.name}`
          body += propfindEntry(token, childPath, child)
        }
      }
      return send(res, 207, multistatus(body), {
        'Content-Type': 'application/xml; charset=utf-8',
      })
    }

    if (method === 'GET' || method === 'HEAD') {
      const node = await backend.stat(path)
      if (!node) return send(res, 404)
      if (node.isDir) return send(res, 405)
      const headers: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(node.size),
        'Last-Modified': node.mtime.toUTCString(),
        'Accept-Ranges': 'bytes',
      }
      if (node.etag) headers.ETag = `"${node.etag}"`
      if (method === 'HEAD') return send(res, 200, '', headers)
      const data = await backend.read(path)
      res.writeHead(200, { DAV: '1, 2', 'MS-Author-Via': 'DAV', ...headers, 'Content-Length': String(data.length) })
      return void res.end(data)
    }

    if (method === 'PUT') {
      const data = await readBody(req)
      const existed = await backend.stat(path)
      await backend.write(path, data)
      return send(res, existed ? 204 : 201)
    }

    if (method === 'MKCOL') {
      if (await backend.stat(path)) return send(res, 405)
      await backend.mkdir(path)
      return send(res, 201)
    }

    if (method === 'DELETE') {
      if (!(await backend.stat(path))) return send(res, 404)
      await backend.remove(path)
      return send(res, 204)
    }

    if (method === 'MOVE' || method === 'COPY') {
      const dest = decodePath(String(req.headers.destination ?? ''), token)
      if (dest === null) return send(res, 400)
      const overwrite = String(req.headers.overwrite ?? 'T').toUpperCase() !== 'F'
      const existed = await backend.stat(dest)
      if (existed && !overwrite) return send(res, 412)
      if (method === 'COPY') {
        const node = await backend.stat(path)
        if (!node) return send(res, 404)
        if (node.isDir) await backend.mkdir(dest)
        else await backend.write(dest, await backend.read(path))
      } else {
        await backend.move(path, dest, overwrite)
      }
      return send(res, existed ? 204 : 201)
    }

    return send(res, 405, '', { Allow: ALLOW })
  }

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    // ⚠ 127.0.0.1 에만 바인딩한다 — 0.0.0.0 이면 같은 네트워크의 아무나
    // 사용자의 파일을 읽는다.
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  })

  return {
    server,
    port,
    token,
    url: () => `http://127.0.0.1:${port}/${token}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}
