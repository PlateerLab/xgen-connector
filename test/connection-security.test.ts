// 서버별 인증서 예외와 SSO 연결 입력 검증을 확인하는 단위 테스트
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildSsoUrl,
  parseSsoLoginResponse,
  shouldAllowPrivateCertificate,
} from '../src/main/connection-security';

test('사설 CA 오류는 활성화된 동일 hostname에서만 허용한다', () => {
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://xgen.internal:8443',
      true,
      'xgen.internal',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ),
    true,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://xgen.internal:8443',
      false,
      'xgen.internal',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ),
    false,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://xgen.internal:8443',
      true,
      'other.internal',
      'net::ERR_CERT_AUTHORITY_INVALID',
    ),
    false,
  );
  assert.equal(
    shouldAllowPrivateCertificate(
      'https://xgen.internal:8443',
      true,
      'xgen.internal',
      'net::ERR_CERT_DATE_INVALID',
    ),
    false,
  );
});

test('SSO URL은 같은 origin 상대 PATH에 완료 콜백을 추가한다', () => {
  const url = new URL(
    buildSsoUrl('https://xgen.internal:8443', '/sso/signin?skip=true', 'finishSso'),
  );
  assert.equal(url.origin, 'https://xgen.internal:8443');
  assert.equal(url.pathname, '/sso/signin');
  assert.equal(url.searchParams.get('skip'), 'true');
  assert.equal(url.searchParams.get('next'), 'parent.finishSso');
  assert.throws(() => buildSsoUrl('https://xgen.internal', 'https://evil.test/sso', 'finishSso'));
  assert.throws(() => buildSsoUrl('https://xgen.internal', '//evil.test/sso', 'finishSso'));
});

test('SSO 완료 응답은 로그인 토큰 필드만 채택한다', () => {
  assert.deepEqual(
    parseSsoLoginResponse({
      success: true,
      access_token: 'ACCESS.jwt',
      refresh_token: 'REFRESH.jwt',
      token_type: 'bearer',
      user_id: '37',
      username: 'user@example.com',
      ignored: { admin: true },
    }),
    {
      accessToken: 'ACCESS.jwt',
      refreshToken: 'REFRESH.jwt',
      tokenType: 'bearer',
      userId: '37',
      username: 'user@example.com',
    },
  );
  assert.throws(() => parseSsoLoginResponse({ success: true }));
  assert.throws(() => parseSsoLoginResponse({ success: false, message: 'Invalid SSO token' }));
});
