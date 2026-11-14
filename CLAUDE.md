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
   ("baleias"), livro de ofertas gravado ao vivo (FEITO e testado em 14/11/2026; falta
   rodar por vários dias — ver "Fase 2" abaixo)
3. Modo replay: reproduzir um dia passado candle a candle; registrar a previsão ANTES
   de revelar o resultado (FEITO e testado em 14/11/2026 — ver "Fase 3" abaixo)
4. Tabela de eventos/notícias com horário exato, ligada ao gráfico (estudo de eventos:
   reação em 1min, 5min, 1h, 1d, 1 semana) (FEITO e testado em 14/11/2026, com entrada
   manual e importação; fonte automática ainda não escolhida — ver "Fase 4" abaixo)
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
- **Um candle provisório nunca fica para trás.** Ao começar um minuto novo, se o anterior
  ainda está `closed=0` (o fechamento dele se perdeu), o coletor busca o definitivo pelo
  histórico. Reproduzido com um repetidor que atrasa a ligação com a Binance.

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

## Fase 2 — fluxo e métricas

Pronto e testado em 14/11/2026 (Windows 10, Node 22.20): negócios, fluxo, ordens grandes,
livro de ofertas e a tela. Falta rodar por vários dias.

O que existe:
- `src/trades.js` — coletor de negócios agregados (aggTrades) em conexão própria, separada
  da dos candles; calcula o fluxo por minuto e as ordens grandes lendo os negócios do banco
  em ordem. `TRADES=0` desliga tudo isso.
- Tabelas novas em `data/market.db`: `agg_trades` (negócios crus, guardados por
  `TRADES_KEEP_DAYS` = 7 dias; no BTCUSDT, 1 milhão por dia em média, uns 50 MB, mas
  numa hora agitada passou de 200 mil, ritmo de 250 MB por dia), `flow_1m` (agressão compradora e vendedora por minuto, para sempre) e `big_orders`
  (ordens agressoras a partir de `BIG_ORDER_USDT` = 25 mil USDT, para sempre).
- `/api/flow?tf=&limit=&to=` (fluxo nos mesmos tempos gráficos dos candles) e
  `/api/big?min=&limit=&to=` (ordens grandes); eventos `flow` e `big` no `/api/stream`.
- `scripts/validar.js`, seção 5: confere tudo isso.
- `public/index.html`: painel embaixo do gráfico com o saldo de agressão por candle (barras)
  e o saldo acumulado na tela (linha), com o tempo sincronizado com o gráfico de cima; lista
  de ordens grandes ao lado, com filtro de valor mínimo, e setas nos candles (para cima =
  compra agressora, para baixo = venda). O saldo do painel sai do próprio candle
  (saldo = 2 × agressão compradora − volume), então vale para todo o histórico, e não só
  para o período em que os negócios foram gravados.

Regras (não desfazer):
- **O banco não tem buraco de negócios sem que isso fique marcado.** O id do negócio
  agregado é sequencial; a cada reconexão o coletor procura saltos de id e baixa pelo
  histórico exatamente o que falta. Se ficou parado mais que `TRADES_MAX_GAP_HOURS` (24 h),
  não baixa o trecho perdido e os minutos dele ficam `complete=0`.
- **Um minuto só é `complete=1` se os ids emendam do começo ao fim**, inclusive com o último
  negócio do minuto anterior e o primeiro do seguinte. Quem consome o fluxo deve olhar
  `complete`: um período incompleto subestima o volume dos dois lados.
- **A prova de exatidão é o candle.** Em todo minuto completo, a soma dos negócios tem que
  dar exatamente o volume, a agressão compradora e o número de negócios do candle daquele
  minuto, que vem de outra fonte da Binance. As quantidades são somadas em inteiros de
  1e-8 para a conta fechar sem erro de arredondamento.
- **Ordem grande = negócios seguidos, no mesmo milissegundo e do mesmo lado, somados.** Uma
  ordem a mercado que varre vários preços chega quebrada em um negócio por preço (40% das
  ordens na amostra medida). É uma aproximação: a Binance não informa a qual ordem cada
  negócio pertence, e duas ordens diferentes no mesmo milissegundo saem somadas.
- `taker_buy = 1` quer dizer que o COMPRADOR agrediu (é o contrário do campo `m` da Binance).

Livro de ofertas (`src/book.js`, em conexão própria; `BOOK=0` desliga):
- O livro local é montado como a Binance manda: uma foto de 5.000 níveis por lado (uns
  ±2,4% do preço no BTCUSDT) mais as atualizações numeradas que chegam uma vez por segundo.
  **Se falta um número, o livro é refeito do zero**; se compra e venda se cruzam, também.
- **A cada 10 minutos o livro local é comparado nível a nível com uma foto nova** (e as
  somas por faixa são refeitas por outro caminho). `/api/book/check` faz isso na hora, e o
  validador chama. É a prova de que o livro local continua igual ao da Binance.
- Gravado: `book_1s` (um resumo por segundo: melhor compra, melhor venda e a quantidade
  ofertada de cada lado até 0,02%, 0,05%, 0,1%, 0,2%, 0,5% e 1% do preço; `BOOK_KEEP_DAYS` =
  14 dias, uns 12 MB por dia), `book_1m` (a média por minuto, para sempre) e `book_walls`
  (as 5 maiores ofertas de cada lado até 1% do preço, de 10 em 10 s, 14 dias).
- Uma faixa que passa do trecho conhecido do livro fica `NULL`, em vez de uma soma incompleta.
- **Custo de tráfego: cerca de 1,3 GB por dia** só do livro (15 KB por segundo). A opção de
  100 ms custaria 5,9 GB por dia e não é usada.
- `/api/book` (o livro agora) e evento `book` no `/api/stream`; na tela, caixa "Livro de
  ofertas" com as faixas de 0,05%, 0,1% e 0,5% e a maior oferta de cada lado.

Verificado: retomada depois de ficar parado (26 mil negócios baixados em 12 s, sem buraco);
queda da conexão ao vivo de candles e de negócios ao mesmo tempo (simulada); em todos os
casos os minutos completos bateram exatamente com os candles, a amostra de 3.000 negócios
crus bateu com a Binance e todas as ordens grandes conferiram com o recálculo.

A tela foi conferida pelos dados (saldo e acumulado iguais ao cálculo feito a partir da API,
gráficos sincronizados, setas e lista de acordo com `/api/big`), não por alguém olhando.

Livro verificado: em todas as conferências feitas (antes e depois de uma queda simulada da
conexão), cerca de 10 mil níveis comparados com a Binance e nenhum diferente; o salto de
numeração na reconexão foi detectado e o livro foi refeito sozinho.

Falta na fase 2: rodar vários dias para conferir a limpeza dos dados antigos, o tamanho
real do banco e as conferências automáticas do livro ao longo do tempo; o Bruno olhar a
tela nova. O disco do computador tinha 25 GB livres de 447 GB em 14/11/2026: com os
padrões, a fase 2 ocupa de 0,5 a 2 GB.

## Fase 3 — replay

Pronto e testado em 14/11/2026 (Windows 10, Node 22.20). Tela em
http://localhost:3333/replay (há um link na tela ao vivo).

O que existe:
- `src/replay.js` — sessões, operações, contas de resultado e as rotas `/api/replay/...`.
- `public/replay.html` — a tela: gráfico só com o que já foi revelado, botões de próximo
  candle (ou barra de espaço), formulário da operação, resultado da sessão.
- Tabelas `replay_sessions` e `replay_trades` em `data/market.db`.
- `scripts/testar-replay.js` — 14 casos das contas, com candles montados à mão. Rodar
  depois de mexer em `src/replay.js`.

Regras (não desfazer):
- **Quem garante que a operação é registrada antes do resultado é o servidor, não a tela.**
  A API do replay só devolve candles até o último revelado; o preço de entrada é sempre o
  fechamento desse candle (a tela informa só lado, stop, alvo, prazo e motivo); o resultado
  sai só dos candles revelados depois.
- **Sem stop não há operação.** O projeto mede perda máxima; operação sem perda máxima
  definida é recusada.
- **Dentro de um candle vale o pior caso:** se o stop e o alvo foram tocados no mesmo
  candle, conta como stop; se o candle abriu além do stop, a saída é na abertura.
- **Resultado líquido de taxas:** `REPLAY_FEE_PCT` = 0,1% por lado, na entrada e na saída.
- **Ordem do resumo:** resultado líquido, perda máxima, pior operação, expectativa por
  operação, R médio; a taxa de acerto vem por último, de propósito.
- **Sessão sorteada é disfarçada:** a data fica oculta e o preço vira um índice que começa
  em 100, até a sessão acabar, para não dar para reconhecer o dia. No banco ficam sempre
  os preços reais.

Limites conhecidos:
- Só há 30 dias de candles para sortear; com pouco histórico os períodos se repetem.
- Uma operação aberta por vez; o passo é sempre um candle inteiro do tempo gráfico da sessão.
- Não há modelo de derrapagem (slippage): a entrada é exatamente no fechamento.
- As porcentagens são somadas como se cada operação usasse o mesmo valor.
- O replay mostra candles e saldo de agressão; ordens grandes e livro ainda não entram
  (só existem a partir de 14/11/2026).

Verificado: os 14 casos das contas; e, num servidor de teste com cópia do banco, 35
conferências de ponta a ponta (nenhum candle depois do ponto atual em resposta alguma;
três operações com saída e resultado iguais a uma simulação independente; recusas; sessão
disfarçada revelando data e preço reais só no fim). A tela foi exercitada pelo navegador
automatizado; o Bruno ainda não usou.

## Fase 4 — eventos e notícias

Pronto e testado em 14/11/2026 (Windows 10, Node 22.20). Tela em
http://localhost:3333/eventos (há links nas outras telas).

O que existe:
- `src/events.js` — tabela de eventos, cálculo da reação e as rotas `/api/events...`.
- `src/http.js` — leitura de JSON das rotas que recebem dados (usada também pelo replay).
- `public/eventos.html` — a tela: tabela com a reação em cada janela, gráfico em volta do
  evento escolhido, formulário, importação de várias linhas, movimento típico e média por tipo.
- Tabela `events` em `data/market.db`. Na tela ao vivo, cada evento aparece como um quadrado
  amarelo no candle em que aconteceu.
- `scripts/testar-eventos.js` — 16 casos das contas, com candles montados à mão. Rodar
  depois de mexer em `src/events.js`.

Regras (não desfazer):
- **A reação é medida com os candles de 1 minuto:** preço de referência = fechamento do
  último minuto que terminou antes do evento; reação em N minutos = até o fechamento do
  N-ésimo minuto a partir do minuto do evento. A precisão é de um minuto, não de segundos.
- **Janela que ainda não terminou não tem número** ("ainda não passou"); janela com mais de
  2% dos minutos ausentes também não ("faltam candles").
- **Toda reação vem ao lado do movimento típico daquela janela** (mediana do tamanho da
  variação em qualquer horário, em todo o histórico). Sem essa régua, qualquer balanço
  normal parece efeito do evento.
- **A média por tipo com menos de 20 eventos aparece em cinza:** não prova nada.
- Evento repetido (mesmo horário e título) não é gravado de novo.

Limites conhecidos:
- **Não há fonte automática.** Os eventos entram pelo formulário ou por importação de
  linhas (`data e hora; título; tipo; importância; fonte; anotação`). Qual fonte automática
  usar (calendário econômico, notícias) é decisão do Bruno e ainda não foi tomada.
- Com 30 dias de histórico, a janela de 1 semana quase não tem amostra para o movimento
  típico, e a de 1 dia tem só 30.
- A hora digitada é a do computador; o banco guarda em UTC.
- Reação medida não é causa provada: outra coisa pode ter acontecido no mesmo minuto.

Verificado: os 16 casos das contas; e, num servidor de teste com cópia do banco, 20
conferências de ponta a ponta (a reação de três eventos igual a uma conta independente nas
janelas completas; evento antes do histórico; importação com linha ruim; duplicado;
apagar). A tela foi exercitada pelo navegador automatizado; o Bruno ainda não usou.

## Fase 5 — o que falta decidir antes de começar

A fase 5 (agente conversando com o Bruno e ordens só no Demo Mode) depende de decisões dele:
- os limites de risco fixos em código (perda máxima por operação e por dia, tamanho máximo
  da posição, quantas operações por dia);
- as chaves de API do Demo Mode da Binance, que ele mesmo cria e coloca no arquivo `.env`
  (já ignorado pelo git). Nunca usar chave da conta real neste projeto.
