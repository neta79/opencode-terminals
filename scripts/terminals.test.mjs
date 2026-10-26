import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { encodeInput, isShellLike, parseExitCode, promptSeen, promptWarning, sendInput, stripMarker, tailLines, waitForOutput, wrapWithMarker } from './terminals.mjs';

const snapshot = { info: {
  id: 'pty_persistent_test', sessionID: 'ses_test', output: { tail: 12 },
  size: { cols: 103, rows: 54 },
} };

test('input frame preserves Unicode and control bytes, with live dimensions', () => {
  const frame = encodeInput('héllo\r\u0003', snapshot.info.size);
  assert.equal(frame[0], 1);
  assert.equal(frame.readUInt16BE(1), 103);
  assert.equal(frame.readUInt16BE(3), 54);
  assert.equal(frame.subarray(5).toString(), 'héllo\r\u0003');
  for (const cols of [0, -1, 1.5, 65536, NaN]) {
    assert.throws(() => encodeInput('x', { cols, rows: 24 }), /dimensions/);
  }
});

test('handshake gates input; duplicates, failures and uncertain delivery are handled', async (t) => {
  const original = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  let events;
  let socket;
  let closeAfterSend = false;
  globalThis.WebSocket = class extends EventEmitter {
    constructor() {
      super(); socket = this; this.frames = []; this.closed = false;
      queueMicrotask(() => {
        for (const event of events) this.emit('message', { data: JSON.stringify(event) });
      });
    }
    addEventListener(name, handler) { this.on(name, handler); }
    close() { this.closed = true; }
    send(frame) {
      this.frames.push(frame);
      if (closeAfterSend) queueMicrotask(() => this.emit('close'));
    }
  };
  const attached = () => ({ type: 'attached', role: 'controller', inputProtocol: 1, info: snapshot.info });
  const replay = { type: 'replay_complete' };
  events = [attached(), replay, replay];
  assert.deepEqual(await sendInput('ws://unused', snapshot, 'pwd\r', 0), { inputSent: true, completion: 'not_inferred' });
  assert.equal(socket.frames.length, 1);
  assert.equal(socket.frames[0].subarray(5).toString(), 'pwd\r');
  assert.equal(socket.closed, true);

  for (const event of [
    { ...attached(), role: 'observer' },
    { ...attached(), inputProtocol: 0 },
    { ...attached(), info: { ...snapshot.info, sessionID: 'ses_other' } },
    { ...attached(), info: { ...snapshot.info, output: { tail: 13 } } },
    { type: 'error', message: 'controller unavailable' },
    replay,
  ]) {
    events = [event, replay];
    await assert.rejects(sendInput('ws://unused', snapshot, 'pwd\r', 0), (error) => {
      assert.equal(error.inputMayHaveBeenSent, false); return true;
    });
    assert.equal(socket.frames.length, 0);
    assert.equal(socket.closed, true);
  }
  events = [attached(), replay]; closeAfterSend = true;
  await assert.rejects(sendInput('ws://unused', snapshot, 'pwd\r', 1000), (error) => {
    assert.equal(error.inputMayHaveBeenSent, true); return true;
  });
  assert.equal(socket.frames.length, 1);
});

test('read window keeps the last screenful and returns short output unchanged', () => {
  const text = 'a\nb\nc\nd';
  assert.deepEqual(tailLines(text, 2), { text: 'c\nd', truncated: true, totalLines: 4 });
  assert.deepEqual(tailLines(text, 4), { text, truncated: false, totalLines: 4 });
  assert.deepEqual(tailLines(text, null), { text, truncated: false, totalLines: 4 });
  const withNewline = 'a\nb\n';
  assert.deepEqual(tailLines(withNewline, 5), { text: withNewline, truncated: false, totalLines: 2 });
  assert.deepEqual(tailLines(withNewline, 1), { text: 'b', truncated: true, totalLines: 2 });
  assert.equal(tailLines('', 3).text, '');
  assert.equal(tailLines('root@host:/# ', 1).text, 'root@host:/# ');
});

test('run guard accepts shells and carriers, and refuses anything else', () => {
  for (const name of ['bash', '/bin/zsh', 'sh', 'ssh', 'docker', 'sudo', 'tmux', 'kubectl']) {
    assert.equal(isShellLike(name), true, name);
  }
  for (const name of ['python', 'vim', 'less', '', undefined, 'node']) {
    assert.equal(isShellLike(name), false, String(name));
  }
});

test('an input prompt blocks a run but an idle shell prompt does not', () => {
  assert.equal(promptWarning('root@host:/#'), null);
  assert.equal(promptWarning('$ ls\nfile.txt'), null);
  assert.ok(promptWarning("user@host's password:"));
  assert.ok(promptWarning('[sudo] password for user:'));
  assert.ok(promptWarning("The authenticity of host 'x' can't be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?"));
});

test('a screen ending in a prompt is distinguishable from a run still waiting', () => {
  // Fixtures are the two live snapshots that exposed the ambiguity.
  assert.equal(promptSeen('root@ea97a16287c7:/#'), true);
  assert.equal(promptSeen('root@ea97a16287c7:/# '), true);
  assert.equal(promptSeen('agronchi@NB-AGRONCHI:~/_$'), true);
  assert.equal(promptSeen('root@ea97a16287c7:/# sleep 3; echo done-after-cap'), false);
  assert.equal(promptSeen('root@ea97a16287c7:/# echo ok\nok'), false);
  assert.equal(promptSeen('root@ea97a16287c7:/# echo ok\nok\nroot@ea97a16287c7:/#'), true);
  assert.equal(promptSeen(''), false);
  assert.equal(promptSeen('\n\n'), false);
  assert.equal(promptSeen('x'.repeat(300) + '#'), false, 'wrapped output is not a prompt');
});

test('exit marker is nonce-bound, last-wins, and stripped from the snapshot', () => {
  const nonce = 'a1b2c3d4';
  const command = wrapWithMarker('make test', nonce);
  assert.match(command, /^make test; printf '\\n__RC_%s=%d\\n' a1b2c3d4 \$\?$/);
  const text = `$ ${command}\nok\n\n__RC_${nonce}=2\nroot@host:/#`;
  const parsed = parseExitCode(text, nonce);
  assert.equal(parsed.exitCode, 2);
  assert.equal(stripMarker(text, parsed.marker), `$ ${command}\nok\nroot@host:/#`);
  assert.equal(parseExitCode(text, 'ffffffff').exitCode, null);
  assert.deepEqual(parseExitCode('plain output', nonce), { marker: null, exitCode: null });
  assert.equal(
    parseExitCode(`__RC_${nonce}=0\nreal output\n__RC_${nonce}=130`, nonce).exitCode,
    130,
    'a forged earlier marker must not win',
  );
  assert.equal(stripMarker('no marker here', null), 'no marker here');
});

test('quiescence reports idle only after a quiet window, and caps honestly', async () => {
  const snap = (tail, text) => ({ text, info: { output: { tail } } });
  let clock = 0;
  const now = () => clock;
  const sleep = async (ms) => { clock += ms; };

  const queue = [snap(5, 'run\na'), snap(5, 'run\na\nb'), snap(5, 'run\na\nb')];
  const settled = await waitForOutput({ read: () => queue.shift(), startTail: 0, capMs: 10000, now, sleep });
  assert.equal(settled.idle, true);
  assert.equal(settled.elapsedMs, 500);
  assert.equal(settled.endTail, 5);
  assert.equal(settled.bufferReset, false);

  clock = 0;
  const growing = [snap(1, 'a'), snap(2, 'ab'), snap(3, 'abc')];
  const capped = await waitForOutput({ read: () => growing.shift(), startTail: 0, capMs: 500, now, sleep });
  assert.equal(capped.idle, false);
  assert.equal(capped.elapsedMs, 500);

  clock = 0;
  const shrinking = [snap(9, 'one\ntwo\nthree'), snap(9, 'root@host:/#'), snap(9, 'root@host:/#')];
  const reset = await waitForOutput({ read: () => shrinking.shift(), startTail: 9, capMs: 10000, now, sleep });
  assert.equal(reset.bufferReset, true);
});

test('CLI validates session, ownership and options before mutation', (t) => {
  const directory = mkdtempSync('/tmp/opencode/terminals-test-');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls.jsonl');
  writeFileSync(join(directory, 'opencode'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_CALLS, JSON.stringify(args) + '\\n');
const [type, method, path] = args;
if (type !== 'api') process.exit(3);
if (process.env.TEST_API_ERROR) {
  console.log(JSON.stringify({_tag:'InvalidRequestError',message:'Missing key: size'}));
  process.exit(1);
}
if (path.endsWith('/terminal') && method === 'get') {
  console.log(JSON.stringify({data:[{id:'pty_persistent_test',sessionID:process.env.TEST_OWNER || 'ses_test',size:{cols:103,rows:54}}]}));
} else if (path.endsWith('/snapshot')) {
  const text = process.env.TEST_PROMPT ? 'Login password: ' : '>>> ';
  console.log(JSON.stringify({data:{info:{id:'pty_persistent_test',sessionID:'ses_test',status:'running',foregroundProcess:process.env.TEST_PROMPT ? 'bash' : 'python'},text,checkpoint:'unused'}}));
} else if (path.endsWith('/terminal') && method === 'post') {
  console.log(JSON.stringify({data:{id:'pty_created',...JSON.parse(args[args.indexOf('--data')+1])}}));
} else if (method !== 'delete') process.exit(4);
`, { mode: 0o755 });
  const helper = fileURLToPath(new URL('./terminals.mjs', import.meta.url));
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, OPENCODE_SESSION_ID: 'ses_test', TEST_CALLS: log };
  const invoke = (args, changes = {}) => spawnSync(process.execPath, [helper, ...args], { env: { ...env, ...changes }, encoding: 'utf8' });
  const missing = invoke(['list'], { OPENCODE_SESSION_ID: '' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /OPENCODE_SESSION_ID/);
  const wrong = invoke(['close', '--id', 'pty_persistent_test'], { TEST_OWNER: 'ses_other' });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /not found in this conversation/);
  assert.equal(invoke(['list', '--id', 'unexpected']).status, 1);
  assert.equal(invoke(['run', '--id', 'pty_persistent_test', '--command', 'pwd', '--wait-ms', '-1']).status, 1);
  assert.equal(invoke(['read', '--id', 'pty_persistent_test', '--lines', '0']).status, 1);
  assert.equal(invoke(['read', '--id', 'pty_persistent_test', '--lines', '5', '--all']).status, 1);
  const execRc = invoke(['run', '--id', 'pty_persistent_test', '--command', 'exec bash', '--rc']);
  assert.equal(execRc.status, 1);
  assert.match(execRc.stderr, /cannot observe/);
  const busy = invoke(['run', '--id', 'pty_persistent_test', '--command', 'pwd']);
  assert.equal(busy.status, 1);
  assert.match(busy.stderr, /neither a shell nor a shell carrier/);
  const prompting = invoke(['run', '--id', 'pty_persistent_test', '--command', 'pwd'], { TEST_PROMPT: '1' });
  assert.equal(prompting.status, 1);
  assert.match(prompting.stderr, /looks like a request for input/);
  assert.equal(JSON.parse(prompting.stderr).inputMayHaveBeenSent, false);
  assert.ok(!readFileSync(log, 'utf8').includes('"delete"'), 'Rejected operations must not mutate terminals');
  const apiError = invoke(['list'], { TEST_API_ERROR: '1' });
  assert.equal(apiError.status, 1);
  assert.match(JSON.parse(apiError.stderr).error, /InvalidRequestError: Missing key: size/);
  assert.deepEqual(JSON.parse(invoke(['list']).stdout).data.map((x) => x.id), ['pty_persistent_test']);
  const read = JSON.parse(invoke(['read', '--id', 'pty_persistent_test']).stdout).data;
  assert.equal(read.text, '>>> ');
  assert.equal('checkpoint' in read, false);
  const cwd = '/a path/with spaces;literal';
  assert.equal(JSON.parse(invoke(['create', '--cwd', cwd]).stdout).data.cwd, cwd);
  assert.equal(invoke(['rename', '--id', 'pty_persistent_test', '--title', 'Work']).status, 1);
  assert.equal(JSON.parse(invoke(['close', '--id', 'pty_persistent_test']).stdout).closed, 'pty_persistent_test');
});
