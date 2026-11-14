# Agente Trader

Laboratorio local de trading com dados reais da Binance (par BTCUSDT por padrao).
Fase 1: coletor de candles de 1 minuto em SQLite + grafico no navegador.
Fase 2 (em andamento): negocios, agressao compradora x vendedora por minuto e ordens grandes.
Leia `CLAUDE.md` para o objetivo, as fases e o estado do projeto.

## Requisitos

- Node >= 22.13 (testado com 22.20 e 26.13.1). Sem `npm install`: zero dependencias.
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

Se houver negocios no banco, o mesmo script confere a fase 2: ids dos negocios sem buraco,
fluxo de cada minuto contra o candle daquele minuto, amostra de negocios contra a Binance e
ordens grandes recalculadas.

## Fase 2: negocios, fluxo e ordens grandes

O `npm start` tambem grava os negocios (aggTrades) e calcula:

- `http://localhost:3333/api/flow?tf=5m&limit=100` - agressao compradora e vendedora por
  periodo (mesmos tempos graficos dos candles). `complete: false` = faltam negocios ali.
- `http://localhost:3333/api/big?min=100000&limit=50` - ordens agressoras grandes (uma ordem
  que varre varios precos aparece somada em uma linha).

Na tela: embaixo do grafico, o saldo de agressao de cada candle (barras) e o acumulado
(linha); ao lado, a lista de ordens grandes, que tambem aparecem como setas nos candles.

Os negocios crus ocupam de 50 MB (dia medio) a 250 MB (dia muito agitado) por dia e sao
apagados depois de 7 dias; o fluxo por minuto e as ordens grandes ficam para sempre. `TRADES=0 npm start` desliga essa parte.

## Variaveis de ambiente

`SYMBOL`, `PORT`, `BACKFILL_DAYS`, `BINANCE_REST`, `BINANCE_WS`, `TRADES`, `TRADES_KEEP_DAYS`,
`TRADES_BACKFILL_HOURS`, `TRADES_MAX_GAP_HOURS`, `BIG_ORDER_USDT` (ver `src/config.js`).
