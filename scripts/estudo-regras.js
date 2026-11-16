// Campeonato de regras: procura, SEM olhar o futuro, regras de entrada que perdem mais do que
// entrar as cegas. Sao 20 situacoes simples e conhecidas (alta forte, rompimento, cruzamento de
// media, IFR, volume...); em cada uma testa-se comprar E vender, em dois jeitos de operar.
//
// O protocolo (treino, confirmacao e a regua "as cegas") esta em scripts/lib/campeonato.js e foi
// fixado antes de rodar: treino = todo o historico menos os ultimos 92 dias; confirmacao = os
// ultimos 92 dias. Por sorte pura, espera-se cerca de 2 candidatas em 80 e quase nenhuma
// confirmada.
//
// Um sinal so vale quando a situacao COMECA (no exame anterior ela nao valia).
//
// Le o banco so em leitura.
// Uso: node scripts/estudo-regras.js [--saida=pasta] [--corte=2026-08-15] [--fim=2026-11-15T21:00:00Z]
// Saida: estudo-regras.json, boletas-regras.csv e sinais.json.
import path from 'node:path';
import { DB_FILE, SYMBOL, MINUTE, REPLAY_FEE_PCT } from '../src/config.js';
import { loadCandles } from './lib/historico.js';
import { championship } from './lib/campeonato.js';

process.removeAllListeners('warning');
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const DAY = 1440;
const CONFIGS = [
  { key: 'medio', label: 'stop 0,5% / alvo 1% / ate 4 h', stopPct: 0.5, targetPct: 1.0, maxMin: 240 },
  { key: 'longo', label: 'stop 1% / alvo 2% / ate 24 h', stopPct: 1.0, targetPct: 2.0, maxMin: 1440 },
];

// ---------- dados e medidas ----------
const C = loadCandles(DB_FILE, SYMBOL, arg('fim', null) ? Date.parse(arg('fim')) : undefined);
const N = C.length;
if (N < 200 * DAY) throw new Error(`historico curto demais para treino e confirmacao: ${Math.round(N / DAY)} dias (baixe mais com BACKFILL_DAYS)`);
const OUT = arg('saida', path.join(path.dirname(DB_FILE), 'relatorios', `${new Date().toISOString().slice(0, 10)}-regras`));
const SPLIT = arg('corte', null) ? Date.parse(`${arg('corte')}T00:00:00Z`) : Math.floor((C[N - 1].openTime - 92 * DAY * MINUTE) / (DAY * MINUTE)) * DAY * MINUTE;

const open = new Float64Array(N), high = new Float64Array(N), low = new Float64Array(N), close = new Float64Array(N);
const pc = new Float64Array(N + 1), pv = new Float64Array(N + 1), pb = new Float64Array(N + 1);
for (let i = 0; i < N; i++) {
  open[i] = C[i].open; high[i] = C[i].high; low[i] = C[i].low; close[i] = C[i].close;
  pc[i + 1] = pc[i] + C[i].close; pv[i + 1] = pv[i] + C[i].volume; pb[i + 1] = pb[i] + C[i].buy;
}
// Maior (ou menor) valor dos ultimos n candles, incluindo o atual.
function rolling(arr, n, beats) {
  const out = new Float64Array(arr.length);
  const dq = [];
  let head = 0;
  for (let i = 0; i < arr.length; i++) {
    while (dq.length > head && beats(arr[i], arr[dq[dq.length - 1]])) dq.pop();
    dq.push(i);
    if (dq[head] <= i - n) head += 1;
    out[i] = arr[dq[head]];
  }
  return out;
}
const hi240 = rolling(high, 240, (a, b) => a >= b), lo240 = rolling(low, 240, (a, b) => a <= b);
const hi1440 = rolling(high, 1440, (a, b) => a >= b), lo1440 = rolling(low, 1440, (a, b) => a <= b);

const endsBar = (i, min) => (C[i].openTime + MINUTE) % (min * MINUTE) === 0; // o candle i fecha uma barra de `min` minutos
const ret = (i, n) => (close[i] / close[i - n] - 1) * 100;                    // variacao dos ultimos n minutos, em %
const sma = (i, n) => (pc[i + 1] - pc[i + 1 - n]) / n;                        // media dos ultimos n fechamentos
const bar5 = (i) => (close[i] / open[i - 4] - 1) * 100;                       // variacao do candle de 5 min que acabou de fechar
const up15 = (i) => close[i] > open[i - 14];                                  // candle de 15 min que fecha em i foi de alta
const down15 = (i) => close[i] < open[i - 14];
const vol5 = (i) => pv[i + 1] - pv[i - 4];
const buyShare5 = (i) => (vol5(i) > 0 ? (pb[i + 1] - pb[i - 4]) / vol5(i) : 0.5);
const volUsual = (i) => (pv[i - 4] - pv[i - 244]) / 48;                       // volume medio por 5 min nas 4 horas anteriores

// IFR (RSI) de 14 periodos nos candles de 15 minutos, pela media de Wilder.
const rsi = new Float64Array(N).fill(NaN);
{
  const ends = [];
  for (let i = 14; i < N; i++) if (endsBar(i, 15)) ends.push(i);
  let gain = 0, loss = 0;
  for (let k = 1; k < ends.length; k++) {
    const d = close[ends[k]] - close[ends[k - 1]];
    const g = Math.max(d, 0), l = Math.max(-d, 0);
    if (k <= 14) { gain += g / 14; loss += l / 14; } else { gain = (gain * 13 + g) / 14; loss = (loss * 13 + l) / 14; }
    if (k >= 14) rsi[ends[k]] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
}

// ---------- as 20 situacoes ----------
// `when(i)` olha so candles fechados ate i. `every` = de quantos em quantos minutos e examinada.
const SITUATIONS = [
  { key: 'S01', nome: 'subiu 1% ou mais em 1 hora', every: 5, when: (i) => ret(i, 60) >= 1 && ret(i - 5, 60) < 1 },
  { key: 'S02', nome: 'caiu 1% ou mais em 1 hora', every: 5, when: (i) => ret(i, 60) <= -1 && ret(i - 5, 60) > -1 },
  { key: 'S03', nome: 'subiu 3% ou mais em 24 horas', every: 5, when: (i) => ret(i, 1440) >= 3 && ret(i - 5, 1440) < 3 },
  { key: 'S04', nome: 'caiu 3% ou mais em 24 horas', every: 5, when: (i) => ret(i, 1440) <= -3 && ret(i - 5, 1440) > -3 },
  { key: 'S05', nome: 'rompeu a maxima das ultimas 24 horas', every: 5, when: (i) => close[i] > hi1440[i - 5] && close[i - 5] <= hi1440[i - 10] },
  { key: 'S06', nome: 'rompeu a minima das ultimas 24 horas', every: 5, when: (i) => close[i] < lo1440[i - 5] && close[i - 5] >= lo1440[i - 10] },
  { key: 'S07', nome: 'rompeu a maxima das ultimas 4 horas', every: 5, when: (i) => close[i] > hi240[i - 5] && close[i - 5] <= hi240[i - 10] },
  { key: 'S08', nome: 'rompeu a minima das ultimas 4 horas', every: 5, when: (i) => close[i] < lo240[i - 5] && close[i - 5] >= lo240[i - 10] },
  { key: 'S09', nome: 'tres candles de 15 minutos seguidos de alta', every: 15, when: (i) => up15(i) && up15(i - 15) && up15(i - 30) && !up15(i - 45) },
  { key: 'S10', nome: 'tres candles de 15 minutos seguidos de queda', every: 15, when: (i) => down15(i) && down15(i - 15) && down15(i - 30) && !down15(i - 45) },
  { key: 'S11', nome: 'candle de 5 minutos de alta de 0,5% ou mais', every: 5, when: (i) => bar5(i) >= 0.5 },
  { key: 'S12', nome: 'candle de 5 minutos de queda de 0,5% ou mais', every: 5, when: (i) => bar5(i) <= -0.5 },
  { key: 'S13', nome: 'preco cruzou para cima a media de 20 horas', every: 5, when: (i) => close[i] > sma(i, 1200) && close[i - 5] <= sma(i - 5, 1200) },
  { key: 'S14', nome: 'preco cruzou para baixo a media de 20 horas', every: 5, when: (i) => close[i] < sma(i, 1200) && close[i - 5] >= sma(i - 5, 1200) },
  { key: 'S15', nome: 'media curta (5 h) cruzou para cima a longa (12,5 h)', every: 5, when: (i) => sma(i, 300) > sma(i, 750) && sma(i - 5, 300) <= sma(i - 5, 750) },
  { key: 'S16', nome: 'media curta (5 h) cruzou para baixo a longa (12,5 h)', every: 5, when: (i) => sma(i, 300) < sma(i, 750) && sma(i - 5, 300) >= sma(i - 5, 750) },
  { key: 'S17', nome: 'IFR de 15 minutos caiu abaixo de 30 (sobrevendido)', every: 15, when: (i) => rsi[i] < 30 && rsi[i - 15] >= 30 },
  { key: 'S18', nome: 'IFR de 15 minutos passou de 70 (sobrecomprado)', every: 15, when: (i) => rsi[i] > 70 && rsi[i - 15] <= 70 },
  { key: 'S19', nome: 'volume de 5 minutos 4x o normal, com agressao compradora', every: 5, when: (i) => vol5(i) >= 4 * volUsual(i) && buyShare5(i) >= 0.6 },
  { key: 'S20', nome: 'volume de 5 minutos 4x o normal, com agressao vendedora', every: 5, when: (i) => vol5(i) >= 4 * volUsual(i) && buyShare5(i) <= 0.4 },
];

const FIRST = 2 * DAY;          // dois dias de aquecimento para medias, maximas e IFR
const LAST = N - DAY - 1;       // sobra um dia inteiro para a operacao mais longa terminar
for (const s of SITUATIONS) {
  s.triggers = [];
  for (let i = FIRST; i <= LAST; i++) if (endsBar(i, s.every) && s.when(i)) s.triggers.push(i);
}

championship({
  C, symbol: SYMBOL, fee: REPLAY_FEE_PCT, configs: CONFIGS, situations: SITUATIONS, first: FIRST, last: LAST, split: SPLIT, out: OUT,
  files: { json: 'estudo-regras.json', csv: 'boletas-regras.csv' }, title: 'CAMPEONATO DE REGRAS',
});
