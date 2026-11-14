// Configuracao central. Tudo pode ser trocado por variavel de ambiente.
// Fase 1 usa apenas dados PUBLICOS da Binance: nao precisa de chave de API.
import { fileURLToPath } from 'node:url';

export const SYMBOL = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();
export const PORT = Number(process.env.PORT || 3333);

// Quantos dias de historico de 1 minuto baixar na primeira execucao. O download comeca as
// 00:00 UTC do dia que cair nessa conta, entao vem ate um dia a mais (ver backfill).
export const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 30);

export const REST_URL = process.env.BINANCE_REST || 'https://api.binance.com';
export const WS_URL = process.env.BINANCE_WS || 'wss://stream.binance.com:9443';

// Arquivo do banco SQLite. Padrao: data/market.db na raiz do projeto.
export const DB_FILE = process.env.DB_FILE || fileURLToPath(new URL('../data/market.db', import.meta.url));

export const MINUTE = 60_000;

// Guardamos so candles de 1 minuto; os outros tempos sao calculados a partir deles.
export const TIMEFRAMES = {
  '1m': 1 * MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '1h': 60 * MINUTE,
  '4h': 240 * MINUTE,
  '1d': 1440 * MINUTE,
};
