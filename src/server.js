import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TIMEFRAMES, MINUTE } from './config.js';
import { aggregate, aggregateFlow } from './aggregate.js';
import { handleReplay } from './replay.js';
import { handleEvents } from './events.js';
import { handleAgent } from './agent.js';
import { handleAi } from './ai.js';

const INDEX = fileURLToPath(new URL('../public/index.html', import.meta.url));
const REPLAY = fileURLToPath(new URL('../public/replay.html', import.meta.url));
const EVENTOS = fileURLToPath(new URL('../public/eventos.html', import.meta.url));
const AGENTE = fileURLToPath(new URL('../public/agente.html', import.meta.url));

export function startServer({ db, symbol, port, getStatus }) {
  const clients = new Set();
  let book = null; // gravador do livro de ofertas (fase 2), ligado depois por attachBook
  let agent = null; // agente da fase 5, ligado depois por attachAgent
  let ai = null; // conversa com a IA (fase 5), ligada depois por attachAi

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      // So atende quem chama pelo endereco desta maquina. Sem isso, uma pagina de outro site
      // poderia apontar o proprio nome para 127.0.0.1 e, pelo navegador, conversar com este
      // servidor como se fosse a tela (e a tela da fase 5 aprova ordens).
      const host = String(req.headers.host || '').replace(/:\d+$/, '');
      if (host !== 'localhost' && host !== '127.0.0.1') return json(res, 403, { error: 'este servidor so atende em localhost' });

      if (url.pathname === '/') {
        const html = await readFile(INDEX);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      // Fase 3: tela e rotas do replay.
      if (url.pathname === '/replay') {
        const html = await readFile(REPLAY);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (await handleReplay(req, res, url, { db, symbol, json })) return;

      // Fase 4: tela e rotas dos eventos.
      if (url.pathname === '/eventos') {
        const html = await readFile(EVENTOS);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (await handleEvents(req, res, url, { db, symbol, json })) return;

      // Fase 5: tela e rotas do agente.
      if (url.pathname === '/agente') {
        const html = await readFile(AGENTE);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
      if (await handleAgent(req, res, url, { agent, json })) return;
      if (await handleAi(req, res, url, { ai, json })) return;

      if (url.pathname === '/api/info') {
        return json(res, 200, {
          symbol,
          timeframes: Object.keys(TIMEFRAMES),
          candles: db.count(symbol),
          first: db.firstOpenTime(symbol),
          last: db.lastOpenTime(symbol),
          // Fase 2: de quando a quando ha negocios crus e fluxo por minuto no banco.
          tradesFirst: db.firstTrade(symbol)?.time ?? null,
          tradesLast: db.lastTrade(symbol)?.time ?? null,
          flowFirst: db.firstFlowTime(symbol),
          flowLast: db.lastFlow(symbol)?.openTime ?? null,
          ...getStatus(),
        });
      }

      if (url.pathname === '/api/candles') {
        const tf = url.searchParams.get('tf') || '1m';
        const bucket = TIMEFRAMES[tf];
        if (!bucket) return json(res, 400, { error: `timeframe desconhecido: ${tf}` });
        const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 1000));
        const last = db.lastOpenTime(symbol);
        if (last === null) return json(res, 200, []);
        // `to` fora do que existe no banco e trazido para dentro, em vez de devolver vazio.
        const to = Math.min(Number(url.searchParams.get('to')) || last, last);
        const from = Math.max(Math.floor(to / bucket) * bucket - (limit - 1) * bucket, db.firstOpenTime(symbol));
        const rows = db.range(symbol, from, to);
        return json(res, 200, bucket === MINUTE ? rows : aggregate(rows, bucket));
      }

      // Fase 2. Fluxo por periodo: volume de agressao compradora e vendedora, nos mesmos
      // tempos graficos dos candles. `complete: false` = faltam negocios naquele periodo.
      if (url.pathname === '/api/flow') {
        const tf = url.searchParams.get('tf') || '1m';
        const bucket = TIMEFRAMES[tf];
        if (!bucket) return json(res, 400, { error: `timeframe desconhecido: ${tf}` });
        const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 1000));
        const last = db.lastFlow(symbol)?.openTime ?? null;
        if (last === null) return json(res, 200, []);
        const to = Math.min(Number(url.searchParams.get('to')) || last, last);
        const from = Math.max(Math.floor(to / bucket) * bucket - (limit - 1) * bucket, db.firstFlowTime(symbol));
        return json(res, 200, aggregateFlow(db.flowRange(symbol, from, to), bucket));
      }

      // Fase 2. Ordens agressoras grandes, da mais recente para a mais antiga.
      // `min` = valor minimo em USDT; `to` = so as de ate esse horario (para paginar).
      if (url.pathname === '/api/big') {
        const min = Math.max(0, Number(url.searchParams.get('min')) || 0);
        const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get('limit')) || 100));
        const to = Number(url.searchParams.get('to')) || Number.MAX_SAFE_INTEGER;
        return json(res, 200, db.bigRecent(symbol, min, to, limit));
      }

      // Fase 2. Livro de ofertas agora: melhor compra e venda, quantidade ofertada em cada
      // faixa de distancia do preco e as maiores ofertas. null = ainda sem livro.
      if (url.pathname === '/api/book') {
        return json(res, 200, book ? book.view() : null);
      }

      // Fase 2. Compara agora o livro local, nivel a nivel, com uma foto nova da Binance.
      if (url.pathname === '/api/book/check') {
        if (!book) return json(res, 200, { ok: false, reason: 'gravador do livro desligado' });
        return json(res, 200, await book.check());
      }

      if (url.pathname === '/api/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(`event: status\ndata: ${JSON.stringify(getStatus())}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      json(res, 404, { error: 'nao encontrado' });
    } catch (err) {
      json(res, 500, { error: String(err?.message || err) });
    }
  });

  // Mantem as conexoes do navegador vivas.
  const ping = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n');
  }, 20_000);
  ping.unref();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`A porta ${port} ja esta em uso: provavelmente outro "npm start" esta rodando. Feche-o ou use PORT=outra.`);
    } else {
      console.error(`Falha ao abrir o servidor na porta ${port}: ${err.message}`);
    }
    process.exit(1);
  });
  server.listen(port, '127.0.0.1');

  const send = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };

  return {
    server,
    broadcastCandle: (candle) => send('candle', candle),
    broadcastStatus: () => send('status', getStatus()),
    broadcastFlow: (flow) => send('flow', flow), // fluxo do minuto em formacao
    broadcastBig: (order) => send('big', order), // ordem agressora grande que acabou de sair
    broadcastBook: (view) => send('book', view), // resumo do livro, uma vez por segundo
    attachBook: (b) => { book = b; },
    broadcastAgent: () => send('agent', { time: Date.now() }), // algo mudou no agente: a tela busca o estado de novo
    attachAgent: (a) => { agent = a; },
    broadcastAi: () => send('ai', { time: Date.now() }), // a conversa com a IA andou: a tela busca de novo
    attachAi: (a) => { ai = a; },
  };
}
