/**
 * 실행 파일 해석 — `spawn uvx ENOENT` 부류의 근본 원인 처리.
 *
 * GUI 로 실행된 앱(Finder/Dock/시작 메뉴)은 **로그인 셸의 PATH 를 상속하지
 * 않는다**. macOS 는 `/usr/bin:/bin:/usr/sbin:/sbin` 수준만 물려받아
 * `~/.local/bin/uvx`, `/opt/homebrew/bin/npx` 같은 사용자 설치 도구를 전부
 * 못 찾는다. Windows 는 `npx`/`uvx` 가 `.cmd`/`.exe` 라 확장자 해석 없이는
 * spawn 이 실패한다.
 *
 * 그래서 두 가지를 한다:
 *   1) PATH 보강 — 로그인 셸에서 실제 PATH 를 한 번 읽어오고(캐시), 흔한
 *      사용자 설치 경로를 덧붙인다.
 *   2) 명시적 해석 — 보강된 PATH 에서 실행 파일을 직접 찾아 **절대 경로**로
 *      spawn 한다 (Windows 는 PATHEXT 순회). 못 찾으면 무엇을 찾았는지
 *      알려주는 오류를 던진다.
 */

import { execFile } from 'child_process';
import { accessSync, constants, statSync } from 'fs';
import { homedir } from 'os';
import { delimiter, isAbsolute, join, sep } from 'path';

const IS_WIN = process.platform === 'win32';

/** 사용자 도구가 흔히 설치되는 위치 (플랫폼별). */
export function commonBinDirs(home = homedir()): string[] {
  if (IS_WIN) {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return [
      join(localAppData, 'Microsoft', 'WindowsApps'),
      join(appData, 'npm'),
      join(home, '.local', 'bin'),
      join(home, '.cargo', 'bin'),
      join(home, '.bun', 'bin'),
      join(localAppData, 'Programs', 'Python', 'Scripts'),
    ];
  }
  return [
    '/opt/homebrew/bin', // Apple Silicon homebrew
    '/usr/local/bin',
    '/opt/local/bin', // MacPorts
    join(home, '.local', 'bin'), // uv / pipx
    join(home, '.cargo', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.deno', 'bin'),
    join(home, 'bin'),
    '/usr/bin',
    '/bin',
  ];
}

let loginPathCache: string | null | undefined;

/** 로그인 셸의 PATH 를 한 번 읽는다 (darwin/linux). 실패/지연은 무시. */
export async function loginShellPath(): Promise<string | null> {
  if (IS_WIN) return null;
  if (loginPathCache !== undefined) return loginPathCache;
  const shell = process.env.SHELL || '/bin/bash';
  loginPathCache = await new Promise<string | null>((resolve) => {
    // 마커로 감싸 rc 파일이 뱉는 잡음과 분리한다. -i 는 일부 환경에서 멈출 수
    // 있어 타임아웃으로 끊는다 (실패해도 보강 목록만으로 동작).
    execFile(
      shell,
      ['-ilc', 'printf "__XGEN_PATH__%s__END__" "$PATH"'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const m = /__XGEN_PATH__([\s\S]*?)__END__/.exec(stdout);
        resolve(m && m[1] ? m[1].trim() : null);
      },
    );
  });
  return loginPathCache;
}

/** 중복 제거 + 빈 항목 제거로 PATH 문자열을 만든다. */
export function mergePaths(...sources: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const src of sources) {
    if (!src) continue;
    for (const p of src.split(delimiter)) {
      const dir = p.trim().replace(new RegExp(`${sep === '\\' ? '\\\\' : sep}+$`), '');
      if (!dir || seen.has(dir)) continue;
      seen.add(dir);
      out.push(dir);
    }
  }
  return out.join(delimiter);
}

/** GUI 실행에서도 사용자 도구를 찾을 수 있는 PATH. */
export async function augmentedPath(): Promise<string> {
  const login = await loginShellPath();
  return mergePaths(login, process.env.PATH, commonBinDirs().join(delimiter));
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (IS_WIN) return true; // Windows 는 확장자로 실행 가능성을 판단
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Windows 확장자 후보 (PATHEXT). npx/uvx 는 실제로 npx.cmd/uvx.exe 다. */
function winExtensions(): string[] {
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return raw.split(';').map((e) => e.trim()).filter(Boolean);
}

/**
 * *command* 의 절대 경로를 찾는다. 경로 구분자가 들어 있으면 그대로 검증만
 * 한다. 못 찾으면 null.
 */
export function resolveExecutable(command: string, pathStr: string): string | null {
  const cmd = command.trim();
  if (!cmd) return null;
  const hasSep = cmd.includes('/') || (IS_WIN && cmd.includes('\\'));
  const candidates = (base: string): string[] =>
    IS_WIN
      ? [base, ...winExtensions().map((e) => base + e)]
      : [base];

  if (hasSep || isAbsolute(cmd)) {
    for (const c of candidates(cmd)) if (isExecutableFile(c)) return c;
    return null;
  }
  for (const dir of pathStr.split(delimiter)) {
    if (!dir) continue;
    for (const c of candidates(join(dir, cmd))) {
      if (isExecutableFile(c)) return c;
    }
  }
  return null;
}

/** 못 찾았을 때 사용자에게 보여줄 안내 (무엇을 어디서 찾았는지). */
export function notFoundMessage(command: string, pathStr: string): string {
  const dirs = pathStr.split(delimiter).filter(Boolean);
  const shown = dirs.slice(0, 6).join(', ');
  return (
    `실행 파일을 찾을 수 없습니다: "${command}"\n` +
    `PATH 에서 찾지 못했습니다 (${dirs.length}개 경로 검색: ${shown}${dirs.length > 6 ? ' …' : ''}).\n` +
    `· 설치되어 있는지 확인하세요 (예: uv/uvx 는 "curl -LsSf https://astral.sh/uv/install.sh | sh")\n` +
    `· 또는 실행 명령에 절대 경로를 적으세요 (예: ${IS_WIN ? 'C:\\\\Users\\\\me\\\\.local\\\\bin\\\\uvx.exe' : '/Users/me/.local/bin/uvx'})`
  );
}
