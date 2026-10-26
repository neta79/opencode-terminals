import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const shellNames = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'nu']);
// Carriers hold a shell directly behind them, so `run` must work under the
// ssh/tmux/docker nesting people actually use. The guard is a nudge, not a
// security boundary: `send` performs no check at all.
const carrierNames = new Set(['ssh', 'mosh', 'tmux', 'screen', 'su', 'sudo', 'doas', 'docker', 'podman', 'nerdctl', 'kubectl', 'nsenter']);
const promptPattern = /(password|passphrase|passwort|contraseña|mot de passe|\[sudo\]|are you sure|continue connecting|\(yes\/no)/i;
const root = '/api/experimental/persistent-pty';
const quietMs = 400;
const pollStepMs = 250;

export function encodeInput(text, size) {
  for (const value of [size.cols, size.rows]) {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      throw new Error('Terminal dimensions must be integers between 1 and 65535.');
    }
  }
  const data = Buffer.from(text, 'utf8');
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = 1;
  frame.writeUInt16BE(size.cols, 1);
  frame.writeUInt16BE(size.rows, 3);
  data.copy(frame, 5);
  return frame;
}

// Last `lines` lines of the retained screen; `null` keeps the whole buffer.
// An untruncated slice returns the input text unchanged.
export function tailLines(text, lines) {
  const parts = text.split('\n');
  const endsWithNewline = parts.length > 1 && parts.at(-1) === '';
  const content = endsWithNewline ? parts.slice(0, -1) : parts;
  const totalLines = content.length;
  if (lines == null || totalLines <= lines) return { text, truncated: false, totalLines };
  return { text: content.slice(-lines).join('\n'), truncated: true, totalLines };
}

export function isShellLike(processName) {
  const name = basename(processName ?? '');
  return shellNames.has(name) || carrierNames.has(name);
}

// The last non-empty screen line when it looks like a request for input.
export function promptWarning(text) {
  const lines = (text ?? '').split('\n').filter((line) => line.trim()).slice(-3);
  return lines.find((line) => promptPattern.test(line)) ?? null;
}

// Shape heuristic for "the screen is back at a shell prompt". Advisory: a
// data line ending in # or $ looks the same, so this never means "finished".
export function promptSeen(text) {
  const last = (text ?? '').split('\n').filter((line) => line.trim()).at(-1)?.trimEnd() ?? '';
  return last.length > 0 && last.length <= 200 && /[#$%>]$/.test(last);
}

export function wrapWithMarker(command, nonce) {
  return `${command}; printf '\\n__RC_%s=%d\\n' ${nonce} $?`;
}

export function parseExitCode(text, nonce) {
  // The wrapper prints its marker last; take the last match so echoed output
  // carrying the same nonce cannot win.
  const marker = new RegExp(`^__RC_${nonce}=(-?\\d+)$`, 'gm');
  let found = null;
  for (const match of (text ?? '').matchAll(marker)) found = match;
  return { marker: found?.[0] ?? null, exitCode: found ? Number(found[1]) : null };
}

export function stripMarker(text, marker) {
  if (!marker) return text;
  const lines = text.split('\n');
  const index = lines.lastIndexOf(marker);
  if (index < 0) return text;
  lines.splice(index, 1);
  if (index > 0 && lines[index - 1] === '') lines.splice(index - 1, 1);
  return lines.join('\n');
}

// Quiescence is advisory: `idle` means "no output changed for quietMs",
// never "the command finished". No busy or exit signal exists in the API.
export async function waitForOutput({ read, startTail, capMs, quietMs: quiet = quietMs, stepMs = pollStepMs, now = Date.now, sleep = delay }) {
  const started = now();
  let lastTail = startTail;
  let settledAt = started;
  let previousLength = null;
  let bufferReset = false;
  let snapshot;
  for (;;) {
    snapshot = read();
    const text = snapshot.text ?? '';
    if (previousLength !== null && text.length < previousLength) bufferReset = true;
    previousLength = text.length;
    if (snapshot.info.output.tail !== lastTail) {
      lastTail = snapshot.info.output.tail;
      settledAt = now();
    }
    if (now() - settledAt >= quiet || now() - started >= capMs) break;
    await sleep(stepMs);
  }
  return {
    idle: now() - settledAt >= quiet,
    quietMs: quiet,
    elapsedMs: now() - started,
    startTail,
    endTail: snapshot.info.output.tail,
    bufferReset,
    snapshot,
  };
}

function cli(args) {
  try {
    return execFileSync('opencode', args, {
      encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    // Do not dump child-process arguments: they can contain user input.
    let response;
    try { response = JSON.parse(error.stdout); } catch {}
    if (response?._tag) throw new Error(`${response._tag}: ${response.message ?? 'API request failed'}`);
    throw new Error(`opencode ${args[0]} failed (${error.code ?? error.status ?? error.signal ?? 'unknown'}). Check the CLI connection/authentication; no automatic retry.`, { cause: error });
  }
}

function api(method, path, server, data, headers = []) {
  const args = ['api', method, path];
  if (server) args.push('--server', server);
  if (data !== undefined) args.push('--data', JSON.stringify(data));
  for (const header of headers) args.push('--header', header);
  const raw = cli(args);
  if (!raw) return undefined;
  let response;
  try { response = JSON.parse(raw); }
  catch { throw new Error('OpenCode returned invalid/truncated JSON; no automatic retry.'); }
  if (response._tag) throw new Error(`${response._tag}: ${response.message ?? 'API request failed'}`);
  return response.data;
}

export async function sendInput(url, snapshot, text, waitMs) {
  if (typeof WebSocket !== 'function') throw new Error('Node with built-in WebSocket support is required (verified with Node 24).');
  let inputSent = false;
  let ws;
  try {
    await new Promise((resolve, reject) => {
      ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      let info;
      let finished = false;
      let observation;
      const connection = setTimeout(() => finish(new Error('Terminal handshake timed out.')), 10000);
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(connection);
        clearTimeout(observation);
        ws.close();
        if (error) reject(error); else resolve();
      }
      ws.addEventListener('error', () => finish(new Error('Terminal WebSocket failed.')));
      ws.addEventListener('close', () => finish(new Error('Terminal connection closed before observation ended.')));
      ws.addEventListener('message', ({ data }) => {
        if (finished || typeof data !== 'string') return;
        try {
          const event = JSON.parse(data);
          if (event.type === 'error') throw new Error(`Terminal error: ${event.message}`);
          if (event.type === 'attached') {
            if (event.role !== 'controller' || event.inputProtocol !== 1) {
              throw new Error('Terminal did not grant controller access with input protocol 1.');
            }
            info = event.info;
            if (info.id !== snapshot.info.id || info.sessionID !== snapshot.info.sessionID) {
              throw new Error('Attached terminal does not match the selected session/terminal.');
            }
            if (info.output.tail !== snapshot.info.output.tail) {
              throw new Error('Terminal changed before input; read it again and coordinate with the user.');
            }
          }
          if (event.type === 'replay_complete' && !inputSent) {
            if (!info) throw new Error('Terminal replay completed without an attachment.');
            const frame = encodeInput(text, info.size);
            // A send is not acknowledged; any later error requires reading before retrying.
            inputSent = true;
            ws.send(frame);
            clearTimeout(connection);
            observation = setTimeout(() => finish(), waitMs);
          }
        } catch (error) { finish(error); }
      });
    });
    return { inputSent, completion: 'not_inferred' };
  } catch (error) {
    error.inputMayHaveBeenSent = inputSent;
    throw error;
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    id: { type: 'string' }, cwd: { type: 'string' }, title: { type: 'string' },
    command: { type: 'string' }, text: { type: 'string' },
    lines: { type: 'string' }, all: { type: 'boolean' }, rc: { type: 'boolean' },
    'wait-ms': { type: 'string' }, server: { type: 'string' },
  } });
  const [action] = positionals;
  const allowed = {
    list: [], create: ['cwd', 'title'], read: ['id', 'lines', 'all'],
    run: ['id', 'command', 'wait-ms', 'lines', 'all', 'rc'], send: ['id', 'text', 'wait-ms', 'lines', 'all'],
    close: ['id'],
  };
  if (positionals.length !== 1 || !Object.hasOwn(allowed, action)) {
    throw new Error('Use: terminals.mjs list|create|read|run|send|close [options].');
  }
  for (const [key, value] of Object.entries(values)) {
    if (key === 'server' || key === 'wait-ms' || value === false) continue;
    if (!allowed[action].includes(key)) throw new Error(`--${key} is not valid for ${action}.`);
  }
  const sessionID = process.env.OPENCODE_SESSION_ID;
  if (!sessionID || !/^ses_[A-Za-z0-9_-]+$/.test(sessionID)) {
    throw new Error('OPENCODE_SESSION_ID is missing or invalid; run from an OpenCode session.');
  }
  const required = action === 'run' ? ['id', 'command'] : action === 'send' ? ['id', 'text']
    : ['read', 'close'].includes(action) ? ['id'] : [];
  for (const key of required) {
    if (values[key] === undefined || (key !== 'text' && !values[key].trim())) {
      throw new Error(`--${key} is required for ${action}.`);
    }
  }
  if (values.all && values.lines !== undefined) throw new Error('Use either --lines or --all, not both.');
  if (values.lines !== undefined) {
    const requested = Number(values.lines);
    if (!Number.isInteger(requested) || requested < 1 || requested > 10000) {
      throw new Error('--lines must be an integer between 1 and 10000.');
    }
  }
  // run waits until output settles; send only observes. Both caps, 0..30s.
  const defaultWaitMs = action === 'run' ? 10000 : 1000;
  const waitMs = Number(values['wait-ms'] ?? defaultWaitMs);
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) {
    throw new Error('--wait-ms must be an integer between 0 and 30000.');
  }
  if (action === 'run' && values.rc && /^\s*(exec|exit|logout)\b/.test(values.command)) {
    throw new Error('--rc cannot observe a command that replaces or ends the shell (exec, exit, logout); run it without --rc.');
  }
  const server = values.server;
  if (server && !/^https?:$/.test(new URL(server).protocol)) throw new Error('--server must be an HTTP(S) URL.');
  const sessionPath = `/api/experimental/session/${encodeURIComponent(sessionID)}/terminal`;
  const request = (method, path, data, headers) => api(method, path, server, data, headers);
  if (action === 'list') return { data: request('get', sessionPath) };
  if (action === 'create') {
    return { data: request('post', sessionPath, {
      args: [], title: values.title ?? 'Shared terminal', env: {}, cwd: values.cwd ?? process.cwd(),
    }) };
  }
  const terminals = request('get', sessionPath);
  if (!Array.isArray(terminals)) throw new Error('Unexpected terminal list response.');
  const terminal = terminals.find((terminal) => terminal.id === values.id && terminal.sessionID === sessionID);
  if (!terminal) {
    throw new Error('Terminal not found in this conversation. List its terminals; do not guess another session/server.');
  }
  const path = `${root}/${encodeURIComponent(values.id)}`;
  if (action === 'close') {
    request('delete', path);
    return { closed: values.id };
  }
  const snapshot = request('get', `${path}/snapshot`);
  if (snapshot?.info?.id !== values.id || snapshot.info.sessionID !== sessionID) {
    throw new Error('Snapshot does not belong to the selected terminal/session.');
  }
  // The checkpoint is a binary replay aid, not useful screen text.
  delete snapshot.checkpoint;
  // Default view: the last screenful, so a read is not a whole-buffer dump.
  const showLines = values.all ? null : Number(values.lines ?? snapshot.info.size?.rows ?? 40);
  if (action === 'read') {
    const view = tailLines(snapshot.text ?? '', showLines);
    return { data: { ...snapshot, text: view.text, textTruncated: view.truncated, totalLines: view.totalLines } };
  }
  if (snapshot.info.status !== 'running') throw new Error('Terminal has exited; input was not sent.');
  if (action === 'run' && !isShellLike(snapshot.info.foregroundProcess)) {
    throw new Error(`Refusing to type into ${snapshot.info.foregroundProcess ?? 'the terminal'}: it is neither a shell nor a shell carrier (ssh, tmux, docker...). Read the screen. An idle shell prompt means use send with an explicit trailing Enter; an application, editor, pager or password prompt means send nothing.`);
  }
  const prompt = action === 'run' ? promptWarning(snapshot.text) : null;
  if (prompt) {
    throw new Error(`Refusing to run: the screen ends with what looks like a request for input (${JSON.stringify(prompt.trim().slice(0, 80))}). Answer it with send, or read again when it is gone.`);
  }
  const base = new URL(server ?? cli(['service', 'status']));
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(`api/experimental/persistent-pty/${encodeURIComponent(values.id)}/connect`, base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = request('post', `${path}/connect-token`, undefined, ['x-opencode-ticket:1']);
  if (typeof token?.ticket !== 'string') throw new Error('OpenCode did not return a terminal connection ticket.');
  url.search = new URLSearchParams({
    ticket: token.ticket, cursor: String(snapshot.info.output.tail),
    attachment_id: `agent-${crypto.randomUUID()}`, takeover: 'true', input_protocol: '1',
  }).toString();
  const nonce = action === 'run' && values.rc ? randomBytes(4).toString('hex') : null;
  const text = action !== 'run' ? values.text
    : nonce ? `${wrapWithMarker(values.command, nonce)}\r` : `${values.command}\r`;
  // A run hands off to a snapshot poll; a send only observes briefly.
  const result = await sendInput(url, snapshot, text, action === 'run' ? Math.min(waitMs, 300) : waitMs);
  let full;
  let waited;
  try {
    if (action === 'run') {
      waited = await waitForOutput({ read: () => request('get', `${path}/snapshot`), startTail: snapshot.info.output.tail, capMs: waitMs });
      full = waited.snapshot.text ?? '';
      delete waited.snapshot;
    } else {
      full = request('get', `${path}/snapshot`)?.text ?? '';
    }
  } catch (error) { error.inputMayHaveBeenSent = true; throw error; }
  let exit;
  if (nonce) {
    const parsed = parseExitCode(full, nonce);
    full = stripMarker(full, parsed.marker);
    exit = parsed.exitCode === null ? { exitCode: null, exitReason: 'marker_not_found' } : { exitCode: parsed.exitCode };
  }
  const view = tailLines(full, showLines);
  return {
    ...result, ...(waited ?? {}), ...(exit ?? {}),
    ...(action === 'run' ? { promptSeen: promptSeen(full) } : {}),
    snapshot: view.text, snapshotTruncated: view.truncated, totalLines: view.totalLines,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(JSON.stringify({
      error: error.message, inputMayHaveBeenSent: error.inputMayHaveBeenSent ?? false,
      ...(error.inputMayHaveBeenSent ? { next: 'Read the terminal before considering another send; do not automatically retry.' } : {}),
    }, null, 2));
    process.exitCode = 1;
  });
}
