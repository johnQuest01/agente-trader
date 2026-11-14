// Fase 5: o agente propoe, o Bruno aprova, e so entao a ordem vai para o Demo Mode.
//
// O caminho de uma operacao:
//   proposta (pendente) -> o Bruno aprova ou recusa -> a trava de risco (src/risk.js) confere e
//   calcula o tamanho -> compra no Demo Mode -> stop (e alvo) ficam parados NA CORRETORA ->
//   saida -> resultado liquido.
//
// Regras deste arquivo (scripts/testar-agente.js confere cada uma):
//   - Nenhuma ordem sai sem a aprovacao do Bruno e sem passar pela trava de risco.
//   - Quem propoe nao aprova: `propose` so grava a proposta, sempre como 'pendente'. Aprovar e
//     outra funcao, ligada so ao botao da tela.
//   - Posicao aberta sempre tem stop na corretora. Se o stop nao pode ser colocado, ou some, a
//     posicao e vendida a mercado na hora.
//   - Antes de enviar qualquer ordem, a intencao e gravada no banco, com um nome unico para a
//     ordem. Depois de uma queda (do programa ou da internet) o agente pergunta a corretora o
//     que existe com aqueles nomes e continua dali (`settle`), em vez de adivinhar.
//   - Tudo o que acontece vai para o registro (tabela agent_log), que so recebe linhas novas.
//
// Estados de uma proposta:
//   pendente  esperando a decisao do Bruno
//   recusada  o Bruno recusou                      expirada  passou do prazo sem decisao
//   barrada   aprovada, mas a trava de risco nao deixou (nenhuma ordem enviada)
//   enviando  aprovada; compra em andamento        falhou    a compra nao executou; nada aberto
//   aberta    comprado e com stop na corretora     fechando  saida em andamento
//   fechada   terminou, com resultado              atencao   algo nao pode ser confirmado: o
//                                                            agente tenta de novo sozinho e a tela avisa
import { randomBytes } from 'node:crypto';
import { checkProposal, limitsProblem, floorToStep, ceilToStep, formatStep } from './risk.js';
import { isJson, readJson } from './http.js';

// Estados em que pode haver posicao na corretora. Enquanto existir uma operacao num deles,
// nenhuma outra e aberta.
export const LIVE = ['enviando', 'aberta', 'fechando', 'atencao'];

const DAY = 86_400_000;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const num = (x) => Number(x) || 0;
const usd = (x) => Number(x).toFixed(2);
const signed = (x) => `${x >= 0 ? '+' : ''}${usd(x)}`;
const isOpenOrder = (o) => !!o && (o.status === 'NEW' || o.status === 'PARTIALLY_FILLED' || o.status === 'PENDING_NEW');
const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });

// Resumo das operacoes encerradas, em USDT. A ordem dos campos e a de importancia do projeto:
// resultado liquido, perda maxima e expectativa por operacao; a taxa de acerto vem por ultimo.
// `closed` = [{ net, r }] na ordem em que terminaram.
export function agentStats(closed) {
  const done = closed.filter((c) => Number.isFinite(c.net));
  if (!done.length) return { trades: 0 };
  let cum = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const c of done) {
    cum += c.net;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.max(maxDrawdown, peak - cum);
  }
  const nets = done.map((c) => c.net);
  const rs = done.map((c) => c.r).filter(Number.isFinite);
  return {
    trades: done.length,
    netTotal: cum,
    maxDrawdown,
    worstTrade: Math.min(...nets),
    expectancy: cum / done.length,
    avgR: rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null,
    winRatePct: (nets.filter((n) => n > 0).length / done.length) * 100,
  };
}

//   limits     - src/limits.js (os testes passam limites de teste; o programa, os do arquivo)
//   client     - cliente do Demo Mode (src/demo.js), ou null se nao ha chaves no .env
//   feePct     - taxa por lado usada pela trava de risco para dimensionar, em %
//   ttlMs      - prazo de validade de uma proposta sem decisao
//   maxSlipPct - quanto acima da oferta de agora a compra aceita pagar, em %
//   refPrice   - preco de mercado de agora, so para conferir a proposta ao ser criada
export function createAgent({
  db, symbol, limits, client = null, feePct = 0.1, ttlMs = 15 * 60_000, maxSlipPct = 0.05,
  refPrice = () => null, now = Date.now, wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = () => {}, onChange = () => {},
}) {
  let filters = null;   // regras do par na corretora
  let filtersAt = -Infinity;
  let snap = null;      // ultima leitura da conta e do preco no Demo Mode
  let demoError = null; // ultimo erro ao falar com o Demo Mode (para a tela)
  let lastRefreshTry = -Infinity;
  let refreshing = null;
  let timer = null;
  let ticking = false;
  let lastDay = null;

  // Uma coisa de cada vez: aprovar, encerrar e o acompanhamento nunca se misturam.
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const run = chain.then(fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  const journal = (proposalId, kind, text, data) => {
    db.agentLogAdd({ time: now(), proposalId, kind, text, data: data === undefined ? null : JSON.stringify(data) });
    log(`agente: ${proposalId ? `#${proposalId} ` : ''}${text}`);
  };
  const hydrate = (row) => ({ ...row, plan: row.plan ? JSON.parse(row.plan) : null, exec: row.exec ? JSON.parse(row.exec) : null });
  const mustLoad = (id) => {
    const row = Number.isInteger(id) ? db.agentGet(symbol, id) : null;
    if (!row) throw Object.assign(new Error('proposta nao encontrada'), { status: 404 });
    return hydrate(row);
  };
  const save = (p, patch) => {
    Object.assign(p, patch);
    const row = { ...patch };
    if ('plan' in row) row.plan = row.plan == null ? null : JSON.stringify(row.plan);
    if ('exec' in row) row.exec = row.exec == null ? null : JSON.stringify(row.exec);
    db.agentUpdate(p.id, row);
  };

  // ---------- conta, preco e numeros do dia ----------

  async function getFilters() {
    if (!filters || now() - filtersAt > 3_600_000) {
      filters = await client.filters(symbol);
      filtersAt = now();
    }
    return filters;
  }

  // Quanto da moeda comprada o agente ainda tem em posicao (comprado menos vendido).
  const positionQty = () => db.agentByStatus(symbol, LIVE).map(hydrate)
    .reduce((s, p) => s + Math.max(0, num(p.exec?.pos) - num(p.exec?.sold)), 0);

  // Saldo = USDT da conta de demonstracao (livre + travado em ordens) + a posicao do agente
  // pelo preco de venda de agora. Outras moedas que a conta tenha nao entram.
  async function readAccount() {
    const f = await getFilters();
    const [acc, tick] = await Promise.all([client.account(), client.bookTicker(symbol)]);
    const q = acc.balances?.find((b) => b.asset === f.quoteAsset);
    const free = num(q?.free);
    const locked = num(q?.locked);
    const bid = num(tick.bidPrice);
    const ask = num(tick.askPrice);
    if (!(bid > 0) || !(ask > 0)) throw new Error('o Demo Mode nao informou o preco de agora');
    const pos = positionQty();
    snap = { at: now(), asset: f.quoteAsset, baseAsset: f.baseAsset, free, locked, bid, ask, positionQty: pos, equity: free + locked + pos * bid };
    demoError = null;
    return snap;
  }

  // Numeros do dia (UTC). Na primeira leitura do dia, grava o saldo de abertura.
  function dayNumbers(equity, record = true) {
    const key = dayKey(now());
    const from = Date.parse(`${key}T00:00:00Z`);
    let startEquity = db.agentDayGet(symbol, key);
    if (startEquity === null && record && equity > 0) {
      db.agentDaySet(symbol, key, equity, now());
      startEquity = equity;
      journal(null, 'sistema', `primeira leitura do dia ${key} (UTC): saldo de ${usd(equity)}`);
    }
    const s = db.agentDayStats(symbol, from, from + DAY);
    return { key, startEquity: startEquity ?? equity, recorded: startEquity !== null, realized: s.realized, trades: s.opened };
  }

  // A trava de risco, mais as conferencias que dependem do preco de agora.
  // A compra aceita pagar ate `entryLimit` (a oferta de agora mais uma folga); a trava
  // dimensiona por esse preco maximo, entao a perda ate o stop nao passa da planejada mesmo
  // que a compra saia no pior preco aceito.
  function gate(p, acct, day, f) {
    const entryLimit = ceilToStep(acct.ask * (1 + maxSlipPct / 100), f.tickSize);
    const check = checkProposal({
      limits, equity: acct.equity, dayStartEquity: day.startEquity, realizedToday: day.realized, tradesToday: day.trades,
      openPositions: db.agentByStatus(symbol, LIVE).length,
      proposal: { side: p.side, entry: entryLimit, stop: p.stop, target: p.target }, filters: f, feePct,
    });
    if (!check.ok) return { ...check, entryLimit };
    const reasons = [];
    if (f.status !== 'TRADING') reasons.push(`o par nao esta em negociacao no Demo Mode (${f.status})`);
    if (check.stop >= acct.bid) reasons.push(`o stop (${check.stop}) ja esta no preco de agora (${acct.bid}) ou acima dele`);
    if (f.sellPriceDown && check.stop < acct.bid * f.sellPriceDown) reasons.push('o stop esta longe demais do preco: a corretora nao aceita');
    if (check.target != null && f.sellPriceUp && check.target > acct.bid * f.sellPriceUp) reasons.push('o alvo esta longe demais do preco: a corretora nao aceita');
    if (acct.free < check.notional) reasons.push(`saldo livre insuficiente: ${usd(acct.free)} para uma compra de ate ${usd(check.notional)}`);
    return reasons.length ? { ok: false, reasons, entryLimit } : { ...check, entryLimit };
  }

  // ---------- propostas e decisoes ----------

  // Grava uma proposta. So isso: nao envia nada e nao aprova nada.
  function propose({ side = 'buy', stop, target, reason, source = 'manual' } = {}) {
    const s = Number(stop);
    const t = target === null || target === undefined || target === '' ? null : Number(target);
    const why = String(reason ?? '').trim().slice(0, 2000);
    if (side !== 'buy') throw new Error('so compra e permitida: a conta e a vista, sem venda a descoberto');
    if (!(s > 0)) throw new Error('informe o stop: sem perda maxima definida nao ha proposta');
    if (t !== null && !(t > s)) throw new Error('o alvo tem que ficar acima do stop');
    if (!why) throw new Error('informe o motivo: toda proposta fica registrada com a razao dela');
    if (source !== 'manual' && source !== 'ia') throw new Error('origem da proposta invalida');
    const ref = Number(refPrice()) || null;
    if (ref && s >= ref) throw new Error(`o stop tem que ficar abaixo do preco de agora (${ref})`);
    if (ref && t !== null && t <= ref) throw new Error(`o alvo tem que ficar acima do preco de agora (${ref})`);
    if (db.agentByStatus(symbol, ['pendente']).length >= 10) throw new Error('ja ha 10 propostas esperando decisao: decida ou deixe expirar');
    const id = db.agentAdd({ symbol, createdAt: now(), source, side, refPrice: ref, stop: s, target: t, reason: why });
    journal(id, 'proposta', `proposta de compra (${source === 'ia' ? 'IA' : 'manual'}): stop ${s}${t !== null ? `, alvo ${t}` : ', sem alvo'}. Motivo: ${why}`, { refPrice: ref });
    onChange();
    return id;
  }

  function expire(p) {
    save(p, { status: 'expirada', note: `sem decisao em ${Math.round(ttlMs / 60_000)} minutos` });
    journal(p.id, 'sistema', 'a proposta expirou sem decisao');
  }
  function expireOld() {
    let n = 0;
    for (const row of db.agentByStatus(symbol, ['pendente'])) {
      if (now() - row.createdAt > ttlMs) { expire(hydrate(row)); n++; }
    }
    return n;
  }

  const reject = (id, noteText) => exclusive(async () => {
    const p = mustLoad(id);
    if (p.status !== 'pendente') throw conflict(`a proposta #${id} nao esta esperando decisao (estado: ${p.status})`);
    const note = String(noteText ?? '').trim().slice(0, 500) || null;
    save(p, { status: 'recusada', decidedAt: now(), note });
    journal(id, 'decisao', `recusada pelo Bruno${note ? `: ${note}` : ''}`);
    onChange();
  });

  // A aprovacao do Bruno. E o unico caminho que leva a uma ordem.
  const approve = (id) => exclusive(async () => {
    const p = mustLoad(id);
    if (p.status !== 'pendente') throw conflict(`a proposta #${id} nao esta esperando decisao (estado: ${p.status})`);
    if (now() - p.createdAt > ttlMs) {
      expire(p);
      onChange();
      throw conflict(`a proposta #${id} expirou: passou de ${Math.round(ttlMs / 60_000)} minutos sem decisao`);
    }
    // O que falta para poder operar e nao depende desta proposta: ela continua pendente.
    const block = limitsProblem(limits) ?? (client ? null : 'faltam as chaves do Demo Mode (arquivo .env)');
    if (block) {
      journal(id, 'trava', `aprovacao nao aceita: ${block}. Nenhuma ordem foi enviada.`);
      onChange();
      throw conflict(`nao da para aprovar: ${block}`);
    }
    let f;
    let acct;
    try {
      f = await getFilters();
      acct = await readAccount();
    } catch (err) {
      demoError = err.message;
      journal(id, 'erro', `aprovacao nao aceita: sem contato com o Demo Mode (${err.message}). Nenhuma ordem foi enviada.`);
      onChange();
      throw conflict(`sem contato com o Demo Mode: ${err.message}`);
    }
    const day = dayNumbers(acct.equity);
    const g = gate(p, acct, day, f);
    const numbers = { equity: acct.equity, free: acct.free, bid: acct.bid, ask: acct.ask, dayStartEquity: day.startEquity, realizedToday: day.realized, tradesToday: day.trades, limits: { ...limits } };
    journal(id, 'decisao', 'aprovada pelo Bruno');
    if (!g.ok) {
      save(p, { status: 'barrada', decidedAt: now(), note: g.reasons.join('; ') });
      journal(id, 'trava', `barrada pela trava de risco: ${p.note}. Nenhuma ordem foi enviada.`, numbers);
      onChange();
      return;
    }
    const plan = {
      ...numbers, at: now(), feePct, entryLimit: g.entryLimit, qty: g.qty, notional: g.notional, stop: g.stop, target: g.target,
      maxLoss: g.maxLoss, limitedBy: g.limitedBy,
    };
    // O nome das ordens leva um codigo sorteado: assim uma ordem antiga na corretora (de outro
    // banco de dados, por exemplo) nunca e confundida com uma desta operacao.
    const tag = randomBytes(4).toString('hex');
    save(p, {
      status: 'enviando', decidedAt: now(), note: null, plan,
      exec: { tag, entry: { cid: `ag-${tag}-e`, sent: false, done: false }, prots: [], exits: [], pos: 0, sold: 0, wantClose: null, exitTries: 0 },
    });
    journal(id, 'trava', `trava de risco: pode. Compra de ${formatStep(g.qty, f.stepSize)} ${f.baseAsset} a no maximo ${g.entryLimit} (ate ${usd(g.notional)} ${f.quoteAsset}); perda maxima planejada ${usd(g.maxLoss)} (${((g.maxLoss / acct.equity) * 100).toFixed(2)}% do saldo), limitada por: ${g.limitedBy}`, plan);
    await settle(p);
    onChange();
  });

  // O Bruno manda sair da posicao agora, a mercado.
  const close = (id) => exclusive(async () => {
    const p = mustLoad(id);
    if (!LIVE.includes(p.status)) throw conflict(`a operacao #${id} nao esta aberta (estado: ${p.status})`);
    if (!client) throw conflict('faltam as chaves do Demo Mode (arquivo .env)');
    p.exec.wantClose = 'manual';
    p.exec.exitTries = 0;
    save(p, { status: 'fechando', exec: p.exec });
    journal(id, 'decisao', 'o Bruno mandou encerrar a posicao a mercado');
    await settle(p);
    onChange();
  });

  // Tenta de novo, agora, resolver uma operacao que ficou em 'atencao'.
  const retry = (id) => exclusive(async () => {
    const p = mustLoad(id);
    if (!LIVE.includes(p.status)) throw conflict(`a operacao #${id} nao esta aberta (estado: ${p.status})`);
    if (!client) throw conflict('faltam as chaves do Demo Mode (arquivo .env)');
    p.exec.exitTries = 0;
    save(p, { exec: p.exec });
    journal(id, 'decisao', 'o Bruno pediu para tentar de novo');
    await settle(p);
    onChange();
  });

  // ---------- execucao: sempre a partir do que existe na corretora ----------

  // Pergunta a corretora por uma ordem. Devolve a ordem, ou null se ela COM CERTEZA nao existe
  // (duas respostas "nao existe" seguidas). Se nao da para saber, o erro sobe.
  async function findOrder(ref) {
    let missing = 0;
    for (let i = 0; ; i++) {
      try {
        return await client.order(symbol, ref);
      } catch (err) {
        if (err.code === -2013) {
          if (++missing >= 2) return null;
        } else if (i >= 3) throw err;
        await wait(1500);
      }
    }
  }

  // Estado de agora de uma ordem que enviamos (ou tentamos enviar). null = ela nao chegou a
  // existir. Uma ordem que ja terminou nao e consultada de novo.
  async function lookup(ref) {
    if (ref.final) return ref.final;
    if (ref.absent) return null;
    let o;
    if (ref.orderId) {
      o = await client.order(symbol, ref.orderId);
    } else {
      o = await findOrder({ clientId: ref.cid });
      if (!o) {
        ref.absent = true;
        return null;
      }
      ref.orderId = o.orderId;
    }
    if (!isOpenOrder(o)) {
      ref.final = { orderId: o.orderId, status: o.status, type: o.type, origQty: o.origQty, executedQty: o.executedQty, cummulativeQuoteQty: o.cummulativeQuoteQty };
    }
    return o;
  }

  // Taxas de uma ordem, somadas por moeda. A resposta de uma ordem recem-enviada traz as
  // execucoes (`fills`); para uma ordem consultada depois, elas vem da lista de negocios.
  async function feesOf(order, f) {
    const parts = order.fills ?? (num(order.executedQty) > 0 ? await client.myTrades(symbol, order.orderId) : []);
    const fees = { base: 0, quote: 0, other: {} };
    for (const t of parts) {
      const c = num(t.commission);
      if (!c) continue;
      if (t.commissionAsset === f.baseAsset) fees.base += c;
      else if (t.commissionAsset === f.quoteAsset) fees.quote += c;
      else fees.other[t.commissionAsset] = (fees.other[t.commissionAsset] ?? 0) + c;
    }
    return fees;
  }

  // A compra. Devolve 'fim' se a operacao terminou aqui (nada foi comprado).
  async function settleEntry(p, f) {
    const x = p.exec;
    const e = x.entry;
    let order = null;
    if (!e.sent) {
      e.sent = true;
      save(p, { exec: x }); // a intencao fica gravada ANTES do envio
      journal(p.id, 'ordem', `compra enviada ao Demo Mode: ${formatStep(p.plan.qty, f.stepSize)} ${f.baseAsset} a no maximo ${p.plan.entryLimit}`);
      try {
        order = await client.limitBuyIoc(symbol, formatStep(p.plan.qty, f.stepSize), formatStep(p.plan.entryLimit, f.tickSize), e.cid);
      } catch (err) {
        if (!err.unknown) {
          save(p, { status: 'falhou', note: `a corretora recusou a compra: ${err.message}` });
          journal(p.id, 'erro', `${p.note}. Nada foi comprado.`);
          return 'fim';
        }
        journal(p.id, 'erro', `sem resposta ao enviar a compra (${err.message}); perguntando a corretora se a ordem existe`);
      }
    }
    if (!order) {
      order = await findOrder({ clientId: e.cid });
      if (!order) {
        save(p, { status: 'falhou', note: 'a ordem de compra nao chegou a corretora' });
        journal(p.id, 'erro', `${p.note}. Nada foi comprado.`);
        return 'fim';
      }
    }
    if (isOpenOrder(order)) {
      // Nao deveria acontecer (a compra nao fica parada no livro), mas se ficou: cancela e olha de novo.
      await client.cancel(symbol, order.orderId).catch((err) => { if (err.code !== -2011) throw err; });
      order = await client.order(symbol, order.orderId);
      if (isOpenOrder(order)) throw new Error('a ordem de compra continua aberta na corretora');
    }
    const qty = num(order.executedQty);
    const quote = num(order.cummulativeQuoteQty);
    if (!(qty > 0)) {
      save(p, { status: 'falhou', note: 'a compra nao executou: nao havia oferta ate o preco maximo aceito' });
      journal(p.id, 'erro', `${p.note}. Nada foi comprado.`);
      return 'fim';
    }
    const fees = await feesOf(order, f);
    Object.assign(e, { done: true, orderId: order.orderId, qty, quote, avg: quote / qty, fees });
    x.pos = qty - fees.base; // a taxa cobrada na moeda comprada diminui o que ficou em carteira
    // Perda se o stop executar exatamente no preco dele, com a compra como ela saiu de verdade.
    x.riskAtFill = quote + fees.quote - x.pos * p.plan.stop * (1 - feePct / 100);
    save(p, { openedAt: now(), exec: x });
    journal(p.id, 'ordem', `comprado: ${qty} ${f.baseAsset} a ${e.avg.toFixed(2)} em media (${usd(quote)} ${f.quoteAsset})${qty < p.plan.qty - 1e-12 ? `, MENOS que o pedido (${p.plan.qty}): faltou oferta ate o preco maximo` : ''}. Perda ate o stop com essa compra: ${usd(x.riskAtFill)}`, { order: e });
    return 'segue';
  }

  // Coloca o stop (e o alvo) na corretora para `qty`. Nao conclui nada: quem diz se a posicao
  // esta protegida e a proxima consulta a corretora.
  async function placeProtection(p, f, qty) {
    const x = p.exec;
    const n = x.prots.length + 1;
    const withTarget = p.plan.target != null;
    const prot = {
      n, qty, stop: { cid: `ag-${x.tag}-s${n}` },
      target: withTarget ? { cid: `ag-${x.tag}-t${n}` } : null,
      list: withTarget ? `ag-${x.tag}-l${n}` : null,
    };
    x.prots.push(prot);
    save(p, { exec: x }); // a intencao fica gravada ANTES do envio
    const q = formatStep(qty, f.stepSize);
    const stop = formatStep(p.plan.stop, f.tickSize);
    try {
      if (withTarget) {
        const r = await client.ocoSell(symbol, q, { target: formatStep(p.plan.target, f.tickSize), stop, listId: prot.list, targetId: prot.target.cid, stopId: prot.stop.cid });
        for (const o of r.orders ?? []) {
          if (o.clientOrderId === prot.stop.cid) prot.stop.orderId = o.orderId;
          if (o.clientOrderId === prot.target.cid) prot.target.orderId = o.orderId;
        }
      } else {
        prot.stop.orderId = (await client.stopMarketSell(symbol, q, stop, prot.stop.cid)).orderId;
      }
      journal(p.id, 'ordem', `stop a mercado em ${stop}${withTarget ? ` e alvo em ${formatStep(p.plan.target, f.tickSize)}` : ''} enviados para ${q} ${f.baseAsset}`);
    } catch (err) {
      if (err.unknown) {
        journal(p.id, 'erro', `sem resposta ao colocar o stop (${err.message}); conferindo na corretora`);
      } else {
        prot.rejected = err.message;
        prot.stop.absent = true;
        if (prot.target) prot.target.absent = true;
        journal(p.id, 'erro', `a corretora recusou o stop: ${err.message}`);
      }
    }
    save(p, { exec: x });
  }

  async function cancelOpen(p, open) {
    const lists = new Set();
    for (const r of open) {
      try {
        if (r.prot?.list) {
          if (lists.has(r.prot.list)) continue;
          lists.add(r.prot.list);
          await client.cancelList(symbol, r.prot.list);
        } else {
          await client.cancel(symbol, r.o.orderId);
        }
      } catch (err) {
        if (err.code !== -2011) throw err; // -2011: a ordem ja nao estava aberta
      }
    }
    journal(p.id, 'ordem', 'ordens paradas (stop/alvo) canceladas na corretora');
  }

  // Fecha a conta de uma operacao que terminou.
  async function finalize(p, f, sells, bid) {
    const x = p.exec;
    let got = 0;
    let feeQuote = 0;
    let qty = 0;
    const feeOther = { ...x.entry.fees.other };
    const by = {};
    for (const r of sells) {
      const q = num(r.o.executedQty);
      if (!(q > 0)) continue;
      const fees = await feesOf(r.o, f);
      got += num(r.o.cummulativeQuoteQty);
      feeQuote += fees.quote;
      qty += q;
      for (const [asset, v] of Object.entries(fees.other)) feeOther[asset] = (feeOther[asset] ?? 0) + v;
      by[r.role] = (by[r.role] ?? 0) + q;
    }
    // O que sobrou sem vender (menos que o minimo da corretora) continua na conta: entra no
    // resultado pelo preco da saida, e fica anotado a parte.
    const dustQty = Math.max(0, x.pos - qty);
    const mark = qty > 0 ? got / qty : bid;
    const net = got - feeQuote - x.entry.quote - x.entry.fees.quote + dustQty * mark;
    const kind = Object.entries(by).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'poeira';
    x.sold = qty;
    x.result = {
      exitQty: qty, exitQuote: got, exitAvg: qty > 0 ? got / qty : null, feeQuote, feeOther, dustQty, dustValue: dustQty * mark,
      net, r: p.plan.maxLoss > 0 ? net / p.plan.maxLoss : null,
    };
    save(p, { status: 'fechada', closedAt: now(), exitKind: kind, net, note: null, exec: x });
    const extra = Object.keys(feeOther).length ? ` (fora taxas pagas em ${Object.keys(feeOther).join(', ')}, nao convertidas)` : '';
    journal(p.id, 'resultado', `operacao encerrada por ${kind}: resultado liquido ${signed(net)} ${f.quoteAsset}${extra}; planejado perder no maximo ${usd(p.plan.maxLoss)}`, x.result);
  }

  // Um passo em direcao a um estado estavel. Devolve true quando chegou la.
  async function settlePosition(p, f) {
    const x = p.exec;
    // 1. O que existe na corretora: todas as ordens de venda que ja tentamos colocar.
    const sells = [];
    for (const prot of x.prots) {
      const s = await lookup(prot.stop);
      if (s) sells.push({ role: 'stop', o: s, prot });
      if (prot.target) {
        const t = await lookup(prot.target);
        if (t) sells.push({ role: 'alvo', o: t, prot });
      }
    }
    for (const ex of x.exits) {
      const o = await lookup(ex);
      if (o) sells.push({ role: ex.reason, o });
    }
    x.sold = sells.reduce((s, r) => s + num(r.o.executedQty), 0);
    const leftQty = floorToStep(x.pos - x.sold, f.stepSize); // o que ainda da para vender
    const open = sells.filter((r) => isOpenOrder(r.o));
    const liveStop = open.find((r) => r.role === 'stop');

    // 2. Protegida: ha um stop vivo na corretora cobrindo o que resta, e ninguem mandou sair.
    if (!x.wantClose && liveStop && num(liveStop.o.origQty) - num(liveStop.o.executedQty) >= leftQty - 1e-12) {
      if (p.status !== 'aberta') {
        save(p, { status: 'aberta', note: null, exec: x });
        journal(p.id, 'sistema', 'posicao aberta e protegida: o stop esta parado na corretora');
      }
      return true;
    }
    // Daqui para baixo ja se sabe que o que resta da posicao NAO tem stop vivo na corretora
    // (ou que e para sair). Se algo falhar a partir daqui, a operacao nao pode continuar
    // aparecendo como protegida (ver `settle`).
    p.unprotected = true;

    // 3. Sobrou so poeira (menos que o minimo que a corretora aceita vender): terminou.
    const bid = num((await client.bookTicker(symbol)).bidPrice);
    if (!(leftQty >= num(f.minQty)) || leftQty * bid < num(f.minNotional)) {
      if (open.length) {
        await cancelOpen(p, open);
        return false;
      }
      await finalize(p, f, sells, bid);
      return true;
    }

    // 4. Ha posicao sem stop vivo. Coloca o stop; se nao for possivel, sai a mercado.
    if (!x.wantClose) {
      const last = x.prots.at(-1);
      const neverArrived = last && last.stop.absent && !last.rejected;
      if (!last || (neverArrived && x.prots.length < 2)) {
        await placeProtection(p, f, leftQty);
        return false; // olha de novo: so vale o que a corretora confirmar
      }
      x.wantClose = 'emergencia';
      x.exitTries = 0;
      const why = last.rejected ? 'a corretora recusou o stop' : neverArrived ? 'nao foi possivel colocar o stop' : 'o stop nao esta mais na corretora (cancelado ou expirado)';
      save(p, { status: 'fechando', exec: x });
      journal(p.id, 'erro', `${why}. Posicao nao fica sem stop: saindo a mercado.`);
      return false;
    }

    // 5. Saida (mandada pelo Bruno ou de emergencia): tira as ordens paradas e vende a mercado.
    if (p.status !== 'fechando' && p.status !== 'atencao') save(p, { status: 'fechando', exec: x });
    if (open.length) {
      await cancelOpen(p, open);
      return false;
    }
    if (x.exitTries >= 3) throw new Error(`nao foi possivel vender a posicao: ${x.exitError}`);
    const ex = { cid: `ag-${x.tag}-x${x.exits.length + 1}`, reason: x.wantClose };
    x.exits.push(ex);
    save(p, { exec: x }); // a intencao fica gravada ANTES do envio
    journal(p.id, 'ordem', `venda a mercado enviada (${x.wantClose}): ${formatStep(leftQty, f.stepSize)} ${f.baseAsset}`);
    try {
      ex.orderId = (await client.marketSell(symbol, formatStep(leftQty, f.stepSize), ex.cid)).orderId;
    } catch (err) {
      if (err.unknown) {
        journal(p.id, 'erro', `sem resposta ao enviar a venda (${err.message}); conferindo na corretora`);
      } else {
        ex.absent = true;
        x.exitTries++;
        x.exitError = err.message;
        journal(p.id, 'erro', `a corretora recusou a venda: ${err.message}`);
      }
    }
    save(p, { exec: x });
    return false;
  }

  // Leva uma operacao ate um estado estavel, olhando o que existe NA CORRETORA. Pode ser
  // chamada quantas vezes for preciso: depois de aprovar, a cada poucos segundos, depois de
  // uma queda. Nunca repete uma ordem que ja chegou.
  async function settle(p) {
    const x = p.exec;
    const was = p.status;
    const before = JSON.stringify(x);
    p.unprotected = false; // so vale para esta chamada; nao vai para o banco
    try {
      const f = await getFilters();
      if (!x.entry.done && (await settleEntry(p, f)) === 'fim') return;
      for (let i = 0; i < 12; i++) {
        if (await settlePosition(p, f)) {
          if (x.misses) {
            if (x.misses >= 3) journal(p.id, 'sistema', 'o contato com a corretora voltou');
            x.misses = 0;
          }
          if (was === 'atencao' && p.status !== 'atencao') journal(p.id, 'sistema', `situacao resolvida: a operacao esta ${p.status}`);
          if (JSON.stringify(x) !== before) save(p, { exec: x }); // so grava se algo mudou
          demoError = null;
          return;
        }
      }
      throw new Error('a operacao nao chegou a um estado estavel na corretora');
    } catch (err) {
      demoError = err.message;
      if (p.status === 'aberta' && !p.unprotected) {
        // Nao deu para olhar agora; pelo que se sabe, o stop continua parado na corretora.
        x.misses = (x.misses ?? 0) + 1;
        if (x.misses === 3) journal(p.id, 'erro', `sem conseguir consultar a corretora (${err.message}). O stop continua parado la; sigo tentando.`);
        save(p, { exec: x });
      } else {
        const isNew = p.status !== 'atencao' || p.note !== err.message;
        save(p, { status: 'atencao', note: err.message, exec: x });
        if (isNew) journal(p.id, 'erro', `ATENCAO: ${err.message}. Confira a conta no Demo Mode. O agente tenta de novo sozinho.`);
      }
    }
  }

  // ---------- acompanhamento ----------

  // Chamado a cada poucos segundos: vence propostas velhas e confere as operacoes abertas.
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await exclusive(async () => {
        let changed = expireOld() > 0;
        const live = client ? db.agentByStatus(symbol, LIVE).map(hydrate) : [];
        for (const p of live) {
          const before = `${p.status}|${p.note}|${p.exec.sold}`;
          await settle(p);
          if (before !== `${p.status}|${p.note}|${p.exec.sold}`) changed = true;
        }
        // Virou o dia (UTC) com operacao aberta: registra o saldo de abertura do dia novo.
        if (live.length && dayKey(now()) !== lastDay) {
          try {
            dayNumbers((await readAccount()).equity);
            lastDay = dayKey(now());
          } catch (err) {
            demoError = err.message;
          }
        }
        if (changed) onChange();
      });
    } finally {
      ticking = false;
    }
  }

  function start(pollMs = 5000) {
    if (timer) return;
    const run = () => tick().catch((err) => log(`agente: erro no acompanhamento: ${err.message}`));
    run(); // logo ao subir: retoma o que estava em andamento
    timer = setInterval(run, pollMs);
    timer.unref();
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // ---------- o que a tela ve ----------

  // Le a conta de novo, em segundo plano, no maximo uma vez a cada 10 s.
  function refreshSoon() {
    if (!client || refreshing || now() - lastRefreshTry < 10_000) return;
    lastRefreshTry = now();
    refreshing = readAccount()
      .then((a) => { if (!limitsProblem(limits)) dayNumbers(a.equity); })
      .catch((err) => { demoError = err.message; })
      .finally(() => { refreshing = null; onChange(); });
  }

  // O que a trava de risco diria agora de uma proposta pendente. E so uma previa: o que vale
  // e a conta refeita na hora da aprovacao.
  function preview(p) {
    const problem = limitsProblem(limits);
    if (problem) return { ok: false, reasons: [problem] };
    if (!client) return { ok: false, reasons: ['faltam as chaves do Demo Mode (arquivo .env)'] };
    if (!snap || !filters) return { ok: false, reasons: [demoError ? `sem contato com o Demo Mode: ${demoError}` : 'lendo a conta no Demo Mode...'] };
    const g = gate(p, snap, dayNumbers(snap.equity, false), filters);
    return g.ok
      ? { ok: true, reasons: [], entryLimit: g.entryLimit, qty: g.qty, notional: g.notional, maxLoss: g.maxLoss, maxLossPct: (g.maxLoss / snap.equity) * 100, limitedBy: g.limitedBy, stop: g.stop, target: g.target, at: snap.at }
      : { ok: false, reasons: g.reasons, at: snap.at };
  }

  function view(p) {
    const x = p.exec;
    const out = {
      id: p.id, createdAt: p.createdAt, source: p.source, side: p.side, refPrice: p.refPrice, stop: p.stop, target: p.target,
      reason: p.reason, status: p.status, decidedAt: p.decidedAt, note: p.note, openedAt: p.openedAt, closedAt: p.closedAt,
      exitKind: p.exitKind, net: p.net, plan: p.plan,
    };
    if (p.status === 'pendente') {
      out.expiresAt = p.createdAt + ttlMs;
      out.preview = preview(p);
    }
    if (x?.entry?.done) {
      out.entry = { qty: x.entry.qty, avg: x.entry.avg, quote: x.entry.quote, fees: x.entry.fees };
      out.position = { qty: x.pos, sold: x.sold ?? 0 };
      out.riskAtFill = x.riskAtFill;
      if (LIVE.includes(p.status) && snap) {
        // Estimativa: se vendesse agora o que resta, pelo preco de compra do livro, ja com a taxa.
        const left = x.pos - (x.sold ?? 0);
        out.unrealized = left * snap.bid * (1 - feePct / 100) - (x.entry.quote + x.entry.fees.quote) * (left / x.pos);
        out.priceNow = snap.bid;
      }
    }
    if (x?.result) out.result = x.result;
    return out;
  }

  function state() {
    refreshSoon();
    const key = dayKey(now());
    const from = Date.parse(`${key}T00:00:00Z`);
    const today = db.agentDayStats(symbol, from, from + DAY);
    const startEquity = db.agentDayGet(symbol, key);
    const problem = limitsProblem(limits);
    return {
      symbol, time: now(),
      limits: {
        maxLossPerTradePct: limits?.maxLossPerTradePct ?? null, maxLossPerDayPct: limits?.maxLossPerDayPct ?? null,
        maxPositionPct: limits?.maxPositionPct ?? null, maxTradesPerDay: limits?.maxTradesPerDay ?? null, problem,
      },
      demo: { keys: !!client, url: client?.origin ?? null, error: demoError, readAt: snap?.at ?? null },
      account: snap,
      day: {
        key, startEquity, realized: today.realized, trades: today.opened,
        lossLimit: problem || startEquity === null ? null : (startEquity * limits.maxLossPerDayPct) / 100,
      },
      settings: { feePct, ttlMin: ttlMs / 60_000, maxSlipPct },
      proposals: db.agentList(symbol, 200).map((row) => view(hydrate(row))),
      stats: agentStats(db.agentClosed(symbol).map((row) => ({ net: row.net, r: row.exec ? JSON.parse(row.exec).result?.r : null }))),
      log: db.agentLog(300),
    };
  }

  return { propose, approve, reject, close, retry, tick, start, stop, state };
}

// ---------- rotas HTTP ----------
// Devolve true se a rota era do agente. A rota de propor so repassa stop, alvo e motivo: o
// estado da proposta e quem propos nao vem de quem chama.
export async function handleAgent(req, res, url, { agent, json }) {
  if (!url.pathname.startsWith('/api/agent/')) return false;
  if (!agent) {
    json(res, 503, { error: 'o agente ainda nao foi iniciado' });
    return true;
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/agent/state') {
      json(res, 200, agent.state());
      return true;
    }
    if (req.method === 'POST') {
      if (!isJson(req)) {
        json(res, 415, { error: 'envie JSON (content-type: application/json)' });
        return true;
      }
      const body = await readJson(req);
      const id = Number(body.id);
      if (url.pathname === '/api/agent/propose') agent.propose({ stop: body.stop, target: body.target, reason: body.reason, source: 'manual' });
      else if (url.pathname === '/api/agent/approve') await agent.approve(id);
      else if (url.pathname === '/api/agent/reject') await agent.reject(id, body.note);
      else if (url.pathname === '/api/agent/close') await agent.close(id);
      else if (url.pathname === '/api/agent/retry') await agent.retry(id);
      else {
        json(res, 404, { error: 'rota do agente desconhecida' });
        return true;
      }
      json(res, 200, agent.state());
      return true;
    }
    json(res, 404, { error: 'rota do agente desconhecida' });
  } catch (err) {
    json(res, err.status ?? 400, { error: String(err?.message || err) });
  }
  return true;
}
