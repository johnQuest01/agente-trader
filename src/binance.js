import { REST_URL, WS_URL, MINUTE } from './config.js';

const DAY = 24 * 60 * MINUTE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Formato REST: [openTime, open, high, low, close, volume, closeTime,
//                quoteVolume, trades, takerBuyBase, takerBuyQuote, ignore]
function fromRest(symbol, k, now) {
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
    closed: k[6] < now,
  };
}

async function fetchKlines(symbol, startTime) {
  const url = `${REST_URL}/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=1000`;
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
  const offset = serverTime - (before + Date.now()) / 2; // ms a somar no relogio local
  // Avisa uma vez (e de novo so se o desvio mudar mais de 5 s), nao a cada reconexao.
  if (Math.abs(offset) > 30_000 && (lastWarnedOffset === null || Math.abs(offset - lastWarnedOffset) > 5_000)) {
    const s = Math.round(Math.abs(offset) / 1000);
    log(`AVISO: relogio do PC esta ${s}s ${offset > 0 ? 'atrasado' : 'adiantado'} em relacao a Binance; sincronize o relogio do Windows`);
    lastWarnedOffset = offset;
  }
  return offset;
}

async function fillSegment(db, symbol, from, to, clock, log) {
  let cursor = from;
  let total = 0;
  while (cursor < to) {
    // O instante de referencia e ANTES do pedido: tudo que a Binance ja tinha fechado antes
    // de receber o pedido esta, por construcao, completo na resposta. (Se usassemos o
    // instante da chegada, um minuto que fechasse durante a viagem seria gravado como
    // "fechado" com dados parciais.)
    const before = clock();
    const rows = await fetchKlines(symbol, cursor);
    if (!rows.length) break;
    db.upsertMany(rows.map((k) => fromRest(symbol, k, before)));
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

// Baixa o historico que falta: o trecho antigo (se pediu mais dias) e o buraco ate agora.
export async function backfill(db, symbol, days, log = () => {}) {
  const offset = await clockOffset(log);
  const clock = () => Date.now() + offset;
  const now = clock();
  // Comeca em 00:00 UTC, para que o primeiro candle de 1d (e 4h, 1h...) seja completo,
  // e nao um pedaco de dia que parece um candle de verdade.
  const target = Math.floor((now - days * DAY) / DAY) * DAY;
  const first = db.firstOpenTime(symbol);
  const last = db.lastOpenTime(symbol);
  let total = 0;
  if (first === null) {
    total += await fillSegment(db, symbol, target, now, clock, log);
  } else {
    if (first > target) total += await fillSegment(db, symbol, target, first, clock, log);
    // Retoma do primeiro candle ainda marcado como aberto (ou do ultimo, se todos fecharam):
    // assim um candle gravado como provisorio e sempre refeito com o dado definitivo.
    const resume = Math.min(last, db.firstUnclosedOpenTime(symbol) ?? last);
    total += await fillSegment(db, symbol, resume, now, clock, log);
  }
  return total;
}

// Fluxo ao vivo dos candles de 1 minuto, com reconexao automatica.
//
// Duas formas de a conexao morrer:
//  - o outro lado fecha o TCP: chega o evento 'close' e reconectamos;
//  - a rede some em silencio (cabo, Wi-Fi, NAT): nada chega. O watchdog detecta 60 s sem
//    mensagem. Nao da para esperar o fechamento gracioso (ws.close() manda um frame e espera
//    resposta que nunca vem; o WebSocket do Node ficaria em CLOSING para sempre), entao
//    abandonamos o socket e abrimos outro. Eventos do socket abandonado sao ignorados.
export function streamKlines(symbol, { onCandle, onOpen, onStatus, log = () => {} }) {
  const url = `${WS_URL}/ws/${symbol.toLowerCase()}@kline_1m`;
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
    log(`ao vivo: ${why}, tentando de novo em ${wait / 1000}s`);
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
      log(`ao vivo: conectado em ${symbol}`);
      onOpen?.();
    });
    sock.addEventListener('message', (ev) => {
      if (ws !== sock) return;
      armWatchdog();
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
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
    });
    sock.addEventListener('error', () => {});
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
