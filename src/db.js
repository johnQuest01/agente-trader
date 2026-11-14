import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Banco SQLite local usando o modulo embutido do Node (sem dependencias).
export async function openDb(file) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(file), { recursive: true });
  // timeout: se outro processo (ex.: scripts/validar.js ou uma segunda instancia) estiver com o
  // arquivo travado, espera ate 5 s em vez de falhar na hora com "database is locked".
  const db = new DatabaseSync(file, { timeout: 5000 });

  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS candles (
      symbol            TEXT    NOT NULL,
      open_time         INTEGER NOT NULL,  -- inicio do minuto, em ms (UTC)
      open              REAL    NOT NULL,
      high              REAL    NOT NULL,
      low               REAL    NOT NULL,
      close             REAL    NOT NULL,
      volume            REAL    NOT NULL,  -- volume total (moeda base, ex.: BTC)
      quote_volume      REAL    NOT NULL,  -- volume total em USDT
      trades            INTEGER NOT NULL,  -- numero de negocios
      taker_buy_volume  REAL    NOT NULL,  -- volume de agressao compradora
      closed            INTEGER NOT NULL,  -- 1 = candle fechado
      PRIMARY KEY (symbol, open_time)
    ) WITHOUT ROWID;

    -- Fase 2. Negocios agregados (aggTrades) crus. A chave comeca pelo horario para que as
    -- leituras por periodo usem a propria tabela, sem indice extra (sao milhoes de linhas).
    -- O id cresce junto com o horario, entao a ordem (time, id) e a ordem dos negocios.
    CREATE TABLE IF NOT EXISTS agg_trades (
      symbol     TEXT    NOT NULL,
      time       INTEGER NOT NULL,  -- horario do negocio, em ms (UTC)
      id         INTEGER NOT NULL,  -- aggTradeId da Binance: sequencial por par, sem buracos
      price      REAL    NOT NULL,
      qty        REAL    NOT NULL,  -- quantidade (moeda base, ex.: BTC)
      trades     INTEGER NOT NULL,  -- quantos negocios individuais este agregado junta
      taker_buy  INTEGER NOT NULL,  -- 1 = quem agrediu foi o COMPRADOR; 0 = o vendedor
      PRIMARY KEY (symbol, time, id)
    ) WITHOUT ROWID;

    -- Fluxo por minuto, calculado a partir dos negocios. Fica para sempre.
    CREATE TABLE IF NOT EXISTS flow_1m (
      symbol      TEXT    NOT NULL,
      open_time   INTEGER NOT NULL,  -- inicio do minuto, em ms (UTC)
      buy_qty     REAL    NOT NULL,  -- volume de agressao compradora (moeda base)
      sell_qty    REAL    NOT NULL,  -- volume de agressao vendedora
      buy_quote   REAL    NOT NULL,  -- idem, em USDT
      sell_quote  REAL    NOT NULL,
      buy_trades  INTEGER NOT NULL,  -- negocios individuais por lado agressor
      sell_trades INTEGER NOT NULL,
      first_id    INTEGER NOT NULL,  -- primeiro e ultimo aggTradeId do minuto
      last_id     INTEGER NOT NULL,
      complete    INTEGER NOT NULL,  -- 1 = todos os negocios do minuto foram contados
      PRIMARY KEY (symbol, open_time)
    ) WITHOUT ROWID;

    -- Ordens agressoras grandes. Uma ordem a mercado que varre varios precos aparece na
    -- Binance como varios negocios no mesmo milissegundo e do mesmo lado; aqui eles estao
    -- somados em uma linha so. Fica para sempre.
    CREATE TABLE IF NOT EXISTS big_orders (
      symbol      TEXT    NOT NULL,
      first_id    INTEGER NOT NULL,  -- primeiro aggTradeId da ordem
      last_id     INTEGER NOT NULL,
      time        INTEGER NOT NULL,
      taker_buy   INTEGER NOT NULL,  -- 1 = compra agressora; 0 = venda agressora
      qty         REAL    NOT NULL,
      quote       REAL    NOT NULL,  -- valor em USDT
      price_first REAL    NOT NULL,  -- preco do primeiro e do ultimo negocio da ordem
      price_last  REAL    NOT NULL,
      prints      INTEGER NOT NULL,  -- em quantos negocios agregados (precos) ela se quebrou
      PRIMARY KEY (symbol, first_id)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS big_orders_time ON big_orders (symbol, time);
  `);

  // Um candle gravado nunca anda para tras. O historico (REST) e o fluxo ao vivo (WebSocket)
  // gravam ao mesmo tempo, e uma resposta do historico pode chegar atrasada, com uma foto do
  // candle mais velha do que a que ja esta no banco. Por isso a gravacao so substitui quando:
  //   - o novo esta fechado e o do banco ainda nao (o definitivo troca o provisorio); ou
  //   - os dois estao no mesmo estado e o novo tem pelo menos tantos negocios quanto o do
  //     banco (o numero de negocios de um candle so cresce, entao serve de "versao").
  // Um candle provisorio nunca substitui um fechado.
  const upsertStmt = db.prepare(`
    INSERT INTO candles
      (symbol, open_time, open, high, low, close, volume, quote_volume, trades, taker_buy_volume, closed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (symbol, open_time) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
      volume = excluded.volume, quote_volume = excluded.quote_volume, trades = excluded.trades,
      taker_buy_volume = excluded.taker_buy_volume, closed = excluded.closed
    WHERE excluded.closed > candles.closed
       OR (excluded.closed = candles.closed AND excluded.trades >= candles.trades)
  `);
  const firstStmt = db.prepare('SELECT MIN(open_time) AS t FROM candles WHERE symbol = ?');
  const lastStmt = db.prepare('SELECT MAX(open_time) AS t FROM candles WHERE symbol = ?');
  // Primeiro candle que ainda nao sabemos estar fechado: e dali que o download retoma,
  // para que dados provisorios sejam sempre substituidos pelos definitivos.
  const firstUnclosedStmt = db.prepare('SELECT MIN(open_time) AS t FROM candles WHERE symbol = ? AND closed = 0');
  const countStmt = db.prepare('SELECT COUNT(*) AS n FROM candles WHERE symbol = ?');
  const rangeStmt = db.prepare(`
    SELECT open_time AS openTime, open, high, low, close, volume,
           quote_volume AS quoteVolume, trades, taker_buy_volume AS takerBuyVolume, closed
    FROM candles
    WHERE symbol = ? AND open_time >= ? AND open_time <= ?
    ORDER BY open_time
  `);

  const run = (c) =>
    upsertStmt.run(
      c.symbol, c.openTime, c.open, c.high, c.low, c.close,
      c.volume, c.quoteVolume, c.trades, c.takerBuyVolume, c.closed ? 1 : 0,
    );

  // ---------- Fase 2: negocios, fluxo e ordens grandes ----------
  // O mesmo negocio pode chegar duas vezes (pelo historico e pelo ao vivo): o segundo e ignorado.
  const tradeStmt = db.prepare(`
    INSERT OR IGNORE INTO agg_trades (symbol, time, id, price, qty, trades, taker_buy)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const TRADE_COLS = 'time, id, price, qty, trades, taker_buy AS takerBuy';
  const lastTradeStmt = db.prepare(`SELECT ${TRADE_COLS} FROM agg_trades WHERE symbol = ? ORDER BY time DESC, id DESC LIMIT 1`);
  const firstTradeStmt = db.prepare(`SELECT ${TRADE_COLS} FROM agg_trades WHERE symbol = ? ORDER BY time, id LIMIT 1`);
  // Negocios depois de uma posicao (horario, id) e com horario ANTES de um limite, em ordem.
  const tradesAfterStmt = db.prepare(`
    SELECT ${TRADE_COLS} FROM agg_trades
    WHERE symbol = ? AND (time, id) > (?, ?) AND time < ?
    ORDER BY time, id LIMIT ?
  `);
  const deleteTradesStmt = db.prepare('DELETE FROM agg_trades WHERE symbol = ? AND time < ?');
  const firstAfterStmt = db.prepare(`
    SELECT ${TRADE_COLS} FROM agg_trades WHERE symbol = ? AND (time, id) > (?, ?) ORDER BY time, id LIMIT 1
  `);
  // Primeiro salto de id a partir de uma posicao: o negocio cujo seguinte nao e "id + 1".
  const holeStmt = db.prepare(`
    SELECT id, time, next_id AS nextId, next_time AS nextTime FROM (
      SELECT id, time, LEAD(id) OVER w AS next_id, LEAD(time) OVER w AS next_time
      FROM agg_trades WHERE symbol = ? AND (time, id) >= (?, ?)
      WINDOW w AS (ORDER BY time, id)
    ) WHERE next_id IS NOT NULL AND next_id != id + 1 LIMIT 1
  `);

  // Um minuto ja contado como completo nunca volta a ser incompleto por uma recontagem parcial.
  const flowStmt = db.prepare(`
    INSERT INTO flow_1m
      (symbol, open_time, buy_qty, sell_qty, buy_quote, sell_quote, buy_trades, sell_trades, first_id, last_id, complete)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (symbol, open_time) DO UPDATE SET
      buy_qty = excluded.buy_qty, sell_qty = excluded.sell_qty,
      buy_quote = excluded.buy_quote, sell_quote = excluded.sell_quote,
      buy_trades = excluded.buy_trades, sell_trades = excluded.sell_trades,
      first_id = excluded.first_id, last_id = excluded.last_id, complete = excluded.complete
    WHERE excluded.complete >= flow_1m.complete
  `);
  const FLOW_COLS = `open_time AS openTime, buy_qty AS buyQty, sell_qty AS sellQty, buy_quote AS buyQuote,
    sell_quote AS sellQuote, buy_trades AS buyTrades, sell_trades AS sellTrades,
    first_id AS firstId, last_id AS lastId, complete`;
  const lastFlowStmt = db.prepare(`SELECT ${FLOW_COLS} FROM flow_1m WHERE symbol = ? ORDER BY open_time DESC LIMIT 1`);
  const firstFlowStmt = db.prepare('SELECT MIN(open_time) AS t FROM flow_1m WHERE symbol = ?');
  const flowRangeStmt = db.prepare(`
    SELECT ${FLOW_COLS} FROM flow_1m WHERE symbol = ? AND open_time >= ? AND open_time <= ? ORDER BY open_time
  `);

  const bigStmt = db.prepare(`
    INSERT OR REPLACE INTO big_orders
      (symbol, first_id, last_id, time, taker_buy, qty, quote, price_first, price_last, prints)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bigRecentStmt = db.prepare(`
    SELECT first_id AS firstId, last_id AS lastId, time, taker_buy AS takerBuy, qty, quote,
           price_first AS priceFirst, price_last AS priceLast, prints
    FROM big_orders WHERE symbol = ? AND quote >= ? AND time <= ?
    ORDER BY time DESC, first_id DESC LIMIT ?
  `);

  const tx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    upsert: run,
    upsertMany: (candles) => tx(() => { for (const c of candles) run(c); }),
    firstOpenTime: (symbol) => firstStmt.get(symbol).t ?? null,
    lastOpenTime: (symbol) => lastStmt.get(symbol).t ?? null,
    firstUnclosedOpenTime: (symbol) => firstUnclosedStmt.get(symbol).t ?? null,
    count: (symbol) => countStmt.get(symbol).n,
    range: (symbol, from, to) => rangeStmt.all(symbol, from, to),

    tx,
    insertTrades: (trades) => tx(() => {
      for (const t of trades) tradeStmt.run(t.symbol, t.time, t.id, t.price, t.qty, t.trades, t.takerBuy ? 1 : 0);
    }),
    lastTrade: (symbol) => lastTradeStmt.get(symbol) ?? null,
    firstTrade: (symbol) => firstTradeStmt.get(symbol) ?? null,
    tradesAfter: (symbol, time, id, beforeTime, limit) => tradesAfterStmt.all(symbol, time, id, beforeTime, limit),
    deleteTradesBefore: (symbol, time) => Number(deleteTradesStmt.run(symbol, time).changes),
    // Primeiro buraco de negocios depois de uma posicao. `prevId` e o id do negocio daquela
    // posicao (ou null se nao ha anterior). Devolve { afterId, afterTime, nextId, nextTime }:
    // faltam os ids entre afterId e nextId. Devolve null se dali ate o fim esta tudo emendado.
    firstHoleAfter(symbol, { time, id, prevId }) {
      const first = firstAfterStmt.get(symbol, time, id);
      if (!first) return null;
      if (prevId !== null && first.id !== prevId + 1) {
        return { afterId: prevId, afterTime: time, nextId: first.id, nextTime: first.time };
      }
      const h = holeStmt.get(symbol, first.time, first.id);
      return h ? { afterId: h.id, afterTime: h.time, nextId: h.nextId, nextTime: h.nextTime } : null;
    },
    upsertFlow: (f) => flowStmt.run(
      f.symbol, f.openTime, f.buyQty, f.sellQty, f.buyQuote, f.sellQuote,
      f.buyTrades, f.sellTrades, f.firstId, f.lastId, f.complete ? 1 : 0,
    ),
    lastFlow: (symbol) => lastFlowStmt.get(symbol) ?? null,
    firstFlowTime: (symbol) => firstFlowStmt.get(symbol).t ?? null,
    flowRange: (symbol, from, to) => flowRangeStmt.all(symbol, from, to),
    upsertBig: (o) => bigStmt.run(
      o.symbol, o.firstId, o.lastId, o.time, o.takerBuy ? 1 : 0, o.qty, o.quote, o.priceFirst, o.priceLast, o.prints,
    ),
    bigRecent: (symbol, minQuote, beforeTime, limit) => bigRecentStmt.all(symbol, minQuote, beforeTime, limit),

    close: () => db.close(),
  };
}
