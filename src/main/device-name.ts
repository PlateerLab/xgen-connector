/**
 * 이 PC 의 이름 — 클라우드 안에서 폴더가 되는 그 이름.
 *
 *     {XgenCloud} / {PC 이름} / (파일)
 *
 * **로컬 로그인 이름은 여기 들어갈 이유가 없다.** 클라우드는 이미 XGEN 계정으로
 * 갈린다 — A 계정의 클라우드에 닿을 수 있는 것은 A 로 로그인한 커넥터뿐이다.
 * 그 안에서 폴더를 나누는 축은 "누구" 가 아니라 "어느 기기" 다.
 *
 * 그런데 리눅스·맥 배포판은 설치할 때 호스트명을 `{로그인이름}-{모델}` 로
 * 만들어 둔다. 그대로 쓰면 클라우드에 `hrjang-Crosshair-17-HX-D14VGKG` 같은
 * 폴더가 생긴다 — 앞의 `hrjang` 은 이 트리 안에서 아무것도 구분하지 않는
 * 잡음이고, 계정 이름과 다르기까지 하면 사용자를 헷갈리게 한다.
 *
 * 그래서 기본값에서 그 접두사만 걷어낸다. 걷어내고 남는 게 없으면 원래
 * 호스트명을 쓴다 — 이름이 없는 것보다 잡음이 낫다.
 *
 * 물론 자동 규칙은 언제나 누군가의 기기에서 어색하다. 그래서 사용자가 직접
 * 정할 수 있고(설정 → PC 이름), 정해 두면 이 규칙은 관여하지 않는다.
 */

/** 호스트명 앞에 붙은 로컬 로그인 이름을 걷어낸 기본 PC 이름. */
export function defaultDeviceName(hostname: string, localUser: string): string {
  const host = String(hostname || '').trim()
  const user = String(localUser || '').trim()
  if (!host) return user || 'PC'
  if (!user) return host

  // `hrjang-Crosshair-17` · `hrjang.local` · `hrjangs-MacBook-Pro`
  const lower = host.toLowerCase()
  const u = user.toLowerCase()
  for (const prefix of [`${u}-`, `${u}_`, `${u}.`, `${u}s-`, `${u}'s-`]) {
    if (lower.startsWith(prefix)) {
      const rest = host.slice(prefix.length).trim()
      // 접두사를 떼고 나면 아무것도 안 남는 경우(호스트명이 곧 로그인 이름)는
      // 원래 이름을 쓴다. 빈 이름은 폴더가 될 수 없다.
      if (rest) return rest
    }
  }
  // 호스트명이 곧 로그인 이름이면 그대로 둔다 — 지우면 남는 게 없다.
  return host
}

/** 사용자가 정한 이름이 있으면 그것, 없으면 기본 규칙. */
export function resolveDeviceName(configured: string | undefined, fallback: string): string {
  const picked = String(configured || '').trim()
  return picked || fallback
}
