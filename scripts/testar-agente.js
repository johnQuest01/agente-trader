// Testa o fluxo da fase 5 (src/agent.js): proposta -> aprovacao do Bruno -> trava de risco ->
// ordens -> resultado, contra uma corretora de mentira que roda dentro do proprio teste.
// Nao usa a internet nem chave de verdade, e usa bancos temporarios (nao toca em data/market.db).
//
//   node scripts/testar-agente.js
//
// Os limites usados aqui sao so numeros de teste. Os de verdade ficam em src/limits.js.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.removeAllListeners('warning'); // o aviso de que o SQLite embutido do Node e experimental
process.on('warning', (w) => { if (!/SQLite/i.test(w.message)) console.warn(w); });

const { openDb } = await import('../src/db.js');
const { createDemoClient } = await import('../src/demo.js');
const { createAgent, agentStats } = await import('../src/agent.js');
const { LIMITS } = await import('../src/limits.js');
const { startMockExchange } = await import('./lib/corretora-simulada.js');

let feitos = 0;
const dir = mkdtempSync(join(tmpdir(), 'agente-teste-'));
let bancos = 0;
const perto = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${msg}: esperado ${b}, veio ${a}`);
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

const L = { maxLossPerTradePct: 1, maxLossPerDayPct: 3, maxPositionPct: 50, maxTradesPerDay: 3 };

// Um mundo novo para cada caso: corretora de mentira, banco vazio, relogio que o teste controla.
async function mundo({ limits = L, keys = true, ttlMs, exchange = {} } = {}) {
  const ex = await startMockExchange({ balances: { USDT: 10_000 }, ...exchange });
  const db = await openDb(join(dir, `t${++bancos}.db`));
  const relogio = { t: Date.UTC(2026, 10, 14, 12, 0, 0) };
  const client = keys ? createDemoClient({ apiKey: ex.key, apiSecret: ex.secret, baseUrl: ex.url }) : null;
  const mudou = { n: 0 };
  const novoAgente = () => createAgent({
    db, symbol: 'BTCUSDT', limits, client, ttlMs, now: () => relogio.t, wait: async () => {},
    onChange: () => { mudou.n++; }, refPrice: () => ex.S.bid,
  });
  const w = {
    ex, db, relogio, mudou, novoAgente, agent: novoAgente(),
    // A proposta como esta no banco, com o plano e a execucao ja lidos.
    prop(id) {
      const r = db.agentGet('BTCUSDT', id);
      return { ...r, plan: r.plan && JSON.parse(r.plan), exec: r.exec && JSON.parse(r.exec) };
    },
    diario: () => db.agentLog(500).reverse().map((l) => l.text),
    compras: () => ex.sent('POST', '/api/v3/order').filter((r) => r.side === 'BUY'),
    vendasMercado: () => ex.sent('POST', '/api/v3/order').filter((r) => r.side === 'SELL' && r.type === 'MARKET'),
    ordensEnviadas: () => ex.S.requests.filter((r) => r.method === 'POST').length,
    // Propoe e aprova; devolve o numero da proposta.
    async abrir({ stop = 99, target = 103, reason = 'teste' } = {}) {
      const id = w.agent.propose({ stop, target, reason });
      await w.agent.approve(id);
      return id;
    },
    fim: async () => { await ex.close(); db.close(); },
  };
  return w;
}
const caso = async (nome, fn, opcoes) => {
  const w = await mundo(opcoes);
  try { await fn(w); } finally { await w.fim(); }
  feitos++;
  console.log(`ok  ${nome}`);
};

// ---------- o caminho normal ----------

await caso('ciclo completo com alvo: proposta, aprovacao, compra, stop e alvo na corretora, saida no alvo', async (w) => {
  const id = w.agent.propose({ stop: 99, target: 103, reason: 'rompimento com agressao compradora' });
  assert.equal(w.prop(id).status, 'pendente');
  assert.equal(w.ordensEnviadas(), 0, 'propor nao envia nada');
  await w.agent.approve(id);
  let p = w.prop(id);
  assert.equal(p.status, 'aberta');
  // Tamanho: 50% de 10.000 pelo preco maximo aceito (oferta 100,01 + 0,05% = 100,07).
  assert.equal(p.plan.entryLimit, 100.07);
  assert.equal(p.plan.qty, 49.96502);
  assert.equal(p.plan.limitedBy, 'tamanho maximo da posicao');
  const compra = w.compras()[0];
  assert.deepEqual([compra.type, compra.timeInForce, compra.quantity, compra.price], ['LIMIT', 'IOC', '49.96502', '100.07']);
  perto(p.exec.entry.avg, 100.01, 'preco medio da compra'); // executou na oferta, nao no maximo
  // A taxa da compra sai em BTC: o que vai para o stop e o que sobrou em carteira, no passo da corretora.
  const lista = w.ex.sent('POST', '/api/v3/orderList/oco')[0];
  assert.deepEqual([lista.quantity, lista.belowType, lista.belowStopPrice, lista.aboveType, lista.abovePrice], ['49.91505', 'STOP_LOSS', '99.00', 'LIMIT_MAKER', '103.00']);
  assert.equal(w.ex.balance('BTC').locked, 49.91505, 'a posicao esta travada nas ordens de saida');
  assert.ok(p.exec.riskAtFill <= p.plan.maxLoss, 'com a compra real, a perda ate o stop nao passa da planejada');

  w.ex.setPrice(103.5); // o preco sobe ate o alvo
  await w.agent.tick();
  p = w.prop(id);
  assert.deepEqual([p.status, p.exitKind], ['fechada', 'alvo']);
  // Prova independente: o resultado do agente bate com o saldo da corretora.
  const caixa = w.ex.balance('USDT').free - 10_000;
  perto(p.net, caixa + p.exec.result.dustValue, 'resultado liquido x saldo da corretora');
  assert.ok(p.net > 139 && p.net < 140, `resultado ${p.net}`);
  assert.equal(w.ex.S.orders.filter((o) => o.status === 'NEW').length, 0, 'nao sobrou ordem parada');
  const textos = w.diario().join('\n');
  for (const trecho of ['proposta de compra', 'aprovada pelo Bruno', 'trava de risco: pode', 'compra enviada', 'comprado:', 'stop a mercado em 99.00 e alvo em 103.00', 'posicao aberta e protegida', 'operacao encerrada por alvo']) {
    assert.ok(textos.includes(trecho), `falta no registro: ${trecho}`);
  }
});

await caso('saida no stop: a perda fica dentro da planejada quando o stop executa no preco', async (w) => {
  const id = await w.abrir();
  w.ex.setPrice(99); // toca o stop e executa exatamente nele
  await w.agent.tick();
  const p = w.prop(id);
  assert.deepEqual([p.status, p.exitKind], ['fechada', 'stop']);
  assert.ok(p.net < 0 && -p.net <= p.plan.maxLoss + 1e-6, `perda ${-p.net} x planejada ${p.plan.maxLoss}`);
  perto(p.net, w.ex.balance('USDT').free - 10_000 + p.exec.result.dustValue, 'resultado liquido x saldo da corretora');
  perto(p.exec.result.r, p.net / p.plan.maxLoss, 'R');
});

await caso('queda com salto: o stop a mercado sai pior que o preco dele, e o registro mostra as duas contas', async (w) => {
  const id = await w.abrir();
  w.ex.setPrice(95); // o preco pula o stop (99) e a venda sai a 95
  await w.agent.tick();
  const p = w.prop(id);
  assert.deepEqual([p.status, p.exitKind], ['fechada', 'stop']);
  assert.ok(-p.net > p.plan.maxLoss, 'aqui a perda PASSA da planejada: e o risco conhecido do stop a mercado');
  assert.ok(w.diario().at(-1).includes(`planejado perder no maximo ${p.plan.maxLoss.toFixed(2)}`));
  assert.equal(w.ex.balance('BTC').locked, 0);
});

await caso('sem alvo: so o stop fica na corretora; o Bruno encerra a mercado', async (w) => {
  const id = await w.abrir({ target: null });
  assert.equal(w.ex.sent('POST', '/api/v3/orderList/oco').length, 0);
  const stop = w.ex.sent('POST', '/api/v3/order').find((r) => r.type === 'STOP_LOSS');
  assert.deepEqual([stop.side, stop.quantity, stop.stopPrice], ['SELL', '49.91505', '99.00']);
  w.ex.setPrice(101);
  await w.agent.close(id);
  const p = w.prop(id);
  assert.deepEqual([p.status, p.exitKind], ['fechada', 'manual']);
  assert.equal(w.ex.S.orders.filter((o) => o.status === 'NEW').length, 0, 'o stop foi cancelado antes da venda');
  assert.ok(p.net > 0);
  perto(p.net, w.ex.balance('USDT').free - 10_000 + p.exec.result.dustValue, 'resultado liquido x saldo da corretora');
});

await caso('tamanho pela perda maxima por operacao: a perda planejada nao passa de 1% do saldo', async (w) => {
  const id = await w.abrir();
  const p = w.prop(id);
  assert.equal(p.plan.limitedBy, 'perda maxima por operacao');
  assert.ok(p.plan.maxLoss <= 100 && p.plan.maxLoss > 99.99, `perda planejada ${p.plan.maxLoss}`);
}, { limits: { ...L, maxPositionPct: 100 } });

// ---------- nada sai sem aprovacao, sem limites e sem chaves ----------

await caso('recusada pelo Bruno: nada e enviado a corretora', async (w) => {
  const id = w.agent.propose({ stop: 99, target: 103, reason: 'teste' });
  await w.agent.reject(id, 'contra a tendencia do dia');
  const p = w.prop(id);
  assert.deepEqual([p.status, p.note], ['recusada', 'contra a tendencia do dia']);
  assert.equal(w.ordensEnviadas(), 0);
  await assert.rejects(w.agent.approve(id), /nao esta esperando decisao/);
  assert.equal(w.ordensEnviadas(), 0);
});

await caso('proposta sem decisao expira; aprovar depois do prazo nao envia nada', async (w) => {
  const a = w.agent.propose({ stop: 99, reason: 'primeira' });
  const b = w.agent.propose({ stop: 99, reason: 'segunda' });
  w.relogio.t += 16 * 60_000; // o prazo padrao e de 15 minutos
  await assert.rejects(w.agent.approve(a), /expirou/);
  assert.equal(w.prop(a).status, 'expirada');
  await w.agent.tick(); // o acompanhamento vence as outras
  assert.equal(w.prop(b).status, 'expirada');
  assert.equal(w.ordensEnviadas(), 0);
});

await caso('com os limites do arquivo ainda indefinidos, a aprovacao nao envia ordem alguma', async (w) => {
  assert.equal(LIMITS.maxLossPerTradePct, null, 'este caso so vale enquanto src/limits.js estiver sem numeros');
  const id = w.agent.propose({ stop: 99, target: 103, reason: 'teste' });
  await assert.rejects(w.agent.approve(id), /limites de risco ainda nao definidos/);
  assert.equal(w.prop(id).status, 'pendente');
  assert.equal(w.ordensEnviadas(), 0);
  assert.ok(w.diario().at(-1).includes('Nenhuma ordem foi enviada'));
}, { limits: LIMITS });

await caso('sem chaves do Demo Mode a aprovacao nao e aceita', async (w) => {
  const id = w.agent.propose({ stop: 99, target: 103, reason: 'teste' });
  await assert.rejects(w.agent.approve(id), /faltam as chaves/);
  assert.equal(w.prop(id).status, 'pendente');
  assert.equal(w.ex.S.requests.length, 0, 'sem chaves, nem conversa com a corretora');
}, { keys: false });

await caso('quem propoe nao escolhe o estado: toda proposta nasce pendente', async (w) => {
  const id = w.agent.propose({ stop: 99, reason: 'teste', source: 'ia', status: 'aberta', plan: { qty: 999 }, id: 77 });
  const p = w.prop(id);
  assert.deepEqual([p.status, p.source, p.plan, p.exec], ['pendente', 'ia', null, null]);
  assert.throws(() => w.agent.propose({ stop: 99, reason: 'teste', source: 'outro' }), /origem/);
});

await caso('proposta mal formada e recusada na entrada', async (w) => {
  assert.throws(() => w.agent.propose({ stop: 99 }), /motivo/);
  assert.throws(() => w.agent.propose({ reason: 'teste' }), /stop/);
  assert.throws(() => w.agent.propose({ stop: 101, reason: 'teste' }), /abaixo do preco de agora/);
  assert.throws(() => w.agent.propose({ stop: 99, target: 99.5, reason: 'teste' }), /acima do preco de agora/);
  assert.throws(() => w.agent.propose({ side: 'sell', stop: 101, reason: 'teste' }), /so compra/);
  for (let i = 0; i < 10; i++) w.agent.propose({ stop: 99, reason: `teste ${i}` });
  assert.throws(() => w.agent.propose({ stop: 99, reason: 'a decima primeira' }), /10 propostas/);
});

// ---------- o que a trava de risco barra na hora da aprovacao ----------

await caso('com uma posicao aberta, a proxima aprovacao e barrada', async (w) => {
  await w.abrir();
  const b = await w.abrir();
  const p = w.prop(b);
  assert.equal(p.status, 'barrada');
  assert.match(p.note, /ja existe uma posicao aberta/);
  assert.equal(w.compras().length, 1);
});

await caso('limite de operacoes por dia', async (w) => {
  const a = await w.abrir();
  await w.agent.close(a);
  const b = await w.abrir();
  assert.equal(w.prop(b).status, 'barrada');
  assert.match(w.prop(b).note, /limite de 1 operacoes por dia atingido/);
  w.relogio.t += 86_400_000; // no dia seguinte (UTC) pode de novo
  const c = await w.abrir();
  assert.equal(w.prop(c).status, 'aberta');
}, { limits: { ...L, maxTradesPerDay: 1 } });

await caso('perda maxima do dia: o tamanho encolhe para o que ainda cabe, e depois nada mais abre ate o dia seguinte', async (w) => {
  const a = await w.abrir();
  assert.equal(w.prop(a).plan.limitedBy, 'perda maxima por operacao');
  w.ex.setPrice(99);
  await w.agent.tick();
  const perdido = -w.prop(a).net;
  assert.ok(perdido > 90 && perdido <= 100, `primeira perda ${perdido}`);

  w.ex.setPrice(100);
  const b = await w.abrir();
  const pb = w.prop(b);
  assert.equal(pb.plan.limitedBy, 'perda maxima do dia'); // 1,5% de 10.000 = 150; sobram uns 50
  perto(pb.plan.maxLoss, 150 - perdido, 'o que ainda cabia no dia', 0.02);
  w.ex.setPrice(97); // desta vez o stop sai com salto: a perda do dia passa do limite
  await w.agent.tick();
  assert.ok(-w.prop(a).net - w.prop(b).net > 150);

  w.ex.setPrice(100);
  const c = await w.abrir();
  assert.equal(w.prop(c).status, 'barrada');
  assert.match(w.prop(c).note, /perda maxima do dia atingida/);
  assert.equal(w.compras().length, 2);

  w.relogio.t += 86_400_000; // dia novo: o limite volta, sobre o saldo de abertura do novo dia
  const d = await w.abrir();
  assert.equal(w.prop(d).status, 'aberta');
  assert.ok(w.prop(d).plan.dayStartEquity < 10_000 - 150);
}, { limits: { maxLossPerTradePct: 1, maxLossPerDayPct: 1.5, maxPositionPct: 100, maxTradesPerDay: 10 } });

await caso('preco caiu ate o stop antes da decisao: a aprovacao e barrada', async (w) => {
  const a = w.agent.propose({ stop: 99, target: 103, reason: 'teste' });
  const b = w.agent.propose({ stop: 99, target: 103, reason: 'teste' });
  w.ex.setPrice(98.99); // encostou no stop: uma ordem de stop dispararia na hora
  await w.agent.approve(a);
  assert.equal(w.prop(a).status, 'barrada');
  assert.match(w.prop(a).note, /ja esta no preco de agora/);
  w.ex.setPrice(98.5); // passou do stop
  await w.agent.approve(b);
  assert.equal(w.prop(b).status, 'barrada');
  assert.match(w.prop(b).note, /o stop tem que ficar abaixo do preco de entrada/);
  assert.equal(w.ordensEnviadas(), 0);
});

await caso('aprovar duas vezes ao mesmo tempo envia uma compra so', async (w) => {
  const id = w.agent.propose({ stop: 99, target: 103, reason: 'teste' });
  const r = await Promise.allSettled([w.agent.approve(id), w.agent.approve(id)]);
  assert.deepEqual(r.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(w.compras().length, 1);
  assert.equal(w.prop(id).status, 'aberta');
});

// ---------- quando a corretora ou a conexao falham ----------

await caso('compra recusada pela corretora: nada fica aberto e a proxima proposta nao e bloqueada', async (w) => {
  w.ex.failNext((r) => r.method === 'POST' && r.side === 'BUY', 'recusar', { code: -2010, msg: 'Account has insufficient balance for requested action.' });
  const a = await w.abrir();
  assert.equal(w.prop(a).status, 'falhou');
  assert.match(w.prop(a).note, /a corretora recusou a compra.*insufficient balance/);
  assert.equal(w.ex.balance('BTC').free, 0);
  const b = await w.abrir();
  assert.equal(w.prop(b).status, 'aberta');
});

await caso('compra que nao chega a corretora (conexao cai antes): nada comprado, nenhuma repeticao as cegas', async (w) => {
  w.ex.failNext((r) => r.method === 'POST' && r.side === 'BUY', 'cair-antes');
  const id = await w.abrir();
  assert.equal(w.prop(id).status, 'falhou');
  assert.match(w.prop(id).note, /nao chegou a corretora/);
  assert.equal(w.ex.S.orders.length, 0);
});

await caso('compra executada mas a resposta se perde: o agente pergunta a corretora e segue, sem comprar de novo', async (w) => {
  w.ex.failNext((r) => r.method === 'POST' && r.side === 'BUY', 'cair-depois');
  const id = await w.abrir();
  const p = w.prop(id);
  assert.equal(p.status, 'aberta');
  assert.equal(w.ex.S.orders.filter((o) => o.side === 'BUY').length, 1);
  perto(p.exec.pos, 49.96502 * 0.999, 'posicao (com a taxa lida da lista de negocios)', 1e-9);
  assert.ok(w.diario().some((t) => t.includes('sem resposta ao enviar a compra')));
});

await caso('compra parcial (pouca oferta): o stop cobre so o que foi comprado', async (w) => {
  w.ex.S.maxFill = 10;
  const id = await w.abrir();
  const p = w.prop(id);
  assert.equal(p.status, 'aberta');
  assert.equal(p.exec.entry.qty, 10);
  assert.equal(w.ex.sent('POST', '/api/v3/orderList/oco')[0].quantity, '9.99000');
  assert.ok(w.diario().some((t) => t.includes('MENOS que o pedido')));
});

await caso('compra que nao executa nada: operacao encerrada sem posicao', async (w) => {
  w.ex.S.maxFill = 0;
  const id = await w.abrir();
  assert.equal(w.prop(id).status, 'falhou');
  assert.match(w.prop(id).note, /nao executou/);
  assert.equal(w.ex.S.orders.filter((o) => o.status === 'NEW').length, 0);
});

await caso('stop recusado pela corretora: a posicao e vendida a mercado na hora', async (w) => {
  w.ex.failNext((r) => r.path === '/api/v3/orderList/oco', 'recusar', { code: -2010, msg: 'Stop price would trigger immediately.' });
  const id = await w.abrir();
  const p = w.prop(id);
  assert.deepEqual([p.status, p.exitKind], ['fechada', 'emergencia']);
  assert.equal(w.vendasMercado().length, 1);
  assert.ok(w.ex.balance('BTC').free < 0.00001, 'nao sobrou posicao');
  assert.ok(w.diario().some((t) => t.includes('a corretora recusou o stop') && t.includes('saindo a mercado')));
  perto(p.net, w.ex.balance('USDT').free - 10_000 + p.exec.result.dustValue, 'resultado liquido x saldo da corretora');
});

await caso('stop que nao chega (conexao cai antes): o agente confere e coloca de novo, uma vez so', async (w) => {
  w.ex.failNext((r) => r.path === '/api/v3/orderList/oco', 'cair-antes');
  const id = await w.abrir();
  assert.equal(w.prop(id).status, 'aberta');
  assert.equal(w.ex.S.lists.length, 1);
  assert.equal(w.prop(id).exec.prots.length, 2);
});

await caso('stop colocado mas a resposta se perde: o agente acha a ordem e nao duplica', async (w) => {
  w.ex.failNext((r) => r.path === '/api/v3/orderList/oco', 'cair-depois');
  const id = await w.abrir();
  assert.equal(w.prop(id).status, 'aberta');
  assert.equal(w.ex.S.lists.length, 1);
  assert.equal(w.prop(id).exec.prots.length, 1);
  assert.equal(w.ex.balance('BTC').locked, 49.91505);
});

await caso('stop cancelado por fora: no acompanhamento seguinte a posicao e vendida a mercado', async (w) => {
  const id = await w.abrir();
  w.ex.cancelOutside(w.prop(id).exec.prots[0].stop.orderId);
  await w.agent.tick();
  const p = w.prop(id);
  assert.deepEqual([p.status, p.exitKind], ['fechada', 'emergencia']);
  assert.ok(w.diario().some((t) => t.includes('o stop nao esta mais na corretora')));
  assert.ok(w.ex.balance('BTC').free < 0.00001);
});

await caso('alvo executa em parte e o stop some: o resto e vendido a mercado', async (w) => {
  const id = await w.abrir();
  w.ex.partialTarget(w.prop(id).exec.prots[0].target.orderId, 20);
  await w.agent.tick();
  const p = w.prop(id);
  assert.equal(p.status, 'fechada');
  assert.equal(p.exitKind, 'emergencia'); // a maior parte saiu na venda de emergencia
  perto(p.exec.result.exitQty, 49.91505, 'tudo vendido', 1e-9);
  assert.equal(w.ex.S.orders.filter((o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED').length, 0);
  perto(p.net, w.ex.balance('USDT').free - 10_000 + p.exec.result.dustValue, 'resultado liquido x saldo da corretora');
});

await caso('sem stop e sem conseguir vender: fica em ATENCAO, nao insiste as cegas, e resolve quando da', async (w) => {
  w.ex.failNext((r) => r.path === '/api/v3/orderList/oco', 'recusar', { code: -2010, msg: 'Stop price would trigger immediately.' });
  w.ex.failNext((r) => r.method === 'POST' && r.type === 'MARKET', 'recusar', { code: -1013, msg: 'Market is closed.', times: 3 });
  const id = await w.abrir();
  let p = w.prop(id);
  assert.equal(p.status, 'atencao');
  assert.match(p.note, /nao foi possivel vender a posicao.*Market is closed/);
  assert.equal(w.vendasMercado().length, 3);
  await w.agent.tick();
  await w.agent.tick();
  assert.equal(w.vendasMercado().length, 3, 'sem novas tentativas sozinho depois de tres recusas');
  // Enquanto isso, nenhuma operacao nova abre.
  const outra = await w.abrir();
  assert.equal(w.prop(outra).status, 'barrada');
  await w.agent.retry(id); // o Bruno manda tentar de novo; agora a corretora aceita
  p = w.prop(id);
  assert.deepEqual([p.status, p.exitKind], ['fechada', 'emergencia']);
  assert.ok(w.diario().some((t) => t.startsWith('ATENCAO')));
  assert.ok(w.diario().some((t) => t.includes('situacao resolvida')));
});

await caso('queda logo depois da compra: outro processo, so com o banco, acha a compra e coloca o stop', async (w) => {
  w.ex.failNext((r) => r.method === 'POST' && r.side === 'BUY', 'cair-depois');
  w.ex.failNext((r) => r.method === 'GET' && r.path === '/api/v3/order', 'cair-antes', { times: 4 });
  const id = await w.abrir();
  assert.equal(w.prop(id).status, 'atencao'); // comprou, mas nao conseguiu confirmar nem proteger
  assert.equal(w.ex.balance('BTC').locked, 0);
  const depois = w.novoAgente(); // como se o programa tivesse sido reiniciado
  await depois.tick();
  const p = w.prop(id);
  assert.equal(p.status, 'aberta');
  assert.equal(w.ex.S.orders.filter((o) => o.side === 'BUY').length, 1);
  assert.equal(w.ex.balance('BTC').locked, 49.91505);
  assert.ok(w.diario().some((t) => t.includes('situacao resolvida')));
});

await caso('sem contato com a corretora durante uma posicao protegida: continua aberta, avisa uma vez, e retoma', async (w) => {
  const id = await w.abrir();
  w.ex.failNext((r) => r.method === 'GET' && r.path === '/api/v3/order', 'cair-antes', { times: 3 });
  await w.agent.tick();
  await w.agent.tick();
  await w.agent.tick();
  assert.equal(w.prop(id).status, 'aberta');
  assert.equal(w.diario().filter((t) => t.includes('sem conseguir consultar a corretora')).length, 1);
  await w.agent.tick();
  assert.equal(w.prop(id).status, 'aberta');
  assert.ok(w.diario().at(-1).includes('o contato com a corretora voltou'));
  assert.equal(w.ex.balance('BTC').locked, 49.91505, 'o stop continuou parado na corretora o tempo todo');
});

await caso('stop sumiu e a conexao falha logo em seguida: a operacao nao continua aparecendo como protegida', async (w) => {
  const id = await w.abrir();
  w.ex.cancelOutside(w.prop(id).exec.prots[0].stop.orderId);
  w.ex.failNext((r) => r.path === '/api/v3/ticker/bookTicker', 'cair-antes');
  await w.agent.tick(); // ve que o stop sumiu, mas a consulta seguinte falha
  assert.equal(w.prop(id).status, 'atencao');
  assert.ok(!w.diario().some((t) => t.includes('O stop continua parado la')));
  await w.agent.tick(); // na tentativa seguinte, vende
  assert.deepEqual([w.prop(id).status, w.prop(id).exitKind], ['fechada', 'emergencia']);
});

await caso('stop executou e a conexao falha antes de fechar a conta: resolve na tentativa seguinte, sem vender de novo', async (w) => {
  const id = await w.abrir();
  w.ex.setPrice(99);
  w.ex.failNext((r) => r.path === '/api/v3/myTrades', 'cair-antes');
  await w.agent.tick();
  assert.equal(w.prop(id).status, 'atencao');
  await w.agent.tick();
  const p = w.prop(id);
  assert.deepEqual([p.status, p.exitKind], ['fechada', 'stop']);
  assert.equal(w.vendasMercado().length, 0);
  perto(p.net, w.ex.balance('USDT').free - 10_000 + p.exec.result.dustValue, 'resultado liquido x saldo da corretora');
});

// ---------- registro, previa e resumo ----------

await caso('o registro so recebe linhas novas: o proprio banco recusa alterar ou apagar', async (w) => {
  await w.abrir();
  const { DatabaseSync } = await import('node:sqlite');
  const cru = new DatabaseSync(join(dir, `t${bancos}.db`));
  const antes = cru.prepare('SELECT COUNT(*) AS n FROM agent_log').get().n;
  assert.ok(antes >= 6);
  assert.throws(() => cru.exec("UPDATE agent_log SET text = 'outra coisa'"), /nao pode ser alterado/);
  assert.throws(() => cru.exec('DELETE FROM agent_log'), /nao pode ser apagado/);
  assert.equal(cru.prepare('SELECT COUNT(*) AS n FROM agent_log').get().n, antes);
  cru.close();
});

await caso('a tela recebe a previa da trava para a proposta pendente, e nunca as chaves', async (w) => {
  const id = w.agent.propose({ stop: 99, target: 103, reason: 'teste' });
  w.agent.state(); // dispara a leitura da conta em segundo plano
  await pausa(300);
  const s = w.agent.state();
  const p = s.proposals.find((x) => x.id === id);
  assert.equal(p.preview.ok, true);
  assert.deepEqual([p.preview.qty, p.preview.entryLimit, p.preview.limitedBy], [49.96502, 100.07, 'tamanho maximo da posicao']);
  assert.equal(s.account.equity, 10_000);
  assert.deepEqual(s.limits, { ...L, problem: null });
  assert.deepEqual([s.demo.keys, s.demo.url], [true, w.ex.url]);
  assert.doesNotMatch(JSON.stringify(s), /chave-de-teste|segredo-de-teste/);
  assert.equal(w.ordensEnviadas(), 0, 'olhar a tela nao envia ordem');
});

await caso('resumo das operacoes: resultado liquido, perda maxima, expectativa; acerto por ultimo', async () => {
  assert.deepEqual(agentStats([]), { trades: 0 });
  const s = agentStats([{ net: 10, r: 1 }, { net: -30, r: -1 }, { net: -5, r: -0.5 }, { net: 40, r: 2 }]);
  assert.deepEqual(Object.keys(s), ['trades', 'netTotal', 'maxDrawdown', 'worstTrade', 'expectancy', 'avgR', 'winRatePct']);
  assert.deepEqual([s.trades, s.netTotal, s.maxDrawdown, s.worstTrade, s.expectancy, s.avgR, s.winRatePct], [4, 15, 35, -30, 3.75, 0.375, 50]);
});

rmSync(dir, { recursive: true, force: true });
console.log(`\nTODOS OS ${feitos} CASOS PASSARAM`);
