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

    -- Livro de ofertas, um resumo por segundo. b1..b6 = quantidade ofertada na COMPRA ate cada
    -- faixa de distancia do preco medio; a1..a6 = idem na VENDA. As faixas estao em
    -- BOOK_BANDS (src/book.js): 0,02%, 0,05%, 0,1%, 0,2%, 0,5% e 1%. NULL = a faixa passa do
    -- trecho do livro que conhecemos.
    CREATE TABLE IF NOT EXISTS book_1s (
      symbol TEXT NOT NULL,
      time   INTEGER NOT NULL,  -- o segundo, em ms (UTC)
      bid    REAL NOT NULL,     -- melhor oferta de compra
      ask    REAL NOT NULL,     -- melhor oferta de venda
      b1 REAL, a1 REAL, b2 REAL, a2 REAL, b3 REAL, a3 REAL,
      b4 REAL, a4 REAL, b5 REAL, a5 REAL, b6 REAL, a6 REAL,
      PRIMARY KEY (symbol, time)
    ) WITHOUT ROWID;

    -- O mesmo resumo, em media por minuto. Fica para sempre.
    CREATE TABLE IF NOT EXISTS book_1m (
      symbol  TEXT NOT NULL,
      time    INTEGER NOT NULL,  -- inicio do minuto, em ms (UTC)
      samples INTEGER NOT NULL,  -- quantos segundos entraram na media (60 = minuto inteiro)
      spread  REAL NOT NULL,     -- media de (venda - compra)
      bid     REAL NOT NULL,     -- melhor compra e melhor venda no ultimo segundo do minuto
      ask     REAL NOT NULL,
      b1 REAL, a1 REAL, b2 REAL, a2 REAL, b3 REAL, a3 REAL,
      b4 REAL, a4 REAL, b5 REAL, a5 REAL, b6 REAL, a6 REAL,
      PRIMARY KEY (symbol, time)
    ) WITHOUT ROWID;

    -- Maiores ofertas paradas no livro ("paredes"), de 10 em 10 segundos.
    CREATE TABLE IF NOT EXISTS book_walls (
      symbol TEXT NOT NULL,
      time   INTEGER NOT NULL,
      is_bid INTEGER NOT NULL,  -- 1 = oferta de compra; 0 = oferta de venda
      rank   INTEGER NOT NULL,  -- 1 = a maior daquele lado naquele instante
      price  REAL NOT NULL,
      qty    REAL NOT NULL,
      PRIMARY KEY (symbol, time, is_bid, rank)
    ) WITHOUT ROWID;

    -- Fase 3. Sessoes de replay: um periodo passado revelado candle a candle.
    CREATE TABLE IF NOT EXISTS replay_sessions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol     TEXT    NOT NULL,
      tf         TEXT    NOT NULL,     -- tempo grafico da sessao (ex.: 5m)
      start_time INTEGER NOT NULL,     -- abertura do primeiro candle a revelar (ms UTC)
      end_time   INTEGER NOT NULL,     -- fim do periodo (exclusivo)
      cursor     INTEGER NOT NULL,     -- abertura do ultimo candle ja revelado
      context    INTEGER NOT NULL,     -- quantos candles anteriores ao inicio ficam visiveis
      hidden     INTEGER NOT NULL,     -- 1 = data e preco disfarcados ate a sessao acabar
      scale      REAL    NOT NULL,     -- fator dos precos mostrados (1 quando nao disfarcada)
      time_shift INTEGER NOT NULL,     -- deslocamento dos horarios mostrados (0 quando nao disfarcada)
      fee_pct    REAL    NOT NULL,     -- taxa por lado usada nas contas desta sessao
      created_at INTEGER NOT NULL
    );

    -- Operacoes registradas no replay. O preco de entrada e sempre o fechamento do ultimo
    -- candle revelado na hora do registro; o resultado so e preenchido pelos candles
    -- revelados depois. Precos reais (nunca os disfarcados).
    CREATE TABLE IF NOT EXISTS replay_trades (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL,
      made_at    INTEGER NOT NULL,     -- relogio real em que foi registrada
      entry_time INTEGER NOT NULL,     -- candle em que foi registrada
      side       TEXT    NOT NULL,     -- 'buy' ou 'sell'
      entry      REAL    NOT NULL,
      stop       REAL    NOT NULL,
      target     REAL,                 -- opcional
      max_bars   INTEGER NOT NULL,     -- prazo maximo, em candles
      reason     TEXT,                 -- por que entrou (texto livre)
      bars       INTEGER NOT NULL DEFAULT 0,  -- candles ja passados com a operacao aberta
      worst      REAL,                 -- pior preco visto com a operacao aberta
      best       REAL,                 -- melhor preco visto
      exit_time  INTEGER,              -- preenchidos quando a operacao termina
      exit       REAL,
      exit_kind  TEXT                  -- 'stop', 'target', 'time', 'manual' ou 'end'
    );
    CREATE INDEX IF NOT EXISTS replay_trades_session ON replay_trades (session_id, id);

    -- Fase 4. Eventos e noticias, com o horario exato em que aconteceram.
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol     TEXT    NOT NULL,
      time       INTEGER NOT NULL,  -- horario exato do evento, em ms (UTC)
      title      TEXT    NOT NULL,
      kind       TEXT    NOT NULL,  -- tipo, em texto livre (ex.: macro, cripto, regulacao)
      importance INTEGER NOT NULL,  -- 1 (baixa), 2 (media) ou 3 (alta)
      source     TEXT,              -- de onde veio (nome ou link)
      note       TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (symbol, time, title)
    );
    CREATE INDEX IF NOT EXISTS events_time ON events (symbol, time);
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

  // ---------- Fase 2: livro de ofertas ----------
  const BANDS_SQL = 'b1, a1, b2, a2, b3, a3, b4, a4, b5, a5, b6, a6';
  const bookStmt = db.prepare(`
    INSERT OR REPLACE INTO book_1s (symbol, time, bid, ask, ${BANDS_SQL}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const bookMinStmt = db.prepare(`
    INSERT OR REPLACE INTO book_1m (symbol, time, samples, spread, bid, ask, ${BANDS_SQL})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const wallStmt = db.prepare('INSERT OR REPLACE INTO book_walls (symbol, time, is_bid, rank, price, qty) VALUES (?, ?, ?, ?, ?, ?)');
  const deleteBookStmt = db.prepare('DELETE FROM book_1s WHERE symbol = ? AND time < ?');
  const deleteWallsStmt = db.prepare('DELETE FROM book_walls WHERE symbol = ? AND time < ?');
  // Intercala compra e venda de cada faixa, na ordem das colunas (b1, a1, b2, a2, ...).
  const bands = (r) => r.b.flatMap((v, i) => [v, r.a[i]]);

  // ---------- Fase 3: replay ----------
  const SESSION_COLS = `id, symbol, tf, start_time AS startTime, end_time AS endTime, cursor, context,
    hidden, scale, time_shift AS timeShift, fee_pct AS feePct, created_at AS createdAt`;
  const TRADE_ROW = `id, session_id AS sessionId, made_at AS madeAt, entry_time AS entryTime, side, entry, stop,
    target, max_bars AS maxBars, reason, bars, worst, best, exit_time AS exitTime, exit, exit_kind AS exitKind`;
  const sessionInsStmt = db.prepare(`
    INSERT INTO replay_sessions (symbol, tf, start_time, end_time, cursor, context, hidden, scale, time_shift, fee_pct, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const sessionGetStmt = db.prepare(`SELECT ${SESSION_COLS} FROM replay_sessions WHERE id = ?`);
  const sessionListStmt = db.prepare(`SELECT ${SESSION_COLS} FROM replay_sessions WHERE symbol = ? ORDER BY id DESC LIMIT 100`);
  const sessionCursorStmt = db.prepare('UPDATE replay_sessions SET cursor = ? WHERE id = ?');
  const rtradeInsStmt = db.prepare(`
    INSERT INTO replay_trades (session_id, made_at, entry_time, side, entry, stop, target, max_bars, reason, worst, best)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const rtradeListStmt = db.prepare(`SELECT ${TRADE_ROW} FROM replay_trades WHERE session_id = ? ORDER BY id`);
  const rtradeUpdStmt = db.prepare(`
    UPDATE replay_trades SET bars = ?, worst = ?, best = ?, exit_time = ?, exit = ?, exit_kind = ? WHERE id = ?
  `);

  // ---------- Fase 4: eventos ----------
  const eventInsStmt = db.prepare(`
    INSERT OR IGNORE INTO events (symbol, time, title, kind, importance, source, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const eventListStmt = db.prepare(`
    SELECT id, time, title, kind, importance, source, note, created_at AS createdAt
    FROM events WHERE symbol = ? AND time >= ? AND time <= ? ORDER BY time DESC LIMIT 2000
  `);
  const eventGetStmt = db.prepare('SELECT id, time, title, kind, importance, source, note FROM events WHERE id = ? AND symbol = ?');
  const eventDelStmt = db.prepare('DELETE FROM events WHERE id = ? AND symbol = ?');
  const candleAtStmt = db.prepare(`
    SELECT open_time AS openTime, open, high, low, close, volume, closed FROM candles WHERE symbol = ? AND open_time = ?
  `);
  // Resumo de um trecho de candles de 1m: quantos sao, a maior maxima, a menor minima e o volume.
  const windowStmt = db.prepare(`
    SELECT COUNT(*) AS n, MAX(high) AS high, MIN(low) AS low, COALESCE(SUM(volume), 0) AS volume
    FROM candles WHERE symbol = ? AND open_time >= ? AND open_time < ?
  `);
  const closesStmt = db.prepare('SELECT open_time AS openTime, close FROM candles WHERE symbol = ? AND closed = 1 ORDER BY open_time');
  const lastClosedStmt = db.prepare('SELECT MAX(open_time) AS t FROM candles WHERE symbol = ? AND closed = 1');

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

    // `r.b` e `r.a` sao as quantidades por faixa (compra e venda), na ordem de BOOK_BANDS.
    insertBook: (r) => bookStmt.run(r.symbol, r.time, r.bid, r.ask, ...bands(r)),
    insertBookMinute: (r) => bookMinStmt.run(r.symbol, r.time, r.samples, r.spread, r.bid, r.ask, ...bands(r)),
    insertWalls: (symbol, time, walls) => tx(() => {
      walls.bids.forEach((w, i) => wallStmt.run(symbol, time, 1, i + 1, w.price, w.qty));
      walls.asks.forEach((w, i) => wallStmt.run(symbol, time, 0, i + 1, w.price, w.qty));
    }),
    deleteBookBefore: (symbol, time) =>
      Number(deleteBookStmt.run(symbol, time).changes) + Number(deleteWallsStmt.run(symbol, time).changes),

    replayCreate: (s) => Number(sessionInsStmt.run(
      s.symbol, s.tf, s.startTime, s.endTime, s.cursor, s.context, s.hidden ? 1 : 0, s.scale, s.timeShift, s.feePct, s.createdAt,
    ).lastInsertRowid),
    replayGet: (id) => sessionGetStmt.get(id) ?? null,
    replayList: (symbol) => sessionListStmt.all(symbol),
    replaySetCursor: (id, cursor) => sessionCursorStmt.run(cursor, id),
    replayAddTrade: (t) => Number(rtradeInsStmt.run(
      t.sessionId, t.madeAt, t.entryTime, t.side, t.entry, t.stop, t.target ?? null, t.maxBars, t.reason ?? null, t.entry, t.entry,
    ).lastInsertRowid),
    replayTrades: (sessionId) => rtradeListStmt.all(sessionId),
    replayUpdateTrade: (t) => rtradeUpdStmt.run(
      t.bars, t.worst, t.best, t.exitTime ?? null, t.exit ?? null, t.exitKind ?? null, t.id,
    ),

    // Devolve true se gravou; false se ja existia um evento igual (mesmo horario e titulo).
    eventAdd: (e) => Number(eventInsStmt.run(
      e.symbol, e.time, e.title, e.kind, e.importance, e.source ?? null, e.note ?? null, e.createdAt,
    ).changes) > 0,
    eventList: (symbol, from = 0, to = Number.MAX_SAFE_INTEGER) => eventListStmt.all(symbol, from, to),
    eventGet: (symbol, id) => eventGetStmt.get(id, symbol) ?? null,
    eventDelete: (symbol, id) => Number(eventDelStmt.run(id, symbol).changes) > 0,
    candleAt: (symbol, openTime) => candleAtStmt.get(symbol, openTime) ?? null,
    windowStats: (symbol, from, to) => windowStmt.get(symbol, from, to),
    closes: (symbol) => closesStmt.all(symbol),
    lastClosedTime: (symbol) => lastClosedStmt.get(symbol).t ?? null,

    close: () => db.close(),
  };
}
