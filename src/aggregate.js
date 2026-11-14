import { MINUTE } from './config.js';

// Junta candles de 1 minuto em candles maiores (5m, 1h, 1d...).
// `rows` precisa estar em ordem crescente de openTime.
//
// Cada bucket sai com `minutes` (quantos candles de 1m entraram) e `complete`
// (true so quando todos os minutos do bucket estao presentes e fechados).
// O primeiro bucket do historico e o bucket corrente normalmente sao parciais;
// quem consome (grafico, replay, indicadores) deve olhar `complete` antes de
// tratar o candle como definitivo.
export function aggregate(rows, bucketMs) {
  const perBucket = bucketMs / MINUTE;
  const out = [];
  let cur = null;
  for (const r of rows) {
    const start = Math.floor(r.openTime / bucketMs) * bucketMs;
    if (!cur || cur.openTime !== start) {
      if (cur) cur.complete = cur.minutes === perBucket && cur.allClosed;
      cur = {
        openTime: start,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: 0,
        quoteVolume: 0,
        trades: 0,
        takerBuyVolume: 0,
        minutes: 0,
        complete: false,
        allClosed: true,
      };
      out.push(cur);
    }
    if (r.high > cur.high) cur.high = r.high;
    if (r.low < cur.low) cur.low = r.low;
    cur.close = r.close;
    cur.volume += r.volume;
    cur.quoteVolume += r.quoteVolume;
    cur.trades += r.trades;
    cur.takerBuyVolume += r.takerBuyVolume;
    cur.minutes += 1;
    if (!r.closed) cur.allClosed = false;
  }
  if (cur) cur.complete = cur.minutes === perBucket && cur.allClosed;
  for (const b of out) delete b.allClosed;
  return out;
}

// Junta o fluxo de 1 minuto (tabela flow_1m) em periodos maiores. `rows` em ordem crescente.
// `complete` so e true quando todos os minutos do periodo estao presentes e completos: um
// periodo com negocios faltando subestima o volume dos dois lados.
export function aggregateFlow(rows, bucketMs) {
  const perBucket = bucketMs / MINUTE;
  const out = [];
  let cur = null;
  const close = (b) => { b.complete = b.minutes === perBucket && b.allComplete; delete b.allComplete; };
  for (const r of rows) {
    const start = Math.floor(r.openTime / bucketMs) * bucketMs;
    if (!cur || cur.openTime !== start) {
      if (cur) close(cur);
      cur = {
        openTime: start, buyQty: 0, sellQty: 0, buyQuote: 0, sellQuote: 0, buyTrades: 0, sellTrades: 0,
        minutes: 0, complete: false, allComplete: true,
      };
      out.push(cur);
    }
    cur.buyQty += r.buyQty;
    cur.sellQty += r.sellQty;
    cur.buyQuote += r.buyQuote;
    cur.sellQuote += r.sellQuote;
    cur.buyTrades += r.buyTrades;
    cur.sellTrades += r.sellTrades;
    cur.minutes += 1;
    if (!r.complete) cur.allComplete = false;
  }
  if (cur) close(cur);
  return out;
}
