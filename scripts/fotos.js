// Tira fotos de paginas deste computador com o Edge ou o Chrome sem janela, pelo protocolo de
// depuracao (CDP). Usa um perfil temporario proprio: nao toca no navegador do usuario.
// Serve para mandar fotos das telas quando o Bruno acompanha de outro computador.
// Uso: node scripts/fotos.js <navegador.exe> <perfil temporario> <pasta de saida> <passos.json>
// Tamanho da janela: variaveis FOTOS_W e FOTOS_H (padrao 1500 x 950).
// passos.json: [{ "name": "1-grafico", "url": "http://localhost:3333/", "wait": 6000 },
//               { "name": "2-depois", "js": "document.querySelector('#x').click()", "wait": 1500 }]
// Passo sem "name" nao gera foto (so navega ou executa).
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const [, , exe, profile, outDir, stepsFile] = process.argv;
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'));
const PORT = Number(process.env.FOTOS_PORT || 9339);
const W = Number(process.env.FOTOS_W || 1500);
const H = Number(process.env.FOTOS_H || 950);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(exe, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-gpu', '--hide-scrollbars', `--window-size=${W},${H}`, 'about:blank',
], { stdio: 'ignore' });
let done = false;
const finish = (code) => { if (done) return; done = true; try { child.kill(); } catch { /* ja saiu */ } process.exit(code); };
setTimeout(() => { console.log('TEMPO ESGOTADO (150 s): navegador encerrado'); finish(2); }, 150_000).unref();
child.on('exit', (c) => { if (!done) { console.log(`o navegador saiu sozinho (codigo ${c})`); finish(3); } });
child.on('error', (e) => { console.log(`nao deu para abrir o navegador: ${e.message}`); finish(3); });

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const waiters = [];
    const listeners = [];
    ws.onerror = () => reject(new Error('falha na ligacao de depuracao com o navegador'));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message)); else p.res(msg.result);
        return;
      }
      if (!msg.method) return;
      for (const l of listeners) if (l.event === msg.method) l.fn(msg.params);
      for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].event === msg.method) waiters.splice(i, 1)[0].res(msg.params);
    };
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); }),
      once: (event, ms) => new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error(`o navegador nao avisou ${event} em ${ms / 1000} s`)), ms);
        waiters.push({ event, res: (p) => { clearTimeout(t); res(p); } });
      }),
      on: (event, fn) => listeners.push({ event, fn }),
    });
  });
}

try {
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* ainda abrindo */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('o navegador nao abriu a porta de depuracao');
  const cdp = await connect(target.webSocketDebuggerUrl);
  const problems = [];
  cdp.on('Runtime.exceptionThrown', (p) => problems.push(`erro na pagina: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`));
  cdp.on('Log.entryAdded', (p) => { if (p.entry.level === 'error') problems.push(`log de erro: ${p.entry.text} ${p.entry.url ?? ''}`); });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  for (const s of steps) {
    if (s.url) {
      const loaded = cdp.once('Page.loadEventFired', 30_000);
      await cdp.send('Page.navigate', { url: s.url });
      await loaded;
    }
    if (s.js) {
      const r = await cdp.send('Runtime.evaluate', { expression: s.js, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`passo "${s.name ?? s.js.slice(0, 40)}": ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      if (r.result?.value !== undefined) console.log(`   js -> ${JSON.stringify(r.result.value).slice(0, 400)}`);
    }
    await sleep(s.wait ?? 3000);
    if (!s.name) continue;
    // "sections": um PNG por elemento que casa com o seletor (pagina longa, dividida em partes).
    if (s.sections) {
      const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: `[...document.querySelectorAll(${JSON.stringify(s.sections)})].map((e) => { const b = e.getBoundingClientRect(); return { y: Math.floor(b.top + scrollY), h: Math.ceil(b.height) }; })` });
      let k = 0;
      for (const b of r.result.value) {
        k += 1;
        const part = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: b.y, width: W, height: b.h, scale: 1 } });
        writeFileSync(path.join(outDir, `${s.name}-${k}.png`), Buffer.from(part.data, 'base64'));
        console.log(`foto ${s.name}-${k}.png (${W}x${b.h})`);
      }
      continue;
    }
    const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
    const height = Math.min(Math.max(H, Math.ceil(cssContentSize.height)), s.maxHeight ?? 3500);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: W, height, scale: 1 } });
    writeFileSync(path.join(outDir, `${s.name}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`foto ${s.name}.png (${W}x${height})`);
  }
  for (const p of problems) console.log(p);
  console.log(`problemas na pagina: ${problems.length}`);
  finish(0);
} catch (err) {
  console.log(`FALHOU: ${err.message}`);
  finish(1);
}
