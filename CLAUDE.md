# Agente Trader — laboratório de trading (Binance)

Projeto do Bruno. Idioma de trabalho: português (pt-BR). Ele quer feedback direto e
que riscos reais sejam apontados, não validação.

Uma branch só: trabalhar direto na `main`, sem criar outras branches nem pull requests
(pedido do Bruno em 14/11/2026). Antes de começar, rodar `git pull`: em 14/11 duas sessões
trabalharam neste repositório ao mesmo tempo e os trabalhos tiveram de ser juntados à mão.

**Este repositório é público.** O que é pessoal do Bruno (dinheiro, o que aconteceu com as
chaves, de onde e como ele acompanha) não entra neste arquivo nem em outro do repositório: fica
em `CLAUDE.local.md`, na raiz do projeto, fora do git (pedido dele em 15/11/2026). **Ler esse
arquivo no começo de cada sessão**, se ele existir.

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
   não altera, e registro de toda decisão (FEITO em 14/11/2026, testado só com corretora
   e API da Anthropic simuladas; em 15/11/2026 a IA respondeu de verdade pela API da Anthropic;
   faltam os limites e uma chave do Demo Mode que funcione — ver "Fase 5")

## Fase 1 — o que existe

Zero dependências (sem `npm install`). Precisa de Node >= 22.13 (usa `node:sqlite`
e o `WebSocket` global). Testado com Node 22.20 (Windows 10) e com Node 26.13.1.
Única exceção, desde 14/11/2026: a IA da fase 5 usa a biblioteca oficial da Anthropic
(`@anthropic-ai/sdk`, versão fixada no `package.json`). Sem `npm install` só a IA fica
desligada; todo o resto roda igual.

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
- Watchdog de 60 s pode derrubar conexões saudáveis em pares sem negócio por >60 s. Visto em
  15/11/2026 num par quase parado (ADABRL): a Binance manda o candle a cada virada de minuto
  mesmo sem negócio, o maior silêncio foi de 56 s e o watchdog não disparou em 7 minutos. A
  folga é de só 4 s.
- Rodar 24 horas seguidas ainda não foi feito (a Binance derruba toda conexão ao vivo
  depois de 24 h).
- O teste real de queda de internet é anterior à junção das duas versões da reconexão;
  com o código juntado só há as simulações.
- A corrida do candle provisório só foi reproduzida com uma Binance simulada; os testes
  de reprodução (dela e das quedas de conexão) não estão no repositório.
- O desenho da vela ao vivo foi conferido pelos dados e, em 15/11/2026, visto em foto (ver
  "Teste reverso, eventos e fotos"); o Bruno ainda não usou a tela.

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

## Fase 5 — agente e ordens no Demo Mode

Pronto e testado em 14/11/2026 (Windows 10, Node 22.20): propostas, aprovação do Bruno, trava
de risco, ordens, registro e a IA que conversa e propõe. **Só foi testado contra uma corretora
simulada e uma API da Anthropic simulada:** sem as chaves, nenhuma ordem foi ao Demo Mode de
verdade e nenhuma mensagem foi à Anthropic de verdade. Tela em http://localhost:3333/agente
(há links nas outras telas).

Decisões do Bruno (14/11/2026): **o agente propõe e o Bruno aprova cada ordem**, na tela; a
IA usa a API da Anthropic, com uma chave dele e custo por uso, pela biblioteca oficial.

O que existe:
- `src/limits.js` — os quatro limites de risco, fixos em código. **Estão todos `null`: quem
  define os números é o Bruno.** Enquanto um deles estiver `null`, nenhuma ordem é enviada.
- `src/risk.js` — a trava de risco (funções puras): confere a proposta e calcula o tamanho.
- `src/demo.js` — cliente do Demo Mode; o único lugar que assina pedidos com chave.
- `src/agent.js` — propostas, aprovação, execução (`settle`), registro e as rotas
  `/api/agent/...`; evento `agent` no `/api/stream`.
- `src/env.js` — lê o `.env` (`BINANCE_DEMO_KEY` e `BINANCE_DEMO_SECRET`); `.env.example`
  mostra o formato.
- `public/agente.html` — a tela: limites, conta, proposta manual, aprovar/recusar (em dois
  cliques), posição aberta, resultado e registro.
- Tabelas `agent_proposals`, `agent_log` e `agent_days` em `data/market.db`.
- `scripts/testar-risco.js` (15 casos), `scripts/testar-demo.js` (17) e
  `scripts/testar-agente.js` (34), com a corretora simulada de
  `scripts/lib/corretora-simulada.js`. Rodar depois de mexer em qualquer arquivo da fase 5.
- A IA: `src/ai.js` (a conversa: pedido à API, rodadas de consulta, teto de gasto, rotas
  `/api/ai/...`, evento `ai` no `/api/stream`), `src/ai-tools.js` (as sete ferramentas dela),
  `src/ai-prompt.js` (as instruções; único arquivo de código com acentos) e
  `src/ai-client.js` (a ligação com a Anthropic; o único lugar que usa a chave dela).
  Tabelas `ai_conversations` e `ai_messages`. Painel "Conversa com a IA" na tela `/agente`.
- `scripts/testar-ia.js` (25 casos, com uma IA de roteiro) e `scripts/testar-ia-cliente.js`
  (8 casos: a biblioteca oficial falando com uma API simulada local; precisa de
  `npm install`). `npm test` roda os oito scripts de teste do projeto (154 casos).

Regras (não desfazer):
- **Só Demo Mode.** O cliente recusa qualquer endereço que não seja
  `https://demo-api.binance.com` (ou um servidor de teste em 127.0.0.1) e não segue
  redirecionamento. As chaves vêm só do `.env` e nunca vão para log, tela ou mensagem de erro.
- **Nenhuma ordem sai sem a aprovação do Bruno e sem passar pela trava.** Quem propõe não
  aprova: `propose` só grava a proposta, sempre `pendente`; aprovar é outra rota, ligada ao
  botão da tela. Quando a IA for ligada, ela recebe só a função de propor.
- **Os limites só mudam editando `src/limits.js`.** Não há variável de ambiente, tela nem
  comando que mude um limite.
- **Só compra, sempre com stop, uma posição por vez** (conta à vista: sem venda a descoberto
  e sem alavancagem).
- **O tamanho é o menor entre** o que a perda máxima por operação permite, o que ainda cabe
  na perda máxima do dia e o tamanho máximo da posição. A perda vai do preço máximo aceito
  na compra até o stop, com as taxas dos dois lados.
- **O preço para dimensionar e enviar vem do próprio Demo Mode, não do coletor.** O Demo Mode
  tem livro de ofertas próprio (negócios e quantidades diferentes dos do mercado de verdade):
  em 14/11/2026, em três leituras quase simultâneas, o BTCUSDT de lá estava de 0 a 7 dólares
  diferente.
- **A compra tem preço máximo** (a oferta de agora + `AGENT_MAX_SLIP_PCT` = 0,05%; executa na
  hora o que houver e cancela o resto). É o teto da derrapagem na entrada.
- **O stop é a mercado e fica parado na corretora** (junto com o alvo, numa lista OCO, quando
  há alvo): a saída não depende de o programa estar ligado. Um stop com preço limite poderia
  não executar numa queda rápida e deixar a posição aberta.
- **Posição nunca fica sem stop:** se a corretora recusa o stop, ou ele some (cancelado por
  fora), a posição é vendida a mercado na hora.
- **Antes de enviar qualquer ordem, a intenção é gravada no banco**, com um nome único para a
  ordem. Depois de uma queda, o agente pergunta à corretora o que existe com aqueles nomes e
  continua dali; nunca repete uma ordem às cegas. O que não dá para confirmar vira o estado
  `atencao`: aviso vermelho na tela, novas operações bloqueadas, e o agente tenta de novo sozinho.
- **O registro (`agent_log`) só recebe linhas novas:** o próprio banco recusa alterar ou
  apagar (gatilhos).
- **O servidor só atende pedidos feitos a `localhost` ou `127.0.0.1`** (cabeçalho Host) e só
  aceita JSON nas rotas que recebem dados: uma página de outro site não consegue aprovar nada.
- Proposta sem decisão expira em `AGENT_PROPOSAL_TTL_MIN` = 15 minutos; a conta do tamanho é
  refeita na hora da aprovação, com o saldo e o preço daquele momento.
- O agente só começa a acompanhar depois que a porta do servidor abriu: um segundo
  `npm start` termina sem mexer em nada.
- Resumo na ordem do projeto: resultado líquido, perda máxima, pior operação, expectativa por
  operação, R médio; a taxa de acerto por último.

Regras da IA (não desfazer):
- **A IA só tem sete ferramentas:** seis leem dados do laboratório (candles, ordens grandes,
  livro, eventos, caderno do Bruno, conta e operações) e uma registra proposta. Não existe
  ferramenta para aprovar, enviar ordem, encerrar posição, mexer em limite ou escrever no
  caderno; pedido de ferramenta que não existe volta como erro para ela. Uma proposta dela por
  vez. (Eram seis até 15/11/2026, quando entrou a leitura do caderno.)
- **A conversa é reenviada inteira e nunca é reescrita.** Instruções, ferramentas e mensagens
  antigas vão sempre iguais, byte a byte; o que muda a cada pergunta (hora, preço, situação da
  conta) vai dentro da mensagem nova. Os modelos atuais guardam o raciocínio de uma rodada para
  a outra preso a esse histórico: mexer nele invalida o que foi guardado e, numa conta nova da
  Anthropic, a chamada é recusada. Por isso `ai_messages` só recebe linhas novas (gatilhos), e
  mudar as instruções, as ferramentas ou o modelo começa uma conversa nova.
- **As instruções (`src/ai-prompt.js`) são fixas:** sem data, hora, saldo ou nome.
- **O texto que vem do banco (título de evento, anotação, motivo de proposta) é dado, não
  instrução**: as instruções dizem isso à IA e, mesmo que ela obedecesse a um texto desses, o
  máximo que consegue é registrar uma proposta, que depende da aprovação do Bruno.
- **A chave só vai para `https://api.anthropic.com`** (ou um servidor de teste em 127.0.0.1).
  O endereço é passado e conferido pelo programa; a variável `ANTHROPIC_BASE_URL` do sistema é
  ignorada de propósito (ela existe no terminal do Claude Code desta máquina). A chave vem só
  do `.env` (`ANTHROPIC_API_KEY`) e nunca vai para log, tela ou mensagem de erro.
- **Limites da conversa:** uma mensagem por vez; até `AI_MAX_ROUNDS` = 8 rodadas de consulta
  por mensagem (na última a IA tem que responder com o que já tem); respostas de até
  `AI_MAX_TOKENS` = 16.000 tokens; e teto de gasto de `AI_MAX_USD_PER_DAY` = 2 dólares por dia
  (UTC), pela estimativa do programa. O teto é um padrão posto pelo Claude: o Bruno muda no `.env`.
- Modelo padrão `claude-opus-5-5` com `effort` `medium` (o que a Anthropic recomenda como
  ponto de partida); trocar é decisão do Bruno (`AI_MODEL`, `AI_EFFORT`). Os preços usados na
  estimativa estão em `src/ai.js` e são de 03/11/2026.
- O pedido usa dois recursos opcionais da API (troca automática para um modelo substituto
  quando o filtro de segurança recusa uma pergunta por engano, e seguir em frente em vez de
  falhar se o histórico não bater). Se a conta não os tiver liberados (erro 400), o programa
  tenta uma vez sem eles, avisa na conversa e segue sem eles.
- Resposta recusada pelo modelo, ou cortada no meio de um pedido de consulta, não executa
  nada e não entra no histórico.

Limites conhecidos:
- **A perda real pode passar da planejada** quando o preço pula o stop: o stop a mercado sai
  pelo preço que houver. O registro mostra as duas contas.
- **Resultado no Demo Mode não é resultado no mercado de verdade:** o livro é outro e a
  liquidez é outra. A própria Binance avisa isso na documentação.
- O saldo usado nos limites é o USDT da conta de demonstração mais a posição do agente;
  outras moedas da conta não entram. A perda do dia conta só as operações do agente.
- O dia (UTC) e o prazo das propostas usam o relógio do computador. Uma saída entra no dia
  em que o agente ficou sabendo dela (se o programa estava desligado quando o stop executou,
  é o dia em que voltou).
- A aprovação está protegida contra páginas de outros sites, não contra outro programa
  rodando neste computador.
- Taxa cobrada em outra moeda (ex.: BNB) não entra no resultado; fica anotada.
- Só o par do `SYMBOL`, só compra.
- A IA só responde quando o Bruno escreve: não acompanha o mercado sozinha nem avisa de nada.
- O gasto com a IA mostrado na tela é estimativa (tabela de preços no código); a conta de
  verdade é a da Anthropic. Tentativas recusadas ou refeitas pela API não entram na estimativa.
- A tela mostra só a conversa em andamento; as antigas ficam no banco, sem tela para ver.
- Conversa longa custa mais a cada pergunta (ela é reenviada inteira, ainda que com desconto
  de cache); a tela mostra o tamanho, e "Nova conversa" zera.
- A resposta da IA chega inteira no fim, não aos poucos; enquanto isso a tela mostra o que
  ela está consultando.

Verificado: os 15 + 17 + 34 casos (entre eles: ciclo completo com alvo, com stop e com saída
manual, com o resultado do agente conferido contra o saldo da corretora simulada; limites
indefinidos ou falta de chaves não enviam nada; conexão caindo antes e depois de a ordem
chegar; stop recusado; stop cancelado por fora; retomada por outro processo, só com o banco);
15 conferências de ponta a ponta com o programa de verdade numa porta de teste (com os limites
indefinidos, nenhuma ordem chega à corretora); e a tela exercitada pelo navegador
automatizado, num servidor de teste com limites de teste. Contra o Demo Mode de verdade, só o
que não precisa de chave: regras do par, preço, diferença de relógio e a recusa de uma chave
inválida.

Verificado na IA: os 25 + 8 casos (eram 24 + 8 até entrar a leitura do caderno, em 15/11/2026;
pedido montado como o guia da Anthropic manda; histórico
idêntico de uma pergunta para a outra; proposta da IA pendente e marcada como dela; tentativa
de "aprovar" devolvida como erro; limite de rodadas; teto de gasto; recusa; resposta cortada;
erros da API em frases claras e sem a chave; variáveis do sistema que não desviam a chave);
10 conferências de ponta a ponta com o programa de verdade numa porta de teste, pela
biblioteca oficial, contra uma API simulada; e a tela exercitada pelo navegador automatizado
com uma IA de roteiro, que propôs e teve a proposta aprovada pela tela.

**Não verificado (precisa das chaves do Bruno):**
- qualquer rota assinada no Demo Mode de verdade — saldo, compra, stop, lista OCO,
  cancelamento, taxas cobradas. A corretora simulada imita a documentação da Binance; o
  comportamento real só se confirma lá. A primeira operação de verdade no Demo Mode deve ser
  acompanhada passo a passo;
- qualquer chamada à API da Anthropic de verdade: se a conta dele aceita o modelo e os dois
  recursos opcionais, quanto custa uma conversa típica, e principalmente a qualidade do que
  a IA responde e propõe (as instruções dela nunca foram lidas por um modelo de verdade aqui).
  A primeira conversa real é o teste;
- o Bruno ainda não usou a tela.

Falta, e depende do Bruno:
- os quatro números de `src/limits.js`;
- criar as chaves em demo.binance.com ("API Key Management") e colocá-las no `.env`. Nunca
  usar chave da conta real neste projeto;
- criar a chave da API da Anthropic (platform.claude.com) e colocá-la no `.env`
  (`ANTHROPIC_API_KEY`); rodar `npm install` em qualquer máquina nova.

## Caderno de anotações

Pronto e testado em 15/11/2026 (Windows 10, Node 22.20), a pedido do Bruno ("Sim, construa").
Tela em http://localhost:3333/caderno (há links nas outras telas). É a primeira peça da visão
dele: ele escreve o que viu, leu ou pensa e, se quiser, o lado que espera (alta ou baixa) com um
prazo (1 hora, 4 horas, 1 dia ou 1 semana); o laboratório confere depois e monta o placar.

O que existe:
- `src/notes.js` — as contas da conferência, o placar e as rotas `/api/notes` (ler e gravar) e
  `/api/notes/now` (o que seria carimbado agora; a tela consulta de 2 em 2 segundos).
- `public/caderno.html` — a tela: formulário (com confirmação antes de gravar), lista com o
  resultado de cada previsão, placar, resultado por assunto e por prazo, movimento típico de
  cada prazo. Os assuntos sugeridos (a lista que o Bruno fez) ficam nesse arquivo.
- Tabela `notes` em `data/market.db`.
- `scripts/testar-caderno.js` — 26 casos, com candles montados à mão. Rodar depois de mexer em
  `src/notes.js`.
- A IA lê o caderno pela ferramenta `ver_caderno` (só leitura).

Regras (não desfazer):
- **O preço de referência de uma previsão é o FECHAMENTO do minuto em que ela foi gravada**: um
  preço que ainda não existia quando o Bruno clicou. A primeira versão usava o último candle já
  fechado, o que dava até um minuto de vantagem a quem prevê (numa notícia, o tranco que ele
  acabou de ver na tela entraria como acerto); foi trocada antes de ir para o ar. Por isso o
  preço não é gravado na tabela: sai dos candles quando o minuto fecha.
- **O minuto de referência vem do coletor, nunca do relógio do PC:** é o candle em formação (o
  mais novo do banco); se o mais novo já fechou, é o minuto seguinte.
- **Previsão só é aceita com o preço ao vivo chegando:** último candle ao vivo há no máximo
  `MAX_FEED_AGE` = 10 s, medido por tempo decorrido (`performance.now` em `src/server.js`), não
  pela hora do relógio. Com o coletor parado, o "minuto em formação" do banco já teria fechado
  no mercado. Anotação sem previsão é sempre aceita (sem minuto de referência se o preço está
  parado).
- **Nada é alterado nem apagado:** não há rota para isso e o banco recusa (gatilhos). Uma
  previsão errada que pudesse ser apagada não contaria no placar. Erro de digitação se resolve
  com outra anotação.
- **A hora e o minuto de referência são carimbados pelo servidor;** o que o pedido mandar nesses
  campos é ignorado.
- **O resultado vai do preço de referência até o fechamento do candle que termina o prazo**, sem
  stop. Preço igual no fim do prazo conta como erro. Com mais de 2% dos minutos ausentes não há
  resultado.
- **Ordem do placar:** média no lado previsto, média com a taxa (como se tivesse operado: 0,1%
  por lado), pior previsão; os acertos por último, ao lado da chance de uma moeda fazer igual
  ou melhor. **Com menos de 20 previsões conferidas os números ficam em cinza: não provam nada.**
- A IA só LÊ o caderno; quem escreve é o Bruno. O texto das anotações é dado, não instrução.
- **Testar o caderno sempre num servidor de teste com banco separado** (`PORT`, `DB_FILE` e as
  três chaves vazias no comando): no banco principal uma anotação de teste ficaria para sempre.

Limites conhecidos:
- **Acertar o lado não é ganhar dinheiro.** A conta com taxa é sem stop e sem derrapagem.
- **O placar ainda não desconta a tendência:** num período de queda, quem diz "baixa" toda vez
  acerta mais da metade sem saber nada. A comparação honesta é com entradas às cegas do mesmo
  lado, prazo e período (o protocolo de `scripts/lib/campeonato.js`); ainda não foi feita. A
  tela avisa.
- Previsões com prazos que se sobrepõem não são independentes: 20 na mesma tarde valem menos
  que 20 em dias diferentes.
- Não há como anular uma previsão gravada por engano (a confirmação na tela é a proteção).
- Em par com poucos negócios a previsão é recusada quase sempre: no ADABRL (um negócio a cada
  3,5 minutos) o preço só "chegava" uns 10 segundos por minuto. No BTCUSDT os candles chegam a
  cada 1 a 2 segundos.
- A hora mostrada em cada anotação é a do relógio do PC; a conta usa o minuto da Binance.
- O resultado final de cada previsão fica guardado na memória por 10 minutos (refazer tudo a
  cada consulta custava de 1 a 6 ms por previsão, medido com 1 ano de candles). A régua do
  movimento típico lê o ano inteiro: 0,75 s na primeira consulta de cada hora.
- Só o par do `SYMBOL`. A lista mostra as 2.000 anotações mais recentes.

Verificado em 15/11/2026, sempre em servidores de teste com banco separado e sem chaves:
- os 26 casos das contas; `npm test` inteiro (155 casos);
- 29 conferências de ponta a ponta com o programa de verdade: hora e minuto carimbados pelo
  servidor (o minuto bateu com a hora da Binance), recusas, banco recusando alterar e apagar por
  fora do programa, pedido com nome de outro site recusado (403);
- **o preço de referência de uma previsão gravada ao vivo ficou idêntico ao fechamento oficial
  da Binance daquele minuto** (64.776,01; na tela, na hora do clique, estava 64.794,53), e o
  "até agora" bateu com a conta feita direto com o candle oficial;
- 9 previsões de exemplo num banco de teste (prazos de 1 hora a 1 semana) e o placar refeitos
  por um cálculo independente, com candles buscados direto na Binance: todos idênticos;
- sem conexão ao vivo (endereço que não responde) e com o preço parado de verdade (par ADABRL,
  conexão aberta, 11 s sem candle): previsão recusada, anotação simples aceita;
- a tela exercitada pelo navegador automatizado (gravar com confirmação, voltar, recusa sem
  preço ao vivo) e vista em foto.

Dois achados de passagem:
- **Dois processos do Node neste Windows discordam em alguns milissegundos sobre a hora** (até
  11 ms em 9.000 medições). Um teste meu assumia que não; o programa não depende disso.
- **A Binance manda o candle a cada virada de minuto mesmo sem negócio** (visto no ADABRL): o
  maior silêncio foi de 56 s e o vigia de 60 s não disparou em 7 minutos. A folga é de 4 s.

As instruções da IA mudaram em 15/11/2026: entrou o caderno e saiu a frase "o histórico de
candles tem cerca de 30 dias", que ficou errada com 1 ano no banco. A conversa anterior continua
guardada; a próxima mensagem começa uma conversa nova. **A IA ainda não leu as instruções novas
de verdade** (nenhuma mensagem foi enviada depois da mudança).

## Teste reverso, eventos e fotos (15/11/2026)

Pedido do Bruno em 15/11/2026: testes em que só se perde, um estudo do porquê das perdas, os
acontecimentos do período (Estados Unidos, Rússia e China; Brasil por último) e fotos das telas.

Como o Bruno acompanha: à distância, pela conversa. O programa roda num computador só (o
"principal", onde o Claude opera), e as telas só abrem nele. Quando ele não puder ver o sistema,
quer **fotos e relatórios**, enviados pela conversa.

O que existe:
- `scripts/estudo-perdas.js` — o teste reverso no histórico: de meia em meia hora, uma compra e
  uma venda em três jeitos (stop de 0,2%, 0,5% e 1%; alvo de 2× o stop; prazo de 1 h, 4 h e
  24 h), com as contas do replay (`stepTrade` e `tradeResult`) e passo de 1 minuto. Lê o banco
  só em leitura. Grava `boletas-so-perdas.csv` e `estudo-perdas.json` em
  `data/relatorios/<dia>/` (pasta que o git ignora).
- `scripts/fotos.js` — fotografa telas com o Edge ou o Chrome sem janela (protocolo de
  depuração, perfil temporário próprio). Recebe um arquivo de passos em JSON.
- Na tabela de eventos, cinco acontecimentos com horário exato, registrados pelo Claude em
  15/11/2026: decisão do Fed (28/10 18:00 UTC), roubo de US$ 6,3 bilhões na Binance
  (29/10 20:05 UTC), eleições nos EUA (03/11 23:00 UTC), emprego (06/11 13:30 UTC) e inflação
  (10/11 13:30 UTC).

Regras (não desfazer):
- **Só entra na tabela de eventos o que tem horário conhecido por fonte independente do preço.**
  Escolher o horário olhando o tranco no gráfico fabrica uma "reação". Notícia sem horário
  exato fica no relatório, não na tabela.
- O estudo descreve o período; não prevê. Todo número dele sai com o aviso de que as operações
  se sobrepõem no tempo e de que o histórico é curto.

Histórico de 1 ano (15/11/2026): a pedido do Bruno, o banco passou a ter os candles de 1 minuto
desde 15/11/2025 (526.895 candles), baixados pelo próprio programa com `BACKFILL_DAYS=365 npm
start`. Para isso o programa foi reiniciado às 18h30: a contagem de "dias seguidos rodando"
recomeçou dali, e o livro de ofertas tem um buraco de uns 4 minutos nesse horário. Com 1 ano no
banco, `/api/candles` leva 0,5 s em 1h, 1,9 s em 4h e 3,2 s em 1d.

Dois números do teste reverso que não se confundem (o Bruno estranhou "6 mil em 8 mil"):
- **Às cegas** (compra E venda em toda entrada): perde perto de 67% por pura conta, porque com
  alvo de 2× o stop e preço sem direção 2 em cada 3 saem no stop. Não é defeito do teste.
- **Errando todas** (em cada entrada, o lado que perde): 100% de perdas, por construção. Só é
  possível olhando o futuro; nenhuma regra de verdade consegue isso, nem o contrário disso.

O que saiu com 1 ano (16/11/2025 a 14/11/2026, 17.467 entradas, Bitcoin em queda de 32%):
- Errando todas: 52.401 de 52.401 perdem; perda média de 0,37%, 0,61% e 1,13% por operação nos
  três jeitos. Em 53%, 38% e 28% das entradas o lado contrário também perdia.
- Às cegas: 104.802 operações, 73.087 perdedoras (69,7%); perda média de 0,199%, 0,198% e
  0,201% por operação, que é a taxa. Vale para cada um dos 13 meses.
- Em 12 dos 13 meses o lado que mais perdeu foi o contrário à direção do mês.
- **O sinal da agressão, visto em 30 dias, não se confirmou em 1 ano** (no jeito médio
  inverteu). O único padrão que se repetiu: entrar "esticado" (comprar perto do topo da faixa
  de 4 horas, vender perto do fundo) foi pior, uns 0,04 ponto por operação. Nenhum grupo fica
  positivo depois das taxas.
- Errando todas com limites, 1 ano: perda de 79% a 100% com qualquer conjunto de exemplo.
- 1.200 boletas sorteadas refeitas por um cálculo independente: todas idênticas.
- `validar.js --completo` depois do download: os 526.894 candles fechados idênticos aos da
  Binance, sem buracos; negócios, ordens grandes e livro também conferem.

O que saiu (30 dias, de 16/10 a 14/11/2026, mês em que o Bitcoin caiu 21%):
- 8.604 operações simuladas, 6.060 perdedoras. Resultado médio de −0,200%, −0,185% e −0,206%
  por operação nos três jeitos: é a taxa de 0,2% (ida e volta). Antes das taxas, zero.
- Em 36% das entradas (58% com stop de 0,2%) perdem a compra E a venda.
- Com stop de 0,2% a taxa custa 100% do risco; para empatar seria preciso acertar 67%.
- Emprego e inflação dos EUA: preço 17 a 20 vezes o normal no primeiro minuto. Roubo na
  Binance: −1,87% em 1 hora (11 vezes o típico) e −4,3% em 1 dia.
- Em 30 dias, entrar contra a agressão dos últimos 30 minutos parecia pior. Em 1 ano isso não
  se confirmou (ver acima): conclusão tirada de 30 dias não vale.
- **Os quatro limites não freiam o mês.** Errando todas, 1% por operação com 3 por dia leva
  48% em 30 dias. Um limite de perda acumulada é uma ideia em aberto; a decisão é do Bruno.
- Teste do agente com tudo perdendo (corretora simulada; limites de teste de 1% por operação,
  3% por dia e 5 por dia): três stops, a terceira operação reduzida pelo que restava do dia, a
  quarta e a quinta barradas. O dia fechou em −300,68 para um limite de 300: um salto de preço
  passa do limite.

Verificado em 15/11/2026: 600 boletas sorteadas refeitas por um cálculo independente, todas
idênticas; `npm test` (128 casos) e `validar.js --completo` (45.894 candles idênticos); as
telas vistas em foto pela primeira vez. Os acontecimentos vieram de pesquisa na internet: o que
conferi foi o horário e o tamanho do movimento contra o nosso banco, não as notícias em si.

Vistos nas fotos e ainda não corrigidos: rótulos de ordens grandes e de eventos se sobrepõem
no gráfico quando há muitos juntos; na tela do replay sem sessão, a frase da taxa sai sem o
número.

Chaves (15/11/2026): a da Anthropic foi aceita numa consulta sem custo (os três modelos
aparecem). A do Demo Mode foi **recusada** (401, código −2015, a mesma resposta de uma chave
inventada): falta uma chave criada em demo.binance.com.

Mais tarde no mesmo dia (15/11/2026):
- **As chaves ficam só no `.env` do principal**, fora do git. **Antes de qualquer commit,
  conferir que o `.env.example` não tem chave**, e nunca mostrar o `git diff` desse arquivo. A
  chave do Demo Mode continua recusada: a tela do agente mostra o erro 401. **Nenhum pedaço de
  chave entra neste arquivo nem em outro do repositório**: nem o começo, nem o fim.
- **A IA respondeu de verdade.** Primeira conversa pela API da Anthropic: 32 segundos, cerca de
  US$ 0,12, cinco consultas numa rodada, sem aviso de recurso recusado e sem proposta (como
  pedido). A mensagem foi escrita pelo Claude a pedido do Bruno.
- `scripts/estudo-regras.js` — campeonato de regras: 20 situações conhecidas (alta ou queda
  forte, rompimentos, candles seguidos, médias, IFR, volume com agressão), comprando e vendendo,
  em dois jeitos; treino em 271 dias e confirmação nos últimos 92. **Resultado: nenhuma** das 80
  combinações perde ou ganha das entradas às cegas além do acaso (0 piores; 1 melhor no treino,
  que não se confirmou; 0 positivas depois das taxas). Sinais de 5 situações e 600 boletas
  conferidos por cálculo independente. A simulação comum aos estudos fica em
  `scripts/lib/historico.js`.
- Taxa contra movimento típico (1 ano): em 1 minuto o preço anda 0,024%, em 5 minutos 0,055%,
  em 1 hora 0,19% e em 1 dia 1,13%; a taxa de ida e volta é 0,2%. Operação rápida paga várias
  vezes o movimento normal.
- Quando o Bitcoin se mexe (Brasília): pico das 10h às 13h nos dias úteis (segunda das 9h às
  13h: 1,00% por hora, contra 0,62% na média); sábado é o dia mais parado; domingo à noite
  volta a mexer.
- Os dez maiores trancos do ano têm quase sempre alavancagem sendo liquidada, acesa por: juros e
  inflação dos EUA, ações de tecnologia e IA, Irã e petróleo, falas de Trump, ouro e prata, e
  notícias de cripto (roubo, ETFs, regras). Estão no relatório, não na tabela de eventos (as
  reportagens dão o dia, não o minuto).
- O programa foi reiniciado três vezes neste dia (18h30, 18h49 e antes disso às 23h41 de 14/11):
  o livro de ofertas tem um buraco em cada reinício.

Baleias (pedido do Bruno em 15/11/2026: "Sim, 90 dias"):
- `scripts/reconstruir-baleias.js` — reconstrói o fluxo por minuto e as ordens grandes de um
  período passado a partir do histórico público de negócios da Binance, sem guardar os negócios
  crus e **sem tocar no banco principal** (grava em `data/baleias.db`). As contas são as de
  `step` em `src/trades.js`, repetidas de propósito para não mexer no coletor que está rodando:
  **se mudar lá, mudar aqui.** Respeita o limite da Binance (teto de 2.800 de 6.000 por minuto),
  pode ser interrompido e retomado. Cada minuto é comparado com o candle (coluna `confere`).
- Teste de 3 horas: 180 minutos idênticos aos candles e 869 ordens grandes idênticas às que o
  coletor ao vivo gravou no mesmo trecho.
- Os 90 dias (17/08 a 15/11/2026) foram reconstruídos em 15/11/2026, em 128 minutos e sem
  aviso de limite da Binance: 85.324.677 negócios lidos, 816.103 ordens grandes, 130.924
  minutos idênticos aos candles (nenhum diferente). No trecho que o coletor ao vivo também
  gravou (1.541 minutos), fluxo e 15.751 ordens grandes idênticos, um por um. `data/baleias.db`
  tem 100 MB e fica fora do git.
- **Resultado do teste das baleias: nenhuma passou.** De 84 combinações (14 situações, comprar
  e vender, três jeitos), 0 perdem das cegas com folga, 1 ganhou no treino e não se confirmou, 0
  ficaram positivas depois das taxas. Uma baleia sozinha não manda no preço: depois das 12
  maiores ordens (8,5 a 10 milhões de USDT) o preço ficou dentro de 0,17% em 5 minutos. O único
  efeito que se repetiu: nos 5 minutos depois de um minuto com 30 ou mais ordens grandes, alta
  de 0,04% a 0,05% acima do normal, cinco vezes menor que a taxa. Os "efeitos" de 1 hora vistos
  no treino (período de alta) inverteram na confirmação (período de queda). Sinais de 4
  situações e 600 boletas conferidos por cálculo independente.
- `scripts/estudo-baleias.js` — 14 situações com ordens grandes (compra ou venda de 1 e de 3
  milhões, saldo em 5 e em 30 minutos, enxurrada de ordens, baleia contra o movimento, baleia
  absorvida), comprando e vendendo, em três jeitos; treino nos primeiros 60 dias, confirmação
  no resto. Só roda com a reconstrução completa (ou `--parcial`, para testar).
- `scripts/lib/campeonato.js` — o protocolo de treino e confirmação, comum ao campeonato de
  regras e ao teste das baleias. A reorganização foi conferida: o campeonato de regras deu a
  mesma impressão digital antes e depois.

Visão do Bruno para o projeto (mensagens de 15/11/2026, resumidas):
- um banco de notícias e acontecimentos do mundo (política, guerras, Irã, Rússia, China, ouro,
  petróleo, terras raras, nióbio, dólar, IA e chips, Nvidia, Tesla, SpaceX, alimentos e
  exportações do Brasil, escândalos, catástrofes, mortes de políticos e de presidentes de
  empresas), com um **campo aberto para as anotações e avaliações dele** sobre para que lado o
  mercado pode ir;
- um agente que acha padrão de compra ou venda, enxerga o momento (notícias incluídas), entra,
  realiza o lucro e sai;
- depois do Bitcoin: moedas "meme" e outras (Ethereum, Solana); mais tarde, MT5 para dólar e
  mini-índice.
- mais adiante (**ele pediu em 15/11/2026 para NÃO fazer isto agora**; fica só registrado, e
  com isso também esperam o teste "a favor ou contra a notícia" e o filtro de oferta que some):
  um programa que acompanhe Binance e B3 "por fora do gráfico", tirando os "fluxos falsos",
  nascido de testes em que o agente perde de propósito indo contra as notícias e depois testa o
  contrário. Foi dito a ele que "fluxo falso" precisa virar algo medido (oferta grande que some
  do livro, agressão absorvida, tranco devolvido em minutos).
**Nada do que foi conversado sobre valores é decisão de operar com dinheiro real:** continua
valendo a regra do Objetivo (só simulação até ele decidir com todas as letras, depois de meses
de resultado). O Claude não envia ordem com dinheiro real nem dá conselho de investimento; o
papel dele aqui é medir e dizer o que os dados mostram.
Foi dito a ele: abrir mais mercados antes de haver um padrão confirmado em um só multiplica o
trabalho sem aumentar a chance de lucro. A primeira peça pedida na ideia dele, o caderno de
anotações (o lado que ele espera, registrado antes, conferido depois pelo laboratório), foi
construída em 15/11/2026: ver "Caderno de anotações". Os assuntos da lista dele entram como
sugestões do campo "assunto" do caderno; a tabela de eventos continua com tipo livre.

Pedidos novos do Bruno em 15/11/2026, ainda SEM decisão tomada (não tratar como decididos):
- notícias e acontecimentos do mundo de forma contínua (ouro, chips e IA, guerras, petróleo e
  Ormuz, Rússia, China, Trump, foguetes, carros elétricos, catástrofes);
- um "cérebro" que procure padrões (baleias, picos, grandes quedas);
- o agente operando sozinho, com entradas e saídas rápidas, compensando as taxas.
O que foi dito a ele: os testes de hoje não acharam padrão nenhum, e a taxa pesa mais quanto
mais rápida a operação. Continua valendo "o agente propõe e o Bruno aprova cada ordem" até ele
mudar isso com todas as letras.
