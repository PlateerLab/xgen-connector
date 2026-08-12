/**
 * 잠금 버튼의 계약.
 *
 * 버그: 잠그면 **아무것도 조작할 수 없어졌다** — 잠금 해제 버튼조차.
 *
 * 원인은 구조였다. 한 창 안에서 hover 로 입력을 되살리는 방식이었는데:
 *   • 리눅스에서 클릭 통과 창에는 이벤트가 **아예** 오지 않는다 → hover 가
 *     영원히 안 뜨고, 잠그면 되돌릴 방법이 없다.
 *   • darwin/win32 에서도 forward 되는 것은 이동 이벤트뿐이라, hover 감지 →
 *     IPC 왕복 → ignore 해제 사이에 누른 클릭은 사라진다.
 *
 * geny-connector 가 같은 버그를 겪고 **컨트롤을 별도 창으로 빼서** 해결했다.
 * 이 파일은 그 구조가 유지되는지 검사한다 — 되돌아가면 같은 버그가 재발한다.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = join(__dirname, '..');
const MAIN = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8');
const OVERLAY = readFileSync(join(ROOT, 'src/renderer/src/overlay/OverlayApp.tsx'), 'utf8');
const CHIP = readFileSync(join(ROOT, 'src/renderer/src/overlay/ChipApp.tsx'), 'utf8');
const PRELOAD = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8');
const VITE = readFileSync(join(ROOT, 'electron.vite.config.ts'), 'utf8');

// ── 컨트롤은 자기 창에 산다 ────────────────────────────────────────────

test('컨트롤 창이 존재하고 별도 진입점으로 빌드된다', () => {
  assert.match(MAIN, /function createOverlayChip\(/, '컨트롤 창을 만들지 않는다');
  assert.match(MAIN, /loadRendererPage\(overlayChip, 'chip\.html'\)/);
  assert.match(VITE, /chip: resolve\('src\/renderer\/chip\.html'\)/, '빌드 진입점이 없다');
});

test('잠긴 아바타 창은 아무 컨트롤도 렌더하지 않는다', () => {
  // 입력이 통과하는 창에 버튼을 그리면 "보이는데 눌리지 않는" 상태가 된다.
  assert.match(OVERLAY, /\{locked \? null : \(/, '잠금 상태에서 UI 를 그린다');
  assert.ok(!/ov-lockchip/.test(OVERLAY), '아바타 창에 잠금 칩이 남아 있다');
});

test('hover 로 입력을 되살리는 방식이 되살아나지 않는다', () => {
  // 이 방식이 버그의 원인이었다. 되돌아가면 같은 증상이 재발한다.
  assert.ok(!/onBarEnter|onBarLeave/.test(OVERLAY), 'hover 복귀 핸들러가 남아 있다');
  assert.ok(
    !/xgen\.overlay\.setClickThrough/.test(OVERLAY),
    '아바타 창이 직접 클릭 통과를 조작한다 — 잠금 소유자는 main 이다',
  );
});

test('컨트롤 창에는 아바타 런타임이 실리지 않는다', () => {
  // 버튼 몇 개를 위해 두 번째 WebGL 컨텍스트를 띄우면 앱이 죽는다.
  assert.ok(!/Live2D|cubism|AvatarSlot/.test(CHIP), '컨트롤 창이 아바타를 싣는다');
  const html = readFileSync(join(ROOT, 'src/renderer/chip.html'), 'utf8');
  assert.ok(!/live2dcubismcore/.test(html), 'chip.html 이 Cubism Core 를 싣는다');
});

// ── 잠금 상태는 한 곳이 소유한다 ───────────────────────────────────────

test('잠금은 main 이 소유하고 두 창에 방송한다', () => {
  assert.match(MAIN, /function setOverlayLocked\(/);
  assert.match(MAIN, /overlayWindow\?\.webContents\.send\(CHANNELS\.overlayLocked/);
  assert.match(MAIN, /overlayChip\?\.webContents\.send\(CHANNELS\.overlayLocked/);
});

test('두 창 모두 main 에서 잠금을 받는다', () => {
  for (const [name, src] of [['overlay', OVERLAY], ['chip', CHIP]] as const) {
    assert.match(src, /xgen\.overlay\.(onLocked|setLocked|getLocked)/, `${name} 이 잠금 배선을 안 쓴다`);
  }
});

test('preload 가 잠금 브릿지를 노출한다', () => {
  for (const fn of ['getLocked', 'setLocked', 'onLocked', 'reportChipSize', 'onChipInset']) {
    assert.match(PRELOAD, new RegExp(`\\b${fn}:`), `${fn} 이 없다`);
  }
});

// ── 모든 플랫폼에서 같은 규칙 ──────────────────────────────────────────

test('클릭 통과에 플랫폼별 예외가 없다', () => {
  const fn = MAIN.slice(
    MAIN.indexOf('function applyOverlayIgnoreMouse'),
    MAIN.indexOf('function setOverlayLocked'),
  );
  // 예전에는 리눅스만 '항상 인터랙티브' 로 빠져 잠금이 동작하지 않았다.
  // 컨트롤이 별도 창이 된 지금은 그 예외가 필요 없다.
  assert.ok(
    !/linuxClickThrough/.test(fn),
    '리눅스만 다르게 동작한다 — 잠금이 플랫폼마다 다른 뜻을 갖는다',
  );
  // forward 는 미지원 플랫폼에서 undefined 로 넘긴다 (옵션 자체는 무해).
  assert.match(fn, /IS_LINUX \? undefined : \{ forward: true \}/);
});

test('잠금이 아바타 창의 입력을 실제로 바꾼다', () => {
  const fn = MAIN.slice(MAIN.indexOf('function applyOverlayInput'), MAIN.length);
  assert.match(fn.slice(0, 300), /applyOverlayIgnoreMouse\(overlayWindow, overlayLocked\)/);
});

// ── 컨트롤 창이 아바타를 따라다닌다 ────────────────────────────────────

test('아바타가 움직이거나 크기가 바뀌면 컨트롤도 따라간다', () => {
  assert.match(MAIN, /overlayWindow\.on\('moved'[\s\S]{0,160}syncChipBounds\(\)/);
  assert.match(MAIN, /overlayWindow\.on\('resized'[\s\S]{0,160}syncChipBounds\(\)/);
});

test('아바타가 숨거나 닫히면 컨트롤도 같이 사라진다', () => {
  assert.match(MAIN, /overlayWindow\.on\('hide', \(\) => applyChipVisibility\(\)\)/);
  assert.match(MAIN, /overlayWindow\.on\('closed'[\s\S]{0,160}destroyOverlayChip\(\)/);
});

test('컨트롤 창은 잠금 상태에서만 보인다', () => {
  const fn = MAIN.slice(
    MAIN.indexOf('function applyChipVisibility'),
    MAIN.indexOf('function createOverlayChip'),
  );
  assert.match(fn, /const shouldShow =\s*\n?\s*overlayLocked &&/);
  assert.match(fn, /showInactive\(\)/, '포커스를 뺏으면 사용자가 하던 일에서 끌려 나온다');
});

// ── 부수 효과 ──────────────────────────────────────────────────────────

test('컨트롤 창이 자막을 가리지 않는다', () => {
  assert.match(MAIN, /function chipInsetPx\(/);
  assert.match(MAIN, /CHANNELS\.overlayChipInset/);
  assert.match(OVERLAY, /paddingBottom: chipInset/, '자막을 들어 올리지 않는다');
});

test('컨트롤 창 크기는 내용에 맞춘다', () => {
  // 버튼 수가 STT/TTS 가용성에 따라 달라진다. 고정 크기면 잘리거나,
  // 남는 투명 영역이 데스크톱 클릭을 먹는다.
  assert.match(CHIP, /reportChipSize/);
  assert.match(MAIN, /ipcMain\.on\(CHANNELS\.overlayChipSize/);
});

test('잠긴 채로도 위치를 옮길 수 있다', () => {
  // 아바타가 가리는 곳에 있을 때 잠금을 풀었다 다시 잠그게 만들 이유가 없다.
  assert.match(CHIP, /xgen\.overlay\.moveBy/);
  assert.match(CHIP, /xgen\.overlay\.commitBounds/);
});

test('트레이에 비상 복구가 있다', () => {
  // 어떤 상태에 빠지든 통제권을 돌려줄 길이 있어야 한다.
  assert.match(MAIN, /label: '아바타 조작 복구'/);
  assert.match(MAIN, /function forceOverlayInteractive\(/);
});

test('컨트롤과 아바타 상단 바가 같은 버튼 집합을 쓴다', () => {
  // 갈리면 "잠갔을 때만 없는 버튼" 이 생기고, 사용자는 그게 의도인지
  // 버그인지 알 수 없다.
  assert.match(CHIP, /VoiceButtons/);
  assert.match(OVERLAY, /VoiceButtons/);
});
