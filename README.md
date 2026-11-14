# Agente Trader

Laboratorio local de trading com dados reais da Binance (par BTCUSDT por padrao).
Fase 1: coletor de candles de 1 minuto em SQLite + grafico no navegador.
Leia `CLAUDE.md` para o objetivo, as fases e o estado do projeto.

## Requisitos

- Node >= 22.13 (testado com 26.13.1). Sem `npm install`: zero dependencias.
- Internet para a Binance (REST + WebSocket) e para o CDN do grafico.
- Relogio do computador sincronizado (o programa avisa no log se estiver errado).

## Rodar

```bash
npm start
```

Abra http://localhost:3333. Na primeira vez baixa 30 dias de historico (~43 mil candles,
menos de 1 minuto) para `data/market.db`. Nas seguintes baixa so o que faltou.
O historico comeca sempre as 00:00 UTC (vem ate um dia a mais que os 30), para que o primeiro
candle de 1h, 4h e 1d nao fique incompleto.

## Validar os dados contra a Binance

Com o servidor rodando:

```bash
node scripts/validar.js
```

Compara 20 candles de 1m, 5 de 1h e 2 de 1d com a API publica, mais o primeiro candle de
cada tempo grafico (a borda do historico), procura buracos e duplicados, e confere o
relogio. Sai com codigo 1 se achar qualquer diferenca.

Com `--completo` confere todos os candles fechados de 1m, e nao so os 20 sorteados (leva uns
20 segundos):

```bash
node scripts/validar.js --completo
```

## Variaveis de ambiente

`SYMBOL`, `PORT`, `BACKFILL_DAYS`, `BINANCE_REST`, `BINANCE_WS` (ver `src/config.js`).
