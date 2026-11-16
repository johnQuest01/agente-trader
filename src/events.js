// Fase 4: eventos e noticias com horario exato, e o estudo da reacao do preco a cada um.
//
// A reacao e medida com os candles de 1 minuto, que sao o dado permanente do projeto:
//   - preco de referencia: o fechamento do ultimo minuto que terminou antes do evento;
//   - reacao em N minutos: do preco de referencia ate o fechamento do N-esimo minuto contado
//     a partir do minuto do evento.
// Para um evento as 12:30:00 em ponto, "5 minutos" e exatamente de 12:30 a 12:35. Para um
// evento as 12:30:20, a referencia e 12:30:00 e a janela vai ate 12:35:00: a precisao e de um
// minuto, nao de segundos.
import { MINUTE, TIMEFRAMES } from './config.js';
import { aggregate } from './aggregate.js';
import { readJson, isJson } from './http.js';

export const HORIZONS = [
  { key: '1min', label: '1 min', minutes: 1 },
  { key: '5min', label: '5 min', minutes: 5 },
  { key: '1h', label: '1 hora', minutes: 60 },
  { key: '1d', label: '1 dia', minutes: 1440 },
  { key: '1sem', label: '1 semana', minutes: 10080 },
];

// ---------- contas (funcoes puras; scripts/testar-eventos.js confere) ----------

// `src` da acesso aos candles de 1m: candleAt(abertura), windowStats(de, ate) e lastClosedTime.
export function reaction(src, time) {
  const m0 = Math.floor(time / MINUTE) * MINUTE; // o minuto em que o evento aconteceu
  const ref = src.candleAt(m0 - MINUTE);
  if (!ref) {
    return { refPrice: null, horizons: HORIZONS.map((h) => ({ key: h.key, status: 'sem candle antes do evento' })) };
  }
  // Volume medio por minuto nas 24 horas anteriores: serve para dizer se o volume depois do
  // evento foi fora do comum.
  const before = src.windowStats(m0 - 1440 * MINUTE, m0);
  const usual = before.n >= 60 && before.volume > 0 ? before.volume / before.n : null;
  const pct = (p) => (p / ref.close - 1) * 100;
  return {
    refPrice: ref.close,
    horizons: HORIZONS.map((h) => {
      const end = m0 + h.minutes * MINUTE; // fim da janela (exclusivo)
      if (end - MINUTE > src.lastClosedTime) return { key: h.key, status: 'ainda nao passou' };
      const last = src.candleAt(end - MINUTE);
      const w = src.windowStats(m0, end);
      // Tolera ate 2% de minutos ausentes (manutencao da Binance), mas o ultimo tem que existir.
      if (!last || w.n < h.minutes * 0.98) return { key: h.key, status: 'faltam candles' };
      return {
        key: h.key, status: 'ok',
        retPct: pct(last.close),   // onde o preco estava no fim da janela
        maxUpPct: pct(w.high),     // o mais alto que chegou dentro da janela
        maxDownPct: pct(w.low),    // o mais baixo que chegou
        volumeRatio: usual ? w.volume / w.n / usual : null, // 1 = volume normal; 3 = o triplo
      };
    }),
  };
}

// Movimento "tipico" de cada janela, em qualquer horario: a mediana e o percentil 90 do
// tamanho da variacao, em janelas seguidas (sem sobreposicao) de todo o historico. Sem isso
// nao da para saber se a reacao a um evento foi fora do comum ou so o balanco de sempre.
// `horizons` permite medir outras janelas (o caderno usa 1 hora, 4 horas, 1 dia e 1 semana).
export function typicalMoves(closes, horizons = HORIZONS) {
  return horizons.map((h) => {
    const sizes = [];
    for (let i = 1; i + h.minutes - 1 < closes.length; i += h.minutes) {
      const a = closes[i - 1];
      const b = closes[i + h.minutes - 1];
      if (b.openTime - a.openTime !== h.minutes * MINUTE) continue; // buraco no meio: descarta
      sizes.push(Math.abs(b.close / a.close - 1) * 100);
    }
    sizes.sort((x, y) => x - y);
    const q = (p) => (sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))] : null);
    return { key: h.key, samples: sizes.length, medianAbsPct: q(0.5), p90AbsPct: q(0.9) };
  });
}

// Resumo por tipo de evento. `n` e quantos eventos daquele tipo tem a janela completa: com
// poucos, a media nao prova nada, e a tela avisa.
export function summarize(events) {
  const kinds = new Map();
  for (const e of events) {
    if (!kinds.has(e.kind)) kinds.set(e.kind, []);
    kinds.get(e.kind).push(e);
  }
  return [...kinds].map(([kind, list]) => ({
    kind,
    events: list.length,
    horizons: HORIZONS.map((h, i) => {
      const rets = list.map((e) => e.reaction.horizons[i]).filter((x) => x.status === 'ok').map((x) => x.retPct).sort((a, b) => a - b);
      if (!rets.length) return { key: h.key, n: 0 };
      const mid = rets.length >> 1;
      return {
        key: h.key, n: rets.length,
        meanPct: rets.reduce((s, x) => s + x, 0) / rets.length,
        medianPct: rets.length % 2 ? rets[mid] : (rets[mid - 1] + rets[mid]) / 2,
        upPct: (rets.filter((x) => x > 0).length / rets.length) * 100,
      };
    }),
  })).sort((a, b) => b.events - a.events);
}

// ---------- entrada de dados ----------
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

export function normalizeEvent(input) {
  const time = Number(input.time);
  if (!Number.isFinite(time) || time < Date.UTC(2009, 0, 1) || time > Date.UTC(2100, 0, 1)) throw new Error('horario invalido');
  const title = clip(input.title, 200);
  if (!title) throw new Error('falta o titulo do evento');
  const importance = Math.round(Number(input.importance ?? 2));
  if (![1, 2, 3].includes(importance)) throw new Error('importancia invalida: use 1 (baixa), 2 (media) ou 3 (alta)');
  return {
    time, title, importance,
    kind: clip(input.kind, 40).toLowerCase() || 'geral',
    source: clip(input.source, 300) || null,
    note: clip(input.note, 1000) || null,
  };
}

// Aceita "14/11/2026 18:30" ou "14/11/2026 18:30:05" (horario do computador) e tambem datas no
// formato ISO, como "2026-11-14T18:30:00-03:00". Devolve ms UTC, ou NaN.
export function parseWhen(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] ?? 0)).getTime();
  return Date.parse(s);
}

// Uma linha por evento: data e hora; titulo; tipo; importancia; fonte; nota. Separador ";" ou
// ",". A primeira linha pode ser um cabecalho. Devolve as linhas boas e os erros, linha a linha.
export function parseEventsCsv(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  const errors = [];
  if (!lines.length) return { rows, errors };
  const sep = lines[0].includes(';') ? ';' : ',';
  lines.forEach((line, i) => {
    const f = line.split(sep).map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
    const time = parseWhen(f[0]);
    if (Number.isNaN(time)) {
      if (i > 0) errors.push({ line: i + 1, error: `data e hora invalidas: "${f[0]}"` });
      return; // na primeira linha, e o cabecalho
    }
    try {
      rows.push(normalizeEvent({ time, title: f[1], kind: f[2], importance: f[3] === undefined || f[3] === '' ? 2 : f[3], source: f[4], note: f[5] }));
    } catch (err) {
      errors.push({ line: i + 1, error: err.message });
    }
  });
  return { rows, errors };
}

// ---------- consulta ----------
const typicalCache = new Map(); // simbolo -> { at, value }

function typicalFor(db, symbol) {
  const hit = typicalCache.get(symbol);
  if (hit && Date.now() - hit.at < 10 * MINUTE) return hit.value;
  const value = typicalMoves(db.closes(symbol));
  typicalCache.set(symbol, { at: Date.now(), value });
  return value;
}

export function listEvents(db, symbol) {
  const src = {
    candleAt: (t) => db.candleAt(symbol, t),
    windowStats: (from, to) => db.windowStats(symbol, from, to),
    lastClosedTime: db.lastClosedTime(symbol) ?? -Infinity,
  };
  const events = db.eventList(symbol).map((e) => ({ ...e, reaction: reaction(src, e.time) }));
  return { horizons: HORIZONS, typical: typicalFor(db, symbol), events, summary: summarize(events) };
}

// Candles em volta de um evento, para o grafico da tela de eventos.
function eventWindow(db, symbol, id, tf) {
  const e = db.eventGet(symbol, Number(id));
  if (!e) throw new Error('evento nao encontrado');
  const ms = TIMEFRAMES[tf];
  if (!ms || ms > 60 * MINUTE) throw new Error('tempo grafico invalido: use 1m, 5m, 15m ou 1h');
  const bucket = Math.floor(e.time / ms) * ms;
  const rows = db.range(symbol, bucket - 60 * ms, bucket + 241 * ms - MINUTE);
  return { event: e, tf, eventBucket: bucket, candles: ms === MINUTE ? rows : aggregate(rows, ms) };
}

// ---------- rotas HTTP ----------
export async function handleEvents(req, res, url, { db, symbol, json }) {
  if (url.pathname !== '/api/events' && !url.pathname.startsWith('/api/events/')) return false;
  try {
    if (req.method === 'GET' && url.pathname === '/api/events') {
      json(res, 200, listEvents(db, symbol));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/events/window') {
      json(res, 200, eventWindow(db, symbol, url.searchParams.get('id'), url.searchParams.get('tf') || '1m'));
      return true;
    }
    if (req.method === 'POST') {
      if (!isJson(req)) {
        json(res, 415, { error: 'envie JSON (content-type: application/json)' });
        return true;
      }
      const body = await readJson(req);
      let result = null;
      if (url.pathname === '/api/events') {
        const added = db.eventAdd({ symbol, createdAt: Date.now(), ...normalizeEvent(body) });
        result = { added: added ? 1 : 0, duplicates: added ? 0 : 1, errors: [] };
      } else if (url.pathname === '/api/events/delete') {
        if (!db.eventDelete(symbol, Number(body.id))) throw new Error('evento nao encontrado');
        result = { deleted: 1 };
      } else if (url.pathname === '/api/events/import') {
        const { rows, errors } = parseEventsCsv(body.csv);
        let added = 0;
        db.tx(() => { for (const r of rows) if (db.eventAdd({ symbol, createdAt: Date.now(), ...r })) added += 1; });
        result = { added, duplicates: rows.length - added, errors };
      }
      if (result) {
        json(res, 200, { ...result, ...listEvents(db, symbol) });
        return true;
      }
    }
    json(res, 404, { error: 'rota de eventos desconhecida' });
  } catch (err) {
    json(res, 400, { error: String(err?.message || err) });
  }
  return true;
}
