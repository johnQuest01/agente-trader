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

1. **Coletor e gráfico** (código escrito, FALTA TESTAR NA MÁQUINA — ver abaixo)
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
- `src/aggregate.js` — monta 5m/15m/1h/4h/1d a partir dos candles de 1m
- `src/server.js` — HTTP em 127.0.0.1: `/`, `/api/info`, `/api/candles?tf=&limit=`,
  `/api/stream` (SSE)
- `public/index.html` — gráfico de velas (lightweight-charts v4 via CDN)

Rodar: `npm start` e abrir http://localhost:3333

## O que falta testar no terminal (tarefa imediata)

Só foi testado fora da máquina do Bruno, com dados falsos e sem acesso à Binance.
Verificar de verdade:

1. `node -v` é >= 22.13; `npm start` sobe sem erro
2. O histórico de 30 dias baixa (~43 mil candles) e `data/market.db` é criado
3. O WebSocket conecta e o candle de 1m atualiza ao vivo no gráfico
4. Troca de tempo gráfico (1m…1d) funciona e os horários aparecem no fuso local
5. Parar e subir de novo: baixa só o buraco, sem duplicar
6. Desligar a internet por um minuto: reconecta e preenche o buraco
7. Conferir alguns candles contra o gráfico da própria Binance (abertura, máxima,
   mínima, fechamento, volume)

Corrigir o que quebrar e só então seguir para a fase 2.
