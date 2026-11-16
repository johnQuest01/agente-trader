// Reconstroi o fluxo por minuto e as ORDENS GRANDES ("baleias") de um periodo passado, a partir
// do historico publico de negocios agregados da Binance (aggTrades). O coletor ao vivo so tem
// isso desde o dia em que foi ligado; aqui se volta no tempo para poder estudar.
//
// - NAO guarda os negocios crus (seriam milhoes por dia): le pagina por pagina, soma e descarta.
// - NAO toca no banco principal: grava em data/baleias.db. Pode rodar com o programa no ar.
// - As contas sao AS MESMAS de src/trades.js (funcao `step`): fluxo somado em inteiros de 1e-8, e
//   ordem grande = negocios seguidos, no mesmo milissegundo e do mesmo lado, somados, a partir de
//   BIG_ORDER_USDT. Estao repetidas aqui de proposito, para nao mexer no coletor que esta
//   rodando; se mudar la, mude aqui. Duas provas de que continuam iguais:
//     1. cada minuto reconstruido e comparado com o candle daquele minuto (volume, agressao
//        compradora e numero de negocios tem que dar EXATAMENTE igual) - coluna `confere`;
//     2. no trecho que o coletor ao vivo tambem gravou, as ordens grandes tem que ser as mesmas.
// - O id do negocio agregado e sequencial e sem buracos: a pagina que comeca no id X traz os ids
//   X a X+999. Por isso da para pedir varias paginas ao mesmo tempo e processar em ordem.
// - Respeita o limite da Binance: le o peso usado no cabecalho de cada resposta e para de pedir
//   ate o minuto virar quando passa do teto (padrao 2800 de 6000 por minuto, para sobrar para o
//   programa principal). Um 418 (bloqueio) encerra tudo na hora.
// - Pode ser interrompido e retomado: recomeca do inicio do ultimo minuto que nao terminou.
//
// Uso: node scripts/reconstruir-baleias.js [--dias=90] [--horas=N] [--saida=arquivo.db]
//      [--concorrencia=4] [--peso=2800]
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DB_FILE, SYMBOL, MINUTE, REST_URL, BIG_ORDER_USDT } from '../src/config.js';

process.removeAllListeners('warning');
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const HOURS = arg('horas', null) ? Number(arg('horas')) : Number(arg('dias', 90)) * 24;
const OUT = arg('saida', path.join(path.dirname(DB_FILE), 'baleias.db'));
const CONC = Number(arg('concorrencia', 4));
const MAX_WEIGHT = Number(arg('peso', 2800));
const PAGE = 1000;
const PAGE_WEIGHT = 4;
const UNITS = 1e8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('pt-BR')}] ${m}`);
const iso = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
const minuteOf = (t) => Math.floor(t / MINUTE) * MINUTE;

// ---------- pedidos, com o limite da Binance ----------
let usedWeight = 0;
let weightMinute = 0;
let pending = 0;
let requests = 0;
function noteWeight(w) {
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== weightMinute) { weightMinute = minute; usedWeight = 0; }
  if (Number.isFinite(w)) usedWeight = Math.max(usedWeight, w);
}
async function gate() {
  for (;;) {
    noteWeight(NaN);
    if (usedWeight + (pending + 1) * PAGE_WEIGHT <= MAX_WEIGHT) return;
    await sleep(60_000 - (Date.now() % 60_000) + 2500); // ate o minuto virar, com folga para o relogio
  }
}
async function getJson(query, weight = PAGE_WEIGHT) {
  for (let attempt = 0; ; attempt++) {
    await gate();
    pending += 1;
    usedWeight += 0; // o peso real vem no cabecalho da resposta
    let res;
    try {
      res = await fetch(`${REST_URL}/api/v3/aggTrades?symbol=${SYMBOL}&${query}`, { signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      pending -= 1;
      if (attempt >= 9) throw new Error(`sem resposta da Binance depois de ${attempt + 1} tentativas (${err?.cause?.code ?? err?.name})`);
      await sleep(Math.min(60_000, 2000 * 2 ** attempt));
      continue;
    }
    pending -= 1;
    requests += 1;
    noteWeight(Number(res.headers.get('x-mbx-used-weight-1m')) || usedWeight + weight);
    if (res.status === 418) throw Object.assign(new Error('a Binance BLOQUEOU este endereco por excesso de pedidos (418). Parei tudo; espere o prazo que ela informou antes de tentar de novo'), { fatal: true });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after')) || 60;
      log(`a Binance pediu para esperar ${wait} s (429); esperando`);
      usedWeight = MAX_WEIGHT;
      await sleep((wait + 3) * 1000);
      continue;
    }
    if (!res.ok) {
      if (attempt >= 9) throw new Error(`a Binance respondeu ${res.status} depois de ${attempt + 1} tentativas`);
      await sleep(Math.min(60_000, 2000 * 2 ** attempt));
      continue;
    }
    return res.json();
  }
}

// ---------- banco de saida ----------
const db = new DatabaseSync(OUT);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS flow_1m (
    symbol TEXT NOT NULL, open_time INTEGER NOT NULL,
    buy_qty REAL NOT NULL, sell_qty REAL NOT NULL, buy_quote REAL NOT NULL, sell_quote REAL NOT NULL,
    buy_trades INTEGER NOT NULL, sell_trades INTEGER NOT NULL, first_id INTEGER NOT NULL, last_id INTEGER NOT NULL,
    complete INTEGER NOT NULL,  -- 1 = todos os negocios do minuto foram contados
    confere  INTEGER,           -- 1 = igual ao candle do minuto; 0 = diferente; NULL = sem candle para comparar
    PRIMARY KEY (symbol, open_time)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS big_orders (
    symbol TEXT NOT NULL, first_id INTEGER NOT NULL, last_id INTEGER NOT NULL, time INTEGER NOT NULL,
    taker_buy INTEGER NOT NULL,  -- 1 = compra agressora; 0 = venda agressora
    qty REAL NOT NULL, quote REAL NOT NULL, price_first REAL NOT NULL, price_last REAL NOT NULL, prints INTEGER NOT NULL,
    PRIMARY KEY (symbol, first_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS big_orders_time ON big_orders (symbol, time);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
const metaGet = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
const metaSet = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
const putFlow = db.prepare('INSERT OR REPLACE INTO flow_1m VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const putBig = db.prepare('INSERT OR REPLACE INTO big_orders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

// ---------- de onde ate onde ----------
let startId = Number(metaGet('startId'));
let endId = Number(metaGet('endId'));
let resumeId;
if (metaGet('startId') === null) {
  const [tip] = await getJson('limit=1');
  const since = minuteOf(tip.T - HOURS * 60 * MINUTE);
  const t0 = HOURS >= 48 ? Math.floor(since / (1440 * MINUTE)) * 1440 * MINUTE : since; // periodos longos comecam as 00:00 UTC
  const [first] = await getJson(`startTime=${t0}&endTime=${t0 + 60 * MINUTE - 1}&limit=1`);
  if (!first) throw new Error(`a Binance nao devolveu negocio nenhum a partir de ${iso(t0)}`);
  startId = first.a;
  endId = tip.a;
  resumeId = startId;
  metaSet.run('startId', String(startId));
  metaSet.run('endId', String(endId));
  metaSet.run('startTime', String(first.T));
  metaSet.run('endTime', String(tip.T));
  metaSet.run('resumeId', String(resumeId));
  metaSet.run('done', '0');
  log(`periodo novo: de ${iso(first.T)} a ${iso(tip.T)} UTC, ids ${startId} a ${endId} (${((endId - startId + 1) / 1e6).toFixed(1)} milhoes de negocios, ${Math.ceil((endId - startId + 1) / PAGE)} paginas)`);
} else if (metaGet('done') === '1') {
  log(`este arquivo ja esta completo (ids ${startId} a ${endId}). Para refazer, apague ${OUT}`);
  process.exit(0);
} else {
  resumeId = Number(metaGet('resumeId'));
  // Retomada: o minuto que estava em formacao e refeito do comeco.
  const [probe] = await getJson(`fromId=${resumeId}&limit=1`);
  const from = minuteOf(probe.T);
  db.prepare('DELETE FROM flow_1m WHERE symbol = ? AND open_time >= ?').run(SYMBOL, from);
  db.prepare('DELETE FROM big_orders WHERE symbol = ? AND time >= ?').run(SYMBOL, from);
  log(`retomando do id ${resumeId} (${iso(probe.T)} UTC); faltam ${Math.ceil((endId - resumeId + 1) / PAGE)} paginas`);
}

// Os candles do periodo, para a prova de exatidao (banco principal, so leitura).
const candles = new Map();
{
  const main = new DatabaseSync(DB_FILE, { readOnly: true });
  const t0 = Number(metaGet('startTime')), t1 = Number(metaGet('endTime'));
  for (const c of main.prepare('SELECT open_time t, volume v, taker_buy_volume b, trades n FROM candles WHERE symbol = ? AND closed = 1 AND open_time >= ? AND open_time <= ?').all(SYMBOL, minuteOf(t0), t1)) {
    candles.set(c.t, { v: Math.round(c.v * UNITS), b: Math.round(c.b * UNITS), n: c.n });
  }
  main.close();
}

// ---------- as contas (iguais a `step` de src/trades.js) ----------
let acc = null; // minuto em formacao
let grp = null; // ordem agressora em formacao
const count = { minutes: 0, same: 0, different: 0, noCandle: 0, big: 0, trades: 0 };
let firstMinute = true;
let lastTime = 0;

function closeMinute(complete) {
  const c = candles.get(acc.openTime);
  let ok = null;
  if (c && complete) {
    ok = (acc.buyUnits + acc.sellUnits === c.v && acc.buyUnits === c.b && acc.buyTrades + acc.sellTrades === c.n) ? 1 : 0;
    if (ok) count.same += 1; else count.different += 1;
  } else if (complete) count.noCandle += 1;
  putFlow.run(SYMBOL, acc.openTime, acc.buyUnits / UNITS, acc.sellUnits / UNITS, acc.buyQuote, acc.sellQuote, acc.buyTrades, acc.sellTrades, acc.firstId, acc.lastId, complete ? 1 : 0, ok);
  count.minutes += 1;
  acc = null;
}
function closeGroup() {
  if (!grp) return;
  const g = grp;
  grp = null;
  if (g.quote < BIG_ORDER_USDT) return;
  putBig.run(SYMBOL, g.firstId, g.lastId, g.time, g.takerBuy ? 1 : 0, g.units / UNITS, g.quote, g.priceFirst, g.priceLast, g.prints);
  count.big += 1;
}
function step(r) {
  const time = r.T, price = +r.p, qty = +r.q, takerBuy = !r.m, trades = r.l - r.f + 1;
  const m = minuteOf(time);
  if (acc && m !== acc.openTime) { closeMinute(!acc.partial); firstMinute = false; }
  if (!acc) {
    // O primeiro minuto de uma execucao so e completo se comecamos no primeiro negocio dele.
    acc = { openTime: m, buyUnits: 0, sellUnits: 0, buyQuote: 0, sellQuote: 0, buyTrades: 0, sellTrades: 0, firstId: r.a, lastId: r.a, partial: false };
  }
  const units = Math.round(qty * UNITS);
  const quote = price * qty;
  if (takerBuy) { acc.buyUnits += units; acc.buyQuote += quote; acc.buyTrades += trades; }
  else { acc.sellUnits += units; acc.sellQuote += quote; acc.sellTrades += trades; }
  acc.lastId = r.a;
  if (grp && grp.time === time && grp.takerBuy === takerBuy) {
    grp.units += units; grp.quote += quote; grp.lastId = r.a; grp.priceLast = price; grp.prints += 1;
  } else {
    closeGroup();
    grp = { firstId: r.a, lastId: r.a, time, takerBuy, units, quote, priceFirst: price, priceLast: price, prints: 1 };
  }
  lastTime = time;
  count.trades += 1;
}

// ---------- paginas em paralelo, processadas em ordem ----------
let nextToFetch = resumeId;
let nextToProcess = resumeId;
const ready = new Map();
let pagesDone = 0;
const totalPages = Math.ceil((endId - resumeId + 1) / PAGE);
const started = Date.now();
let failure = null;
let stopping = false;

function checkpoint() {
  metaSet.run('resumeId', String(acc ? acc.firstId : nextToProcess));
  db.exec('COMMIT');
  db.exec('BEGIN');
}
function drain() {
  while (ready.has(nextToProcess)) {
    const rows = ready.get(nextToProcess);
    ready.delete(nextToProcess);
    const expected = Math.min(PAGE, endId - nextToProcess + 1);
    if (rows.length !== expected || rows[0].a !== nextToProcess || rows.at(-1).a !== nextToProcess + expected - 1) {
      throw new Error(`pagina fora do esperado no id ${nextToProcess}: vieram ${rows.length} negocios (${rows[0]?.a} a ${rows.at(-1)?.a}); esperava ${expected} seguidos`);
    }
    for (const r of rows) step(r);
    nextToProcess += expected;
    pagesDone += 1;
    if (pagesDone % 50 === 0) checkpoint();
    if (pagesDone % 1000 === 0 || pagesDone === totalPages) {
      const el = (Date.now() - started) / 1000;
      const left = ((totalPages - pagesDone) * el) / pagesDone;
      log(`${pagesDone} de ${totalPages} paginas (${((100 * pagesDone) / totalPages).toFixed(1)}%) | ate ${iso(lastTime)} UTC | ${count.big} ordens grandes | minutos iguais ao candle ${count.same}, diferentes ${count.different} | peso ${usedWeight} | faltam ~${Math.round(left / 60)} min`);
    }
  }
}
async function worker() {
  while (!failure && !stopping) {
    if (nextToFetch > endId) return;
    if (ready.size > 300) { await sleep(40); continue; } // processamento atrasado: nao acumula memoria
    const from = nextToFetch;
    nextToFetch += PAGE;
    try {
      const rows = await getJson(`fromId=${from}&limit=${Math.min(PAGE, endId - from + 1)}`);
      ready.set(from, rows);
      drain();
    } catch (err) {
      failure = err;
    }
  }
}
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });

db.exec('BEGIN');
await Promise.all(Array.from({ length: CONC }, worker));
if (failure || stopping) {
  metaSet.run('resumeId', String(acc ? acc.firstId : nextToProcess));
  db.exec('COMMIT');
  log(failure ? `PAROU: ${failure.message}` : 'interrompido a pedido');
  log(`feito ate ${iso(lastTime)} UTC (${pagesDone} de ${totalPages} paginas). Rode de novo o mesmo comando para continuar de onde parou.`);
  process.exit(failure?.fatal ? 3 : 1);
}
// Fim: a ultima ordem em formacao esta inteira; o ultimo minuto foi cortado pelo fim do periodo.
closeGroup();
if (acc) closeMinute(false);
metaSet.run('done', '1');
metaSet.run('finishedAt', new Date().toISOString());
db.exec('COMMIT');
const el = (Date.now() - started) / 1000;
log(`PRONTO em ${Math.round(el / 60)} min: ${count.trades} negocios lidos em ${requests} pedidos; ${count.minutes} minutos (iguais ao candle ${count.same}, diferentes ${count.different}, sem candle ${count.noCandle}); ${count.big} ordens grandes a partir de ${BIG_ORDER_USDT} USDT`);
log(`arquivo: ${OUT}`);
