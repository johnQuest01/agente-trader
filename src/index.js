import { SYMBOL, PORT, BACKFILL_DAYS, DB_FILE } from './config.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Este projeto precisa do Node 22.13 ou mais novo. Voce esta no ${process.version}.`);
  console.error('Baixe a versao LTS em https://nodejs.org e rode de novo.');
  process.exit(1);
}

// O modulo de SQLite embutido ainda avisa que e "experimental"; escondemos so esse aviso.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
  console.warn(w);
});

const { openDb } = await import('./db.js');
const { backfill, streamKlines } = await import('./binance.js');
const { startServer } = await import('./server.js');

const log = (msg) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`);

const db = await openDb(DB_FILE);

const status = { live: false, backfilling: false };
const app = startServer({ db, symbol: SYMBOL, port: PORT, getStatus: () => ({ ...status }) });
log(`grafico em http://localhost:${PORT}  (par: ${SYMBOL})`);

let filling = null;
async function fillGaps() {
  if (filling) return filling;
  status.backfilling = true;
  app.broadcastStatus();
  filling = (async () => {
    try {
      const n = await backfill(db, SYMBOL, BACKFILL_DAYS, log);
      log(`historico em dia: ${n} candles baixados, ${db.count(SYMBOL)} no banco`);
    } catch (err) {
      log(`falha ao baixar historico: ${err.message}`);
      log('confira a internet; tento de novo em 30s');
      setTimeout(fillGaps, 30_000).unref();
    } finally {
      status.backfilling = false;
      filling = null;
      app.broadcastStatus();
    }
  })();
  return filling;
}

log(`baixando historico (${BACKFILL_DAYS} dias de candles de 1 minuto)...`);
await fillGaps();

const stop = streamKlines(SYMBOL, {
  log,
  onOpen: fillGaps, // a cada (re)conexao, tapa o buraco do tempo que ficou fora
  onStatus: (live) => {
    status.live = live;
    app.broadcastStatus();
  },
  onCandle: (candle) => {
    db.upsert(candle);
    app.broadcastCandle(candle);
  },
});

process.on('SIGINT', () => {
  log('encerrando...');
  stop();
  app.server.close();
  db.close();
  process.exit(0);
});
