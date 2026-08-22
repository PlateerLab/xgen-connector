#!/usr/bin/env node
/**
 * bundle-python-sidecar — 커넥터 로컬 실행 사이드카(Python)를 앱 리소스로 담는다.
 *
 * 커넥터는 커넥터-세션 턴을 `python -m xgen_agent_host.sidecar` 로 로컬 실행한다
 * (src/main/local-agent-sidecar.ts). 그러려면 **이식형 Python + 런타임 패키지**가
 * 앱에 번들되어야 한다. 이 스크립트가 그 트리를 `resources/python-sidecar/` 로
 * 조립하고, electron-builder 의 extraResources 가 앱 `resources/` 로 복사한다.
 * (resolveSidecarCommand 의 packaged 경로 `<resources>/python/...` 와 정렬.)
 *
 * 조립 단계(각 OS 러너에서 prepackage 로 실행):
 *   1) 이식형 CPython 을 받는다 — astral-sh/python-build-standalone 릴리스
 *      (win/mac/linux × x64/arm64). → resources/python-sidecar/python
 *   2) 그 python 으로 wheel 을 설치한다:
 *        python -m pip install xgen-agent-runtime==<pin> \
 *          https://github.com/PlateerLab/xgen-agent-host/releases/download/<v>/xgen_agent_host-<v>-py3-none-any.whl
 *      (오프라인 빌드면 사전 다운로드한 wheelhouse 에서 --no-index --find-links.)
 *   3) 용량 절감(선택): __pycache__/tests/*.dist-info 정리.
 *
 * ⚠ 실제 다운로드·설치는 **네트워크와 각 OS 러너**가 필요하다 — 이 스크립트는
 * 단계를 캡슐화하고, CI 에서 OS/arch 매트릭스로 채운다. 로컬 dev 는 번들 대신
 * env(XGEN_SIDECAR_PYTHON / XGEN_SIDECAR_PYTHONPATH)로 시스템 Python 을 쓴다
 * (resolveSidecarCommand 폴백).
 *
 * electron-builder.yml 에 추가할 스니펫(빌드 엔지니어가 실기 검증 후 적용):
 *
 *   extraResources:
 *     - from: resources/python-sidecar
 *       to: python
 *       filter: ['**\/*']
 *
 * (extraResources 가 없는 dir 을 가리키면 패키징이 실패하므로, 이 스크립트를
 *  prepackage 훅으로 먼저 돌려 트리를 만든 뒤에만 스니펫을 켠다.)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'resources', 'python-sidecar');

// python-build-standalone 릴리스 태그/트리플은 CI 에서 OS/arch 로 채운다.
const PBS_RELEASE = process.env.PBS_RELEASE || '20240415'; // 예시 — 최신으로 갱신
const RUNTIME_PIN = process.env.XGEN_RUNTIME_PIN || '3.5.1';
const HOST_WHEEL_URL =
  process.env.XGEN_HOST_WHEEL_URL ||
  'https://github.com/PlateerLab/xgen-agent-host/releases/download/<v>/xgen_agent_host-<v>-py3-none-any.whl';

function log(m) {
  process.stdout.write(`[bundle-python-sidecar] ${m}\n`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  log(`대상: ${OUT}`);
  log(
    `1) 이식형 CPython 내려받기 (python-build-standalone ${PBS_RELEASE}, OS/arch 매트릭스) → ${OUT}/python`,
  );
  log(`2) wheel 설치: xgen-agent-runtime==${RUNTIME_PIN} + xgen-agent-host (${HOST_WHEEL_URL})`);
  log('3) __pycache__/tests 정리 (용량)');
  log('');
  if (existsSync(join(OUT, 'python'))) {
    log('이미 조립됨 — 스킵.');
    return;
  }
  log('⚠ 실제 다운로드·설치는 미구현(placeholder). CI 의 OS/arch 매트릭스에서 위 단계를 채운다.');
  log('   로컬 dev 는 XGEN_SIDECAR_PYTHON/PYTHONPATH env 로 시스템 Python 사용(번들 불요).');
  // 의도적으로 실패하지 않는다 — dev 빌드가 번들 없이도 진행되게(env 폴백).
}

main().catch((e) => {
  process.stderr.write(`bundle-python-sidecar 실패: ${e?.stack || e}\n`);
  process.exit(1);
});
