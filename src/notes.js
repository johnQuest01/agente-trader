// Caderno do Bruno: anotacoes livres e previsoes ("espero alta" ou "espero baixa", com prazo),
// conferidas depois pelo laboratorio. Serve para descobrir, com o tempo, se a leitura que ele
// faz das noticias e do grafico acerta mais do que uma moeda jogada para cima.
//
// A regra e a mesma do replay: a previsao e registrada ANTES de o resultado existir, e quem
// garante isso e o servidor, nao a tela:
//   - na gravacao o servidor carimba a hora e o MINUTO DE REFERENCIA: o candle de 1m que esta em
//     formacao naquele instante. O preco de referencia e o FECHAMENTO desse candle, um preco que
//     ainda nao existia quando o Bruno clicou. Usar o ultimo candle ja fechado daria ate um
//     minuto de vantagem a quem preve: numa noticia, o tranco que ele acabou de ver na tela
//     entraria na conta como acerto;
//   - previsao so e aceita com o preco ao vivo chegando (ultimo candle recebido ha no maximo
//     MAX_FEED_AGE). Com o coletor parado, o "minuto em formacao" do banco ja teria fechado no
//     mercado de verdade. Isso e medido pelo tempo passado desde a ultima mensagem, nao pela
//     hora do relogio: um relogio errado nao engana a conta;
//   - nao ha rota para alterar nem para apagar, e o proprio banco recusa (gatilhos). Uma previsao
//     errada que pudesse ser apagada nao contaria no placar;
//   - o resultado sai dos candles gravados depois: do preco de referencia ate o fechamento do
//     candle que termina o prazo (N minutos de preco depois da referencia).
import { MINUTE, REPLAY_FEE_PCT } from './config.js';
import { readJson, isJson } from './http.js';
import { typicalMoves } from './events.js';

export const NOTE_HORIZONS = [
  { key: '1h', label: '1 hora', minutes: 60 },
  { key: '4h', label: '4 horas', minutes: 240 },
  { key: '1d', label: '1 dia', minutes: 1440 },
  { key: '1sem', label: '1 semana', minutes: 10080 },
];
// Os candles ao vivo chegam a cada 2 s. Mais de 10 s sem nenhum = preco parado.
export const MAX_FEED_AGE = 10_000;
const MIN_FOR_PROOF = 20; // com menos previsoes conferidas que isso, o placar nao prova nada

// ---------- contas (funcoes puras; scripts/testar-caderno.js confere) ----------
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

export function normalizeNote(input) {
  const text = clip(input?.text, 2000);
  if (!text) throw new Error('escreva a anotacao');
  const raw = clip(input?.side, 10).toLowerCase();
  const side = raw === 'alta' || raw === 'baixa' ? raw : null;
  if (raw && !side && raw !== 'nenhum') throw new Error('lado invalido: use "alta", "baixa" ou deixe sem previsao');
  let horizonMin = null;
  if (side) {
    horizonMin = Math.round(Number(input?.horizonMin));
    if (!NOTE_HORIZONS.some((h) => h.minutes === horizonMin)) throw new Error('prazo invalido: escolha 1 hora, 4 horas, 1 dia ou 1 semana');
  }
  return { text, kind: clip(input?.kind, 40).toLowerCase() || 'geral', side, horizonMin, source: clip(input?.source, 300) || null };
}

// O preco de referencia de uma anotacao: o fechamento do candle de referencia, depois de fechado.
// `src` da acesso aos candles de 1m: candleAt(abertura), windowStats(de, ate) e lastClosedTime.
export function refPriceOf(src, note) {
  if (note.refTime == null || note.refTime > src.lastClosedTime) return null;
  const c = src.candleAt(note.refTime);
  return c && c.closed ? c.close : null;
}

// Uma previsao vale por N minutos de preco contados do candle de referencia: os candles que
// abrem de refTime+1min ate refTime+N min. O resultado e medido no fechamento do ultimo deles.
export function score(src, note, feePct = REPLAY_FEE_PCT) {
  if (!note.side) return { status: 'sem previsao' };
  if (note.refTime == null) return { status: 'sem preco de referencia' };
  if (note.refTime > src.lastClosedTime) return { status: 'aguardando o minuto fechar' };
  const refPrice = refPriceOf(src, note);
  if (refPrice == null) return { status: 'sem preco de referencia' };
  const dir = note.side === 'alta' ? 1 : -1;
  const pct = (p) => (p / refPrice - 1) * 100;
  const lastOpen = note.refTime + note.horizonMin * MINUTE; // abertura do candle que fecha o prazo
  const dueAt = lastOpen + MINUTE;                          // instante em que o prazo termina
  if (lastOpen > src.lastClosedTime) {
    // Ainda correndo: mostra onde esta agora, sem veredito.
    const now = src.lastClosedTime > note.refTime ? src.candleAt(src.lastClosedTime) : null;
    return { status: 'ainda nao venceu', refPrice, dueAt, favorNowPct: now ? dir * pct(now.close) : null };
  }
  const last = src.candleAt(lastOpen);
  const w = src.windowStats(note.refTime + MINUTE, lastOpen + MINUTE);
  // Tolera ate 2% de minutos ausentes (manutencao da Binance), mas o ultimo tem que existir.
  if (!last || w.n < note.horizonMin * 0.98) return { status: 'faltam candles', refPrice, dueAt };
  const retPct = pct(last.close);
  const favorPct = dir * retPct;                 // a favor da previsao (positivo = o preco foi para o lado previsto)
  return {
    status: 'ok', refPrice, dueAt, exitPrice: last.close, retPct, favorPct,
    // Como se tivesse operado sem stop: entra no preco de referencia e sai no fim do prazo,
    // pagando a taxa nos dois lados (mesma conta do replay).
    netPct: favorPct - feePct * (1 + last.close / refPrice),
    // O pior momento contra a previsao dentro do prazo (zero ou negativo).
    worstPct: Math.min(0, dir === 1 ? pct(w.low) : -pct(w.high)),
    hit: favorPct > 0, // preco exatamente igual no fim do prazo conta como erro
  };
}

// Chance de acertar o lado `k` vezes ou mais em `n`, jogando uma moeda (0,5 cada). A soma e
// feita com logaritmos: 0,5^n direto vira zero depois de umas mil previsoes.
export function luck(n, k) {
  if (n <= 0) return null;
  if (k <= 0) return 1;
  let logTerm = -n * Math.LN2; // ln( C(n,0) / 2^n )
  let tail = 0;                // soma de C(n,i)/2^n para i >= k
  for (let i = 0; i <= n; i++) {
    if (i >= k) tail += Math.exp(logTerm);
    logTerm += Math.log(n - i) - Math.log(i + 1); // passa de C(n,i) para C(n,i+1)
  }
  return Math.min(1, tail);
}

const OPEN = ['ainda nao venceu', 'aguardando o minuto fechar'];

// O placar. A ordem dos campos e a do projeto: resultado, resultado com taxa e pior previsao
// primeiro; a taxa de acerto por ultimo.
export function summarize(scored) {
  const group = (list) => {
    const done = list.filter((x) => x.score.status === 'ok');
    const n = done.length;
    const hits = done.filter((x) => x.score.hit).length;
    const mean = (f) => (n ? done.reduce((s, x) => s + f(x.score), 0) / n : null);
    return {
      conferidas: n,
      mediaNoLadoPct: mean((s) => s.favorPct),
      mediaComTaxaPct: mean((s) => s.netPct),
      piorPct: n ? Math.min(...done.map((x) => x.score.favorPct)) : null,
      acertos: hits,
      acertoPct: n ? (100 * hits) / n : null,
      sorte: luck(n, hits),            // chance de acertar isso ou mais so jogando moeda
      prova: n >= MIN_FOR_PROOF,       // com poucas previsoes o placar nao prova nada
    };
  };
  const preds = scored.filter((x) => x.side);
  const kinds = [...new Set(preds.map((x) => x.kind))].sort();
  return {
    ...group(preds),
    emAberto: preds.filter((x) => OPEN.includes(x.score.status)).length,
    semConferencia: preds.filter((x) => x.score.status !== 'ok' && !OPEN.includes(x.score.status)).length,
    anotacoesSemPrevisao: scored.length - preds.length,
    minimoParaProvar: MIN_FOR_PROOF,
    porAssunto: kinds.map((kind) => ({ kind, ...group(preds.filter((x) => x.kind === kind)) })),
    porPrazo: NOTE_HORIZONS.map((h) => ({ key: h.key, label: h.label, ...group(preds.filter((x) => x.horizonMin === h.minutes)) })),
  };
}

// ---------- consulta ----------
// Uma previsao ja conferida nao muda mais: os candles do prazo estao fechados. Refazer a conta de
// todas a cada consulta da tela (de 20 em 20 s) custa de 1 a 6 ms por previsao, medido com 1 ano
// de candles, e trava o coletor enquanto roda. Por isso o resultado final fica guardado por 10
// minutos. O prazo curto e de proposito: se um candle for corrigido depois, a conta se acerta
// sozinha. Previsao ainda em aberto e sempre refeita.
const SCORE_TTL = 10 * MINUTE;
const finals = new WeakMap(); // banco -> Map(id da anotacao -> { at, feePct, score })
function scoreCached(db, src, note, feePct) {
  let byId = finals.get(db);
  if (!byId) finals.set(db, byId = new Map());
  const hit = byId.get(note.id);
  if (hit && hit.feePct === feePct && performance.now() - hit.at < SCORE_TTL) return hit.score;
  const s = score(src, note, feePct);
  if (s.status === 'ok') byId.set(note.id, { at: performance.now(), feePct, score: s });
  else byId.delete(note.id);
  return s;
}

// A regua (movimento tipico de cada prazo) le o historico inteiro: e refeita so de hora em hora.
const typicalCache = new Map(); // simbolo -> { at, value }
function typicalFor(db, symbol) {
  const hit = typicalCache.get(symbol);
  if (hit && Date.now() - hit.at < 60 * MINUTE) return hit.value;
  const value = typicalMoves(db.closes(symbol), NOTE_HORIZONS);
  typicalCache.set(symbol, { at: Date.now(), value });
  return value;
}

// O que seria carimbado se uma anotacao fosse gravada agora. `feedAgeMs` = ha quanto tempo
// chegou o ultimo candle ao vivo (Infinity = sem conexao ao vivo).
//
// O minuto de referencia e o candle em formacao: o mais novo do banco. Se o mais novo ja esta
// fechado (virada de minuto: o fechamento chegou e o primeiro negocio do minuto seguinte ainda
// nao), a referencia e o minuto seguinte, nunca um que ja acabou.
export function liveRef(db, symbol, feedAgeMs) {
  const lastOpen = db.lastOpenTime(symbol);
  if (!(feedAgeMs <= MAX_FEED_AGE) || lastOpen == null) return { fresh: false, refTime: null, price: null };
  const lastClosed = db.lastClosedTime(symbol);
  return {
    fresh: true,
    refTime: Math.max(lastOpen, lastClosed == null ? lastOpen : lastClosed + MINUTE),
    price: db.candleAt(symbol, lastOpen)?.close ?? null, // o preco que esta na tela agora
  };
}

// O mesmo, pronto para a tela (que consulta isto de 2 em 2 segundos).
export function liveView(db, symbol, feedAgeMs) {
  return { ...liveRef(db, symbol, feedAgeMs), feedAgeMs: Number.isFinite(feedAgeMs) ? Math.round(feedAgeMs) : null };
}

export function listNotes(db, symbol, { feePct = REPLAY_FEE_PCT, feedAgeMs = Infinity } = {}) {
  const src = {
    candleAt: (t) => db.candleAt(symbol, t),
    windowStats: (from, to) => db.windowStats(symbol, from, to),
    lastClosedTime: db.lastClosedTime(symbol) ?? -Infinity,
  };
  const notes = db.noteList(symbol).map((n) => {
    const s = scoreCached(db, src, n, feePct);
    return { ...n, refPrice: s.refPrice ?? refPriceOf(src, n), score: s };
  });
  return {
    symbol, horizons: NOTE_HORIZONS, feePct, typical: typicalFor(db, symbol),
    lastClosedTime: Number.isFinite(src.lastClosedTime) ? src.lastClosedTime : null,
    live: liveView(db, symbol, feedAgeMs),
    kinds: [...new Set(notes.map((n) => n.kind))].sort(), // assuntos ja usados (a tela soma os sugeridos)
    notes, summary: summarize(notes),
  };
}

// Grava uma anotacao. A hora e o minuto de referencia sao daqui, nunca de quem chama.
export function addNote(db, symbol, input, { now = Date.now(), feedAgeMs = Infinity } = {}) {
  const n = normalizeNote(input);
  const live = liveRef(db, symbol, feedAgeMs);
  if (n.side && !live.fresh) {
    throw new Error(Number.isFinite(feedAgeMs)
      ? `o preco ao vivo esta parado ha ${Math.round(feedAgeMs / 1000)} s: nao da para registrar uma previsao agora. Tente de novo em instantes (a anotacao sem previsao pode ser gravada)`
      : 'sem preco ao vivo da Binance: nao da para registrar uma previsao agora (a anotacao sem previsao pode ser gravada)');
  }
  // Sem preco ao vivo a anotacao simples entra sem minuto de referencia: o do banco estaria velho.
  return db.noteAdd({ symbol, time: now, ...n, refTime: live.refTime, seenPrice: live.price });
}

// ---------- rotas HTTP ----------
// So ler e gravar. Nao existe rota para alterar nem para apagar.
// `feedAgeMs()` diz ha quanto tempo chegou o ultimo candle ao vivo (ver src/server.js).
export async function handleNotes(req, res, url, { db, symbol, json, feedAgeMs = () => Infinity }) {
  if (url.pathname !== '/api/notes' && !url.pathname.startsWith('/api/notes/')) return false;
  try {
    // O que seria carimbado agora: a tela mostra isto ao lado do formulario.
    if (url.pathname === '/api/notes/now' && req.method === 'GET') {
      json(res, 200, liveView(db, symbol, feedAgeMs()));
      return true;
    }
    if (url.pathname !== '/api/notes') {
      json(res, 404, { error: 'rota do caderno desconhecida' });
      return true;
    }
    if (req.method === 'GET') {
      json(res, 200, listNotes(db, symbol, { feedAgeMs: feedAgeMs() }));
      return true;
    }
    if (req.method === 'POST') {
      if (!isJson(req)) {
        json(res, 415, { error: 'envie JSON (content-type: application/json)' });
        return true;
      }
      const body = await readJson(req);
      // A idade do preco e lida so agora, no instante do carimbo, depois de o pedido chegar inteiro.
      const id = addNote(db, symbol, body, { feedAgeMs: feedAgeMs() });
      json(res, 200, { added: id, ...listNotes(db, symbol, { feedAgeMs: feedAgeMs() }) });
      return true;
    }
    json(res, 405, { error: 'o caderno so aceita ler e gravar: uma anotacao nao pode ser alterada nem apagada' });
  } catch (err) {
    json(res, 400, { error: String(err?.message || err) });
  }
  return true;
}
