// Corretora de mentira para os testes da fase 5 (scripts/testar-demo.js e scripts/testar-agente.js).
// Roda dentro do proprio teste, em 127.0.0.1: nada sai desta maquina.
//
// Imita o que o projeto usa da Binance: confere chave, assinatura e horario de cada pedido;
// guarda saldos, ordens e listas de ordens (OCO); executa as ordens paradas quando o teste muda
// o preco; e deixa o teste provocar falhas (recusa, queda da conexao antes ou depois de executar).
//
// E uma imitacao: o que a Binance faz de verdade em cada caso so se confirma no Demo Mode real.
import http from 'node:http';
import { createHmac } from 'node:crypto';

const r8 = (x) => Math.round(x * 1e8) / 1e8;
const s8 = (x) => Number(x).toFixed(8);
const isOpen = (o) => o.status === 'NEW' || o.status === 'PARTIALLY_FILLED';
const multiple = (x, step) => Math.abs(x / step - Math.round(x / step)) < 1e-6;
const STEP = 0.00001, TICK = 0.01, MIN_NOTIONAL = 5;

export async function startMockExchange({
  key = 'chave-de-teste', secret = 'segredo-de-teste', symbol = 'BTCUSDT', base = 'BTC', quote = 'USDT',
  balances = { USDT: 10_000 }, bid = 100, ask = 100.01, feePct = 0.1, feeInBase = true,
} = {}) {
  const S = {
    bid, ask,
    clockAhead: 0,       // quanto o relogio da corretora esta a frente do nosso, em ms
    maxFill: Infinity,   // quanto uma compra consegue executar (para simular pouca oferta)
    balances: new Map(Object.entries(balances).map(([a, v]) => [a, { free: v, locked: 0 }])),
    orders: [], trades: [], lists: [], requests: [], failures: [],
  };
  let nextOrder = 1000, nextTrade = 1, nextList = 1;
  const bal = (asset) => {
    if (!S.balances.has(asset)) S.balances.set(asset, { free: 0, locked: 0 });
    return S.balances.get(asset);
  };

  const viewOrder = (o) => ({
    symbol, orderId: o.orderId, orderListId: o.orderListId, clientOrderId: o.clientOrderId,
    price: s8(o.price), origQty: s8(o.origQty), executedQty: s8(o.executedQty), cummulativeQuoteQty: s8(o.quoteQty),
    status: o.status, timeInForce: o.timeInForce ?? 'GTC', type: o.type, side: o.side, stopPrice: s8(o.stopPrice),
    time: o.time, updateTime: o.updateTime,
  });
  const viewTrade = (t) => ({
    symbol, id: t.id, orderId: t.orderId, price: s8(t.price), qty: s8(t.qty), quoteQty: s8(t.quoteQty),
    commission: s8(t.commission), commissionAsset: t.commissionAsset, time: t.time, isBuyer: t.isBuyer, isMaker: t.isMaker,
  });
  const viewFill = (t) => ({ price: s8(t.price), qty: s8(t.qty), commission: s8(t.commission), commissionAsset: t.commissionAsset, tradeId: t.id });
  const newOrder = (fields) => ({
    orderId: nextOrder++, orderListId: -1, clientOrderId: `auto-${nextOrder}`, executedQty: 0, quoteQty: 0, price: 0, stopPrice: 0,
    status: 'NEW', time: Date.now(), updateTime: Date.now(), locked: 0, ...fields,
  });

  // Executa `qty` de uma ordem ao preco dado: mexe nos saldos, cobra a taxa e grava o negocio.
  // Na compra a taxa sai da moeda comprada (como na Binance sem desconto) ou do USDT, conforme
  // `feeInBase`; na venda, sempre do USDT recebido.
  function fill(o, qty, price) {
    const quoteAmt = r8(qty * price);
    const t = { id: nextTrade++, orderId: o.orderId, price, qty, quoteQty: quoteAmt, time: Date.now(), isBuyer: o.side === 'BUY', isMaker: o.type === 'LIMIT_MAKER' };
    if (o.side === 'BUY') {
      t.commission = r8(((feeInBase ? qty : quoteAmt) * feePct) / 100);
      t.commissionAsset = feeInBase ? base : quote;
      bal(quote).free = r8(bal(quote).free - quoteAmt - (feeInBase ? 0 : t.commission));
      bal(base).free = r8(bal(base).free + qty - (feeInBase ? t.commission : 0));
    } else {
      t.commission = r8((quoteAmt * feePct) / 100);
      t.commissionAsset = quote;
      bal(quote).free = r8(bal(quote).free + quoteAmt - t.commission);
      // a moeda vendida ja saiu do saldo: do livre (venda a mercado) ou do travado (ordem parada)
    }
    o.executedQty = r8(o.executedQty + qty);
    o.quoteQty = r8(o.quoteQty + quoteAmt);
    o.status = o.executedQty >= o.origQty - 1e-10 ? 'FILLED' : 'PARTIALLY_FILLED';
    o.updateTime = Date.now();
    S.trades.push(t);
    return t;
  }

  // Ordens de venda paradas travam a moeda. Numa lista (OCO) a quantidade e travada uma vez so.
  const holderOf = (o) => (o.orderListId === -1 ? o : S.lists.find((l) => l.orderListId === o.orderListId));
  function lock(holder, qty) {
    bal(base).free = r8(bal(base).free - qty);
    bal(base).locked = r8(bal(base).locked + qty);
    holder.locked = qty;
  }
  function release(holder) {
    bal(base).locked = r8(bal(base).locked - holder.locked);
    bal(base).free = r8(bal(base).free + holder.locked);
    holder.locked = 0;
  }
  function execResting(o, qty, price) {
    const h = holderOf(o);
    h.locked = r8(h.locked - qty);
    bal(base).locked = r8(bal(base).locked - qty);
    fill(o, qty, price);
    if (o.status === 'FILLED' && o.orderListId !== -1) {
      for (const x of h.orders) if (x !== o && isOpen(x)) { x.status = 'EXPIRED'; x.updateTime = Date.now(); }
      h.status = 'ALL_DONE';
    }
  }
  function cancelOrder(o) {
    const l = o.orderListId === -1 ? null : holderOf(o);
    for (const x of l ? l.orders : [o]) if (isOpen(x)) { x.status = 'CANCELED'; x.updateTime = Date.now(); }
    release(l ?? o);
    if (l) l.status = 'ALL_DONE';
  }

  // O teste muda o preco; as ordens paradas que o preco alcancou executam.
  function setPrice(newBid, newAsk = r8(newBid + TICK)) {
    S.bid = newBid;
    S.ask = newAsk;
    for (const o of [...S.orders]) {
      if (!isOpen(o) || o.side !== 'SELL') continue;
      const left = r8(o.origQty - o.executedQty);
      if (o.type === 'STOP_LOSS' && newBid <= o.stopPrice) execResting(o, left, newBid); // a mercado: sai pelo preco que houver
      else if (o.type === 'LIMIT_MAKER' && newBid >= o.price) execResting(o, left, o.price);
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = Object.fromEntries(url.searchParams);
    const route = `${req.method} ${url.pathname}`;
    const nowEx = Date.now() + S.clockAhead;
    let dropAfter = false;
    let fail500 = false;
    const send = (code, body) => {
      if (dropAfter) return req.socket.destroy(); // executou, mas a resposta se perde no caminho
      if (fail500 && code === 200) { code = 500; body = { code: -1000, msg: 'An unknown error occurred while processing the request.' }; }
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const fail = (code, msg, status = 400) => send(status, { code, msg });

    S.requests.push({ method: req.method, path: url.pathname, ...p });

    // Falhas provocadas pelo teste.
    const f = S.failures.find((x) => x.times > 0 && x.when({ method: req.method, path: url.pathname, ...p }));
    if (f) {
      f.times--;
      if (f.mode === 'recusar') return fail(f.code ?? -2010, f.msg ?? 'recusa provocada pelo teste');
      if (f.mode === 'cair-antes') return req.socket.destroy(); // o pedido nem chega a ser processado
      if (f.mode === 'redirecionar') { res.writeHead(307, { location: f.to }); return res.end(); }
      if (f.mode === 'cair-depois') dropAfter = true;
      if (f.mode === 'erro500-depois') fail500 = true;
    }

    // ---------- rotas publicas ----------
    if (route === 'GET /api/v3/time') return send(200, { serverTime: nowEx });
    if (route === 'GET /api/v3/ticker/bookTicker') return send(200, { symbol, bidPrice: s8(S.bid), bidQty: '1.00000000', askPrice: s8(S.ask), askQty: '1.00000000' });
    if (route === 'GET /api/v3/exchangeInfo') {
      return send(200, { symbols: [{
        symbol, status: 'TRADING', baseAsset: base, quoteAsset: quote, ocoAllowed: true,
        orderTypes: ['LIMIT', 'LIMIT_MAKER', 'MARKET', 'STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT'],
        filters: [
          { filterType: 'PRICE_FILTER', tickSize: s8(TICK) },
          { filterType: 'LOT_SIZE', minQty: s8(STEP), stepSize: s8(STEP) },
          { filterType: 'PERCENT_PRICE_BY_SIDE', bidMultiplierUp: '1.2', bidMultiplierDown: '0.5', askMultiplierUp: '2', askMultiplierDown: '0.8' },
          { filterType: 'NOTIONAL', minNotional: s8(MIN_NOTIONAL) },
        ],
      }] });
    }

    // ---------- daqui para baixo, tudo e assinado ----------
    if (req.headers['x-mbx-apikey'] !== key) return fail(-2015, 'Invalid API-key, IP, or permissions for action.', 401);
    const raw = url.search.slice(1);
    const cut = raw.lastIndexOf('&signature=');
    if (cut < 0) return fail(-1102, "Mandatory parameter 'signature' was not sent, was empty/null, or malformed.");
    if (raw.slice(cut + 11) !== createHmac('sha256', secret).update(raw.slice(0, cut)).digest('hex')) return fail(-1022, 'Signature for this request is not valid.');
    if (Math.abs(nowEx - Number(p.timestamp)) > Number(p.recvWindow || 5000)) return fail(-1021, 'Timestamp for this request is outside of the recvWindow.');

    if (route === 'GET /api/v3/account') {
      return send(200, { canTrade: true, balances: [...S.balances].filter(([, b]) => b.free || b.locked).map(([asset, b]) => ({ asset, free: s8(b.free), locked: s8(b.locked) })) });
    }
    if (route === 'GET /api/v3/openOrders') return send(200, S.orders.filter(isOpen).map(viewOrder));
    if (route === 'GET /api/v3/myTrades') return send(200, S.trades.filter((t) => t.orderId === Number(p.orderId)).map(viewTrade));

    const findOrder = () => S.orders.findLast((o) => (p.orderId !== undefined ? o.orderId === Number(p.orderId) : o.clientOrderId === p.origClientOrderId));
    if (route === 'GET /api/v3/order') {
      const o = findOrder();
      return o ? send(200, viewOrder(o)) : fail(-2013, 'Order does not exist.');
    }
    if (route === 'DELETE /api/v3/order') {
      const o = findOrder();
      if (!o || !isOpen(o)) return fail(-2011, 'Unknown order sent.');
      cancelOrder(o); // cancelar uma ordem de uma lista cancela a lista inteira
      return send(200, viewOrder(o));
    }
    if (route === 'DELETE /api/v3/orderList') {
      const l = S.lists.find((x) => (p.orderListId !== undefined ? x.orderListId === Number(p.orderListId) : x.listClientOrderId === p.listClientOrderId));
      if (!l || l.status === 'ALL_DONE') return fail(-2011, 'Unknown order sent.');
      cancelOrder(l.orders[0]);
      return send(200, { orderListId: l.orderListId, listOrderStatus: 'ALL_DONE', listClientOrderId: l.listClientOrderId, orderReports: l.orders.map(viewOrder) });
    }

    if (route === 'POST /api/v3/order') {
      const qty = Number(p.quantity);
      if (p.symbol !== symbol) return fail(-1121, 'Invalid symbol.');
      if (!(qty >= STEP) || !multiple(qty, STEP)) return fail(-1013, 'Filter failure: LOT_SIZE');
      if (S.orders.some((o) => isOpen(o) && o.clientOrderId === p.newClientOrderId)) return fail(-2010, 'Duplicate order sent.');
      const o = newOrder({ side: p.side, type: p.type, timeInForce: p.timeInForce, origQty: qty, price: Number(p.price) || 0, stopPrice: Number(p.stopPrice) || 0 });
      if (p.newClientOrderId) o.clientOrderId = p.newClientOrderId;

      if (p.side === 'BUY' && p.type === 'LIMIT' && p.timeInForce === 'IOC') {
        if (!multiple(o.price, TICK)) return fail(-1013, 'Filter failure: PRICE_FILTER');
        if (qty * o.price < MIN_NOTIONAL) return fail(-1013, 'Filter failure: NOTIONAL');
        if (bal(quote).free < qty * o.price - 1e-9) return fail(-2010, 'Account has insufficient balance for requested action.');
        S.orders.push(o);
        const fills = [];
        const can = r8(Math.min(qty, S.maxFill));
        if (o.price >= S.ask && can > 0) fills.push(fill(o, can, S.ask));
        if (o.status !== 'FILLED') o.status = 'EXPIRED'; // o que nao executou na hora e cancelado
        return send(200, { ...viewOrder(o), transactTime: o.time, fills: fills.map(viewFill) });
      }
      if (p.side === 'SELL' && p.type === 'MARKET') {
        if (qty * S.bid < MIN_NOTIONAL) return fail(-1013, 'Filter failure: NOTIONAL');
        if (bal(base).free < qty - 1e-12) return fail(-2010, 'Account has insufficient balance for requested action.');
        S.orders.push(o);
        bal(base).free = r8(bal(base).free - qty);
        const t = fill(o, qty, S.bid);
        return send(200, { ...viewOrder(o), transactTime: o.time, fills: [viewFill(t)] });
      }
      if (p.side === 'SELL' && p.type === 'STOP_LOSS') {
        if (!multiple(o.stopPrice, TICK)) return fail(-1013, 'Filter failure: PRICE_FILTER');
        if (o.stopPrice >= S.bid) return fail(-2010, 'Stop price would trigger immediately.');
        if (qty * o.stopPrice < MIN_NOTIONAL) return fail(-1013, 'Filter failure: NOTIONAL');
        if (bal(base).free < qty - 1e-12) return fail(-2010, 'Account has insufficient balance for requested action.');
        lock(o, qty);
        S.orders.push(o);
        return send(200, viewOrder(o));
      }
      return fail(-1116, 'Invalid orderType.');
    }

    if (route === 'POST /api/v3/orderList/oco') {
      const qty = Number(p.quantity);
      const above = Number(p.abovePrice);
      const below = Number(p.belowStopPrice);
      if (p.side !== 'SELL' || p.aboveType !== 'LIMIT_MAKER' || p.belowType !== 'STOP_LOSS') return fail(-1013, 'lista de um tipo que a corretora de mentira nao conhece');
      if (!(qty >= STEP) || !multiple(qty, STEP)) return fail(-1013, 'Filter failure: LOT_SIZE');
      if (!multiple(above, TICK) || !multiple(below, TICK)) return fail(-1013, 'Filter failure: PRICE_FILTER');
      if (!(above > S.bid && S.bid > below)) return fail(-2010, 'The relationship of the prices for the orders is not correct.');
      if (qty * below < MIN_NOTIONAL) return fail(-1013, 'Filter failure: NOTIONAL');
      if (bal(base).free < qty - 1e-12) return fail(-2010, 'Account has insufficient balance for requested action.');
      const l = { orderListId: nextList++, listClientOrderId: p.listClientOrderId ?? `lista-${nextList}`, status: 'EXECUTING', locked: 0, orders: [] };
      l.orders.push(
        newOrder({ orderListId: l.orderListId, clientOrderId: p.belowClientOrderId, side: 'SELL', type: 'STOP_LOSS', origQty: qty, stopPrice: below }),
        newOrder({ orderListId: l.orderListId, clientOrderId: p.aboveClientOrderId, side: 'SELL', type: 'LIMIT_MAKER', origQty: qty, price: above }),
      );
      lock(l, qty);
      S.lists.push(l);
      S.orders.push(...l.orders);
      return send(200, {
        orderListId: l.orderListId, contingencyType: 'OCO', listStatusType: 'EXEC_STARTED', listOrderStatus: 'EXECUTING',
        listClientOrderId: l.listClientOrderId, transactionTime: Date.now(), symbol,
        orders: l.orders.map((o) => ({ symbol, orderId: o.orderId, clientOrderId: o.clientOrderId })),
        orderReports: l.orders.map(viewOrder),
      });
    }

    return fail(-1, 'rota que a corretora de mentira nao conhece', 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    key, secret, S, setPrice,
    // Faz o proximo pedido que casar com `when` falhar. Modos: 'recusar' (a corretora responde
    // que nao fez), 'cair-antes' (a conexao cai e nada e executado), 'cair-depois' (executa, mas
    // a resposta nao chega), 'erro500-depois' (executa e responde erro), 'redirecionar'.
    failNext: (when, mode, extra = {}) => S.failures.push({ when, mode, times: 1, ...extra }),
    // Alguem cancela a ordem por fora (pelo site da corretora, por exemplo).
    cancelOutside: (orderId) => cancelOrder(S.orders.find((o) => o.orderId === orderId)),
    // O alvo de uma lista executa so em parte e a corretora tira o stop: o pior caso para quem
    // conta com o stop.
    partialTarget: (orderId, qty) => {
      const o = S.orders.find((x) => x.orderId === orderId);
      execResting(o, qty, o.price);
      for (const x of holderOf(o).orders) if (x !== o && isOpen(x)) { x.status = 'EXPIRED'; x.updateTime = Date.now(); }
    },
    order: (ref) => S.orders.findLast((o) => o.orderId === ref || o.clientOrderId === ref),
    sent: (method, path) => S.requests.filter((r) => r.method === method && r.path === path),
    balance: (asset) => ({ ...bal(asset) }),
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}
