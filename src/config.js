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

// ---------- Fase 2: negocios (aggTrades), fluxo e ordens grandes ----------
// TRADES=0 desliga o coletor de negocios e roda so os candles, como na fase 1.
export const TRADES = process.env.TRADES !== '0';
// Por quantos dias os negocios crus ficam no banco. O BTCUSDT teve em media 1 milhao por dia
// (uns 50 MB), mas numa hora agitada passou de 200 mil (ritmo de 250 MB por dia).
// O fluxo por minuto e as ordens grandes ficam para sempre.
export const TRADES_KEEP_DAYS = Number(process.env.TRADES_KEEP_DAYS || 7);
// Na primeira execucao, quantas horas de negocios baixar para tras.
export const TRADES_BACKFILL_HOURS = Number(process.env.TRADES_BACKFILL_HOURS || 1);
// Se o programa ficou parado mais do que isso, nao baixa tudo o que perdeu: recomeca do
// periodo acima, e os minutos do buraco ficam marcados como incompletos.
export const TRADES_MAX_GAP_HOURS = Number(process.env.TRADES_MAX_GAP_HOURS || 24);
// Piso, em USDT, para gravar uma ordem agressora como "grande". A tela filtra dali para cima.
export const BIG_ORDER_USDT = Number(process.env.BIG_ORDER_USDT || 25_000);

// ---------- Fase 2: livro de ofertas ----------
// BOOK=0 desliga o gravador do livro. Ele recebe uma atualizacao por segundo com todos os
// niveis que mudaram: cerca de 15 KB por segundo, ou 1,3 GB de trafego por dia no BTCUSDT.
export const BOOK = process.env.BOOK !== '0';
// Por quantos dias o resumo por segundo e as maiores ofertas ficam no banco (uns 12 MB por
// dia). A media por minuto fica para sempre.
export const BOOK_KEEP_DAYS = Number(process.env.BOOK_KEEP_DAYS || 14);

// ---------- Fase 3: replay ----------
// Taxa por lado, em %, descontada na entrada e na saida de cada operacao simulada. 0,1% e a
// taxa padrao de quem agride (taker) no mercado a vista da Binance, sem desconto.
export const REPLAY_FEE_PCT = Number(process.env.REPLAY_FEE_PCT || 0.1);

// ---------- Fase 5: agente e Demo Mode ----------
// Os LIMITES DE RISCO nao estao aqui: ficam em src/limits.js e nao mudam por variavel de ambiente.
// Endereco da corretora para as ordens. So e aceito o do Demo Mode ou um servidor de teste
// nesta mesma maquina (a conferencia esta em src/demo.js).
export const DEMO_URL = process.env.DEMO_URL || 'https://demo-api.binance.com';
// Taxa por lado, em %, que a trava de risco usa para dimensionar uma operacao. O resultado de
// cada operacao usa as taxas que a corretora cobrou de verdade.
export const AGENT_FEE_PCT = Number(process.env.AGENT_FEE_PCT || 0.1);
// Por quantos minutos uma proposta espera a decisao do Bruno antes de expirar.
export const AGENT_PROPOSAL_TTL_MIN = Number(process.env.AGENT_PROPOSAL_TTL_MIN || 15);
// Quanto acima da oferta de agora a compra aceita pagar, em %. E o teto da derrapagem na entrada.
export const AGENT_MAX_SLIP_PCT = Number(process.env.AGENT_MAX_SLIP_PCT || 0.05);

// ---------- Fase 5: a IA que conversa e propoe (API da Anthropic) ----------
// A chave fica so no arquivo .env (ANTHROPIC_API_KEY). Cada mensagem custa dinheiro de verdade.
// Modelo. O padrao e o Claude Opus 5.5 (US$ 4 por milhao de tokens de entrada e US$ 20 de
// saida, em 03/11/2026). Mais baratos: claude-sonnet-5-5 (US$ 2 / 10) e claude-haiku-5-5
// (US$ 0,10 / 0,50). Trocar de modelo comeca uma conversa nova.
export const AI_MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
// Quanto o modelo pensa antes de responder: low, medium, high, xhigh ou max. Mais alto = mais
// lento e mais caro. "medium" e o ponto de partida que a Anthropic recomenda para este modelo.
export const AI_EFFORT = process.env.AI_EFFORT || 'medium';
// Tamanho maximo de cada resposta (o raciocinio do modelo tambem conta), em tokens.
export const AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 16_000);
// Quantas rodadas de consulta aos dados a IA pode fazer para responder uma mensagem.
export const AI_MAX_ROUNDS = Number(process.env.AI_MAX_ROUNDS || 8);
// Teto de gasto com a IA por dia (UTC), em dolares, pela estimativa do programa. Atingido, a
// IA para de responder ate o dia seguinte. 0 = sem teto.
export const AI_MAX_USD_PER_DAY = Number(process.env.AI_MAX_USD_PER_DAY || 2);
// Endereco da API. So e aceito o da Anthropic ou um servidor de teste nesta mesma maquina (a
// conferencia esta em src/ai-client.js). A variavel ANTHROPIC_BASE_URL do sistema e ignorada.
export const AI_URL = process.env.AI_URL || 'https://api.anthropic.com';

// Guardamos so candles de 1 minuto; os outros tempos sao calculados a partir deles.
export const TIMEFRAMES = {
  '1m': 1 * MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '1h': 60 * MINUTE,
  '4h': 240 * MINUTE,
  '1d': 1440 * MINUTE,
};
