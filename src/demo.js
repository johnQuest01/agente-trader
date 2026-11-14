// Fase 5: cliente do Demo Mode da Binance (conta de demonstracao, sem dinheiro real).
//
// E o UNICO lugar do projeto que assina pedidos com chave de API. Tres travas ficam aqui:
//   1. Pedido assinado so vai para o endereco do Demo Mode (ou para um servidor de teste nesta
//      mesma maquina). O endereco da Binance de verdade nao esta na lista, de proposito: nem
//      com a chave errada no .env este codigo manda ordem para a conta real.
//   2. Nenhum pedido segue redirecionamento: se a resposta mandar ir para outro endereco, o
//      pedido falha em vez de ir.
//   3. As chaves vem so do arquivo .env (BINANCE_DEMO_KEY e BINANCE_DEMO_SECRET), que nao vai
//      para o GitHub. Elas nunca sao escritas em log, em mensagem de erro nem enviadas para a tela.
//
// O Demo Mode tem livro de ofertas proprio: os precos acompanham o mercado de verdade, mas nao
// sao iguais (medido em 14/11/2026: diferencas de alguns dolares no BTCUSDT). Por isso o preco
// usado para dimensionar e enviar uma ordem vem sempre daqui (`bookTicker`), e nao do coletor.
import { createHmac } from 'node:crypto';

export const DEMO_URL = 'https://demo-api.binance.com';

export function assertDemoUrl(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { throw new Error(`endereco invalido: ${baseUrl}`); }
  const localTest = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (u.origin !== DEMO_URL && !localTest) {
    throw new Error(`endereco nao permitido para ordens: ${u.origin}. Este projeto so opera no Demo Mode (${DEMO_URL}).`);
  }
  return u.origin;
}

// Assinatura que a Binance exige: HMAC-SHA256 do texto dos parametros, com o segredo da chave.
export function sign(secret, query) {
  return createHmac('sha256', secret).update(query).digest('hex');
}

// Um pedido HTTP. Os erros saem de dois tipos, e quem manda ordem precisa saber qual:
//   - recusa clara (a corretora respondeu que nao fez): `err.unknown` e false;
//   - sem resposta, ou erro 5xx: NAO da para saber se o pedido foi executado. `err.unknown` e
//     true, e quem chamou tem que perguntar a corretora antes de tentar de novo.
// O texto do erro leva a mensagem da corretora; nunca o endereco completo (que tem a
// assinatura) nem a chave.
async function call(origin, method, path, query, headers = {}) {
  let res;
  try {
    res = await fetch(`${origin}${path}${query ? `?${query}` : ''}`, {
      method, headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
  } catch (cause) {
    const err = new Error(`sem resposta do Demo Mode (${cause?.cause?.code ?? cause?.name ?? 'erro de rede'})`);
    err.unknown = true;
    throw err;
  }
  let body = null;
  try { body = await res.json(); } catch { /* resposta que nao e JSON */ }
  if (!res.ok) {
    const err = new Error(`Demo Mode recusou (${res.status}${body?.code ? `, codigo ${body.code}` : ''}): ${body?.msg ?? 'sem mensagem'}`);
    err.status = res.status;
    err.code = body?.code;
    err.unknown = res.status >= 500;
    throw err;
  }
  if (body === null) {
    const err = new Error('o Demo Mode respondeu algo que nao deu para ler');
    err.unknown = true;
    throw err;
  }
  return body;
}

const encode = (params) => new URLSearchParams(
  Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]),
).toString();

// Regras do par na corretora (passo de quantidade, passo de preco, valor minimo). Rota publica.
export async function fetchFilters(symbol, baseUrl = DEMO_URL) {
  const origin = assertDemoUrl(baseUrl);
  const info = (await call(origin, 'GET', '/api/v3/exchangeInfo', encode({ symbol }))).symbols?.[0];
  if (!info) throw new Error(`par ${symbol} nao existe no Demo Mode`);
  const f = (type) => info.filters?.find((x) => x.filterType === type) ?? {};
  return {
    status: info.status, baseAsset: info.baseAsset, quoteAsset: info.quoteAsset,
    orderTypes: info.orderTypes ?? [], ocoAllowed: !!info.ocoAllowed,
    stepSize: f('LOT_SIZE').stepSize, minQty: f('LOT_SIZE').minQty,
    tickSize: f('PRICE_FILTER').tickSize,
    minNotional: f('NOTIONAL').minNotional ?? f('MIN_NOTIONAL').minNotional,
    // Ate onde o preco de uma venda pode ficar do preco medio recente (multiplicadores).
    sellPriceDown: Number(f('PERCENT_PRICE_BY_SIDE').askMultiplierDown) || null,
    sellPriceUp: Number(f('PERCENT_PRICE_BY_SIDE').askMultiplierUp) || null,
  };
}

// Uma ordem e apontada pelo numero que a corretora deu (orderId) ou pelo nome que nos demos
// a ela antes de enviar ({ clientId }). O nome e o que permite perguntar "essa ordem chegou?".
const orderRef = (r) => (r !== null && typeof r === 'object' ? { origClientOrderId: r.clientId } : { orderId: r });

export function createDemoClient({ apiKey, apiSecret, baseUrl = DEMO_URL, now = Date.now } = {}) {
  const origin = assertDemoUrl(baseUrl);
  if (!apiKey || !apiSecret) throw new Error('faltam as chaves do Demo Mode: preencha BINANCE_DEMO_KEY e BINANCE_DEMO_SECRET no arquivo .env');
  let offset = 0; // quanto o relogio da corretora esta a frente do nosso, em ms

  const open = (method, path, params = {}) => call(origin, method, path, encode(params));

  // O horario do pedido tem que bater com o relogio da corretora (tolerancia de 5 s).
  async function syncTime() {
    const before = now();
    const { serverTime } = await open('GET', '/api/v3/time');
    offset = serverTime - (before + now()) / 2;
    return offset;
  }

  async function signed(method, path, params = {}, retry = true) {
    let query = encode(params);
    query += `${query ? '&' : ''}recvWindow=5000&timestamp=${Math.round(now() + offset)}`;
    query += `&signature=${sign(apiSecret, query)}`;
    try {
      return await call(origin, method, path, query, { 'X-MBX-APIKEY': apiKey });
    } catch (err) {
      // -1021: o horario do pedido nao bate com o relogio da corretora. O pedido foi recusado
      // antes de ser processado, entao da para acertar o relogio e repetir uma unica vez.
      if (err.code === -1021 && retry) {
        await syncTime();
        return signed(method, path, params, false);
      }
      throw err;
    }
  }

  return {
    origin,
    syncTime,
    // ----- consultas -----
    filters: (symbol) => fetchFilters(symbol, origin),
    bookTicker: (symbol) => open('GET', '/api/v3/ticker/bookTicker', { symbol }), // melhor compra e venda
    account: () => signed('GET', '/api/v3/account', { omitZeroBalances: true }),
    openOrders: (symbol) => signed('GET', '/api/v3/openOrders', { symbol }),
    order: (symbol, ref) => signed('GET', '/api/v3/order', { symbol, ...orderRef(ref) }),
    myTrades: (symbol, orderId) => signed('GET', '/api/v3/myTrades', { symbol, orderId }), // execucoes e taxas de uma ordem
    // ----- ordens -----
    // Compra com preco maximo: executa na hora o que houver ate `price` e cancela o resto.
    // E o que limita a derrapagem na entrada (uma ordem a mercado aceitaria qualquer preco).
    limitBuyIoc: (symbol, quantity, price, clientId) => signed('POST', '/api/v3/order', {
      symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'IOC', quantity, price, newClientOrderId: clientId, newOrderRespType: 'FULL',
    }),
    marketSell: (symbol, quantity, clientId) => signed('POST', '/api/v3/order', {
      symbol, side: 'SELL', type: 'MARKET', quantity, newClientOrderId: clientId, newOrderRespType: 'FULL',
    }),
    // Stop de venda A MERCADO: quando o preco cai ate `stopPrice`, vende pelo que houver. Garante
    // a saida (o preco pode sair pior que o stop); um stop com preco limite poderia nao executar
    // numa queda rapida e deixar a posicao aberta.
    stopMarketSell: (symbol, quantity, stopPrice, clientId) => signed('POST', '/api/v3/order', {
      symbol, side: 'SELL', type: 'STOP_LOSS', quantity, stopPrice, newClientOrderId: clientId,
    }),
    // Stop e alvo juntos (OCO): duas ordens de venda paradas na corretora; quando uma executa,
    // a outra e cancelada. Alvo = venda limitada acima do preco; stop = venda a mercado abaixo.
    ocoSell: (symbol, quantity, { target, stop, listId, targetId, stopId }) => signed('POST', '/api/v3/orderList/oco', {
      symbol, side: 'SELL', quantity,
      aboveType: 'LIMIT_MAKER', abovePrice: target, aboveClientOrderId: targetId,
      belowType: 'STOP_LOSS', belowStopPrice: stop, belowClientOrderId: stopId,
      listClientOrderId: listId, newOrderRespType: 'RESULT',
    }),
    cancel: (symbol, ref) => signed('DELETE', '/api/v3/order', { symbol, ...orderRef(ref) }),
    cancelList: (symbol, listId) => signed('DELETE', '/api/v3/orderList', { symbol, listClientOrderId: listId }),
  };
}
