// Testa as contas do replay (src/replay.js) com candles montados a mao. Nao usa a internet nem
// o banco.
//
//   node scripts/testar-replay.js
//
// Cada caso diz o que tem que acontecer com a operacao diante de um candle e qual resultado
// tem que sair. Sai com codigo 1 se algum caso falhar.

import assert from 'node:assert/strict';
import { stepTrade, tradeResult, sessionStats } from '../src/replay.js';

const TAXA = 0.1; // % por lado
let feitos = 0;
const perto = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: esperado ${b}, veio ${a}`);
const caso = (nome, fn) => { fn(); feitos++; console.log(`ok  ${nome}`); };

const candle = (open, high, low, close, openTime = 0) => ({ openTime, open, high, low, close });
const compra = (extra = {}) => ({ side: 'buy', entry: 100, stop: 98, target: 104, maxBars: 5, bars: 0, worst: 100, best: 100, ...extra });
const venda = (extra = {}) => ({ side: 'sell', entry: 100, stop: 102, target: 96, maxBars: 5, bars: 0, worst: 100, best: 100, ...extra });

caso('compra: candle sem tocar stop nem alvo continua aberta', () => {
  const t = stepTrade(compra(), candle(100.5, 101, 99, 100.8));
  assert.equal(t.exit, undefined);
  assert.equal(t.bars, 1);
  assert.equal(t.worst, 99);
  assert.equal(t.best, 101);
});

caso('compra: alvo tocado sai no alvo, com resultado liquido de taxas', () => {
  let t = stepTrade(compra(), candle(100.5, 101, 99, 100.8, 1));
  t = stepTrade(t, candle(100.8, 104.5, 100.2, 104.2, 2));
  assert.equal(t.exit, 104);
  assert.equal(t.exitKind, 'target');
  assert.equal(t.exitTime, 2);
  const r = tradeResult(t, TAXA);
  perto(r.grossPct, 4, 'bruto');
  perto(r.netPct, 4 - 0.1 * (1 + 1.04), 'liquido'); // taxa na entrada e na saida
  perto(r.rMultiple, 2, 'R');                       // ganhou 4 arriscando 2
  perto(r.worstPct, -1, 'pior momento');
  perto(r.bestPct, 4, 'melhor momento');
});

caso('compra: stop e alvo no mesmo candle conta como stop (pior caso)', () => {
  const t = stepTrade(compra(), candle(100, 105, 97, 101));
  assert.equal(t.exit, 98);
  assert.equal(t.exitKind, 'stop');
  const r = tradeResult(t, TAXA);
  perto(r.grossPct, -2, 'bruto');
  perto(r.netPct, -2 - 0.1 * (1 + 0.98), 'liquido');
  perto(r.rMultiple, -1, 'R');
});

caso('compra: abertura abaixo do stop sai na abertura, pior que o stop', () => {
  const t = stepTrade(compra(), candle(97, 99, 96, 98.5));
  assert.equal(t.exit, 97);
  assert.equal(t.exitKind, 'stop');
  perto(tradeResult(t, TAXA).rMultiple, -1.5, 'R');
});

caso('compra: abertura acima do alvo sai na abertura', () => {
  const t = stepTrade(compra(), candle(105, 106, 104.5, 105.5));
  assert.equal(t.exit, 105);
  assert.equal(t.exitKind, 'target');
});

caso('compra: fim do prazo sai no fechamento', () => {
  let t = stepTrade(compra({ maxBars: 2 }), candle(100, 101, 99.5, 100.5, 1));
  assert.equal(t.exit, undefined);
  t = stepTrade(t, candle(100.5, 101.5, 100, 101.2, 2));
  assert.equal(t.exit, 101.2);
  assert.equal(t.exitKind, 'time');
  assert.equal(t.bars, 2);
});

caso('compra sem alvo: nunca sai por alvo', () => {
  const t = stepTrade(compra({ target: null }), candle(100, 150, 99, 140));
  assert.equal(t.exit, undefined);
  assert.equal(t.best, 150);
});

caso('venda: alvo tocado sai no alvo', () => {
  const t = stepTrade(venda(), candle(99.5, 100.5, 95.5, 96.5));
  assert.equal(t.exit, 96);
  assert.equal(t.exitKind, 'target');
  const r = tradeResult(t, TAXA);
  perto(r.grossPct, 4, 'bruto');
  perto(r.netPct, 4 - 0.1 * (1 + 0.96), 'liquido');
  perto(r.rMultiple, 2, 'R');
  perto(r.worstPct, -0.5, 'pior momento'); // foi ate 100,5 contra
});

caso('venda: stop tocado sai no stop', () => {
  const t = stepTrade(venda(), candle(100.5, 102.3, 100, 101));
  assert.equal(t.exit, 102);
  assert.equal(t.exitKind, 'stop');
  perto(tradeResult(t, TAXA).rMultiple, -1, 'R');
});

caso('venda: stop e alvo no mesmo candle conta como stop', () => {
  const t = stepTrade(venda(), candle(100, 103, 95, 99));
  assert.equal(t.exitKind, 'stop');
  assert.equal(t.exit, 102);
});

caso('venda: abertura acima do stop sai na abertura', () => {
  const t = stepTrade(venda(), candle(103, 104, 102.5, 103.5));
  assert.equal(t.exit, 103);
  assert.equal(t.exitKind, 'stop');
});

caso('operacao aberta nao tem resultado', () => {
  assert.equal(tradeResult(compra(), TAXA), null);
});

caso('resumo da sessao: total, perda maxima, expectativa e acerto', () => {
  const fechada = (exit, extra = {}) => compra({ exit, worst: Math.min(100, exit), best: Math.max(100, exit), ...extra });
  // liquidos: +3,796 ; -2,198 ; -2,198 ; +3,796
  const trades = [fechada(104), fechada(98), fechada(98), fechada(104), compra()]; // a ultima esta aberta
  const s = sessionStats(trades, TAXA);
  assert.equal(s.trades, 4);
  perto(s.netTotalPct, 2 * 3.796 - 2 * 2.198, 'total');
  perto(s.expectancyPct, (2 * 3.796 - 2 * 2.198) / 4, 'expectativa');
  perto(s.maxDrawdownPct, 2 * 2.198, 'perda maxima'); // do pico de 3,796 ate -0,6
  perto(s.worstTradePct, -2.198, 'pior operacao');
  perto(s.avgR, (2 - 1 - 1 + 2) / 4, 'R medio');
  perto(s.winRatePct, 50, 'acerto');
});

caso('sessao sem operacao encerrada', () => {
  assert.deepEqual(sessionStats([compra()], TAXA), { trades: 0 });
});

console.log(`\nTODOS OS ${feitos} CASOS PASSARAM`);
