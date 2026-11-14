// Testa o cliente do Demo Mode (src/demo.js) contra uma corretora de mentira que roda dentro
// do proprio teste. Nao usa a internet, nao usa chave de verdade e nao manda ordem a lugar nenhum.
//
//   node scripts/testar-demo.js
//
// A corretora de mentira (scripts/lib/corretora-simulada.js) confere, como a Binance, a chave,
// a assinatura e o horario de cada pedido.

import assert from 'node:assert/strict';
import http from 'node:http';
import { sign, assertDemoUrl, createDemoClient, fetchFilters, DEMO_URL } from '../src/demo.js';
import { startMockExchange } from './lib/corretora-simulada.js';

let feitos = 0;
const caso = async (nome, fn) => { await fn(); feitos++; console.log(`ok  ${nome}`); };

const ex = await startMockExchange({ balances: { USDT: 10_000 } });
const BASE = ex.url;
const cliente = (extra = {}) => createDemoClient({ apiKey: ex.key, apiSecret: ex.secret, baseUrl: BASE, ...extra });
const ultimo = () => ex.S.requests.at(-1);

await caso('assinatura igual ao exemplo publicado na documentacao da Binance', () => {
  const segredo = 'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j';
  const texto = 'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559';
  assert.equal(sign(segredo, texto), 'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71');
});

await caso('pedido assinado so pode ir para o Demo Mode ou para um teste nesta maquina', () => {
  assert.equal(assertDemoUrl(DEMO_URL), 'https://demo-api.binance.com');
  assert.equal(assertDemoUrl(`${DEMO_URL}/api/v3/order`), 'https://demo-api.binance.com');
  assert.equal(assertDemoUrl('https://DEMO-API.BINANCE.COM'), 'https://demo-api.binance.com');
  assert.equal(assertDemoUrl(BASE), BASE);
  for (const proibido of [
    'https://api.binance.com',                       // a conta de verdade
    'https://api1.binance.com',
    'https://testnet.binance.vision',
    'http://demo-api.binance.com',                   // sem criptografia
    'https://demo-api.binance.com:8443',             // outra porta
    'https://demo-api.binance.com.exemplo.com',      // parece, mas e outro endereco
    'https://demo-api.binance.com@exemplo.com',      // o endereco de verdade e o que vem depois do @
    'https://exemplo.com/demo-api.binance.com',
    'http://localhost@exemplo.com',
    'http://127.0.0.1.exemplo.com',
    'https://127.0.0.1:8443',
    'http://192.168.0.10:3000',
    'nao-e-endereco',
  ]) assert.throws(() => assertDemoUrl(proibido), /nao permitido|invalido/, proibido);
});

await caso('nem com chaves o cliente aceita o endereco da conta de verdade', () => {
  assert.throws(() => createDemoClient({ apiKey: ex.key, apiSecret: ex.secret, baseUrl: 'https://api.binance.com' }), /so opera no Demo Mode/);
});

await caso('sem chaves o cliente nao e criado', () => {
  assert.throws(() => createDemoClient({ baseUrl: BASE }), /faltam as chaves/);
  assert.throws(() => createDemoClient({ apiKey: ex.key, baseUrl: BASE }), /faltam as chaves/);
});

await caso('consulta da conta e do preco: chave, assinatura e horario aceitos', async () => {
  const c = cliente();
  const conta = await c.account();
  assert.deepEqual(conta.balances, [{ asset: 'USDT', free: '10000.00000000', locked: '0.00000000' }]);
  assert.equal(ultimo().path, '/api/v3/account');
  const t = await c.bookTicker('BTCUSDT');
  assert.deepEqual([t.bidPrice, t.askPrice], ['100.00000000', '100.01000000']);
  assert.equal(ultimo().signature, undefined); // o preco e rota publica: vai sem assinatura
});

await caso('segredo errado e recusado, e o erro nao vaza chave, segredo nem assinatura', async () => {
  const c = cliente({ apiSecret: 'segredo-errado' });
  await assert.rejects(c.account(), (err) => {
    assert.equal(err.code, -1022);
    assert.equal(err.unknown, false);
    assert.doesNotMatch(`${err.message} ${err.stack}`, /segredo-errado|chave-de-teste|signature=/);
    return true;
  });
});

await caso('chave errada e recusada', async () => {
  await assert.rejects(cliente({ apiKey: 'outra-chave' }).account(), (err) => err.code === -2015 && err.status === 401 && err.unknown === false);
});

await caso('compra com preco maximo: parametros certos e resposta com a execucao e a taxa', async () => {
  const r = await cliente().limitBuyIoc('BTCUSDT', '1.00000', '100.06', 'teste-1');
  assert.equal(r.status, 'FILLED');
  assert.equal(r.clientOrderId, 'teste-1');
  assert.deepEqual([r.executedQty, r.cummulativeQuoteQty], ['1.00000000', '100.01000000']); // executa no preco da oferta, nao no maximo
  assert.deepEqual(r.fills.map((f) => [f.commission, f.commissionAsset]), [['0.00100000', 'BTC']]);
  const p = ex.sent('POST', '/api/v3/order').at(-1);
  assert.deepEqual([p.symbol, p.side, p.type, p.timeInForce, p.quantity, p.price, p.newOrderRespType, p.recvWindow], ['BTCUSDT', 'BUY', 'LIMIT', 'IOC', '1.00000', '100.06', 'FULL', '5000']);
});

await caso('compra com preco maximo abaixo da oferta: nao executa e nao fica parada', async () => {
  const r = await cliente().limitBuyIoc('BTCUSDT', '1.00000', '99.00', 'teste-2');
  assert.deepEqual([r.status, r.executedQty], ['EXPIRED', '0.00000000']);
  assert.equal((await cliente().openOrders('BTCUSDT')).length, 0);
});

await caso('recusa da corretora (saldo insuficiente) vira erro com o codigo dela', async () => {
  await assert.rejects(cliente().limitBuyIoc('BTCUSDT', '500.00000', '100.06', 'teste-3'), (err) => err.code === -2010 && err.unknown === false && /insufficient balance/.test(err.message));
});

await caso('stop a mercado, consulta pelo nome da ordem e cancelamento', async () => {
  const c = cliente();
  const s = await c.stopMarketSell('BTCUSDT', '0.99900', '99.00', 'teste-stop');
  assert.equal(s.status, 'NEW');
  const p = ex.sent('POST', '/api/v3/order').at(-1);
  assert.deepEqual([p.side, p.type, p.quantity, p.stopPrice, p.price], ['SELL', 'STOP_LOSS', '0.99900', '99.00', undefined]);
  assert.equal((await c.order('BTCUSDT', { clientId: 'teste-stop' })).orderId, s.orderId);
  assert.equal((await c.order('BTCUSDT', s.orderId)).clientOrderId, 'teste-stop');
  await assert.rejects(c.order('BTCUSDT', { clientId: 'nunca-existiu' }), (err) => err.code === -2013 && err.unknown === false);
  assert.equal((await c.cancel('BTCUSDT', s.orderId)).status, 'CANCELED');
  await assert.rejects(c.cancel('BTCUSDT', s.orderId), (err) => err.code === -2011);
});

await caso('stop e alvo juntos (OCO): duas ordens paradas, canceladas juntas', async () => {
  const c = cliente();
  const l = await c.ocoSell('BTCUSDT', '0.99900', { target: '103.00', stop: '99.00', listId: 'teste-l', targetId: 'teste-t', stopId: 'teste-s' });
  assert.equal(l.orders.length, 2);
  const p = ex.sent('POST', '/api/v3/orderList/oco').at(-1);
  assert.deepEqual([p.side, p.quantity, p.aboveType, p.abovePrice, p.aboveClientOrderId, p.belowType, p.belowStopPrice, p.belowClientOrderId, p.listClientOrderId],
    ['SELL', '0.99900', 'LIMIT_MAKER', '103.00', 'teste-t', 'STOP_LOSS', '99.00', 'teste-s', 'teste-l']);
  assert.equal((await c.openOrders('BTCUSDT')).length, 2);
  await c.cancelList('BTCUSDT', 'teste-l');
  assert.equal((await c.openOrders('BTCUSDT')).length, 0);
  assert.equal((await c.order('BTCUSDT', { clientId: 'teste-s' })).status, 'CANCELED');
});

await caso('venda a mercado e as taxas da ordem', async () => {
  const c = cliente();
  const v = await c.marketSell('BTCUSDT', '0.99900', 'teste-saida');
  assert.deepEqual([v.status, v.side, v.type], ['FILLED', 'SELL', 'MARKET']);
  const negocios = await c.myTrades('BTCUSDT', v.orderId);
  assert.deepEqual(negocios.map((n) => [n.qty, n.price, n.commissionAsset]), [['0.99900000', '100.00000000', 'USDT']]);
});

await caso('relogio diferente do da corretora: o cliente acerta o horario e repete sozinho', async () => {
  ex.S.clockAhead = 3 * 60_000; // a corretora esta 3 minutos a frente
  const c = cliente();
  const antes = ex.S.requests.length;
  assert.equal((await c.account()).balances.length > 0, true);
  assert.deepEqual(ex.S.requests.slice(antes).map((r) => r.path), ['/api/v3/account', '/api/v3/time', '/api/v3/account']);
  const diferenca = await c.syncTime();
  assert.ok(Math.abs(diferenca - ex.S.clockAhead) < 500, `diferenca medida: ${diferenca}`);
  ex.S.clockAhead = 0;
});

await caso('sem resposta: o erro avisa que nao da para saber se o pedido foi executado', async () => {
  const c = cliente();
  ex.failNext((r) => r.path === '/api/v3/account', 'cair-antes');
  await assert.rejects(c.account(), (err) => {
    assert.equal(err.unknown, true);
    assert.doesNotMatch(`${err.message} ${err.stack}`, /chave-de-teste|segredo-de-teste|signature=/);
    return true;
  });
  ex.failNext((r) => r.path === '/api/v3/account', 'erro500-depois');
  await assert.rejects(c.account(), (err) => err.unknown === true && err.status === 500);
  ex.failNext((r) => r.path === '/api/v3/account', 'recusar', { code: -1003, msg: 'Too many requests.' });
  await assert.rejects(c.account(), (err) => err.unknown === false && err.code === -1003);
});

await caso('redirecionamento nao e seguido: o pedido assinado nao vai para outro endereco', async () => {
  let recebidos = 0;
  const outro = http.createServer((req, res) => { recebidos++; res.end('{}'); });
  await new Promise((r) => outro.listen(0, '127.0.0.1', r));
  ex.failNext((r) => r.path === '/api/v3/account', 'redirecionar', { to: `http://127.0.0.1:${outro.address().port}/api/v3/account` });
  await assert.rejects(cliente().account(), (err) => err.unknown === true);
  assert.equal(recebidos, 0);
  outro.closeAllConnections();
  outro.close();
});

await caso('regras do par (passos, valor minimo, moedas)', async () => {
  const esperado = {
    status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', ocoAllowed: true,
    orderTypes: ['LIMIT', 'LIMIT_MAKER', 'MARKET', 'STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT'],
    stepSize: '0.00001000', minQty: '0.00001000', tickSize: '0.01000000', minNotional: '5.00000000', sellPriceDown: 0.8, sellPriceUp: 2,
  };
  assert.deepEqual(await fetchFilters('BTCUSDT', BASE), esperado);
  assert.deepEqual(await cliente().filters('BTCUSDT'), esperado);
  await assert.rejects(fetchFilters('BTCUSDT', 'https://api.binance.com'), /nao permitido/);
});

await ex.close();
console.log(`\nTODOS OS ${feitos} CASOS PASSARAM`);
