// Testa as contas do estudo de eventos (src/events.js) com candles montados a mao. Nao usa a
// internet nem o banco.
//
//   node scripts/testar-eventos.js
//
// Sai com codigo 1 se algum caso falhar.

import assert from 'node:assert/strict';
import { reaction, typicalMoves, summarize, normalizeEvent, parseWhen, parseEventsCsv, HORIZONS } from '../src/events.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0); // um instante qualquer, alinhado ao minuto
let feitos = 0;
const perto = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: esperado ${b}, veio ${a}`);
const caso = (nome, fn) => { fn(); feitos++; console.log(`ok  ${nome}`); };

// Candles de 1m: o minuto i fecha em 100 + i, com maxima 0,5 acima e minima 0,5 abaixo do
// fechamento e volume 10. `mudar` permite alterar ou remover candles.
function fonte(total, mudar = () => {}) {
  const lista = [];
  for (let i = 0; i < total; i++) {
    const c = { openTime: T0 + i * MIN, close: 100 + i, high: 100.5 + i, low: 99.5 + i, volume: 10, closed: 1 };
    lista.push(c);
  }
  const candles = new Map(lista.map((c) => [c.openTime, c]));
  mudar(candles);
  return {
    lastClosedTime: Math.max(...candles.keys()),
    candleAt: (t) => candles.get(t) ?? null,
    windowStats: (from, to) => {
      let n = 0, high = null, low = null, volume = 0;
      for (const c of candles.values()) {
        if (c.openTime < from || c.openTime >= to) continue;
        n++; volume += c.volume;
        high = high === null ? c.high : Math.max(high, c.high);
        low = low === null ? c.low : Math.min(low, c.low);
      }
      return { n, high, low, volume };
    },
  };
}
const h = (r, key) => r.horizons[HORIZONS.findIndex((x) => x.key === key)];
const minuto = (i) => T0 + i * MIN;

const semana = fonte(12_000);

caso('evento em ponto: referencia e o fechamento do minuto anterior', () => {
  const r = reaction(semana, minuto(1500));
  perto(r.refPrice, 100 + 1499, 'preco de referencia');
});

caso('reacao em 1 e 5 minutos: variacao, maxima e minima da janela', () => {
  const r = reaction(semana, minuto(1500));
  const ref = 1599;
  perto(h(r, '1min').retPct, (1600 / ref - 1) * 100, '1 min');
  perto(h(r, '5min').retPct, (1604 / ref - 1) * 100, '5 min');           // fecha no 5o minuto
  perto(h(r, '5min').maxUpPct, (1604.5 / ref - 1) * 100, 'maxima em 5 min');
  perto(h(r, '5min').maxDownPct, (1599.5 / ref - 1) * 100, 'minima em 5 min');
});

caso('reacao em 1 hora, 1 dia e 1 semana', () => {
  const r = reaction(semana, minuto(1500));
  const ref = 1599;
  perto(h(r, '1h').retPct, (1659 / ref - 1) * 100, '1 hora');
  perto(h(r, '1d').retPct, ((100 + 1500 + 1439) / ref - 1) * 100, '1 dia');
  perto(h(r, '1sem').retPct, ((100 + 1500 + 10079) / ref - 1) * 100, '1 semana');
});

caso('evento no meio do minuto usa o mesmo minuto', () => {
  const a = reaction(semana, minuto(1500));
  const b = reaction(semana, minuto(1500) + 20_000);
  assert.deepEqual(a, b);
});

caso('volume: 1 = normal; o triplo do normal da 3', () => {
  const src = fonte(3000, (m) => { for (let i = 1500; i < 1505; i++) m.get(minuto(i)).volume = 30; });
  const r = reaction(src, minuto(1500));
  perto(h(r, '1min').volumeRatio, 3, 'volume em 1 min');
  perto(h(r, '5min').volumeRatio, 3, 'volume em 5 min');
  perto(h(reaction(semana, minuto(1500)), '1h').volumeRatio, 1, 'volume normal');
});

caso('janela que ainda nao terminou fica "ainda nao passou"', () => {
  const src = fonte(1600);
  const r = reaction(src, minuto(1570));
  assert.equal(h(r, '1min').status, 'ok');
  assert.equal(h(r, '5min').status, 'ok');
  assert.equal(h(r, '1h').status, 'ainda nao passou');
  assert.equal(h(r, '1sem').status, 'ainda nao passou');
});

caso('janela cujo ultimo minuto acabou de fechar ja conta', () => {
  const src = fonte(1600); // ultimo minuto: 1599
  assert.equal(h(reaction(src, minuto(1595)), '5min').status, 'ok');               // janela 1595..1599
  assert.equal(h(reaction(src, minuto(1596)), '5min').status, 'ainda nao passou'); // precisaria do 1600
});

caso('sem candle antes do evento nao ha referencia', () => {
  const r = reaction(semana, minuto(0));
  assert.equal(r.refPrice, null);
  assert.ok(r.horizons.every((x) => x.status === 'sem candle antes do evento'));
});

caso('buraco grande na janela fica "faltam candles"', () => {
  const src = fonte(3000, (m) => { for (let i = 1510; i < 1530; i++) m.delete(minuto(i)); });
  const r = reaction(src, minuto(1500));
  assert.equal(h(r, '5min').status, 'ok');             // o buraco comeca depois
  assert.equal(h(r, '1h').status, 'faltam candles');   // 20 de 60 minutos ausentes
});

caso('movimento tipico: mediana do tamanho da variacao em janelas seguidas', () => {
  // cada minuto sobe 0,1%: toda janela de 1 minuto varia 0,1% e toda de 5 minutos, 1,001^5 - 1
  const closes = Array.from({ length: 2000 }, (_, i) => ({ openTime: minuto(i), close: 100 * 1.001 ** i }));
  const t = typicalMoves(closes);
  perto(t[0].medianAbsPct, 0.1, '1 min');
  perto(t[1].medianAbsPct, (1.001 ** 5 - 1) * 100, '5 min');
  assert.equal(t[0].samples, 1999);
  assert.equal(t[4].samples, 0); // nao cabe uma semana em 2000 minutos
  assert.equal(t[4].medianAbsPct, null);
});

caso('movimento tipico descarta janela com buraco', () => {
  const closes = Array.from({ length: 100 }, (_, i) => ({ openTime: minuto(i), close: 100 + i }));
  closes.splice(50, 1); // falta o minuto 50
  assert.equal(typicalMoves(closes)[0].samples, 97); // 98 pares seguidos, 1 deles pula o buraco
});

caso('horario: formato do Brasil (hora do computador) e formato ISO', () => {
  assert.equal(parseWhen('14/11/2026 18:30'), new Date(2026, 10, 14, 18, 30, 0).getTime());
  assert.equal(parseWhen('14/11/2026 18:30:05'), new Date(2026, 10, 14, 18, 30, 5).getTime());
  assert.equal(parseWhen('2026-11-14T18:30:00-03:00'), Date.UTC(2026, 10, 14, 21, 30, 0));
  assert.ok(Number.isNaN(parseWhen('ontem a tarde')));
});

caso('evento: campos obrigatorios e padroes', () => {
  const e = normalizeEvent({ time: T0, title: '  Decisao de juros  ', kind: 'MACRO' });
  assert.deepEqual(e, { time: T0, title: 'Decisao de juros', importance: 2, kind: 'macro', source: null, note: null });
  assert.equal(normalizeEvent({ time: T0, title: 'x' }).kind, 'geral');
  assert.throws(() => normalizeEvent({ time: T0, title: '' }), /titulo/);
  assert.throws(() => normalizeEvent({ time: 'abc', title: 'x' }), /horario/);
  assert.throws(() => normalizeEvent({ time: T0, title: 'x', importance: 7 }), /importancia/);
});

caso('importacao: cabecalho, linhas boas e erros linha a linha', () => {
  const csv = [
    'data;titulo;tipo;importancia;fonte;nota',
    '14/11/2026 18:30;Decisao de juros;macro;3;Banco Central;subiu 0,25',
    'sem data;Linha ruim;macro;2',
    '2026-11-14T12:00:00Z;;cripto',
    '15/11/2026 09:00:30;"Listagem nova";cripto',
  ].join('\n');
  const { rows, errors } = parseEventsCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Decisao de juros');
  assert.equal(rows[0].importance, 3);
  assert.equal(rows[0].note, 'subiu 0,25');
  assert.equal(rows[1].title, 'Listagem nova');
  assert.equal(rows[1].importance, 2);
  assert.deepEqual(errors.map((e) => e.line), [3, 4]);
});

caso('importacao com virgula como separador', () => {
  const { rows } = parseEventsCsv('2026-11-14T12:00:00Z,Fork,cripto,1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].time, Date.UTC(2026, 10, 14, 12));
});

caso('resumo por tipo: quantidade, media, mediana e quantos subiram', () => {
  const ev = (kind, rets) => ({ kind, reaction: { horizons: HORIZONS.map((x, i) => (rets[i] === undefined ? { key: x.key, status: 'ainda nao passou' } : { key: x.key, status: 'ok', retPct: rets[i] })) } });
  const s = summarize([ev('macro', [1, 2]), ev('macro', [-3, 4]), ev('macro', [5]), ev('cripto', [1])]);
  assert.equal(s[0].kind, 'macro');
  assert.equal(s[0].events, 3);
  assert.equal(s[0].horizons[0].n, 3);
  perto(s[0].horizons[0].meanPct, 1, 'media');
  perto(s[0].horizons[0].medianPct, 1, 'mediana');
  perto(s[0].horizons[0].upPct, (2 / 3) * 100, 'subiram');
  assert.equal(s[0].horizons[1].n, 2);
  perto(s[0].horizons[1].medianPct, 3, 'mediana com quantidade par');
  assert.equal(s[0].horizons[2].n, 0);
  assert.equal(s[1].kind, 'cripto');
});

console.log(`\nTODOS OS ${feitos} CASOS PASSARAM`);
