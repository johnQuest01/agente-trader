import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { TIMEFRAMES, MINUTE } from './config.js';
import { aggregate } from './aggregate.js';

const INDEX = fileURLToPath(new URL('../public/index.html', import.meta.url));

export function startServer({ db, symbol, port, getStatus }) {
  const clients = new Set();

  const json = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/') {
        const html = await readFile(INDEX);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }

      if (url.pathname === '/api/info') {
        return json(res, 200, {
          symbol,
          timeframes: Object.keys(TIMEFRAMES),
          candles: db.count(symbol),
          first: db.firstOpenTime(symbol),
          last: db.lastOpenTime(symbol),
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
        const to = Number(url.searchParams.get('to')) || last;
        const from = Math.floor(to / bucket) * bucket - (limit - 1) * bucket;
        const rows = db.range(symbol, from, to);
        return json(res, 200, bucket === MINUTE ? rows : aggregate(rows, bucket));
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

  server.listen(port, '127.0.0.1');

  const send = (event, data) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(payload);
  };

  return {
    server,
    broadcastCandle: (candle) => send('candle', candle),
    broadcastStatus: () => send('status', getStatus()),
  };
}
