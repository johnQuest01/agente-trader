// Junta candles de 1 minuto em candles maiores (5m, 1h, 1d...).
// `rows` precisa estar em ordem crescente de openTime.
export function aggregate(rows, bucketMs) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const start = Math.floor(r.openTime / bucketMs) * bucketMs;
    if (!cur || cur.openTime !== start) {
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
  }
  return out;
}
