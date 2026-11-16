// Teste das "baleias": o que acontece DEPOIS de uma ordem agressora grande? Vale a pena comprar
// ou vender junto (ou contra)? Usa as ordens grandes reconstruidas por
// scripts/reconstruir-baleias.js (data/baleias.db) e o mesmo protocolo do campeonato de regras
// (scripts/lib/campeonato.js): escolhe no treino, confere na confirmacao, e a regua e entrar as
// cegas. Treino = os primeiros 60 dias; confirmacao = o resto.
//
// A ordem grande e conhecida no fim do minuto em que aconteceu: a entrada e no fechamento desse
// minuto. As situacoes sao examinadas de minuto em minuto.
//
// So entra no estudo o trecho em que a reconstrucao esta completa (todos os minutos conferidos
// com os candles). Le os dois bancos so em leitura.
// Uso: node scripts/estudo-baleias.js [--saida=pasta] [--corte=2026-10-16] [--baleias=arquivo.db] [--parcial]
// Saida: estudo-baleias.json, boletas-baleias.csv e sinais.json.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { DB_FILE, SYMBOL, MINUTE, REPLAY_FEE_PCT, BIG_ORDER_USDT } from '../src/config.js';
import { loadCandles, utc } from './lib/historico.js';
import { championship } from './lib/campeonato.js';

process.removeAllListeners('warning');
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const DAY = 1440;
const WHALES = arg('baleias', path.join(path.dirname(DB_FILE), 'baleias.db'));
const OUT = arg('saida', path.join(path.dirname(DB_FILE), 'relatorios', `${new Date().toISOString().slice(0, 10)}-baleias`));
const CONFIGS = [
  { key: 'curto', label: 'stop 0,2% / alvo 0,4% / ate 1 h', stopPct: 0.2, targetPct: 0.4, maxMin: 60 },
  { key: 'medio', label: 'stop 0,5% / alvo 1% / ate 4 h', stopPct: 0.5, targetPct: 1.0, maxMin: 240 },
  { key: 'longo', label: 'stop 1% / alvo 2% / ate 24 h', stopPct: 1.0, targetPct: 2.0, maxMin: 1440 },
];

// ---------- dados ----------
const wdb = new DatabaseSync(WHALES, { readOnly: true });
const meta = Object.fromEntries(wdb.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
if (meta.done !== '1' && !process.argv.includes('--parcial')) throw new Error('a reconstrucao das ordens grandes ainda nao terminou (rode scripts/reconstruir-baleias.js ate o fim, ou use --parcial para testar com o que ja existe)');
const flow = wdb.prepare('SELECT MIN(open_time) a, MAX(open_time) b, COUNT(*) n, SUM(confere = 1) ok, SUM(confere = 0) bad FROM flow_1m WHERE symbol = ? AND complete = 1').get(SYMBOL);
if (flow.bad > 0) throw new Error(`${flow.bad} minutos reconstruidos nao batem com os candles: investigar antes de estudar`);
const orders = wdb.prepare('SELECT time, taker_buy AS buy, quote FROM big_orders WHERE symbol = ? AND time >= ? AND time < ? ORDER BY time').all(SYMBOL, flow.a, flow.b + MINUTE);
wdb.close();

const C = loadCandles(DB_FILE, SYMBOL);
const N = C.length;
const idx = (t) => Math.floor((t - C[0].openTime) / MINUTE);
const open = (i) => C[i].open, close = (i) => C[i].close;
const ret = (i, n) => (close(i) / close(i - n) - 1) * 100;

// Por minuto: soma em USDT das ordens grandes de cada lado, quantas foram e a maior delas.
const buyQ = new Float64Array(N), sellQ = new Float64Array(N), maxBuy = new Float64Array(N), maxSell = new Float64Array(N);
const buyN = new Int32Array(N), sellN = new Int32Array(N);
for (const o of orders) {
  const i = idx(o.time);
  if (i < 0 || i >= N) continue;
  if (o.buy) { buyQ[i] += o.quote; buyN[i] += 1; if (o.quote > maxBuy[i]) maxBuy[i] = o.quote; }
  else { sellQ[i] += o.quote; sellN[i] += 1; if (o.quote > maxSell[i]) maxSell[i] = o.quote; }
}
const pNet = new Float64Array(N + 1);
for (let i = 0; i < N; i++) pNet[i + 1] = pNet[i] + buyQ[i] - sellQ[i];
const net = (i, k) => pNet[i + 1] - pNet[i + 1 - k]; // saldo (compras - vendas) das ordens grandes nos ultimos k minutos

const FIRST = idx(flow.a) + 60;                       // uma hora de aquecimento
const LAST = Math.min(idx(flow.b), N - DAY - 1);      // sobra um dia para a operacao mais longa terminar
if (LAST - FIRST < 20 * DAY && !process.argv.includes('--parcial')) throw new Error('periodo reconstruido curto demais para treino e confirmacao');
const SPLIT = arg('corte', null) ? Date.parse(`${arg('corte')}T00:00:00Z`) : Math.floor(flow.a / (DAY * MINUTE)) * DAY * MINUTE + 60 * DAY * MINUTE;

// ---------- as situacoes ----------
const M = 1e6;
const SITUATIONS = [
  { key: 'B01', nome: 'uma compra agressora de 1 milhao de USDT ou mais', when: (i) => maxBuy[i] >= 1 * M },
  { key: 'B02', nome: 'uma venda agressora de 1 milhao de USDT ou mais', when: (i) => maxSell[i] >= 1 * M },
  { key: 'B03', nome: 'uma compra agressora de 3 milhoes ou mais', when: (i) => maxBuy[i] >= 3 * M },
  { key: 'B04', nome: 'uma venda agressora de 3 milhoes ou mais', when: (i) => maxSell[i] >= 3 * M },
  { key: 'B05', nome: 'saldo das ordens grandes em 5 minutos: +3 milhoes ou mais', when: (i) => net(i, 5) >= 3 * M && net(i - 1, 5) < 3 * M },
  { key: 'B06', nome: 'saldo das ordens grandes em 5 minutos: -3 milhoes ou menos', when: (i) => net(i, 5) <= -3 * M && net(i - 1, 5) > -3 * M },
  { key: 'B07', nome: 'saldo das ordens grandes em 30 minutos: +10 milhoes ou mais', when: (i) => net(i, 30) >= 10 * M && net(i - 1, 30) < 10 * M },
  { key: 'B08', nome: 'saldo das ordens grandes em 30 minutos: -10 milhoes ou menos', when: (i) => net(i, 30) <= -10 * M && net(i - 1, 30) > -10 * M },
  { key: 'B09', nome: '30 ou mais ordens grandes de compra no mesmo minuto', when: (i) => buyN[i] >= 30 },
  { key: 'B10', nome: '30 ou mais ordens grandes de venda no mesmo minuto', when: (i) => sellN[i] >= 30 },
  { key: 'B11', nome: 'compra de 1 milhao ou mais depois de queda de 0,5% em 1 hora', when: (i) => maxBuy[i] >= 1 * M && ret(i, 60) <= -0.5 },
  { key: 'B12', nome: 'venda de 1 milhao ou mais depois de alta de 0,5% em 1 hora', when: (i) => maxSell[i] >= 1 * M && ret(i, 60) >= 0.5 },
  { key: 'B13', nome: 'venda de 1 milhao ou mais e o minuto fechou em alta (venda absorvida)', when: (i) => maxSell[i] >= 1 * M && close(i) > open(i) },
  { key: 'B14', nome: 'compra de 1 milhao ou mais e o minuto fechou em queda (compra absorvida)', when: (i) => maxBuy[i] >= 1 * M && close(i) < open(i) },
];
for (const s of SITUATIONS) {
  s.every = 1;
  s.triggers = [];
  for (let i = FIRST; i <= LAST; i++) if (s.when(i)) s.triggers.push(i);
}

// ---------- retrato das ordens grandes do periodo ----------
const inRange = orders.filter((o) => { const i = idx(o.time); return i >= FIRST && i <= LAST; });
const bucket = (lo, hi) => {
  const l = inRange.filter((o) => o.quote >= lo && o.quote < hi);
  return { de: lo, ate: hi === Infinity ? null : hi, quantas: l.length, compras: l.filter((o) => o.buy).length, vendas: l.filter((o) => !o.buy).length, somaUsdt: l.reduce((s, o) => s + o.quote, 0) };
};
const days = (C[LAST].openTime - C[FIRST].openTime) / (DAY * MINUTE);
const extra = {
  arquivo: path.basename(WHALES), reconstrucaoCompleta: meta.done === '1',
  de: utc(C[FIRST].openTime), ate: utc(C[LAST].openTime), dias: days, pisoUsdt: BIG_ORDER_USDT,
  minutosConferidosComOsCandles: flow.ok, minutosDiferentes: flow.bad,
  ordensGrandes: inRange.length, porDia: inRange.length / days,
  compras: inRange.filter((o) => o.buy).length, vendas: inRange.filter((o) => !o.buy).length,
  somaComprasUsdt: inRange.filter((o) => o.buy).reduce((s, o) => s + o.quote, 0), somaVendasUsdt: inRange.filter((o) => !o.buy).reduce((s, o) => s + o.quote, 0),
  faixas: [bucket(25e3, 100e3), bucket(100e3, 250e3), bucket(250e3, 500e3), bucket(500e3, 1e6), bucket(1e6, 3e6), bucket(3e6, 5e6), bucket(5e6, Infinity)],
  maiores: [...inRange].sort((a, b) => b.quote - a.quote).slice(0, 12).map((o) => ({ utc: utc(o.time), lado: o.buy ? 'compra' : 'venda', usdt: o.quote, preco: close(idx(o.time)), depois5min: ret(idx(o.time) + 5, 5), depois60min: ret(idx(o.time) + 60, 60) })),
};

championship({
  C, symbol: SYMBOL, fee: REPLAY_FEE_PCT, configs: CONFIGS, situations: SITUATIONS, first: FIRST, last: LAST, split: SPLIT, out: OUT,
  files: { json: 'estudo-baleias.json', csv: 'boletas-baleias.csv' }, title: 'TESTE DAS BALEIAS', horizons: [1, 5, 15, 60], extra,
});
console.log(`\nordens grandes no periodo: ${extra.ordensGrandes} (${extra.porDia.toFixed(0)} por dia); compras ${extra.compras}, vendas ${extra.vendas}`);
for (const b of extra.faixas) console.log(`  de ${String(b.de / 1000).padStart(5)} mil${b.ate ? ` a ${String(b.ate / 1000).padStart(5)} mil` : ' em diante   '}: ${String(b.quantas).padStart(7)} (compras ${b.compras}, vendas ${b.vendas})`);
