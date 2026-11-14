// Valida o banco local contra a API publica da Binance.
//
//   node scripts/validar.js            (precisa do servidor rodando em http://localhost:3333)
//   node scripts/validar.js --sem-api  (pula a parte que usa /api/candles; so banco x Binance)
//
// O que confere:
//   1. 20 candles fechados de 1m sorteados do banco x Binance (O, H, L, C, volume, taker buy,
//      quote volume e numero de negocios). Precisa ser identico.
//   2. 5 candles de 1h e 2 de 1d calculados pelo nosso /api/candles x candles de 1h e 1d da
//      Binance. OHLC e negocios identicos; volumes com tolerancia de arredondamento.
//   3. Buracos: lista qualquer minuto faltando entre o primeiro e o ultimo candle do banco.
//   4. Sanidade: duplicados, candles marcados como abertos, relogio local x Binance.
//
// Teste de retomada (parar, esperar, subir de novo) e manual: rode este script antes e depois;
// a contagem deve crescer so pelos minutos que passaram, sem buraco e sem duplicado.
//
// Sai com codigo 1 se achar qualquer diferenca.

import { fileURLToPath } from 'node:url';

const SYMBOL = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const REST = process.env.BINANCE_REST || 'https://api.binance.com';
const API = process.env.API || 'http://localhost:3333';
const MINUTE = 60_000;
const SEM_API = process.argv.includes('--sem-api');

const { DatabaseSync } = await import('node:sqlite');
const dbFile = fileURLToPath(new URL('../data/market.db', import.meta.url));
const db = new DatabaseSync(dbFile, { readOnly: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
let falhas = 0;

async function binance(interval, startTime, limit = 1) {
  const url = `${REST}/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&startTime=${startTime}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Binance ${res.status} em ${url}`);
  const rows = await res.json();
  await sleep(120);
  return rows.map((k) => ({
    openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    closeTime: k[6], quoteVolume: +k[7], trades: k[8], takerBuyVolume: +k[9],
  }));
}

// Campos comparados e como: 'exato' exige igualdade; 'tol' aceita erro de arredondamento
// (soma de 60 ou 1440 numeros em ponto flutuante pode diferir do total da Binance em ~1e-9).
const CAMPOS = [
  ['open', 'exato'], ['high', 'exato'], ['low', 'exato'], ['close', 'exato'],
  ['volume', 'tol'], ['takerBuyVolume', 'tol'], ['quoteVolume', 'tol'], ['trades', 'exato'],
];

function comparar(nosso, deles, tolerante) {
  const difs = [];
  for (const [campo, modo] of CAMPOS) {
    const a = nosso[campo], b = deles[campo];
    let igual;
    if (modo === 'tol' && tolerante) igual = Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);
    else igual = a === b;
    if (!igual) difs.push(`${campo}: nosso=${a} binance=${b}`);
  }
  return difs;
}

function tabela(linhas) {
  if (!linhas.length) return;
  const cols = Object.keys(linhas[0]);
  const w = cols.map((c) => Math.max(c.length, ...linhas.map((l) => String(l[c]).length)));
  const fmt = (l) => cols.map((c, i) => String(l[c]).padEnd(w[i])).join('  ');
  console.log(fmt(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const l of linhas) console.log(fmt(l));
}

function sortear(arr, n) {
  const copia = [...arr];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia.slice(0, n).sort((a, b) => a.openTime - b.openTime);
}

// ---------- 0. visao geral e relogio ----------
const geral = db.prepare(
  'SELECT COUNT(*) n, MIN(open_time) f, MAX(open_time) l, SUM(closed) fechados FROM candles WHERE symbol = ?',
).get(SYMBOL);
console.log(`\n== Banco (${SYMBOL}) ==`);
console.log(`candles: ${geral.n}  fechados: ${geral.fechados}  abertos: ${geral.n - geral.fechados}`);
console.log(`primeiro: ${iso(geral.f)} UTC   ultimo: ${iso(geral.l)} UTC`);
const esperado = (geral.l - geral.f) / MINUTE + 1;
console.log(`esperado sem buracos: ${esperado}  ${esperado === geral.n ? 'OK' : `DIFERENTE (faltam ${esperado - geral.n})`}`);

const antes = Date.now();
const { serverTime } = await (await fetch(`${REST}/api/v3/time`)).json();
const desvio = (antes + (Date.now() - antes) / 2) - serverTime;
console.log(`relogio local - Binance: ${(desvio / 1000).toFixed(1)} s ${Math.abs(desvio) > 30_000 ? '<< RELOGIO DESSINCRONIZADO' : 'OK'}`);

// ---------- 1. 20 candles de 1m ----------
console.log('\n== 1. 20 candles fechados de 1m: banco x Binance ==');
const fechados = db.prepare(
  `SELECT open_time openTime, open, high, low, close, volume, quote_volume quoteVolume, trades,
          taker_buy_volume takerBuyVolume FROM candles WHERE symbol = ? AND closed = 1`,
).all(SYMBOL);
const amostra = sortear(fechados, 20);
const linhas1 = [];
for (const c of amostra) {
  const [b] = await binance('1m', c.openTime, 1);
  const difs = b && b.openTime === c.openTime ? comparar(c, b, false) : ['Binance nao devolveu esse minuto'];
  if (difs.length) falhas++;
  linhas1.push({
    'abertura (UTC)': iso(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close,
    volume: c.volume, takerBuy: c.takerBuyVolume, trades: c.trades,
    resultado: difs.length ? 'DIFERENTE: ' + difs.join('; ') : 'identico',
  });
}
tabela(linhas1);

// ---------- 2. 1h e 1d via /api/candles ----------
if (!SEM_API) {
  console.log('\n== 2. candles de 1h e 1d calculados por /api/candles x Binance ==');
  let apiOk = true;
  try { await fetch(`${API}/api/info`, { signal: AbortSignal.timeout(3000) }); } catch { apiOk = false; }
  if (!apiOk) {
    console.log(`servidor nao responde em ${API}; pulei esta parte (use --sem-api para nao avisar)`);
    falhas++;
  } else {
    for (const [tf, ms, qtd] of [['1h', 3600_000, 5], ['1d', 86_400_000, 2]]) {
      const rows = await (await fetch(`${API}/api/candles?tf=${tf}&limit=2000`)).json();
      // So candles inteiramente cobertos pelo banco e ja fechados:
      const completos = rows.filter((r) => r.openTime >= geral.f && r.openTime + ms - MINUTE <= geral.l && r.openTime + ms <= serverTime);
      const escolhidos = sortear(completos, qtd);
      const linhas = [];
      for (const c of escolhidos) {
        const [b] = await binance(tf, c.openTime, 1);
        const difs = b && b.openTime === c.openTime ? comparar(c, b, true) : ['Binance nao devolveu esse candle'];
        if (difs.length) falhas++;
        linhas.push({
          tf, 'abertura (UTC)': iso(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close,
          volume: +c.volume.toFixed(5), 'volume Binance': b ? b.volume : '-', trades: c.trades,
          resultado: difs.length ? 'DIFERENTE: ' + difs.join('; ') : 'identico (volumes dentro do arredondamento)',
        });
      }
      tabela(linhas);
      console.log('');
    }
  }
}

// ---------- 3. buracos e duplicados ----------
console.log('== 3. buracos entre o primeiro e o ultimo candle ==');
const tempos = db.prepare('SELECT open_time t FROM candles WHERE symbol = ? ORDER BY open_time').all(SYMBOL).map((r) => r.t);
const buracos = [];
for (let i = 1; i < tempos.length; i++) {
  const salto = tempos[i] - tempos[i - 1];
  if (salto !== MINUTE) buracos.push({ de: iso(tempos[i - 1] + MINUTE), ate: iso(tempos[i] - MINUTE), minutos: salto / MINUTE - 1 });
}
if (buracos.length) { falhas++; tabela(buracos); } else console.log('nenhum buraco');

// A Binance pode nao ter candle em minutos de manutencao; um buraco so e erro nosso
// se a Binance tiver o candle. Confere ate 5 buracos.
for (const b of buracos.slice(0, 5)) {
  const inicio = Date.parse(b.de.replace(' ', 'T') + ':00Z');
  const deles = await binance('1m', inicio, Math.min(1000, b.minutos));
  console.log(`  buraco ${b.de}: Binance tem ${deles.length} candle(s) nesse trecho ${deles.length ? '<< ERRO NOSSO' : '(manutencao da Binance, nao e erro)'}`);
}

// ---------- 4. sanidade ----------
console.log('\n== 4. sanidade ==');
const dup = db.prepare('SELECT open_time, COUNT(*) c FROM candles WHERE symbol = ? GROUP BY open_time HAVING c > 1').all(SYMBOL);
console.log(`duplicados: ${dup.length} ${dup.length ? '<< ERRO' : 'OK'}`);
if (dup.length) falhas++;
const abertos = db.prepare('SELECT open_time t FROM candles WHERE symbol = ? AND closed = 0 ORDER BY open_time').all(SYMBOL);
const velhos = abertos.filter((r) => r.t + MINUTE <= serverTime - MINUTE);
console.log(`candles marcados como abertos: ${abertos.length} (deveria ser 0 ou 1, o minuto atual)`);
if (velhos.length) {
  falhas++;
  console.log(`  ${velhos.length} ja fechados na Binance mas com closed=0 no banco: ${velhos.map((r) => iso(r.t)).join(', ')}`);
}

console.log(`\n${falhas ? `FALHOU: ${falhas} problema(s)` : 'TUDO OK'}`);
process.exit(falhas ? 1 : 0);
