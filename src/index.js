import { SYMBOL, PORT, BACKFILL_DAYS, DB_FILE, TRADES } from './config.js';

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
let retryTimer = null;
async function fillGaps() {
  if (filling) return filling;
  clearTimeout(retryTimer);
  retryTimer = null;
  status.backfilling = true;
  app.broadcastStatus();
  filling = (async () => {
    try {
      const n = await backfill(db, SYMBOL, BACKFILL_DAYS, log);
      log(`historico em dia: ${n} candles baixados, ${db.count(SYMBOL)} no banco`);
      status.backfilling = false;
    } catch (err) {
      log(`falha ao baixar historico: ${err.message}`);
      log('confira a internet; tento de novo em 30s');
      // Continua "baixando historico" na tela: o buraco ainda existe ate o retry ter sucesso.
      retryTimer = setTimeout(fillGaps, 30_000);
      retryTimer.unref();
    } finally {
      filling = null;
      app.broadcastStatus();
    }
  })();
  return filling;
}

log(`baixando historico (${BACKFILL_DAYS} dias de candles de 1 minuto)...`);
await fillGaps();

let lastMinuteSeen = null;
const stop = streamKlines(SYMBOL, {
  log,
  onOpen: fillGaps, // a cada (re)conexao, tapa o buraco do tempo que ficou fora
  onStatus: (live) => {
    status.live = live;
    app.broadcastStatus();
  },
  onCandle: (candle) => {
    // Um erro aqui (ex.: banco travado por outro processo) nao pode derrubar o coletor:
    // o candle vem de novo no proximo segundo e o backfill da reconexao tapa qualquer falha.
    try {
      db.upsert(candle);
    } catch (err) {
      log(`falha ao gravar candle ${new Date(candle.openTime).toISOString().slice(11, 16)}: ${err.message}`);
      return;
    }
    app.broadcastCandle(candle);
    // Rede de seguranca: ao comecar um minuto novo, o anterior ja tem que estar fechado no
    // banco (o fechamento chega pelo ao vivo antes do primeiro negocio do minuto seguinte).
    // Se sobrou um candle provisorio de um minuto que ja acabou, o fechamento dele se perdeu:
    // busca o definitivo pelo historico, que retoma do primeiro candle ainda aberto.
    if (candle.openTime !== lastMinuteSeen) {
      lastMinuteSeen = candle.openTime;
      const stale = db.firstUnclosedOpenTime(SYMBOL);
      if (stale !== null && stale < candle.openTime) {
        log(`candle de ${new Date(stale).toISOString().slice(11, 16)} UTC ficou sem fechamento; buscando o definitivo`);
        fillGaps();
      }
    }
  },
});

// Fase 2: negocios, fluxo por minuto e ordens grandes. Usa uma conexao propria, separada
// da dos candles: se uma cair, a outra continua.
let trades = null;
if (TRADES) {
  const { startTrades } = await import('./trades.js');
  status.trades = { live: false, filling: false };
  trades = startTrades({
    db, symbol: SYMBOL, log,
    onStatus: (s) => {
      status.trades = s;
      app.broadcastStatus();
    },
    onFlow: (flow) => app.broadcastFlow(flow),
    onBig: (order) => app.broadcastBig(order),
  });
}

process.on('SIGINT', () => {
  log('encerrando...');
  stop();
  trades?.stop();
  app.server.close();
  db.close();
  process.exit(0);
});
