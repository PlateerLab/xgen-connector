// 배포 프로필 기본값의 파싱과 입력 검증을 확인하는 단위 테스트
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveDeploymentDefaults } from '../src/main/deployment-defaults';

test('제주은행 배포 프로필 기본값을 구성한다', () => {
  assert.deepEqual(
    resolveDeploymentDefaults({
      serverUrl: 'https://dev-xgen.jejubank.com:8443/',
      allowPrivateCertificate: 'true',
      ssoEnabled: '1',
      ssoPath: '/sso/signin?next=parent.xgenConnectorSsoComplete',
      updateServer: 'xgen',
    }),
    {
      serverUrl: 'https://dev-xgen.jejubank.com:8443',
      allowPrivateCertificate: true,
      ssoEnabled: true,
      ssoPath: '/sso/signin?next=parent.xgenConnectorSsoComplete',
      updateServer: 'xgen',
    },
  );
});

test('미지정 값은 기존 애플리케이션 기본값을 덮어쓰지 않는다', () => {
  assert.deepEqual(resolveDeploymentDefaults({}), {});
});

test('잘못된 배포 프로필 입력을 거부한다', () => {
  assert.throws(() => resolveDeploymentDefaults({ allowPrivateCertificate: 'yes' }));
  assert.throws(() => resolveDeploymentDefaults({ ssoPath: 'https://evil.test/sso' }));
  assert.throws(() => resolveDeploymentDefaults({ updateServer: 'other' }));
});
