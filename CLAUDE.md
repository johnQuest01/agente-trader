# Agente Trader — laboratório de trading (Binance)

Projeto do Bruno. Idioma de trabalho: português (pt-BR). Ele quer feedback direto e
que riscos reais sejam apontados, não validação.

Uma branch só: trabalhar direto na `main`, sem criar outras branches nem pull requests
(pedido do Bruno em 14/11/2026). Antes de começar, rodar `git pull`: em 14/11 duas sessões
trabalharam neste repositório ao mesmo tempo e os trabalhos tiveram de ser juntados à mão.

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
e o `WebSocket` global). Testado com Node 22.20 (Windows 10) e com Node 26.13.1.

- `src/config.js` — par (padrão BTCUSDT), porta 3333, dias de histórico (30)
- `src/db.js` — SQLite em `data/market.db`, tabela `candles` (só 1 minuto)
- `src/binance.js` — histórico via REST `/api/v3/klines` e ao vivo via WebSocket
  `@kline_1m`, com reconexão e preenchimento de buracos
- `src/aggregate.js` — monta 5m/15m/1h/4h/1d a partir dos candles de 1m; cada bucket
  sai com `minutes` e `complete` (o último, em formação, é sempre parcial; o primeiro
  só se a Binance não tiver o começo daquele dia)
- `src/server.js` — HTTP em 127.0.0.1: `/`, `/api/info`, `/api/candles?tf=&limit=&to=`,
  `/api/stream` (SSE)
- `public/index.html` — gráfico de velas (lightweight-charts 4.2.3 via CDN); horário
  local por candle; 1d rotulado pelo dia UTC, como a Binance
- `scripts/validar.js` — compara o banco com a API pública da Binance (rodar com o
  servidor no ar; `--completo` confere todos os candles de 1m)

Rodar: `npm start` e abrir http://localhost:3333
Validar (com o servidor rodando): `node scripts/validar.js --completo`

## Estado da fase 1 (testada em 14/11/2026)

Duas sessões testaram a fase 1 no mesmo dia, em paralelo, e os dois trabalhos foram
juntados na `main`. Tudo da lista original passou depois das correções.

Numa sessão com Node 26.13.1: 30 dias baixam em ~25 s; WebSocket ao vivo; troca de tempo
gráfico; retomada sem buraco e sem duplicar; queda de rede (simulada com proxy local)
reconecta e preenche; todos os 43 mil candles de 1m e amostras de 1h/1d idênticos à
Binance.

No Windows 10 do Bruno, com Node 22.20 e o código já juntado:
- `node scripts/validar.js --completo`: os 44.429 candles fechados idênticos aos da
  Binance, sem buracos; primeiro candle de 5m, 15m, 1h, 4h e 1d idêntico ao da Binance.
- Parar e subir de novo baixa só o buraco, sem duplicar.
- Queda da conexão ao vivo e silêncio de 60 s (simulados com repetidor local): tenta de
  novo aos 2, 4, 8 e 15 s, reconecta e preenche o buraco.
- A página se recupera sozinha quando o servidor reinicia; a troca rápida de tempo
  gráfico não mostra o tempo errado; horários no fuso de São Paulo.
- Antes da junção, com a versão anterior da reconexão: internet desligada de verdade
  por 9 minutos; 21 tentativas falharam, a 22ª conectou cerca de 11 s depois da volta e
  os candles do período ficaram idênticos aos da Binance.

Decisões de projeto que vieram dos testes (não desfazer; o porquê está nos comentários
do código):
- **Nunca usar o relógio do PC para decidir se um candle fechou.** Num dos ambientes de
  teste o relógio estava 11 min atrasado; o coletor usa `/api/v3/time` e avisa no log.
  Sincronizar o relógio do Windows continua necessário (logs e fase 5).
- **"Já fechou?" é decidido pela hora em que a pergunta foi feita à Binance, nunca pela
  hora em que a resposta chega**, e com folga de 2 s (`CLOSE_SLACK` em `src/binance.js`).
  Medido em 4 viradas de minuto: em uma delas a API de histórico ainda devolvia o candle
  incompleto cerca de 0,5 s depois do fechamento. O Bruno decidiu manter 2 s (a
  alternativa discutida foi 5 s).
- O download retoma do primeiro candle ainda `closed=0`, não do último: dado
  provisório é sempre refeito.
- **Um candle gravado nunca anda para trás** (`src/db.js`): provisório não substitui
  fechado; entre duas versões no mesmo estado vale a que tem mais negócios.
- **O histórico começa sempre às 00:00 UTC**, para o primeiro candle de 5m, 15m, 1h, 4h
  e 1d ser completo. O backfill também completa o primeiro dia de um banco que tenha
  começado no meio do dia.
- **WebSocket:** o watchdog abandona o socket mudo e abre outro (o `close()` gracioso
  nunca completa com a rede morta). No Node 22, uma tentativa de conexão que falha emite
  só `error`, nunca `close`; por isso `error` também leva direto a nova tentativa.
  Limite de 15 s para o handshake e teto de 15 s entre tentativas.
- **Na página, só a carga mais recente desenha o gráfico**, e a página recarrega sozinha
  quando a conexão com o servidor volta.

Pendências conhecidas (não bloqueiam a fase 2):
- Gráfico mostra só as últimas 1500 barras e não pagina (fase 3 vai precisar).
- `/api/candles` de 1d agrega todos os 1m em memória: ~0,15 s com 30 dias, ~3,5 s com
  1 ano. Trocar por agregação em SQL quando o histórico crescer.
- Biblioteca do gráfico vem do CDN: sem internet a página não renderiza.
- Watchdog de 60 s pode derrubar conexões saudáveis em pares sem negócio por >60 s
  (não verificado se a Binance manda candle sem trade).
- Rodar 24 horas seguidas ainda não foi feito (a Binance derruba toda conexão ao vivo
  depois de 24 h).
- O teste real de queda de internet é anterior à junção das duas versões da reconexão;
  com o código juntado só há as simulações.
- A corrida do candle provisório só foi reproduzida com uma Binance simulada; os testes
  de reprodução (dela e das quedas de conexão) não estão no repositório.
- O desenho da vela ao vivo foi conferido pelos dados, não olhando a tela.

Próxima fase: 2.
