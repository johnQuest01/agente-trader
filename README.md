# Agente Trader

Laboratorio local de trading com dados reais da Binance (par BTCUSDT por padrao).
Fase 1: coletor de candles de 1 minuto em SQLite + grafico no navegador.
Fase 2: negocios, agressao compradora x vendedora por minuto, ordens grandes e livro de ofertas.
Fase 3: replay de um periodo passado, com a operacao registrada antes de ver o resultado.
Fase 4: tabela de eventos com horario exato e a reacao do preco a cada um.
Fase 5: propostas de operacao que so viram ordem depois de aprovadas, e so no Demo Mode da
Binance (conta de demonstracao, sem dinheiro real).
Leia `CLAUDE.md` para o objetivo, as fases e o estado do projeto.

## Requisitos

- Node >= 22.13 (testado com 22.20 e 26.13.1). Sem `npm install`: zero dependencias, com uma
  excecao: a IA da fase 5 usa a biblioteca oficial da Anthropic. Para liga-la, rode
  `npm install` uma vez; sem isso, so a IA fica desligada.
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
apagados depois de 7 dias; o fluxo por minuto e as ordens grandes ficam para sempre.
`TRADES=0 npm start` desliga essa parte.

## Fase 2: livro de ofertas

O `npm start` tambem mantem uma copia local do livro de ofertas e grava um resumo por segundo:
melhor compra, melhor venda e a quantidade ofertada de cada lado ate 0,02%, 0,05%, 0,1%, 0,2%,
0,5% e 1% do preco, mais as maiores ofertas.

- `http://localhost:3333/api/book` - o livro agora.
- `http://localhost:3333/api/book/check` - compara o livro local, nivel a nivel, com uma foto
  nova da Binance (o programa tambem faz isso sozinho a cada 10 minutos).

Custa cerca de 1,3 GB de trafego de internet por dia e uns 12 MB de disco por dia (guardados
por 14 dias; a media por minuto fica para sempre). `BOOK=0 npm start` desliga essa parte.

## Fase 3: replay

Abra http://localhost:3333/replay. "Sortear periodo" escolhe um trecho qualquer do historico e
esconde a data e o nivel de preco ate o fim. Os candles sao revelados um a um (botao ou barra
de espaco); a operacao (compra ou venda, stop obrigatorio, alvo opcional, prazo e motivo) e
registrada antes de revelar o proximo, com entrada no fechamento do ultimo candle visivel. O
resumo da sessao da o resultado liquido de taxas, a perda maxima e a expectativa por operacao.

```bash
node scripts/testar-replay.js
```

confere as contas do replay (nao precisa do servidor nem da internet).

## Fase 4: eventos e noticias

Abra http://localhost:3333/eventos. Registre o evento com o horario exato (pelo formulario, ou
varias linhas de uma vez: `data e hora; titulo; tipo; importancia; fonte; anotacao`). A tabela
mostra a reacao do preco em 1 minuto, 5 minutos, 1 hora, 1 dia e 1 semana, ao lado de quantas
vezes isso foi maior que o movimento tipico daquela janela, e a media por tipo de evento. Na
tela ao vivo, cada evento aparece como um quadrado amarelo no candle em que aconteceu.

```bash
node scripts/testar-eventos.js
```

confere as contas (nao precisa do servidor nem da internet).

## Fase 5: agente e Demo Mode (simulacao)

Abra http://localhost:3333/agente. Uma proposta de compra (stop obrigatorio, alvo opcional e
motivo) fica esperando a decisao; nada e enviado antes de "Aprovar" (dois cliques). Aprovada,
a trava de risco calcula o tamanho, a compra vai para o Demo Mode da Binance (conta de
demonstracao, sem dinheiro real) e o stop fica parado na corretora. Tudo vai para o registro,
que nao pode ser apagado. As propostas entram pelo formulario da tela ou pela IA (abaixo).

Para o agente poder enviar ordens faltam duas coisas, e as duas sao de quem usa:

1. Os limites de risco, no arquivo `src/limits.js`: perda maxima por operacao, perda maxima
   por dia, tamanho maximo da posicao e operacoes por dia. Enquanto estiverem vazios, nenhuma
   ordem sai.
2. As chaves do Demo Mode: crie em https://demo.binance.com ("API Key Management"), copie
   `.env.example` para `.env` e preencha. Nunca use chave da conta de verdade. O programa so
   fala com `https://demo-api.binance.com` e recusa qualquer outro endereco.

O Demo Mode tem livro de ofertas proprio: o preco acompanha o mercado de verdade, mas nao e
igual, e o resultado de la nao prova o que aconteceria com dinheiro real.

### A IA do agente

Na mesma tela ha o painel "Conversa com a IA". Ela le os dados do laboratorio (candles,
ordens grandes, livro, eventos, a conta e as operacoes passadas) e pode registrar uma
proposta, que aparece esperando a sua decisao como qualquer outra. Ela nao aprova, nao envia
ordem e nao muda limite: essas funcoes nao estao entre as ferramentas dela. So responde
quando voce escreve.

Para ligar:

```bash
npm install
```

(uma vez; baixa a biblioteca oficial da Anthropic) e preencha `ANTHROPIC_API_KEY` no arquivo
`.env`, com uma chave criada em https://platform.claude.com. **Cada mensagem custa dinheiro de
verdade na sua conta da Anthropic.** O modelo padrao e o Claude Opus 5.5; ha um teto de gasto
estimado de 2 dolares por dia, que voce muda com `AI_MAX_USD_PER_DAY` (a tela mostra o gasto
estimado do dia). `AI_MODEL` troca o modelo (`claude-sonnet-5-5` e `claude-haiku-5-5` sao mais
baratos).

### Testes da fase 5

```bash
npm test
```

roda todos os testes do projeto: a trava de risco, o cliente do Demo Mode, o fluxo inteiro
contra uma corretora de mentira, a conversa com uma IA de roteiro e a biblioteca da Anthropic
contra uma API de mentira, alem dos testes do replay e dos eventos. Nenhum usa a internet,
chave de verdade ou dinheiro. (`scripts/testar-ia-cliente.js` precisa do `npm install`.)

## Variaveis de ambiente

`SYMBOL`, `PORT`, `BACKFILL_DAYS`, `BINANCE_REST`, `BINANCE_WS`, `TRADES`, `TRADES_KEEP_DAYS`,
`TRADES_BACKFILL_HOURS`, `TRADES_MAX_GAP_HOURS`, `BIG_ORDER_USDT`, `BOOK`, `BOOK_KEEP_DAYS`,
`REPLAY_FEE_PCT`, `AGENT_FEE_PCT`, `AGENT_PROPOSAL_TTL_MIN`, `AGENT_MAX_SLIP_PCT`, `DEMO_URL`,
`AI_MODEL`, `AI_EFFORT`, `AI_MAX_TOKENS`, `AI_MAX_ROUNDS`, `AI_MAX_USD_PER_DAY`, `AI_URL`
(ver `src/config.js`). Elas tambem podem ficar no arquivo `.env`, que o git ignora; os limites
de risco nao sao variaveis: ficam so em `src/limits.js`.
