import { REST_URL, WS_URL, MINUTE } from './config.js';

const DAY = 24 * 60 * MINUTE; // o maior tempo grafico que montamos (1d)
const dayStart = (ms) => Math.floor(ms / DAY) * DAY; // 00:00 UTC do dia
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Formato REST: [openTime, open, high, low, close, volume, closeTime,
//                quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
// `closedBefore`: so marca como fechado o candle que fechou antes desse horario (ver fillSegment).
function fromRest(symbol, k, closedBefore) {
  return {
    symbol,
    openTime: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    quoteVolume: +k[7],
    trades: k[8],
    takerBuyVolume: +k[9],
    closed: k[6] < closedBefore,
  };
}

// `endTime` (opcional) limita pelo horario de abertura: so vem candle que abriu ate ali.
async function fetchKlines(symbol, startTime, endTime) {
  let url = `${REST_URL}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=1000`;
  if (endTime !== undefined) url += `&endTime=${endTime}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Binance respondeu ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Horario do servidor da Binance. O relogio do PC pode estar errado (nesta maquina ja
// estava 11 minutos atrasado), e isso fazia candles ja fechados serem gravados como abertos.
// Toda decisao "este candle ja fechou?" usa o relogio da Binance, nunca o local.
let lastWarnedOffset = null;
async function clockOffset(log) {
  const before = Date.now();
  const res = await fetch(`${REST_URL}/api/v3/time`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Binance respondeu ${res.status} em /api/v3/time`);
  const { serverTime } = await res.json();
  const after = Date.now();
  const offset = serverTime - (before + after) / 2; // ms a somar no relogio local
  // Avisa uma vez (e de novo so se o desvio mudar mais de 5 s), nao a cada reconexao.
  if (Math.abs(offset) > 30_000 && (lastWarnedOffset === null || Math.abs(offset - lastWarnedOffset) > 5_000)) {
    const s = Math.round(Math.abs(offset) / 1000);
    log(`AVISO: relogio do PC esta ${s}s ${offset > 0 ? 'atrasado' : 'adiantado'} em relacao a Binance; sincronize o relogio do Windows`);
    lastWarnedOffset = offset;
  }
  // Nao sabemos em que ponto da ida e volta a Binance leu o relogio dela, entao o horario
  // calculado pode estar errado em ate metade do tempo que a consulta levou.
  return { offset, error: (after - before) / 2 };
}

// Baixa os candles de `from` ate `to`. Com `endTime`, para exatamente ali (usado no trecho
// antigo, para nao baixar de novo o que o banco ja tem); sem ele, vai ate o candle atual.
async function fillSegment(db, symbol, from, to, closedBefore, log, endTime) {
  let cursor = from;
  let total = 0;
  while (cursor < to) {
    // O instante de referencia e tirado ANTES do pedido, nunca na chegada da resposta. A
    // resposta e uma foto tirada depois da pergunta: o candle que ja tinha fechado (com
    // folga, ver `closedBefore` em backfill) quando perguntamos veio com o dado definitivo.
    // Usando o instante da chegada, um minuto que fechasse durante a viagem seria gravado
    // como "fechado" com dados parciais, e nunca mais seria corrigido.
    const limit = closedBefore();
    const rows = await fetchKlines(symbol, cursor, endTime);
    if (!rows.length) break;
    db.upsertMany(rows.map((k) => fromRest(symbol, k, limit)));
    total += rows.length;
    cursor = rows[rows.length - 1][0] + MINUTE;
    if (total % 10_000 < rows.length) {
      log(`  historico: ${total} candles (ate ${new Date(cursor).toISOString().slice(0, 16)} UTC)`);
    }
    if (rows.length < 1000) break;
    await sleep(150); // educacao com o limite de requisicoes da Binance
  }
  return total;
}

// Folga para aceitar um candle como fechado: da tempo de a Binance terminar de consolidar o
// candle que acabou de fechar. Medido em 14/11/2026: em 1 de 4 viradas de minuto a API de
// historico ainda devolvia o candle incompleto cerca de 0,5 s depois do fechamento. O erro
// possivel do nosso relogio e somado a ela (ver backfill).
const CLOSE_SLACK = 2000;

// Baixa o historico que falta: o trecho antigo (se pediu mais dias) e o buraco ate agora.
//
// O historico comeca sempre as 00:00 UTC. Os candles de 5m, 15m, 1h, 4h e 1d sao montados a
// partir dos de 1 minuto, e todos abrem em multiplos exatos contados de 00:00 UTC. Se o banco
// comecasse no meio do dia, o primeiro candle de cada um desses tempos ficaria sem os minutos
// anteriores e apareceria como se fosse um candle inteiro (maxima, minima e volume errados).
export async function backfill(db, symbol, days, log = () => {}) {
  const { offset, error } = await clockOffset(log);
  const clock = () => Date.now() + offset;
  // So gravamos como fechado o candle que fechou antes deste horario: a hora da Binance, menos
  // o erro possivel do nosso relogio, menos a folga. O que fechou depois disso entra como
  // provisorio e e buscado de novo no fim desta funcao.
  const closedBefore = () => clock() - error - CLOSE_SLACK;
  const now = clock();
  const target = dayStart(now - days * DAY);
  const first = db.firstOpenTime(symbol);
  const last = db.lastOpenTime(symbol);
  let total = 0;
  if (first === null) {
    total += await fillSegment(db, symbol, target, now, closedBefore, log);
  } else {
    // Completa tambem o dia do primeiro candle ja gravado: um banco criado antes desta regra
    // comeca no meio do dia, e `target` avanca a cada dia que passa.
    const start = Math.min(target, dayStart(first));
    if (first > start) total += await fillSegment(db, symbol, start, first, closedBefore, log, first - 1);
    // Retoma do primeiro candle ainda marcado como aberto (ou do ultimo, se todos fecharam):
    // assim um candle gravado como provisorio e sempre refeito com o dado definitivo.
    const resume = Math.min(last, db.firstUnclosedOpenTime(symbol) ?? last);
    total += await fillSegment(db, symbol, resume, now, closedBefore, log);
  }
  // Um candle que fechou ha instantes ficou provisorio por causa da folga. Espera a folga passar
  // e busca de novo, para que ao sair daqui so o candle do minuto atual esteja em aberto.
  for (let i = 0; i < 3; i++) {
    const pending = db.firstUnclosedOpenTime(symbol);
    if (pending === null || pending + MINUTE > clock()) break; // so o minuto atual: normal
    await sleep(Math.max(0, pending + MINUTE - closedBefore()) + 100);
    total += await fillSegment(db, symbol, pending, clock(), closedBefore, log);
  }
  return total;
}

// Conexao WebSocket com reconexao automatica, usada por todos os fluxos ao vivo (candles e
// negocios). `label` identifica o fluxo no log; `onMessage` recebe cada mensagem ja em JSON.
//
// Tres formas de a conexao morrer:
//  - o outro lado fecha o TCP: chega o evento 'close' e reconectamos;
//  - a tentativa de conectar falha (sem internet, sem DNS, porta recusada): no Node 22 chega
//    so o evento 'error', nunca 'close', e o socket fica parado em CONNECTING. Por isso
//    'error' tambem leva direto a nova tentativa, sem esperar o limite do handshake;
//  - a rede some em silencio (cabo, Wi-Fi, NAT): nada chega. O watchdog detecta 60 s sem
//    mensagem. Nao da para esperar o fechamento gracioso (ws.close() manda um frame e espera
//    resposta que nunca vem; o WebSocket do Node ficaria em CLOSING para sempre), entao
//    abandonamos o socket e abrimos outro. Eventos do socket abandonado sao ignorados.
function openStream(url, label, symbol, { onMessage, onOpen, onStatus, log = () => {} }) {
  const WATCHDOG_MS = 60_000;
  const HANDSHAKE_MS = 15_000;
  const MAX_WAIT_MS = 15_000;
  let ws = null; // conexao atual; qualquer outra e zumbi
  let stopped = false;
  let attempt = 0;
  let watchdog = null;
  let reconnectTimer = null;

  const armWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => dropAndReconnect(`sem dados ha ${WATCHDOG_MS / 1000}s`), WATCHDOG_MS);
  };

  const dropAndReconnect = (why) => {
    if (stopped) return;
    const dead = ws;
    ws = null;
    clearTimeout(watchdog);
    try { dead?.close(); } catch {}
    onStatus?.(false);
    attempt += 1;
    const wait = Math.min(MAX_WAIT_MS, 1000 * 2 ** Math.min(attempt, 5));
    log(`${label}: ${why}, tentando de novo em ${wait / 1000}s`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, wait);
  };

  const connect = () => {
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    // Com a rede muda ate o handshake pode pendurar em CONNECTING: desiste e tenta de novo.
    const handshake = setTimeout(() => {
      if (ws === sock && sock.readyState === WebSocket.CONNECTING) dropAndReconnect('handshake nao completou');
    }, HANDSHAKE_MS);

    sock.addEventListener('open', () => {
      clearTimeout(handshake);
      if (ws !== sock) return;
      attempt = 0;
      armWatchdog();
      onStatus?.(true);
      log(`${label}: conectado em ${symbol}`);
      onOpen?.();
    });
    sock.addEventListener('message', (ev) => {
      if (ws !== sock) return;
      armWatchdog();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      onMessage(msg);
    });
    sock.addEventListener('error', () => {
      clearTimeout(handshake);
      if (ws !== sock) return; // socket abandonado
      dropAndReconnect('falha na conexao');
    });
    sock.addEventListener('close', () => {
      clearTimeout(handshake);
      if (ws !== sock) return; // socket abandonado que finalmente morreu
      dropAndReconnect('desconectado');
    });
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(watchdog);
    clearTimeout(reconnectTimer);
    try { ws?.close(); } catch {}
  };
}

// Candles de 1 minuto ao vivo.
export function streamKlines(symbol, { onCandle, onOpen, onStatus, log }) {
  return openStream(`${WS_URL}/ws/${symbol.toLowerCase()}@kline_1m`, 'ao vivo', symbol, {
    onOpen, onStatus, log,
    onMessage: (msg) => {
      const k = msg?.k;
      if (!k) return;
      onCandle({
        symbol,
        openTime: k.t,
        open: +k.o,
        high: +k.h,
        low: +k.l,
        close: +k.c,
        volume: +k.v,
        quoteVolume: +k.q,
        trades: k.n,
        takerBuyVolume: +k.V,
        closed: !!k.x,
      });
    },
  });
}

// ---------- Fase 2: negocios agregados (aggTrades) ----------
//
// Um negocio agregado junta os negocios de uma mesma ordem agressora feitos no mesmo preco e
// no mesmo instante. Campos da Binance (iguais no REST e no WebSocket):
//   a = id do negocio agregado (sequencial por par, sem buracos)   p = preco   q = quantidade
//   f, l = primeiro e ultimo negocio individual   T = horario   m = "o comprador era o maker"
// m = true quer dizer que quem estava parado no livro era o comprador, ou seja, quem AGREDIU
// foi o vendedor. Guardamos o contrario (`takerBuy`), que e o que interessa para ler o fluxo.
function toTrade(symbol, r) {
  return { symbol, id: r.a, time: r.T, price: +r.p, qty: +r.q, trades: r.l - r.f + 1, takerBuy: !r.m };
}

// Ate 1000 negocios por pedido. Com `fromId`, a partir daquele id; com `startTime`/`endTime`
// (janela de menos de 1 hora), a partir daquele horario; sem nada, os mais recentes.
export async function fetchAggTrades(symbol, { fromId, startTime, endTime, limit = 1000 } = {}) {
  let url = `${REST_URL}/api/v3/aggTrades?symbol=${symbol}&limit=${limit}`;
  if (fromId !== undefined) url += `&fromId=${fromId}`;
  if (startTime !== undefined) url += `&startTime=${startTime}`;
  if (endTime !== undefined) url += `&endTime=${endTime}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    // Limite de requisicoes: a Binance diz quanto esperar. Insistir antes disso leva a bloqueio.
    if ((res.status === 429 || res.status === 418) && attempt < 3) {
      await sleep(Math.min(120, Number(res.headers.get('retry-after')) || 30) * 1000);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Binance respondeu ${res.status}: ${body.slice(0, 200)}`);
    }
    return (await res.json()).map((r) => toTrade(symbol, r));
  }
}

// ---------- Fase 2: livro de ofertas ----------
//
// Foto do livro: os `limit` melhores niveis de cada lado ([preco, quantidade]) e o numero da
// ultima atualizacao que ela contem.
export async function fetchDepth(symbol, limit = 5000) {
  const res = await fetch(`${REST_URL}/api/v3/depth?symbol=${symbol}&limit=${limit}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Binance respondeu ${res.status}: ${body.slice(0, 200)}`);
  }
  const d = await res.json();
  const num = (rows) => rows.map(([p, q]) => [+p, +q]);
  return { lastUpdateId: d.lastUpdateId, bids: num(d.bids), asks: num(d.asks) };
}

// Atualizacoes do livro, uma por segundo. Cada uma traz so os niveis que mudaram, com a
// quantidade nova (zero = o nivel saiu do livro). `U` e `u` sao a primeira e a ultima
// atualizacao contidas na mensagem; a seguinte tem que comecar em `u + 1`.
export function streamDepth(symbol, { onEvent, onOpen, onStatus, log }) {
  const num = (rows) => rows.map(([p, q]) => [+p, +q]);
  return openStream(`${WS_URL}/ws/${symbol.toLowerCase()}@depth`, 'livro', symbol, {
    onOpen, onStatus, log,
    onMessage: (m) => {
      if (m?.e !== 'depthUpdate') return;
      onEvent({ time: m.E, U: m.U, u: m.u, bids: num(m.b), asks: num(m.a) });
    },
  });
}

// Negocios ao vivo.
export function streamAggTrades(symbol, { onTrade, onOpen, onStatus, log }) {
  return openStream(`${WS_URL}/ws/${symbol.toLowerCase()}@aggTrade`, 'negocios', symbol, {
    onOpen, onStatus, log,
    onMessage: (msg) => {
      if (msg?.e !== 'aggTrade') return;
      onTrade(toTrade(symbol, msg));
    },
  });
}
