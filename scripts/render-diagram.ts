// Renders the README diagram, docs/diagram/how-it-works.html, to two PNGs:
// docs/how-it-works-light.png and docs/how-it-works-dark.png.
//
//   node scripts/render-diagram.ts
//
// It drives a local Chrome over the DevTools protocol with Node's built-in
// WebSocket, so it needs no dependencies. Set CHROME_PATH if Chrome is not in
// the usual place. The page loads its fonts from Google Fonts, so it needs
// network access.
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const page = pathToFileURL(join(root, 'docs/diagram/how-it-works.html')).href;
const width = 1200;
const scale = 2;

const chromePath =
  process.env.CHROME_PATH ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

const profile = await mkdtemp(join(tmpdir(), 'render-diagram-'));
const chrome = spawn(
  chromePath,
  ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

try {
  const wsUrl = await new Promise<string>((done, fail) => {
    let buffer = '';
    const timer = setTimeout(() => fail(new Error('Chrome did not start')), 15_000);
    chrome.stderr.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (match?.[1]) {
        clearTimeout(timer);
        done(match[1]);
      }
    });
    chrome.on('error', fail);
  });

  const cdp = await connect(wsUrl);
  for (const theme of ['light', 'dark']) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method: string, params: object = {}) => cdp.send(method, params, sessionId);

    await send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: scale, mobile: false });
    await send('Page.enable');
    const loaded = cdp.once('Page.loadEventFired', sessionId);
    await send('Page.navigate', { url: theme === 'dark' ? `${page}#dark` : page });
    await loaded;

    const { result } = await send('Runtime.evaluate', {
      expression: 'document.fonts.ready.then(() => Math.ceil(document.body.getBoundingClientRect().height))',
      awaitPromise: true,
      returnByValue: true,
    });
    const height = Number(result.value);
    const shot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const out = join(root, `docs/how-it-works-${theme}.png`);
    await writeFile(out, Buffer.from(shot.data, 'base64'));
    console.log(`wrote ${out} (${width * scale}x${height * scale})`);
    await cdp.send('Target.closeTarget', { targetId });
  }
  cdp.close();
} finally {
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

// A minimal DevTools protocol client: request/response by id, and one-shot
// event waits.
async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise((done, fail) => {
    ws.addEventListener('open', done, { once: true });
    ws.addEventListener('error', fail, { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { done: (value: any) => void; fail: (error: Error) => void }>();
  const waiters: { method: string; sessionId?: string; done: () => void }[] = [];

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.id !== undefined) {
      const call = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) call?.fail(new Error(`${msg.error.message} (${msg.error.code})`));
      else call?.done(msg.result);
      return;
    }
    for (const [i, w] of waiters.entries()) {
      if (w.method === msg.method && w.sessionId === msg.sessionId) {
        waiters.splice(i, 1);
        w.done();
        break;
      }
    }
  });

  return {
    send(method: string, params: object = {}, sessionId?: string): Promise<any> {
      const id = nextId++;
      ws.send(JSON.stringify({ id, method, params, sessionId }));
      return new Promise((done, fail) => pending.set(id, { done, fail }));
    },
    once(method: string, sessionId?: string): Promise<void> {
      return new Promise((done) => waiters.push({ method, sessionId, done }));
    },
    close() {
      ws.close();
    },
  };
}
