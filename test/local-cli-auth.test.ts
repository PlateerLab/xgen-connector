// 이 PC CLI 로그인 — codex device-auth(URL+코드 파싱, 상태 확정) / claude auth login(URL, 코드 입력, 상태 JSON),
// settings 덮어쓰기(로컬 로그인 > 서버 중앙 자격증명), 인증 가용성 판정(없으면 서버 폴백).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalCliAuth,
  cliAuthAvailable,
  stripAnsi,
  type CliAuthEvent,
} from '../src/main/local-cli-auth';

const NODE = process.execPath;
// 가짜 CLI: argv 로 모드 분기. 로그인 상태는 CODEX_HOME/CLAUDE_CONFIG_DIR 아래 파일 유무로.
const FAKE = `(function(){
  const fs=require('fs'), path=require('path');
  const a=process.argv.filter(x=>x!=='--').slice(1); const tool=process.env.FAKE_TOOL;
  const home = tool==='codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
  const mark = path.join(home, tool==='codex' ? 'auth.json' : '.credentials.json');
  const out=(s)=>process.stdout.write(s+'\\n');
  if (tool==='codex' && a[0]==='login' && a[1]==='status') { out(fs.existsSync(mark)?'Logged in using ChatGPT':'Not logged in'); process.exit(fs.existsSync(mark)?0:1); }
  if (tool==='codex' && a[0]==='login' && a[1]==='--device-auth') {
    out('Welcome to Codex'); out('1. Open this link in your browser'); out('   \\x1b[94mhttps://auth.openai.com/codex/device\\x1b[0m');
    out('2. Enter this one-time code'); out('   7DN1-NB8DP');
    setTimeout(()=>{ fs.mkdirSync(home,{recursive:true}); fs.writeFileSync(mark,'{}'); out('Successfully logged in'); process.exit(0); }, 150); return;
  }
  if (tool==='codex' && a[0]==='logout') { try{fs.unlinkSync(mark)}catch{}; out('Successfully logged out'); process.exit(0); }
  if (tool==='claude' && a[0]==='auth' && a[1]==='status') { out(JSON.stringify({loggedIn:fs.existsSync(mark), authMethod: fs.existsSync(mark)?'claude.ai':'none', email: fs.existsSync(mark)?'u@x.io':undefined})); process.exit(0); }
  if (tool==='claude' && a[0]==='auth' && a[1]==='login') {
    out('Opening browser to sign in…'); out("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&x=1");
    process.stdout.write('Paste code here if prompted > ');
    let buf=''; process.stdin.on('data',d=>{buf+=d; if(buf.includes('\\n')){ fs.mkdirSync(home,{recursive:true}); fs.writeFileSync(mark,'{}'); out(''); out('Logged in as u@x.io'); process.exit(0);} });
    return;
  }
  if (tool==='claude' && a[0]==='auth' && a[1]==='logout') { try{fs.unlinkSync(mark)}catch{}; process.exit(0); }
  process.exit(2);
})();
`;

function make(root: string) {
  return new LocalCliAuth({
    binaryPath: () => NODE,
    homeDir: (tool) => join(root, tool + '-home'),
    commandFor: (_tool, argv) => ({ command: NODE, args: ['-e', FAKE, '--', ...argv] }),
  });
}
// FAKE_TOOL 을 env 로 — commandFor 는 argv 만 주므로 process.env 에 심는다(테스트 직렬 실행).
function withTool<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  process.env.FAKE_TOOL = tool;
  return fn();
}

function collect(auth: LocalCliAuth, tool: 'codex' | 'claude') {
  const events: CliAuthEvent[] = [];
  const r = auth.startLogin(tool, (e) => events.push(e));
  return {
    r,
    events,
    done: new Promise<void>((res) => {
      const t = setInterval(() => {
        if (events.some((e) => e.channel === 'exit')) {
          clearInterval(t);
          res();
        }
      }, 20);
    }),
  };
}

test('codex device-auth: URL·코드 이벤트 → 완료 후 상태 로그인됨 → overlaySettings 가 oauth 로 덮고 중앙 자격증명 제거', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cliauth-'));
  try {
    await withTool('codex', async () => {
      const auth = make(root);
      assert.equal((await auth.status('codex')).loggedIn, false);
      const { r, events, done } = collect(auth, 'codex');
      assert.ok(r.ok && r.jobId);
      await done;
      const kinds = events.map((e) => e.channel);
      assert.ok(kinds.includes('url') && kinds.includes('code') && kinds.includes('success'));
      assert.equal(events.find((e) => e.channel === 'code')?.text, '7DN1-NB8DP');
      assert.equal(
        events.find((e) => e.channel === 'url')?.text,
        'https://auth.openai.com/codex/device',
      );
      const st = await auth.status('codex', { fresh: true });
      assert.equal(st.loggedIn, true);
      assert.equal(st.method, 'chatgpt');
      const ov = await auth.overlaySettings(
        { CODEX_AUTH_MODE: 'api_key', CODEX_CREDENTIALS_JSON: '{"central":1}' },
        { claude: false },
      );
      assert.equal(ov.settings.CODEX_AUTH_MODE, 'oauth');
      assert.equal(ov.settings.CODEX_CREDENTIALS_JSON, undefined);
      assert.equal(ov.local.codex, true);
      await auth.logout('codex');
      assert.equal((await auth.status('codex', { fresh: true })).loggedIn, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('claude auth login: URL + 코드 입력 → 로그인됨(이메일), overlay 는 claude 만', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cliauth-'));
  try {
    await withTool('claude', async () => {
      const auth = make(root);
      const { r, events, done } = collect(auth, 'claude');
      assert.ok(r.ok && r.jobId);
      // URL 과 prompt 가 나올 때까지 대기 후 코드 제출
      const until = Date.now() + 3000;
      while (Date.now() < until && !events.some((e) => e.channel === 'prompt'))
        await new Promise((x) => setTimeout(x, 20));
      assert.ok(
        events.some(
          (e) => e.channel === 'url' && e.text.startsWith('https://claude.com/cai/oauth/authorize'),
        ),
      );
      assert.equal(auth.submitInput(r.jobId!, 'ABC123').ok, true);
      await done;
      assert.ok(events.some((e) => e.channel === 'success'));
      const st = await auth.status('claude', { fresh: true });
      assert.equal(st.loggedIn, true);
      assert.equal(st.email, 'u@x.io');
      const ov = await auth.overlaySettings(
        { CLAUDE_CODE_AUTH_MODE: 'setup_token', CLAUDE_CODE_OAUTH_TOKEN: 't' },
        { codex: false },
      );
      assert.equal(ov.settings.CLAUDE_CODE_AUTH_MODE, 'oauth');
      assert.equal(ov.settings.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cliAuthAvailable: 로컬 로그인 > 서버 키/토큰/중앙 자격증명 > 없음(서버 폴백)', () => {
  assert.equal(cliAuthAvailable('codex', {}, {}, true).source, 'local_login');
  assert.equal(
    cliAuthAvailable('codex', { CODEX_AUTH_MODE: 'api_key' }, { openai: 'sk' }, false).source,
    'server_api_key',
  );
  assert.equal(cliAuthAvailable('codex', { CODEX_AUTH_MODE: 'api_key' }, {}, false).ok, false);
  assert.equal(
    cliAuthAvailable('codex', { CODEX_AUTH_MODE: 'oauth', CODEX_CREDENTIALS_JSON: '{}' }, {}, false)
      .source,
    'server_credentials',
  );
  assert.equal(
    cliAuthAvailable(
      'claude',
      { CLAUDE_CODE_AUTH_MODE: 'setup_token', CLAUDE_CODE_OAUTH_TOKEN: 't' },
      {},
      false,
    ).source,
    'server_token',
  );
  assert.equal(cliAuthAvailable('claude', { CLAUDE_CODE_AUTH_MODE: 'oauth' }, {}, false).ok, false);
  assert.equal(cliAuthAvailable('claude', {}, { anthropic: 'k' }, false).source, 'server_api_key');
  assert.equal(stripAnsi('\x1b[94mhttps://x\x1b[0m'), 'https://x');
});
