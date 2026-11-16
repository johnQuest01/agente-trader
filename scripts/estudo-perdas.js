// Teste reverso: em vez de procurar operacoes que ganham, simula muitas operacoes "ingenuas"
// no historico real (compra E venda, de meia em meia hora, com stop e alvo fixos), separa SO
// as que perderam e mede o que elas tem em comum. Serve para aprender o que evitar.
//
// As contas de cada operacao sao as mesmas do replay (src/replay.js, conferidas por
// scripts/testar-replay.js): entrada no fechamento do candle, pior caso dentro do candle
// (stop antes do alvo), taxa de REPLAY_FEE_PCT por lado. Aqui o passo e de 1 minuto.
//
// Le o banco SO EM LEITURA (pode rodar com o programa no ar) e nao grava nada nele.
// Uso: node scripts/estudo-perdas.js [--passo=30] [--saida=pasta] [--de=2026-01-01] [--ate=2026-06-30]
// Saida: boletas-so-perdas.csv (uma linha por operacao perdedora), boletas-errando-todas.csv
// (em cada entrada, so o lado que perde: 100% de perdas) e estudo-perdas.json.
//
// Dois numeros que nao devem ser confundidos:
//   - "as cegas" (compra E venda em toda entrada): com alvo de 2x o stop e preco sem direcao,
//     2 em cada 3 saem no stop. Perder perto de 67% e o esperado, nao um defeito do teste;
//   - "errando todas" (em cada entrada, o lado que perde): 100% de perdas por construcao. So
//     e possivel olhando o futuro; nenhuma regra de verdade consegue isso, nem o contrario.
//
// AVISOS (valem para qualquer numero que sair daqui):
//   - e um retrato do periodo que esta no banco, nao uma previsao;
//   - as operacoes se sobrepoem no tempo (nao sao amostras independentes);
//   - nao ha derrapagem: a entrada e exatamente no fechamento, e o stop sai no preco do stop
//     (a nao ser que o candle ja abra alem dele).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DB_FILE, SYMBOL, MINUTE, REPLAY_FEE_PCT } from '../src/config.js';
import { BRT, WD, brt, loadCandles, simulate as simulateOne, utc } from './lib/historico.js';

process.removeAllListeners('warning');
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const STEP = Number(arg('passo', 30));
const OUT = arg('saida', path.join(path.dirname(DB_FILE), 'relatorios', new Date().toISOString().slice(0, 10)));
const FEE = REPLAY_FEE_PCT;
const DAY = 1440;

// Tres jeitos de operar, todos com alvo de 2x o stop. O stop "curto" fica do tamanho do
// balanco normal de 1 hora; o "longo", do balanco normal de 1 dia.
const CONFIGS = [
  { key: 'curto', label: 'stop 0,2% / alvo 0,4% / ate 1 h', stopPct: 0.2, targetPct: 0.4, maxMin: 60 },
  { key: 'medio', label: 'stop 0,5% / alvo 1% / ate 4 h', stopPct: 0.5, targetPct: 1.0, maxMin: 240 },
  { key: 'longo', label: 'stop 1% / alvo 2% / ate 24 h', stopPct: 1.0, targetPct: 2.0, maxMin: 1440 },
];

// Exemplos de limites para a conta "errando todas". Sao exemplos para comparar, nao os limites
// do projeto (esses ficam em src/limits.js e quem define e o Bruno).
const LIMIT_EXAMPLES = [
  { p: 0.25, N: 2, D: 0.5 }, { p: 0.5, N: 2, D: 1 }, { p: 0.5, N: 3, D: 1.5 }, { p: 1, N: 2, D: 2 },
  { p: 1, N: 3, D: 3 }, { p: 1, N: 5, D: 3 }, { p: 2, N: 3, D: 6 }, { p: 2, N: 5, D: 6 },
];

// ---------- dados ----------
const C = loadCandles(DB_FILE, SYMBOL);
const N = C.length;
if (N < 3 * DAY) throw new Error(`historico curto demais para o estudo: ${N} candles`);
const pv = new Float64Array(N + 1);
const pb = new Float64Array(N + 1);
for (let i = 0; i < N; i++) { pv[i + 1] = pv[i] + C[i].volume; pb[i + 1] = pb[i] + C[i].buy; }

const sum = (a) => a.reduce((s, x) => s + x, 0);
const pct = (a, b) => (a / b - 1) * 100;

// O que se via no momento da entrada (so candles ja fechados ate ali).
function context(i) {
  let hi60 = -Infinity, lo60 = Infinity, hi240 = -Infinity, lo240 = Infinity;
  for (let k = i - 239; k <= i; k++) {
    if (C[k].high > hi240) hi240 = C[k].high;
    if (C[k].low < lo240) lo240 = C[k].low;
    if (k > i - 60) { if (C[k].high > hi60) hi60 = C[k].high; if (C[k].low < lo60) lo60 = C[k].low; }
  }
  const v30 = pv[i + 1] - pv[i - 29];
  const b30 = pb[i + 1] - pb[i - 29];
  return {
    ret60: pct(C[i].close, C[i - 60].close),
    ret240: pct(C[i].close, C[i - 240].close),
    ret1440: pct(C[i].close, C[i - 1440].close),
    range60: ((hi60 - lo60) / C[i].close) * 100,          // quanto o preco balancou na ultima hora
    pos240: hi240 > lo240 ? (C[i].close - lo240) / (hi240 - lo240) : 0.5, // 0 = no fundo da faixa de 4 h; 1 = no topo
    aggr30: v30 > 0 ? ((2 * b30 - v30) / v30) * 100 : 0,   // saldo de agressao dos ultimos 30 min, em % do volume
  };
}

// A simulacao de uma operacao fica em scripts/lib/historico.js, comum aos estudos.
const simulate = (i, side, cfg) => simulateOne(C, i, side, cfg, FEE);

// ---------- operacoes ----------
const FROM = arg('de', null) ? Date.parse(`${arg('de')}T00:00:00Z`) : -Infinity;
const TO = arg('ate', null) ? Date.parse(`${arg('ate')}T00:00:00Z`) + DAY * MINUTE : Infinity;
const entries = [];
for (let i = DAY; i + DAY < N; i++) {
  const when = C[i].openTime + MINUTE;
  if (when % (STEP * MINUTE) === 0 && when >= FROM && when < TO) entries.push(i);
}
if (!entries.length) throw new Error('nenhuma entrada no periodo pedido');
const trades = []; // todas; as perdedoras sao netPct < 0
for (const i of entries) {
  const ctx = context(i);
  const day = utc(C[i].openTime + MINUTE).slice(0, 10); // dia (UTC) da entrada
  for (const cfg of CONFIGS) {
    for (const side of ['buy', 'sell']) trades.push({ cfg: cfg.key, i, day, ...ctx, ...simulate(i, side, cfg) });
  }
}

// ---------- contas ----------
function stats(list) {
  if (!list.length) return { n: 0 };
  const nets = list.map((x) => x.netPct);
  const losers = list.filter((x) => x.netPct < 0);
  let cum = 0, peak = 0, dd = 0, worst = Infinity;
  for (const x of nets) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); if (x < worst) worst = x; }
  return {
    n: list.length, perdas: losers.length, pctPerdas: (100 * losers.length) / list.length,
    liquido: cum, quedaMaxima: dd, pior: worst, expectativa: cum / list.length,
    rMedio: sum(list.map((x) => x.rMultiple)) / list.length,
    perdaMedia: losers.length ? sum(losers.map((x) => x.netPct)) / losers.length : 0,
  };
}
const tri = (x, lim) => (x > lim ? 'a favor' : x < -lim ? 'contra' : 'neutra');
const GROUPS = {
  'tendencia da ultima hora': (t) => tri(t.dir * t.ret60, 0.15),
  'tendencia das ultimas 4 horas': (t) => tri(t.dir * t.ret240, 0.3),
  'tendencia das ultimas 24 horas': (t) => tri(t.dir * t.ret1440, 1),
  'agressao dos ultimos 30 minutos': (t) => tri(t.dir * t.aggr30, 10),
  'onde entrou na faixa das ultimas 4 horas': (t) => {
    const s = t.dir === 1 ? t.pos240 : 1 - t.pos240; // 1 = comprou no topo / vendeu no fundo
    return s >= 0.8 ? 'esticado (comprou perto do topo / vendeu perto do fundo)' : s <= 0.2 ? 'no recuo (comprou perto do fundo / vendeu perto do topo)' : 'no meio da faixa';
  },
  'tamanho do stop x balanco da ultima hora': (t, cfg) => {
    const k = cfg.stopPct / t.range60;
    return k < 0.5 ? 'stop menor que metade do balanco' : k < 1 ? 'stop entre metade e 1x o balanco' : k < 2 ? 'stop entre 1x e 2x o balanco' : 'stop maior que 2x o balanco';
  },
  'hora de Brasilia': (t) => { const h = 4 * Math.floor(new Date(t.entryTime + BRT).getUTCHours() / 4); return `${String(h).padStart(2, '0')}h-${String(h + 4).padStart(2, '0')}h`; },
  'dia da semana (Brasilia)': (t) => WD[new Date(t.entryTime + BRT).getUTCDay()],
  'mes': (t) => t.day.slice(0, 7),
  'ano': (t) => t.day.slice(0, 4),
};
function grouped(list, fn, cfg) {
  const m = new Map();
  for (const t of list) { const k = fn(t, cfg); if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  return [...m].map(([nome, l]) => ({ nome, todos: stats(l), compra: stats(l.filter((t) => t.side === 'buy')), venda: stats(l.filter((t) => t.side === 'sell')) }))
    .sort((a, b) => a.nome.localeCompare(b.nome));
}

// "Errando todas": em cada entrada, o lado que perde (ou o que perde mais). Uma posicao por vez,
// com limites de exemplo: p = perda maxima por operacao (% do saldo), N = operacoes por dia,
// D = perda maxima por dia (% do saldo do comeco do dia). O tamanho e reduzido pelo que resta
// da perda do dia, como faz a trava do agente, e a posicao nunca passa de 100% do saldo (conta
// a vista, sem alavancagem): com stop curto, nem aplicando tudo se chega a perder p.
function alwaysWrong(list, cfg, { p, N: maxTrades, D }) {
  let equity = 100, day = null, dayStart = 100, dayLoss = 0, dayTrades = 0, busyUntil = -Infinity;
  let taken = 0, worstDay = 0, capDays = 0, capped = 0;
  const close = () => { if (day === null) return; worstDay = Math.max(worstDay, (dayLoss / dayStart) * 100); if (dayTrades >= maxTrades || dayLoss >= (dayStart * D) / 100 - 1e-9) capDays += 1; };
  for (const t of list) {
    const d = t.day;
    if (d !== day) { close(); day = d; dayStart = equity; dayLoss = 0; dayTrades = 0; }
    if (t.entryTime < busyUntil || dayTrades >= maxTrades) continue;
    const budget = (dayStart * D) / 100 - dayLoss;
    if (budget <= 1e-9) continue;
    const planned = cfg.stopPct + FEE * (2 - (t.dir * cfg.stopPct) / 100); // perda de um stop limpo, em % do valor aplicado
    const allIn = (equity * planned) / 100; // o que um stop limpo tira com 100% do saldo aplicado
    const wanted = Math.min((equity * p) / 100, budget);
    if (allIn < wanted) capped += 1;
    const risk = Math.min(wanted, allIn);
    const pnl = risk * (t.netPct / planned);
    equity += pnl; dayLoss -= pnl; dayTrades += 1; taken += 1; busyUntil = t.exitTime + MINUTE;
  }
  close();
  return { p, N: maxTrades, D, operacoes: taken, limitadasPeloSaldo: capped, perdaTotalPct: 100 - equity, piorDiaPct: worstDay, diasNoLimite: capDays };
}

const days = [...new Set(trades.map((t) => t.day))];
// Preco de cada mes do periodo estudado, para ler os resultados ao lado do que o mercado fez.
const monthPrices = new Map();
for (let i = entries[0]; i <= entries.at(-1); i++) {
  const k = utc(C[i].openTime).slice(0, 7);
  const mo = monthPrices.get(k) ?? { mes: k, abre: C[i].open, minima: Infinity, maxima: -Infinity };
  mo.fecha = C[i].close;
  if (C[i].low < mo.minima) mo.minima = C[i].low;
  if (C[i].high > mo.maxima) mo.maxima = C[i].high;
  monthPrices.set(k, mo);
}
const result = {
  meta: {
    par: SYMBOL, taxaPorLadoPct: FEE, passoMin: STEP, entradas: entries.length, dias: days.length,
    de: utc(C[entries[0]].openTime + MINUTE), ate: utc(C[entries.at(-1)].openTime + MINUTE),
    candles: N, historicoDe: utc(C[0].openTime), historicoAte: utc(C[N - 1].openTime),
    precoInicial: C[entries[0]].close, precoFinal: C[entries.at(-1)].close,
    variacaoPct: pct(C[entries.at(-1)].close, C[entries[0]].close), geradoEm: new Date().toISOString(),
  },
  configs: {},
};
const allWorst = []; // as operacoes do "errando todas", dos tres jeitos

for (const cfg of CONFIGS) {
  const all = trades.filter((t) => t.cfg === cfg.key);
  const losers = all.filter((t) => t.netPct < 0);
  const stops = losers.filter((t) => t.exitKind === 'stop');
  const minutes = (t) => t.bars;
  const bucketTime = (t) => (minutes(t) <= 5 ? 'ate 5 min' : minutes(t) <= 15 ? '6 a 15 min' : minutes(t) <= 60 ? '16 a 60 min' : 'mais de 1 h');
  const count = (list, fn) => { const o = {}; for (const t of list) { const k = fn(t); o[k] = (o[k] ?? 0) + 1; } return o; };
  // "errando todas": o pior dos dois lados em cada entrada. `otherNet` e o que o lado contrario
  // fez na mesma entrada: se tambem perdeu, nao havia lado bom ali.
  const worst = [];
  let both = 0;
  for (let k = 0; k < all.length; k += 2) {
    const [a, b] = [all[k], all[k + 1]];
    if (a.i !== b.i) throw new Error('pares de compra e venda fora de ordem');
    if (a.netPct < 0 && b.netPct < 0) both += 1;
    const [w, o] = a.netPct <= b.netPct ? [a, b] : [b, a];
    worst.push({ ...w, otherNet: o.netPct });
  }
  allWorst.push(...worst);
  const byDay = new Map();
  for (const t of all) { if (!byDay.has(t.day)) byDay.set(t.day, []); byDay.get(t.day).push(t); }
  const monthsOf = [...new Set(worst.map((t) => t.day.slice(0, 7)))];
  result.configs[cfg.key] = {
    ...cfg,
    todas: stats(all), compra: stats(all.filter((t) => t.side === 'buy')), venda: stats(all.filter((t) => t.side === 'sell')),
    perdas: {
      n: losers.length,
      comoPerdeu: {
        'saiu no stop': stops.length,
        'acabou o prazo no prejuizo': losers.filter((t) => t.exitKind === 'time' && t.grossPct < 0).length,
        'acabou o prazo no lucro bruto, mas as taxas comeram': losers.filter((t) => t.exitKind === 'time' && t.grossPct >= 0).length,
      },
      tempoAteOStop: count(stops, bucketTime),
      stopEDepoisFoiAoAlvo: { n: stops.filter((t) => t.later).length, pctDosStops: stops.length ? (100 * stops.filter((t) => t.later).length) / stops.length : 0 },
      stopComSalto: stops.filter((t) => t.exit !== t.stop).length, // o candle abriu alem do stop
    },
    grupos: Object.fromEntries(Object.entries(GROUPS).map(([nome, fn]) => [nome, grouped(all, fn, cfg)])),
    porDia: days.map((d) => {
      const l = byDay.get(d) ?? [];
      return { dia: d, compra: stats(l.filter((t) => t.side === 'buy')), venda: stats(l.filter((t) => t.side === 'sell')) };
    }),
    errandoTodas: {
      entradas: worst.length, ambosOsLadosPerdem: both, perdem: worst.filter((t) => t.netPct < 0).length,
      perdaMediaPct: sum(worst.map((t) => t.netPct)) / worst.length,
      somaPct: sum(worst.map((t) => t.netPct)),
      comoPerdeu: {
        'saiu no stop': worst.filter((t) => t.exitKind === 'stop').length,
        'acabou o prazo no prejuizo': worst.filter((t) => t.exitKind === 'time' && t.grossPct < 0).length,
        'acabou o prazo no lucro bruto, mas as taxas comeram': worst.filter((t) => t.exitKind === 'time' && t.grossPct >= 0).length,
      },
      ladoQuePerdeu: { compra: worst.filter((t) => t.side === 'buy').length, venda: worst.filter((t) => t.side === 'sell').length },
      // Na mesma entrada, o lado contrario: ganhou (bastava inverter) ou perdeu tambem.
      oOutroLado: { ganhou: worst.filter((t) => t.otherNet >= 0).length, perdeuTambem: worst.filter((t) => t.otherNet < 0).length },
      porMes: monthsOf.map((mo) => {
        const l = worst.filter((t) => t.day.startsWith(mo));
        return {
          mes: mo, entradas: l.length, perdem: l.filter((t) => t.netPct < 0).length, perdaMediaPct: sum(l.map((t) => t.netPct)) / l.length,
          somaPct: sum(l.map((t) => t.netPct)), ambosOsLadosPerdem: l.filter((t) => t.otherNet < 0).length,
          perdeuComprando: l.filter((t) => t.side === 'buy').length, perdeuVendendo: l.filter((t) => t.side === 'sell').length,
        };
      }),
      comLimites: LIMIT_EXAMPLES.map((l) => alwaysWrong(worst, cfg, l)),
    },
  };
}
result.meses = [...monthPrices.values()].map((mo) => ({ ...mo, variacaoPct: pct(mo.fecha, mo.abre) }));

// Os maiores movimentos do periodo: e neles que a pesquisa de noticias deve comecar.
const hours = new Map();
for (const c of C) {
  const k = Math.floor(c.openTime / (60 * MINUTE)) * 60 * MINUTE;
  const h = hours.get(k) ?? { time: k, open: c.open, high: -Infinity, low: Infinity, volume: 0, buy: 0, n: 0 };
  h.high = Math.max(h.high, c.high); h.low = Math.min(h.low, c.low); h.close = c.close; h.volume += c.volume; h.buy += c.buy; h.n += 1;
  hours.set(k, h);
}
const hourRows = [...hours.values()].filter((h) => h.n === 60).map((h) => ({ utc: utc(h.time), brasilia: brt(h.time), variacaoPct: pct(h.close, h.open), volume: h.volume, agressaoPct: ((2 * h.buy - h.volume) / h.volume) * 100 }));
const volMedian = [...hourRows].sort((a, b) => a.volume - b.volume)[Math.floor(hourRows.length / 2)].volume;
result.movimentos = {
  volumeMedianoPorHora: volMedian,
  maioresHoras: [...hourRows].sort((a, b) => Math.abs(b.variacaoPct) - Math.abs(a.variacaoPct)).slice(0, 15),
  // Trancos: maior variacao em 15 minutos, um por janela de 3 horas.
  trancos: (() => {
    const all = [];
    for (let i = 15; i < N; i++) all.push({ i, r: pct(C[i].close, C[i - 15].close) });
    all.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    const picked = [];
    for (const x of all) {
      if (picked.length >= 15) break;
      if (picked.some((p) => Math.abs(p.i - x.i) < 180)) continue;
      picked.push(x);
    }
    return picked.map((x) => ({ utc: utc(C[x.i - 14].openTime), brasilia: brt(C[x.i - 14].openTime), variacao15minPct: x.r, de: C[x.i - 15].close, para: C[x.i].close, volume: pv[x.i + 1] - pv[x.i - 14], agressaoPct: ((2 * (pb[x.i + 1] - pb[x.i - 14]) - (pv[x.i + 1] - pv[x.i - 14])) / (pv[x.i + 1] - pv[x.i - 14])) * 100 }));
  })(),
};

// ---------- arquivos ----------
mkdirSync(OUT, { recursive: true });
const num = (x, d = 2) => (x == null || Number.isNaN(x) ? '' : x.toFixed(d).replace('.', ','));
const lado = (s) => (s === 'buy' ? 'compra' : 'venda');
const saida = { stop: 'stop', target: 'alvo', time: 'prazo' };
const header = ['jeito', 'lado', 'entrada_utc', 'entrada_brasilia', 'dia_semana', 'preco_entrada', 'stop', 'alvo', 'saida_utc', 'preco_saida', 'saiu_por', 'minutos', 'bruto_pct', 'liquido_pct', 'R', 'pior_momento_pct', 'melhor_momento_pct', 'depois_do_stop_foi_ao_alvo', 'variacao_1h_antes_pct', 'variacao_4h_antes_pct', 'variacao_24h_antes_pct', 'balanco_1h_antes_pct', 'posicao_na_faixa_4h', 'agressao_30min_pct'];
const row = (t) => [t.cfg, lado(t.side), utc(t.entryTime), brt(t.entryTime), WD[new Date(t.entryTime + BRT).getUTCDay()], num(t.entry), num(t.stop), num(t.target),
  utc(t.exitTime), num(t.exit), saida[t.exitKind], t.bars, num(t.grossPct, 3), num(t.netPct, 3), num(t.rMultiple), num(t.worstPct, 3), num(t.bestPct, 3),
  t.exitKind === 'stop' ? (t.later ? 'sim' : 'nao') : '', num(t.ret60, 3), num(t.ret240, 3), num(t.ret1440, 3), num(t.range60, 3), num(t.pos240), num(t.aggr30, 1)];
const lines = [header.join(';')];
for (const t of trades) if (t.netPct < 0) lines.push(row(t).join(';')); // so as perdas
// "Errando todas": uma boleta por entrada e por jeito, sempre a do lado que perdeu. A ultima
// coluna diz o que o lado contrario fez na mesma entrada.
const wrongLines = [[...header, 'o_outro_lado_liquido_pct'].join(';')];
for (const t of allWorst) wrongLines.push([...row(t), num(t.otherNet, 3)].join(';'));
// O primeiro caractere (marca de UTF-8) e o que faz o Excel ler os acentos direito.
const mark = String.fromCharCode(0xFEFF);
writeFileSync(path.join(OUT, 'boletas-so-perdas.csv'), `${mark}${lines.join('\r\n')}\r\n`);
writeFileSync(path.join(OUT, 'boletas-errando-todas.csv'), `${mark}${wrongLines.join('\r\n')}\r\n`);
writeFileSync(path.join(OUT, 'estudo-perdas.json'), JSON.stringify(result, null, 1));

// ---------- resumo na tela ----------
const f = (x, d = 2) => (x >= 0 ? '+' : '') + x.toFixed(d);
const m = result.meta;
console.log(`TESTE REVERSO - ${m.par}, entradas de ${m.passoMin} em ${m.passoMin} min, de ${m.de} a ${m.ate} UTC (${m.dias} dias, ${m.entradas} entradas)`);
console.log(`preco no periodo: ${m.precoInicial} -> ${m.precoFinal} (${f(m.variacaoPct)}%); taxa de ${FEE}% por lado\n`);
for (const cfg of CONFIGS) {
  const r = result.configs[cfg.key];
  console.log(`== ${cfg.key}: ${cfg.label} ==`);
  for (const [nome, s] of [['todas', r.todas], ['compra', r.compra], ['venda', r.venda]]) {
    console.log(`  ${nome.padEnd(7)} ${String(s.n).padStart(5)} operacoes | perderam ${String(s.perdas).padStart(5)} (${s.pctPerdas.toFixed(1)}%) | liquido ${f(s.liquido, 1)}% | por operacao ${f(s.expectativa, 3)}% | R medio ${f(s.rMedio)} | pior ${f(s.pior)}% | queda maxima ${s.quedaMaxima.toFixed(1)}%`);
  }
  console.log(`  perdas: ${JSON.stringify(r.perdas.comoPerdeu)}`);
  console.log(`  tempo ate o stop: ${JSON.stringify(r.perdas.tempoAteOStop)} | stop e depois foi ao alvo: ${r.perdas.stopEDepoisFoiAoAlvo.n} (${r.perdas.stopEDepoisFoiAoAlvo.pctDosStops.toFixed(1)}% dos stops) | stops com salto: ${r.perdas.stopComSalto}`);
  for (const [nome, rows] of Object.entries(r.grupos)) {
    console.log(`  - ${nome}`);
    for (const g of rows) console.log(`      ${g.nome.padEnd(58)} n ${String(g.todos.n).padStart(5)} | perderam ${g.todos.pctPerdas.toFixed(1).padStart(5)}% | por operacao ${f(g.todos.expectativa, 3)}% | compra ${g.compra.n ? `${g.compra.pctPerdas.toFixed(0)}% / ${f(g.compra.expectativa, 3)}%` : '-'} | venda ${g.venda.n ? `${g.venda.pctPerdas.toFixed(0)}% / ${f(g.venda.expectativa, 3)}%` : '-'}`);
  }
  const e = r.errandoTodas;
  console.log(`  errando todas: ${e.entradas} entradas; nas duas pontas perde em ${e.ambosOsLadosPerdem}; escolhendo o pior lado perde em ${e.perdem}; perda media ${f(e.perdaMediaPct, 3)}% por operacao`);
  console.log(`      como perdeu: ${JSON.stringify(e.comoPerdeu)} | lado que perdeu: ${JSON.stringify(e.ladoQuePerdeu)} | o outro lado: ${JSON.stringify(e.oOutroLado)}`);
  for (const mo of e.porMes) console.log(`      ${mo.mes}: ${String(mo.entradas).padStart(5)} entradas, perdem ${mo.perdem} | perda media ${f(mo.perdaMediaPct, 3)}% | nos dois lados perde em ${((100 * mo.ambosOsLadosPerdem) / mo.entradas).toFixed(0)}% | perdeu comprando ${mo.perdeuComprando}, vendendo ${mo.perdeuVendendo}`);
  for (const l of e.comLimites) console.log(`      p ${l.p}% | ${l.N} por dia | ${l.D}% por dia -> ${l.operacoes} operacoes (${l.limitadasPeloSaldo} limitadas pelo saldo), perda total ${l.perdaTotalPct.toFixed(1)}%, pior dia ${l.piorDiaPct.toFixed(2)}%, dias no limite ${l.diasNoLimite}`);
  console.log('');
}
console.log('== maiores movimentos de 1 hora ==');
for (const h of result.movimentos.maioresHoras) console.log(`  ${h.utc} UTC (${h.brasilia.slice(5)} Brasilia)  ${f(h.variacaoPct)}%  volume ${h.volume.toFixed(0)} (${(h.volume / volMedian).toFixed(1)}x a mediana)  agressao ${f(h.agressaoPct, 0)}%`);
console.log('== maiores trancos de 15 minutos ==');
for (const h of result.movimentos.trancos) console.log(`  ${h.utc} UTC (${h.brasilia.slice(5)} Brasilia)  ${f(h.variacao15minPct)}%  ${h.de} -> ${h.para}  volume ${h.volume.toFixed(0)}  agressao ${f(h.agressaoPct, 0)}%`);
console.log('== meses do periodo ==');
for (const mo of result.meses) console.log(`  ${mo.mes}: ${mo.abre.toFixed(0)} -> ${mo.fecha.toFixed(0)} (${f(mo.variacaoPct, 1)}%), minima ${mo.minima.toFixed(0)}, maxima ${mo.maxima.toFixed(0)}`);
console.log(`\narquivos em ${OUT}: boletas-so-perdas.csv (${lines.length - 1} perdas de ${trades.length} operacoes as cegas), boletas-errando-todas.csv (${wrongLines.length - 1} operacoes, todas do lado que perdeu) e estudo-perdas.json`);
