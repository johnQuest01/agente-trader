// Fase 3: modo replay.
//
// Uma sessao revela um periodo passado candle a candle. A operacao e registrada ANTES de o
// resultado aparecer, e isso e garantido pelo servidor, nao pela tela:
//   - a API do replay so devolve candles ate o ultimo revelado (`cursor`);
//   - o preco de entrada e sempre o fechamento do ultimo candle revelado; quem registra a
//     operacao informa so o lado, o stop, o alvo, o prazo e o motivo;
//   - o resultado e calculado so com os candles revelados depois.
// Numa sessao disfarcada, a data e o nivel de preco ficam escondidos ate o fim (o preco vira
// um indice que comeca em 100), para nao dar para reconhecer o dia.
import { MINUTE, TIMEFRAMES, REPLAY_FEE_PCT } from './config.js';
import { aggregate } from './aggregate.js';
import { readJson, isJson } from './http.js';

const DAY = 1440 * MINUTE;
const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

// ---------- contas (funcoes puras; scripts/testar-replay.js confere cada caso) ----------

// Aplica um candle novo a uma operacao aberta e devolve a operacao atualizada. Dentro de um
// candle nao se sabe o que veio primeiro, entao a ordem e a mais desfavoravel possivel:
//   1. abriu ja alem do stop: sai na abertura (pior que o stop, como numa abertura com salto);
//   2. abriu ja alem do alvo: sai na abertura;
//   3. tocou o stop: sai no stop, MESMO que o alvo tambem tenha sido tocado no mesmo candle;
//   4. tocou o alvo: sai no alvo;
//   5. acabou o prazo: sai no fechamento.
export function stepTrade(t, c) {
  const buy = t.side === 'buy';
  const out = { ...t, bars: t.bars + 1 };
  const worse = buy ? Math.min : Math.max;
  const better = buy ? Math.max : Math.min;
  const exitAt = (price, kind) => {
    out.exitTime = c.openTime;
    out.exit = price;
    out.exitKind = kind;
    out.worst = worse(out.worst, price);
    out.best = better(out.best, price);
    return out;
  };
  const beyondStop = (p) => (buy ? p <= t.stop : p >= t.stop);
  const beyondTarget = (p) => t.target != null && (buy ? p >= t.target : p <= t.target);
  if (beyondStop(c.open)) return exitAt(c.open, 'stop');
  if (beyondTarget(c.open)) return exitAt(c.open, 'target');
  if (beyondStop(buy ? c.low : c.high)) return exitAt(t.stop, 'stop');
  if (beyondTarget(buy ? c.high : c.low)) {
    // Pelo mesmo criterio do pior caso: o ponto mais contra do candle veio antes do alvo.
    out.worst = worse(out.worst, buy ? c.low : c.high);
    return exitAt(t.target, 'target');
  }
  out.worst = worse(out.worst, buy ? c.low : c.high);
  out.best = better(out.best, buy ? c.high : c.low);
  if (out.bars >= t.maxBars) return exitAt(c.close, 'time');
  return out;
}

// Resultado de uma operacao encerrada, em % do valor aplicado.
//   liquido = bruto - taxa na entrada (sobre o valor de entrada) - taxa na saida (sobre o de saida)
//   R = resultado bruto dividido pelo risco assumido (distancia da entrada ao stop)
export function tradeResult(t, feePct) {
  if (t.exit == null) return null;
  const dir = t.side === 'buy' ? 1 : -1;
  const pct = (p) => (dir * (p - t.entry) / t.entry) * 100;
  const grossPct = pct(t.exit);
  return {
    grossPct,
    netPct: grossPct - feePct * (1 + t.exit / t.entry),
    rMultiple: (dir * (t.exit - t.entry)) / Math.abs(t.entry - t.stop),
    worstPct: pct(t.worst), // o quanto chegou a ficar contra
    bestPct: pct(t.best),   // o quanto chegou a ficar a favor
  };
}

// Resumo de uma sessao. As porcentagens sao somadas (mesmo valor aplicado em cada operacao).
// A ordem dos campos e a ordem de importancia do projeto: resultado liquido, perda maxima e
// expectativa por operacao; a taxa de acerto vem por ultimo.
export function sessionStats(trades, feePct) {
  const results = trades.map((t) => tradeResult(t, feePct)).filter(Boolean);
  if (!results.length) return { trades: 0 };
  let cum = 0;
  let peak = 0;
  let maxDrawdownPct = 0;
  for (const r of results) {
    cum += r.netPct;
    peak = Math.max(peak, cum);
    maxDrawdownPct = Math.max(maxDrawdownPct, peak - cum);
  }
  const nets = results.map((r) => r.netPct);
  return {
    trades: results.length,
    netTotalPct: cum,
    maxDrawdownPct,
    worstTradePct: Math.min(...nets),
    expectancyPct: cum / results.length,
    avgR: results.reduce((s, r) => s + r.rMultiple, 0) / results.length,
    winRatePct: (nets.filter((x) => x > 0).length / results.length) * 100,
  };
}

// ---------- sessoes ----------

// Candles do tempo grafico da sessao com abertura entre `from` e `to` (inclusive).
function candlesBetween(db, s, from, to) {
  const ms = TIMEFRAMES[s.tf];
  const rows = db.range(s.symbol, from, to + ms - MINUTE);
  return ms === MINUTE ? rows : aggregate(rows, ms);
}

const isDone = (s) => s.cursor + TIMEFRAMES[s.tf] >= s.endTime;

// O que a tela ve. Numa sessao disfarcada e ainda em andamento, precos e horarios saem
// convertidos; os reais so aparecem quando ela acaba.
function disguise(s) {
  const on = !!s.hidden && !isDone(s);
  const k = on ? s.scale : 1;
  const dt = on ? s.timeShift : 0;
  const r4 = (x) => Math.round(x * 1e4) / 1e4;
  return {
    on,
    price: (p) => (p == null ? null : on ? r4(p * k) : p),
    time: (t) => (t == null ? null : t + dt),
    real: (p) => p / k,
  };
}

export function createSession(db, symbol, { tf = '5m', start, random = false, hidden, hours = 24, context = 300 } = {}) {
  const ms = TIMEFRAMES[tf];
  if (!ms || ms >= DAY) throw new Error('tempo grafico invalido para o replay (use 1m, 5m, 15m, 1h ou 4h)');
  const first = db.firstOpenTime(symbol);
  const last = db.lastOpenTime(symbol);
  if (first === null) throw new Error('ainda nao ha candles no banco');
  const firstBucket = Math.ceil(first / ms) * ms;
  const lastClosed = Math.floor(last / ms) * ms - ms; // ultimo candle com certeza fechado
  const minStart = firstBucket + 50 * ms;             // sobra pelo menos 50 candles de contexto
  const maxStart = lastClosed - 30 * ms;              // e pelo menos 30 candles para revelar
  if (maxStart < minStart) throw new Error('historico curto demais para um replay nesse tempo grafico');
  let startTime;
  if (random) {
    startTime = minStart + Math.floor(Math.random() * ((maxStart - minStart) / ms + 1)) * ms;
  } else {
    startTime = Math.floor(Number(start) / ms) * ms;
    if (!(startTime >= minStart && startTime <= maxStart)) {
      throw new Error(`inicio fora do historico: escolha entre ${iso(minStart)} e ${iso(maxStart)} UTC`);
    }
  }
  const span = Math.max(1, Math.min(72, Number(hours) || 24)) * 60 * MINUTE;
  const endTime = Math.min(startTime + span, lastClosed + ms);
  const ctx = Math.max(1, Math.min(Number(context) || 300, (startTime - firstBucket) / ms));
  const isHidden = hidden ?? random;
  const draft = { symbol, tf };
  const [base] = candlesBetween(db, draft, startTime - ms, startTime - ms);
  if (!base) throw new Error('nao ha candle logo antes do inicio escolhido');
  return db.replayCreate({
    symbol, tf, startTime, endTime, cursor: startTime - ms, context: ctx, hidden: isHidden,
    // Disfarce: o ultimo fechamento antes do inicio vira 100, e a data vira um dia qualquer
    // (a hora do dia e mantida, porque faz parte do que se quer estudar).
    scale: isHidden ? 100 / base.close : 1,
    timeShift: isHidden ? Date.UTC(2000, 0, 3) + (startTime % DAY) - startTime : 0,
    feePct: REPLAY_FEE_PCT, createdAt: Date.now(),
  });
}

function viewTrade(t, d, feePct) {
  return {
    id: t.id, side: t.side, entryTime: d.time(t.entryTime), entry: d.price(t.entry), stop: d.price(t.stop),
    target: d.price(t.target), maxBars: t.maxBars, reason: t.reason, bars: t.bars,
    open: t.exit == null, exitTime: d.time(t.exitTime), exit: d.price(t.exit), exitKind: t.exitKind,
    result: tradeResult(t, feePct),
  };
}

export function viewSession(db, s, { withCandles = true } = {}) {
  const ms = TIMEFRAMES[s.tf];
  const d = disguise(s);
  const done = isDone(s);
  const trades = db.replayTrades(s.id);
  const out = {
    id: s.id, tf: s.tf, done, hidden: d.on, feePct: s.feePct,
    cursor: d.time(s.cursor), start: d.time(s.startTime),
    revealedCandles: (s.cursor - s.startTime) / ms + 1,
    remainingCandles: Math.max(0, (s.endTime - s.cursor - ms) / ms),
    // Com o disfarce ligado nao se diz quando foi; ao terminar, a data real aparece.
    realStart: d.on ? null : s.startTime,
    trades: trades.map((t) => viewTrade(t, d, s.feePct)),
    stats: sessionStats(trades, s.feePct),
  };
  if (withCandles) {
    out.candles = candlesBetween(db, s, s.startTime - s.context * ms, s.cursor).map((c) => ({
      openTime: d.time(c.openTime), open: d.price(c.open), high: d.price(c.high), low: d.price(c.low),
      close: d.price(c.close), volume: c.volume, takerBuyVolume: c.takerBuyVolume,
    }));
  }
  return out;
}

const mustGet = (db, id) => {
  const s = db.replayGet(Number(id));
  if (!s) throw new Error('sessao de replay nao encontrada');
  return s;
};

// Revela os proximos `n` candles e resolve a operacao aberta contra cada um deles.
export function advance(db, id, n = 1) {
  return db.tx(() => {
    const s = mustGet(db, id);
    const ms = TIMEFRAMES[s.tf];
    let open = db.replayTrades(s.id).find((t) => t.exit == null) ?? null;
    let lastCandle = null;
    const steps = Math.max(1, Math.min(200, Number(n) || 1));
    for (let i = 0; i < steps && s.cursor + ms < s.endTime; i++) {
      s.cursor += ms;
      const [c] = candlesBetween(db, s, s.cursor, s.cursor);
      if (!c) continue; // periodo sem candle (manutencao da Binance): so anda
      lastCandle = c;
      if (open) {
        const upd = stepTrade(open, c);
        db.replayUpdateTrade(upd);
        open = upd.exit == null ? upd : null;
      }
    }
    // Acabou o periodo com operacao aberta: sai no ultimo fechamento.
    if (isDone(s) && open) {
      const [c] = lastCandle ? [lastCandle] : candlesBetween(db, s, s.cursor, s.cursor);
      if (c) db.replayUpdateTrade({ ...open, exitTime: c.openTime, exit: c.close, exitKind: 'end' });
    }
    db.replaySetCursor(s.id, s.cursor);
    return s.id;
  });
}

// Registra uma operacao no candle atual. Stop e alvo chegam como a tela mostra (disfarcados ou nao).
export function addTrade(db, id, { side, stop, target, maxBars = 12, reason } = {}) {
  return db.tx(() => {
    const s = mustGet(db, id);
    if (isDone(s)) throw new Error('a sessao ja terminou');
    if (db.replayTrades(s.id).some((t) => t.exit == null)) throw new Error('ja existe uma operacao aberta nesta sessao');
    if (side !== 'buy' && side !== 'sell') throw new Error('lado invalido: use compra ou venda');
    const [c] = candlesBetween(db, s, s.cursor, s.cursor);
    if (!c) throw new Error('nao ha candle no ponto atual da sessao');
    const d = disguise(s);
    const entry = c.close;
    const realStop = d.real(Number(stop));
    const realTarget = target === null || target === undefined || target === '' ? null : d.real(Number(target));
    if (!(realStop > 0)) throw new Error('informe o stop: sem perda maxima definida a operacao nao e registrada');
    const buy = side === 'buy';
    if (buy ? realStop >= entry : realStop <= entry) throw new Error(`o stop tem que ficar ${buy ? 'abaixo' : 'acima'} do preco de entrada (${d.price(entry)})`);
    if (realTarget !== null && !(realTarget > 0)) throw new Error('alvo invalido');
    if (realTarget !== null && (buy ? realTarget <= entry : realTarget >= entry)) throw new Error(`o alvo tem que ficar ${buy ? 'acima' : 'abaixo'} do preco de entrada (${d.price(entry)})`);
    const bars = Math.round(Number(maxBars));
    if (!(bars >= 1 && bars <= 1000)) throw new Error('prazo invalido: de 1 a 1000 candles');
    db.replayAddTrade({
      sessionId: s.id, madeAt: Date.now(), entryTime: s.cursor, side, entry, stop: realStop, target: realTarget,
      maxBars: bars, reason: String(reason ?? '').slice(0, 500) || null,
    });
    return s.id;
  });
}

// Encerra a operacao aberta no fechamento do candle atual (saida por decisao, sem ver o proximo).
export function closeTrade(db, id) {
  return db.tx(() => {
    const s = mustGet(db, id);
    const open = db.replayTrades(s.id).find((t) => t.exit == null);
    if (!open) throw new Error('nao ha operacao aberta');
    const [c] = candlesBetween(db, s, s.cursor, s.cursor);
    if (!c) throw new Error('nao ha candle no ponto atual da sessao');
    const buy = open.side === 'buy';
    db.replayUpdateTrade({
      ...open, exitTime: s.cursor, exit: c.close, exitKind: 'manual',
      worst: (buy ? Math.min : Math.max)(open.worst, c.close), best: (buy ? Math.max : Math.min)(open.best, c.close),
    });
    return s.id;
  });
}

// ---------- rotas HTTP ----------
// Devolve true se a rota era do replay. Erros de uso (stop do lado errado etc.) saem como 400.
export async function handleReplay(req, res, url, { db, symbol, json }) {
  if (!url.pathname.startsWith('/api/replay/')) return false;
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /api/replay/sessions') {
      json(res, 200, db.replayList(symbol).map((s) => viewSession(db, s, { withCandles: false })));
      return true;
    }
    if (route === 'GET /api/replay/session') {
      json(res, 200, viewSession(db, mustGet(db, url.searchParams.get('id'))));
      return true;
    }
    if (req.method === 'POST') {
      if (!isJson(req)) {
        json(res, 415, { error: 'envie JSON (content-type: application/json)' });
        return true;
      }
      const body = await readJson(req);
      let id = null;
      if (url.pathname === '/api/replay/sessions') id = createSession(db, symbol, body);
      else if (url.pathname === '/api/replay/next') id = advance(db, body.id, body.n);
      else if (url.pathname === '/api/replay/trade') id = addTrade(db, body.id, body);
      else if (url.pathname === '/api/replay/close') id = closeTrade(db, body.id);
      if (id !== null) {
        json(res, 200, viewSession(db, mustGet(db, id)));
        return true;
      }
    }
    json(res, 404, { error: 'rota de replay desconhecida' });
  } catch (err) {
    json(res, 400, { error: String(err?.message || err) });
  }
  return true;
}
