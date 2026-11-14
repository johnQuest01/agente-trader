// Fase 2: coletor de negocios agregados (aggTrades), fluxo por minuto e ordens grandes.
//
// Garantia central: o banco nao tem buraco de negocios sem que isso fique marcado. O id do
// negocio agregado e sequencial, entao da para saber exatamente o que falta e pedir a Binance
// a partir de um id. O fluxo por minuto e as ordens grandes sao calculados lendo os negocios do
// banco em ordem, e um minuto so e marcado como completo se os ids emendam do comeco ao fim.
import { MINUTE, TRADES_KEEP_DAYS, TRADES_BACKFILL_HOURS, TRADES_MAX_GAP_HOURS, BIG_ORDER_USDT } from './config.js';
import { fetchAggTrades, streamAggTrades } from './binance.js';

const HOUR = 60 * MINUTE;
const UNITS = 1e8; // as quantidades sao somadas em inteiros de 1e-8, para a soma ser exata
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minuteOf = (t) => Math.floor(t / MINUTE) * MINUTE;
const hm = (t) => new Date(t).toISOString().slice(11, 16);

export function startTrades({ db, symbol, log = () => {}, onStatus, onFlow, onBig }) {
  const status = { live: false, filling: false };
  let stopped = false;
  let buffer = [];         // negocios ao vivo ainda nao gravados
  let firstLiveId = null;  // primeiro negocio recebido na conexao atual
  let latestTime = db.lastTrade(symbol)?.time ?? 0; // horario do negocio mais recente no banco
  let syncing = null;
  let retryTimer = null;
  let lastFlowSent = 0;

  const emitStatus = () => onStatus?.({ ...status });

  // ---------- leitura em ordem: fluxo por minuto e ordens grandes ----------
  // `cursor` e o ultimo negocio ja lido; `prevId` e o id dele (para conferir a emenda).
  // Ao iniciar, retoma logo depois do ultimo minuto ja fechado no banco.
  const lastFlow = db.lastFlow(symbol);
  let cursor = lastFlow ? { time: lastFlow.openTime + MINUTE - 1, id: Number.MAX_SAFE_INTEGER } : { time: -1, id: 0 };
  let prevId = lastFlow ? lastFlow.lastId : null;
  let acc = null; // minuto em formacao
  let grp = null; // ordem agressora em formacao

  const flowRow = (a, complete) => ({
    symbol, openTime: a.openTime,
    buyQty: a.buyUnits / UNITS, sellQty: a.sellUnits / UNITS,
    buyQuote: a.buyQuote, sellQuote: a.sellQuote,
    buyTrades: a.buyTrades, sellTrades: a.sellTrades,
    firstId: a.firstId, lastId: a.lastId, complete,
  });

  function closeGroup() {
    if (!grp) return;
    const g = grp;
    grp = null;
    if (g.quote < BIG_ORDER_USDT) return;
    const order = {
      symbol, firstId: g.firstId, lastId: g.lastId, time: g.time, takerBuy: g.takerBuy,
      qty: g.units / UNITS, quote: g.quote, priceFirst: g.priceFirst, priceLast: g.priceLast, prints: g.prints,
    };
    db.upsertBig(order);
    // So avisa a tela das recentes: ao reiniciar, a releitura passa de novo pelas antigas.
    if (latestTime - g.time < 2 * MINUTE) onBig?.(order);
  }

  function step(r) {
    const m = minuteOf(r.time);
    const gap = prevId === null || r.id !== prevId + 1; // este negocio nao emenda no anterior

    if (acc && m !== acc.openTime) {
      // Fecha o minuto anterior. Ele so e completo se emenda com o primeiro negocio do
      // minuto seguinte: senao, pode ter ficado sem os ultimos negocios.
      db.upsertFlow(flowRow(acc, acc.complete && !gap));
      acc = null;
    }
    if (!acc) {
      acc = {
        openTime: m, buyUnits: 0, sellUnits: 0, buyQuote: 0, sellQuote: 0, buyTrades: 0, sellTrades: 0,
        firstId: r.id, lastId: r.id,
        complete: !gap, // sem emenda com o anterior, pode ter ficado sem os primeiros negocios
      };
    } else if (gap) {
      acc.complete = false;
    }

    const units = Math.round(r.qty * UNITS);
    const quote = r.price * r.qty;
    if (r.takerBuy) { acc.buyUnits += units; acc.buyQuote += quote; acc.buyTrades += r.trades; }
    else { acc.sellUnits += units; acc.sellQuote += quote; acc.sellTrades += r.trades; }
    acc.lastId = r.id;

    // Ordem agressora: negocios seguidos, no mesmo milissegundo e do mesmo lado. Uma ordem a
    // mercado que varre varios precos chega assim, quebrada em um negocio por preco.
    if (grp && !gap && grp.time === r.time && grp.takerBuy === r.takerBuy) {
      grp.units += units; grp.quote += quote; grp.lastId = r.id; grp.priceLast = r.price; grp.prints += 1;
    } else {
      closeGroup();
      grp = {
        firstId: r.id, lastId: r.id, time: r.time, takerBuy: r.takerBuy,
        units, quote, priceFirst: r.price, priceLast: r.price, prints: 1,
      };
    }

    prevId = r.id;
    cursor = { time: r.time, id: r.id };
  }

  // Le os negocios novos, em ordem. Para ANTES do horario mais recente: os negocios do ultimo
  // milissegundo ainda podem estar chegando, e uma ordem agressora e feita de negocios do mesmo
  // instante. So roda com o banco emendado (fora de um preenchimento de buraco).
  function scan() {
    for (;;) {
      const rows = db.tradesAfter(symbol, cursor.time, cursor.id, latestTime, 20_000);
      if (!rows.length) break;
      db.tx(() => { for (const r of rows) step(r); });
      if (rows.length < 20_000) break;
    }
    // Tudo com horario anterior ao mais recente ja foi lido: a ordem em formacao esta inteira.
    if (grp) db.tx(closeGroup);
    if (acc && Date.now() - lastFlowSent >= 1000) {
      lastFlowSent = Date.now();
      onFlow?.(flowRow(acc, false));
    }
  }

  // Grava no banco o que o fluxo ao vivo entregou. Devolve false se nao conseguiu gravar.
  function flushBuffer() {
    if (!buffer.length) return true;
    const batch = buffer;
    buffer = [];
    try {
      db.insertTrades(batch);
    } catch (err) {
      // Banco ocupado por outro processo: guarda de volta e tenta no proximo ciclo.
      buffer = batch.concat(buffer);
      log(`negocios: falha ao gravar (${err.message}); tento de novo`);
      return false;
    }
    latestTime = Math.max(latestTime, batch.at(-1).time);
    return true;
  }

  function flush() {
    if (!flushBuffer() || status.filling) return;
    try {
      scan();
    } catch (err) {
      log(`negocios: falha ao calcular o fluxo (${err.message})`);
    }
  }

  // ---------- emenda com o que ficou para tras ----------
  let downloaded = 0;

  // Baixa pelo historico (REST) os negocios a partir de `fromId`. Com `untilId`, para ao
  // alcancar esse id (que ja esta no banco); sem ele, vai ate a ponta do historico.
  async function download(fromId, untilId = null) {
    for (let empty = 0; !stopped;) {
      const rows = await fetchAggTrades(symbol, { fromId });
      const useful = untilId === null ? rows : rows.filter((r) => r.id < untilId);
      if (useful.length) {
        db.insertTrades(useful);
        latestTime = Math.max(latestTime, useful.at(-1).time);
        const before = downloaded;
        downloaded += useful.length;
        if (Math.floor(downloaded / 50_000) > Math.floor(before / 50_000)) {
          log(`  negocios: ${downloaded} baixados (ate ${hm(useful.at(-1).time)} UTC)`);
        }
      }
      if (rows.length) fromId = rows.at(-1).id + 1;
      if (untilId === null ? rows.length < 1000 : fromId >= untilId) return;
      // O historico pode estar alguns instantes atras do ao vivo: espera um pouco e pede de novo.
      if (!rows.length && ++empty > 100) throw new Error('o historico nao alcancou o fluxo ao vivo');
      await sleep(rows.length ? 80 : 300);
    }
  }

  // Deixa o banco emendado: preenche todo buraco de ids entre o ponto de leitura e o que o
  // fluxo ao vivo ja entregou. Um buraco aparece a cada reconexao (o trecho em que o programa
  // ficou fora) e tambem se uma emenda anterior foi interrompida no meio. Como o id e
  // sequencial, a emenda e exata.
  async function fillGap() {
    const [tip] = await fetchAggTrades(symbol, { limit: 1 }); // o negocio mais recente na Binance
    if (!tip) return;
    const tooOld = (t) => tip.time - t > TRADES_MAX_GAP_HOURS * HOUR;

    // Banco vazio, ou parado ha tempo demais: recomeca de algumas horas atras. O trecho que
    // fica para tras nao e baixado; os minutos dele saem marcados como incompletos.
    const last = db.lastTrade(symbol);
    if (!last || tooOld(last.time)) {
      if (last) log(`negocios: parado ha mais de ${TRADES_MAX_GAP_HOURS} h; o trecho perdido nao sera baixado e fica marcado como incompleto`);
      let fromId = tip.id;
      if (TRADES_BACKFILL_HOURS > 0) {
        const since = tip.time - TRADES_BACKFILL_HOURS * HOUR;
        const [first] = await fetchAggTrades(symbol, { startTime: since, endTime: since + HOUR - 1, limit: 1 });
        if (first) fromId = first.id;
      }
      await download(Math.max(fromId, last ? last.id + 1 : 0));
    }

    let pos = { time: cursor.time, id: cursor.id, prevId };
    for (let waited = 0; !stopped;) {
      flushBuffer(); // o que o ao vivo ja entregou entra no banco, e a emenda que falta vira um buraco
      const hole = db.firstHoleAfter(symbol, pos);
      if (hole) {
        if (!tooOld(hole.afterTime)) await download(hole.afterId + 1, hole.nextId);
        else pos = { time: hole.nextTime, id: hole.nextId, prevId: hole.nextId }; // velho demais: pula
        continue;
      }
      // Dali ate o ultimo negocio do banco esta tudo emendado.
      if (firstLiveId !== null) return; // e o ao vivo desta conexao ja esta gravando
      // Ainda nao chegou negocio ao vivo: vai ate a ponta do historico e espera um pouco por ele.
      const end = db.lastTrade(symbol);
      await download(end ? end.id + 1 : tip.id);
      if (!status.live || ++waited > 10) return;
      await sleep(500);
    }
  }

  function sync() {
    if (syncing) return syncing;
    clearTimeout(retryTimer);
    status.filling = true;
    emitStatus();
    syncing = (async () => {
      try {
        downloaded = 0;
        await fillGap();
        log(`negocios em dia: ${downloaded} baixados pelo historico`);
        status.filling = false;
        flush();
      } catch (err) {
        // Continua "preenchendo": o buraco existe ate uma tentativa dar certo, e ate la o
        // fluxo por minuto nao avanca (para nao contar minuto com negocio faltando).
        log(`negocios: falha ao baixar o historico (${err.message}); tento de novo em 30s`);
        retryTimer = setTimeout(sync, 30_000);
        retryTimer.unref();
      } finally {
        syncing = null;
        emitStatus();
      }
    })();
    return syncing;
  }

  // ---------- limpeza dos negocios antigos ----------
  function prune() {
    const first = db.firstTrade(symbol);
    if (!first) return;
    // Nunca apaga o que ainda nao foi lido para o fluxo.
    const cutoff = Math.min(minuteOf(latestTime) - TRADES_KEEP_DAYS * 24 * HOUR, minuteOf(cursor.time) - MINUTE);
    let n = 0;
    for (let t = first.time; t < cutoff;) {
      t = Math.min(t + HOUR, cutoff);
      n += db.deleteTradesBefore(symbol, t);
    }
    if (n) log(`negocios: ${n} antigos apagados (ficam os ultimos ${TRADES_KEEP_DAYS} dias; fluxo e ordens grandes ficam para sempre)`);
  }

  const stopStream = streamAggTrades(symbol, {
    log,
    onOpen: () => {
      firstLiveId = null; // a emenda e com o primeiro negocio desta conexao
      sync();
    },
    onStatus: (live) => {
      status.live = live;
      emitStatus();
    },
    onTrade: (t) => {
      if (firstLiveId === null) firstLiveId = t.id;
      buffer.push(t);
    },
  });

  const flushTimer = setInterval(flush, 500);
  const pruneTimer = setInterval(() => { try { prune(); } catch (err) { log(`negocios: falha na limpeza (${err.message})`); } }, HOUR);
  pruneTimer.unref();

  return {
    status: () => ({ ...status }),
    stop: () => {
      stopped = true;
      clearInterval(flushTimer);
      clearInterval(pruneTimer);
      clearTimeout(retryTimer);
      stopStream();
      try { flush(); } catch {}
    },
  };
}
