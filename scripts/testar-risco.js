// Testa a trava de risco da fase 5 (src/risk.js). Nao usa a internet nem o banco.
//
//   node scripts/testar-risco.js
//
// Os limites usados aqui sao so numeros de teste, escolhidos para as contas ficarem faceis de
// conferir. Os limites de verdade ficam em src/limits.js e quem define e o Bruno.

import assert from 'node:assert/strict';
import { checkProposal, limitsProblem, decimalsOf, floorToStep, formatStep } from '../src/risk.js';
import { LIMITS } from '../src/limits.js';

let feitos = 0;
const perto = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: esperado ${b}, veio ${a}`);
const caso = (nome, fn) => { fn(); feitos++; console.log(`ok  ${nome}`); };

const L = { maxLossPerTradePct: 1, maxLossPerDayPct: 3, maxPositionPct: 10, maxTradesPerDay: 5 };
const FILTROS = { stepSize: '0.00001000', minQty: '0.00001000', tickSize: '0.01000000', minNotional: '5.00000000' };
const base = (extra = {}) => ({
  limits: L, equity: 10_000, dayStartEquity: 10_000, realizedToday: 0, tradesToday: 0, openPositions: 0,
  proposal: { side: 'buy', entry: 100, stop: 99, target: 103 }, filters: FILTROS, feePct: 0.1, ...extra,
});
const POR_UNIDADE = 1 + 0.001 * (100 + 99); // perda por unidade ate o stop, com as taxas

caso('os limites do arquivo sao imutaveis em tempo de execucao', () => {
  assert.ok(Object.isFrozen(LIMITS));
  assert.throws(() => { 'use strict'; LIMITS.maxLossPerTradePct = 50; });
});

caso('limites incompletos: recusa e diz quais faltam', () => {
  const r = checkProposal(base({ limits: { maxLossPerTradePct: 1, maxLossPerDayPct: null, maxPositionPct: 10 } }));
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /perda maxima por dia/);
  assert.match(r.reasons[0], /operacoes por dia/);
  assert.doesNotMatch(r.reasons[0], /por operacao/);
  assert.equal(checkProposal(base({ limits: null })).ok, false);
});

caso('limites incoerentes sao recusados', () => {
  assert.match(limitsProblem({ ...L, maxLossPerTradePct: 5 }), /maior que a perda maxima por dia/);
  assert.match(limitsProblem({ ...L, maxPositionPct: 150 }), /alavancagem/);
  assert.match(limitsProblem({ ...L, maxTradesPerDay: 2.5 }), /inteiro/);
  assert.match(limitsProblem({ ...L, maxLossPerDayPct: -1 }), /nao definidos/);
  assert.equal(limitsProblem(L), null);
});

caso('tamanho limitado pelo tamanho maximo da posicao', () => {
  const r = checkProposal(base());
  assert.equal(r.ok, true);
  perto(r.qty, 10, 'quantidade');          // 10% de 10.000 a 100 = 10 unidades
  perto(r.notional, 1000, 'valor');
  assert.equal(r.limitedBy, 'tamanho maximo da posicao');
  perto(r.maxLoss, 10 * POR_UNIDADE, 'perda maxima');
});

caso('tamanho limitado pela perda maxima por operacao, com as taxas na conta', () => {
  const r = checkProposal(base({ limits: { ...L, maxPositionPct: 100 } }));
  assert.equal(r.ok, true);
  assert.equal(r.limitedBy, 'perda maxima por operacao');
  perto(r.qty, floorToStep(100 / POR_UNIDADE, FILTROS.stepSize), 'quantidade'); // 1% de 10.000 = 100 de perda
  assert.ok(r.maxLoss <= 100 + 1e-9 && r.maxLoss > 99.99, `perda ${r.maxLoss}`);
});

caso('tamanho limitado pelo que ainda cabe na perda do dia', () => {
  const r = checkProposal(base({ limits: { ...L, maxPositionPct: 100 }, realizedToday: -250 }));
  assert.equal(r.ok, true);
  assert.equal(r.limitedBy, 'perda maxima do dia');   // 3% = 300; ja perdeu 250; sobram 50
  assert.ok(r.maxLoss <= 50 + 1e-9 && r.maxLoss > 49.99, `perda ${r.maxLoss}`);
});

caso('lucro no dia nao aumenta o que pode ser perdido', () => {
  const comLucro = checkProposal(base({ limits: { ...L, maxPositionPct: 100 }, realizedToday: +500 }));
  const semLucro = checkProposal(base({ limits: { ...L, maxPositionPct: 100 } }));
  perto(comLucro.qty, semLucro.qty, 'quantidade');
});

caso('perda maxima do dia atingida: nenhuma operacao nova', () => {
  const r = checkProposal(base({ realizedToday: -300 }));
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /perda maxima do dia atingida/);
});

caso('limite de operacoes por dia e posicao ja aberta: os dois motivos aparecem', () => {
  const r = checkProposal(base({ tradesToday: 5, openPositions: 1 }));
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 2);
  assert.match(r.reasons.join(' | '), /posicao aberta/);
  assert.match(r.reasons.join(' | '), /5 operacoes por dia/);
});

caso('so compra, sempre com stop do lado certo, alvo do lado certo', () => {
  const recusa = (proposal, re) => { const r = checkProposal(base({ proposal })); assert.equal(r.ok, false); assert.match(r.reasons.join(' | '), re); };
  recusa({ side: 'sell', entry: 100, stop: 101 }, /so compra/);
  recusa({ side: 'buy', entry: 100 }, /precisa de stop/);
  recusa({ side: 'buy', entry: 100, stop: 100 }, /abaixo do preco de entrada/);
  recusa({ side: 'buy', entry: 100, stop: 99, target: 99.5 }, /alvo/);
  recusa(undefined, /so compra/);
  assert.equal(checkProposal(base({ proposal: { side: 'buy', entry: 100, stop: 99 } })).ok, true); // sem alvo pode
});

caso('saldo desconhecido recusa', () => {
  assert.match(checkProposal(base({ equity: 0 })).reasons[0], /saldo/);
  assert.match(checkProposal(base({ dayStartEquity: undefined })).reasons[0], /saldo/);
});

caso('ordem menor que o minimo da corretora e recusada', () => {
  const r = checkProposal(base({ equity: 5, dayStartEquity: 5, proposal: { side: 'buy', entry: 65_000, stop: 64_000 } }));
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /abaixo do minimo da corretora/);
});

caso('quantidade e precos arredondados para baixo, no passo da corretora', () => {
  const r = checkProposal(base({ proposal: { side: 'buy', entry: 65_432.1, stop: 64_999.999, target: 66_000.019 } }));
  assert.equal(r.ok, true);
  assert.equal(r.stop, 64_999.99);
  assert.equal(r.target, 66_000.01);
  perto(r.qty * 1e5, Math.round(r.qty * 1e5), 'multiplo do passo de quantidade');
});

caso('passos da corretora: casas decimais e arredondamento', () => {
  assert.equal(decimalsOf('0.00001000'), 5);
  assert.equal(decimalsOf('0.01000000'), 2);
  assert.equal(decimalsOf('1.00000000'), 0);
  assert.equal(floorToStep(0.123456789, '0.00001000'), 0.12345);
  assert.equal(floorToStep(0.3, '0.10000000'), 0.3); // 0,3 / 0,1 da 2,9999...: nao pode virar 0,2
  assert.equal(formatStep(0.00012, '0.00001000'), '0.00012');
  assert.equal(formatStep(0.00000019, '0.00000001'), '0.00000019'); // nunca em notacao cientifica
  assert.equal(formatStep(65_000.019, '0.01000000'), '65000.01');
});

caso('em 5.000 propostas sorteadas, nenhuma aprovada passa de limite algum', () => {
  let aprovadas = 0;
  let semente = 12345;
  const rnd = () => { semente = (semente * 1103515245 + 12345) % 2147483648; return semente / 2147483648; };
  for (let i = 0; i < 5000; i++) {
    const limits = { maxLossPerTradePct: 0.1 + rnd() * 2, maxLossPerDayPct: 2.2 + rnd() * 5, maxPositionPct: 1 + rnd() * 99, maxTradesPerDay: 1 + Math.floor(rnd() * 10) };
    const equity = 50 + rnd() * 100_000;
    const dayStartEquity = equity * (0.95 + rnd() * 0.1);
    const entry = 10 + rnd() * 70_000;
    const stop = entry * (1 - (0.0005 + rnd() * 0.05));
    const realizedToday = -rnd() * dayStartEquity * 0.04;
    const r = checkProposal({ limits, equity, dayStartEquity, realizedToday, tradesToday: 0, openPositions: 0, proposal: { side: 'buy', entry, stop }, filters: FILTROS, feePct: 0.1 });
    if (!r.ok) continue;
    aprovadas++;
    const folga = 1e-6;
    assert.ok(r.maxLoss <= (equity * limits.maxLossPerTradePct) / 100 + folga, 'perda por operacao');
    assert.ok(r.maxLoss <= (dayStartEquity * limits.maxLossPerDayPct) / 100 + realizedToday + folga, 'perda do dia');
    assert.ok(r.notional <= (equity * limits.maxPositionPct) / 100 + folga, 'tamanho da posicao');
    assert.ok(r.notional >= 5 && r.qty >= 0.00001, 'minimo da corretora');
    assert.ok(Math.abs(r.qty * 1e5 - Math.round(r.qty * 1e5)) < 1e-6, 'passo de quantidade');
  }
  assert.ok(aprovadas > 1000, `poucas aprovadas para o teste valer: ${aprovadas}`);
});

console.log(`\nTODOS OS ${feitos} CASOS PASSARAM`);
