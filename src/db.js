import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Banco SQLite local usando o modulo embutido do Node (sem dependencias).
export async function openDb(file) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

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
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO candles
      (symbol, open_time, open, high, low, close, volume, quote_volume, trades, taker_buy_volume, closed)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (symbol, open_time) DO UPDATE SET
      open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
      volume = excluded.volume, quote_volume = excluded.quote_volume, trades = excluded.trades,
      taker_buy_volume = excluded.taker_buy_volume, closed = excluded.closed
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

  return {
    upsert: run,
    upsertMany(candles) {
      db.exec('BEGIN');
      try {
        for (const c of candles) run(c);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    firstOpenTime: (symbol) => firstStmt.get(symbol).t ?? null,
    lastOpenTime: (symbol) => lastStmt.get(symbol).t ?? null,
    firstUnclosedOpenTime: (symbol) => firstUnclosedStmt.get(symbol).t ?? null,
    count: (symbol) => countStmt.get(symbol).n,
    range: (symbol, from, to) => rangeStmt.all(symbol, from, to),
    close: () => db.close(),
  };
}
