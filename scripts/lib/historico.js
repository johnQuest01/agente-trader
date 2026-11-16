// Pecas comuns aos estudos sobre o historico (scripts/estudo-perdas.js e
// scripts/estudo-regras.js): a leitura dos candles de 1 minuto, so em leitura, e a simulacao de
// UMA operacao com as contas do replay (src/replay.js, conferidas por scripts/testar-replay.js).
// Um lugar so para essas contas: os dois estudos tem que simular do mesmo jeito.
import { DatabaseSync } from 'node:sqlite';
import { MINUTE } from '../../src/config.js';
import { stepTrade, tradeResult } from '../../src/replay.js';

export const BRT = -3 * 60 * MINUTE; // horario de Brasilia (sem horario de verao)
export const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
export const brt = (ms) => new Date(ms + BRT).toISOString().slice(0, 16).replace('T', ' ');
export const WD = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

// Todos os candles FECHADOS de 1 minuto, em ordem. Para se o historico tiver buraco: os estudos
// andam minuto a minuto pelo indice, e um buraco deslocaria tudo sem aviso.
// `until` (opcional, em ms) corta o historico ali: serve para repetir um estudo com os mesmos dados.
export function loadCandles(file, symbol, until = Number.MAX_SAFE_INTEGER) {
  const db = new DatabaseSync(file, { readOnly: true });
  const C = db.prepare('SELECT open_time AS openTime, open, high, low, close, volume, taker_buy_volume AS buy FROM candles WHERE symbol = ? AND closed = 1 AND open_time < ? ORDER BY open_time').all(symbol, until);
  db.close();
  for (let i = 1; i < C.length; i++) {
    if (C[i].openTime - C[i - 1].openTime !== MINUTE) throw new Error(`buraco no historico depois de ${new Date(C[i - 1].openTime).toISOString()}: rode o validador antes`);
  }
  return C;
}

const r2 = (x) => Math.round(x * 100) / 100;

// Uma operacao: entra no fechamento do candle `i`, com stop e alvo em % do preco de entrada e
// prazo em minutos (`cfg`: stopPct, targetPct, maxMin). Dentro de um candle vale o pior caso
// (stop antes do alvo). O resultado sai liquido da taxa `feePct` por lado.
export function simulate(C, i, side, cfg, feePct) {
  const dir = side === 'buy' ? 1 : -1;
  const entry = C[i].close;
  const stop = r2(entry * (1 - (dir * cfg.stopPct) / 100));
  const target = r2(entry * (1 + (dir * cfg.targetPct) / 100));
  let t = { side, entry, stop, target, maxBars: cfg.maxMin, bars: 0, worst: entry, best: entry };
  let j = i;
  while (t.exit == null) { j += 1; t = stepTrade(t, C[j]); }
  // Saiu no stop: o preco chegou ao alvo DEPOIS, ainda dentro do prazo? (a direcao estava certa
  // e o stop era curto demais). O candle do proprio stop nao conta.
  let later = false;
  if (t.exitKind === 'stop') {
    for (let k = j + 1; k <= i + cfg.maxMin && k < C.length; k++) {
      if (dir === 1 ? C[k].high >= target : C[k].low <= target) { later = true; break; }
    }
  }
  return { ...t, ...tradeResult(t, feePct), dir, later, entryTime: C[i].openTime + MINUTE, exitIndex: j };
}
