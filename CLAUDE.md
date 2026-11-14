# Agente Trader — laboratório de trading (Binance)

Projeto do Bruno. Idioma de trabalho: português (pt-BR). Ele quer feedback direto e
que riscos reais sejam apontados, não validação.

## Objetivo

Laboratório local para estudar o mercado com dados reais da Binance e, mais tarde,
ligar um agente de IA que opera **somente em simulação** (Binance Demo Mode).
Nada de dinheiro real e nada de chave da conta real neste projeto até o Bruno decidir
explicitamente, depois de meses de resultados em simulação.

O software é o laboratório, não a estratégia: serve para testar hipóteses com dados.
Métrica que importa: resultado líquido após taxas, perda máxima e expectativa por
operação — não taxa de acerto.

## Fases

1. **Coletor e gráfico** (TESTADO na máquina do Bruno em 14/11/2026 — ver abaixo)
2. Fluxo e métricas: aggTrades (agressão compradora x vendedora), negócios grandes
   ("baleias"), livro de ofertas gravado ao vivo
3. Modo replay: reproduzir um dia passado candle a candle; registrar a previsão ANTES
   de revelar o resultado
4. Tabela de eventos/notícias com horário exato, ligada ao gráfico (estudo de eventos:
   reação em 1min, 5min, 1h, 1d, 1 semana)
5. Agente conversando com o Bruno + ordens no Demo Mode
   (`https://demo-api.binance.com`), com limites de risco fixos em código que a IA
   não altera, e registro de toda decisão

## Fase 1 — o que existe

Zero dependências (sem `npm install`). Precisa de Node >= 22.13 (usa `node:sqlite`
e o `WebSocket` global).

- `src/config.js` — par (padrão BTCUSDT), porta 3333, dias de histórico (30)
- `src/db.js` — SQLite em `data/market.db`, tabela `candles` (só 1 minuto)
- `src/binance.js` — histórico via REST `/api/v3/klines` e ao vivo via WebSocket
  `@kline_1m`, com reconexão e preenchimento de buracos
- `src/aggregate.js` — monta 5m/15m/1h/4h/1d a partir dos candles de 1m; cada bucket
  sai com `minutes` e `complete` (o primeiro e o último costumam ser parciais)
- `src/server.js` — HTTP em 127.0.0.1: `/`, `/api/info`, `/api/candles?tf=&limit=&to=`,
  `/api/stream` (SSE)
- `public/index.html` — gráfico de velas (lightweight-charts 4.2.3 via CDN); horário
  local por candle; 1d rotulado pelo dia UTC, como a Binance
- `scripts/validar.js` — compara o banco com a API pública da Binance (rodar com o
  servidor no ar; `--completo` confere todos os candles de 1m)

Rodar: `npm start` e abrir http://localhost:3333

## Estado da fase 1 (testada em 14/11/2026)

Tudo da lista original passou depois das correções: Node 26.13.1; 30 dias baixam em
~25 s; WebSocket ao vivo; troca de tempo gráfico; retomada sem buraco e sem duplicar;
queda de rede (simulada com proxy local) reconecta e preenche; todos os 43 mil candles
de 1m e amostras de 1h/1d idênticos à Binance.

Decisões de projeto que vieram dos testes:
- **Nunca usar o relógio do PC para decidir se um candle fechou.** O relógio desta
  máquina estava 11 min atrasado; o coletor usa `/api/v3/time` e avisa no log.
  Sincronizar o relógio do Windows continua necessário (logs e fase 5).
- O download retoma do primeiro candle ainda `closed=0`, não do último: dado
  provisório é sempre refeito.
- O histórico começa em 00:00 UTC para o primeiro candle de 1d ser completo.
- Watchdog do WebSocket abandona o socket mudo e abre outro (o `close()` gracioso
  nunca completa com a rede morta).

Pendências conhecidas (não bloqueiam a fase 2):
- Gráfico mostra só as últimas 1500 barras e não pagina (fase 3 vai precisar).
- `/api/candles` de 1d agrega todos os 1m em memória: ~0,15 s com 30 dias, ~3,5 s com
  1 ano. Trocar por agregação em SQL quando o histórico crescer.
- Biblioteca do gráfico vem do CDN: sem internet a página não renderiza.
- Watchdog de 60 s pode derrubar conexões saudáveis em pares sem negócio por >60 s
  (não verificado se a Binance manda candle sem trade).
