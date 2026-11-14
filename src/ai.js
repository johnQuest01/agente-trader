// Fase 5: a conversa com a IA (API da Anthropic).
//
// A IA conversa com o Bruno, olha os dados do laboratorio pelas ferramentas de src/ai-tools.js e
// pode REGISTRAR uma proposta. Ela nao aprova, nao envia ordem e nao muda limite: essas funcoes
// nao estao entre as ferramentas dela.
//
// Regras deste arquivo (scripts/testar-ia.js confere):
//   - A conversa e reenviada inteira a cada rodada, exatamente como foi gravada: instrucoes,
//     ferramentas e mensagens antigas nunca sao reescritas. Os modelos atuais guardam o
//     raciocinio de uma rodada para a outra preso a esse historico; mexer nele invalida o que
//     foi guardado (e, numa conta nova da Anthropic, a chamada e recusada).
//   - O que muda a cada pergunta (hora, preco, situacao da conta) vai DENTRO da mensagem nova,
//     nunca nas instrucoes.
//   - Uma mensagem por vez; no maximo `maxRounds` rodadas de consulta por mensagem; e um teto
//     de gasto por dia (estimado), para uma conversa nao virar uma conta inesperada.
//   - A chave da API nunca aparece aqui: quem fala com a Anthropic e o `transport`.
import { createHash } from 'node:crypto';
import { TOOLS, runTool, describeCall } from './ai-tools.js';
import { isJson, readJson } from './http.js';
import { systemPrompt } from './ai-prompt.js';

export { systemPrompt };

const DAY = 86_400_000;
const dayStart = (ms) => Date.parse(`${new Date(ms).toISOString().slice(0, 10)}T00:00:00Z`);
const utc = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });

// Precos por milhao de tokens, em dolares, da tabela da Anthropic consultada em 03/11/2026.
// Servem so para a estimativa mostrada na tela e para o teto diario: a conta de verdade e a que
// a Anthropic cobra. A escrita em cache e a de 5 minutos.
export const PRICES = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
// Modelo fora da tabela: estima pelo mais caro, para o teto diario errar para o lado seguro.
const PRICE_UNKNOWN = PRICES['claude-fable-5-2'];

export function estimateCost(model, usage = {}) {
  const p = PRICES[model] ?? PRICE_UNKNOWN;
  return ((usage.input_tokens ?? 0) * p.input + (usage.output_tokens ?? 0) * p.output
    + (usage.cache_read_input_tokens ?? 0) * p.cacheRead + (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite) / 1e6;
}

// Modelos que aceitam o pedido de "se o modelo recusar por engano, tente no modelo substituto".
const WITH_FALLBACK = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

// Depois de uma troca de modelo no meio da resposta (o modelo pedido recusou e o substituto
// continuou), a Anthropic pede que o turno volte assim: o que veio ANTES do ultimo bloco
// "fallback" volta so com os textos; o bloco fica onde estava; o que veio depois volta inteiro.
export function echoable(content) {
  const cut = content.map((b) => b.type).lastIndexOf('fallback');
  if (cut < 0) return content;
  return content.filter((b, i) => i >= cut || b.type === 'text');
}

//   transport - quem fala com a Anthropic: { send(pedido) -> mensagem }, ou null se a IA esta desligada
//   offReason - por que esta desligada (falta a chave, etc.), para a tela
//   agent     - o agente de src/agent.js (a IA usa `state` e `propose`, e so)
//   book      - funcao que devolve o resumo do livro de ofertas de agora, ou null
export function createAi({
  db, symbol, agent, book = () => null, transport = null, offReason = null,
  model = 'claude-opus-5-5', effort = 'medium', maxTokens = 16_000, maxRounds = 8, maxUsdPerDay = 2,
  now = Date.now, log = () => {}, onChange = () => {},
}) {
  const SYSTEM = systemPrompt(symbol);
  const setup = createHash('sha256').update(SYSTEM).update(JSON.stringify(TOOLS)).update(model).digest('hex').slice(0, 16);
  const ctx = { db, symbol, agent, book, now };
  let busy = false;
  let doing = null; // o que a IA esta fazendo agora, para a tela

  const spentToday = () => db.aiSpent(dayStart(now()), dayStart(now()) + DAY);
  function budgetProblem() {
    if (!(maxUsdPerDay > 0)) return null;
    const spent = spentToday();
    return spent >= maxUsdPerDay
      ? `o teto de gasto da IA por dia foi atingido (cerca de US$ ${spent.toFixed(2)} de US$ ${maxUsdPerDay.toFixed(2)}). Volta amanha (dia UTC), ou aumente AI_MAX_USD_PER_DAY no arquivo .env`
      : null;
  }

  const add = (conversation, role, content, { shown = null, meta = null, cost = null } = {}) => db.aiMessageAdd({
    conversation, time: now(), role, content: JSON.stringify(content), shown, meta: meta && JSON.stringify(meta), cost,
  });
  // Uma linha que aparece na tela mas nao vai para a IA (erro, recusa, aviso).
  const note = (conversation, text, extra = {}) => add(conversation, 'nota', [], { shown: text, ...extra });

  // A conversa em andamento. Se as instrucoes, as ferramentas ou o modelo mudaram desde que ela
  // comecou, o historico antigo nao serve mais para a IA: comeca outra.
  function currentConversation(create) {
    const last = db.aiConversationLast(symbol);
    if (last && last.setup === setup) return last.id;
    return create ? db.aiConversationAdd({ symbol, startedAt: now(), model, setup }) : null;
  }

  // O que o programa conta a IA no comeco de cada mensagem: muda a cada pergunta, entao fica
  // na mensagem (e e gravado com ela), nunca nas instrucoes.
  function situation() {
    const s = agent.state();
    const last = db.lastOpenTime(symbol);
    const c = last === null ? null : db.candleAt(symbol, last);
    const live = s.proposals.filter((p) => ['enviando', 'aberta', 'fechando', 'atencao'].includes(p.status));
    const pending = s.proposals.filter((p) => p.status === 'pendente');
    return [
      `[Situacao do laboratorio em ${utc(now())} UTC. Este bloco foi gerado pelo programa, nao escrito pelo usuario.]`,
      c ? `Preco do ${symbol} no mercado de verdade: ${c.close} (candle de 1 minuto das ${utc(last).slice(11)} UTC).` : 'Ainda nao ha candles no banco.',
      s.limits.problem ? 'Limites de risco: ainda nao definidos pelo usuario (nenhuma ordem pode ser enviada).' : `Limites de risco: ${s.limits.maxLossPerTradePct}% por operacao, ${s.limits.maxLossPerDayPct}% por dia, posicao de ate ${s.limits.maxPositionPct}% do saldo, ${s.limits.maxTradesPerDay} operacoes por dia.`,
      !s.demo.keys ? 'Demo Mode: faltam as chaves (nenhuma ordem pode ser enviada).' : s.account ? `Demo Mode: saldo ${s.account.equity.toFixed(2)} ${s.account.asset}; preco la ${s.account.bid} / ${s.account.ask}.` : 'Demo Mode: chaves encontradas; conta ainda nao lida.',
      `Posicao aberta: ${live.length ? live.map((p) => `#${p.id} (${p.status})`).join(', ') : 'nenhuma'}. Propostas esperando decisao: ${pending.length ? pending.map((p) => `#${p.id}`).join(', ') : 'nenhuma'}. Resultado realizado hoje: ${s.day.realized.toFixed(2)}.`,
    ].join('\n');
  }

  const apiMessages = (conversation) => db.aiMessages(conversation)
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: JSON.parse(m.content) }));

  // `plain` = sem os dois recursos opcionais (ver `call`).
  function request(messages, lastRound, plain) {
    const req = {
      model, max_tokens: maxTokens,
      // As instrucoes e as ferramentas sao a parte fixa: ficam em cache (bem mais barato reler).
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: TOOLS,
      messages,
      cache_control: { type: 'ephemeral' }, // e a conversa, que so cresce, tambem
      // O raciocinio fica sempre ligado nestes modelos; `effort` regula quanto.
      thinking: { type: 'adaptive' },
      output_config: { effort },
    };
    if (!plain) {
      // Opcional 1: se o historico nao bater com o que o modelo guardou (so por defeito nosso),
      // ele segue sem esse raciocinio em vez de recusar a chamada.
      req.thinking.block_binding = { prefix_mismatch_behavior: 'drop_block' };
      req.betas = ['thinking-binding-controls-2026-08-01'];
      // Opcional 2: se o filtro de seguranca recusar a pergunta por engano, a Anthropic refaz
      // no modelo substituto.
      if (WITH_FALLBACK.has(model)) {
        req.fallbacks = 'default';
        req.betas.push('server-side-fallback-2026-07-01');
      }
    }
    if (lastRound) req.tool_choice = { type: 'none' }; // ultima rodada: responde com o que ja tem
    return req;
  }

  // Chama a API. Os dois recursos opcionais sao novos e podem nao estar liberados em toda
  // conta: se a API recusar o pedido (erro 400), tenta uma vez sem eles e, dando certo, segue
  // sem eles dali em diante. Se o pedido simples tambem falhar, o erro e outro e sobe.
  let plain = false;
  async function call(conversation, lastRound) {
    const messages = apiMessages(conversation);
    try {
      return await transport.send(request(messages, lastRound, plain));
    } catch (err) {
      if (err?.status !== 400 || plain) throw err;
      const msg = await transport.send(request(messages, lastRound, true));
      plain = true;
      log(`ia: a API recusou os recursos opcionais (${err.message}); sigo sem eles`);
      note(conversation, `A Anthropic recusou os recursos opcionais do pedido (${err.message}). Sigo sem eles: a conversa funciona igual, so nao ha troca automatica de modelo se o filtro de seguranca recusar uma pergunta por engano.`);
      return msg;
    }
  }

  // Uma mensagem do usuario, do comeco ao fim: chama a IA, executa as consultas que ela pedir
  // e repete ate ela responder (ou ate o limite de rodadas).
  async function run(conversation) {
    for (let round = 1; ; round++) {
      const stop = budgetProblem();
      if (stop) {
        note(conversation, `Parei aqui: ${stop}.`);
        return;
      }
      doing = round === 1 ? 'pensando...' : 'lendo o que consultou...';
      onChange();
      const msg = await call(conversation, round >= maxRounds);
      const cost = estimateCost(msg.model ?? model, msg.usage);
      const meta = { model: msg.model ?? model, stop: msg.stop_reason, usage: msg.usage ?? null, round };
      if (msg.input_transformations?.length) {
        meta.dropped = msg.input_transformations.length;
        log(`ia: ${meta.dropped} bloco(s) de raciocinio antigo foram descartados pela API (o historico nao bateu)`);
      }
      // Recusa: nada do que veio e aproveitado, e nenhuma ferramenta e executada.
      if (msg.stop_reason === 'refusal') {
        const cat = msg.stop_details?.category;
        note(conversation, `A IA recusou esta mensagem${cat ? ` (filtro de seguranca: ${cat})` : ''}. Nada foi feito. Tente reformular.`, { meta, cost });
        return;
      }
      const content = echoable(msg.content ?? []);
      const uses = content.filter((b) => b.type === 'tool_use');
      const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      // Resposta cortada no meio de um pedido de consulta: a entrada pode estar incompleta, entao
      // nao e executada nem gravada.
      if (uses.length && msg.stop_reason !== 'tool_use') {
        note(conversation, `A resposta da IA foi cortada pelo limite de tamanho (${maxTokens} tokens) no meio de uma consulta. Tente uma pergunta mais especifica.`, { meta, cost });
        return;
      }
      if (uses.length) {
        const results = [];
        const calls = [];
        for (const u of uses) {
          doing = `consultando: ${describeCall(u.name, u.input)}`;
          onChange();
          const r = runTool(ctx, u.name, u.input);
          results.push({ type: 'tool_result', tool_use_id: u.id, content: r.text, ...(r.isError ? { is_error: true } : {}) });
          calls.push({ name: u.name, what: describeCall(u.name, u.input), error: r.isError });
        }
        // O pedido de consulta e as respostas entram juntos no historico: um sem o outro
        // deixaria a conversa invalida para a API.
        db.tx(() => {
          add(conversation, 'assistant', content, { shown: text, meta: { ...meta, calls }, cost });
          add(conversation, 'user', results);
        });
        onChange();
        continue;
      }
      add(conversation, 'assistant', content, { shown: text || '(a IA nao escreveu resposta)', meta, cost });
      if (msg.stop_reason === 'max_tokens') note(conversation, `A resposta acima foi cortada pelo limite de tamanho (${maxTokens} tokens).`);
      return;
    }
  }

  // Recebe uma mensagem do usuario. Devolve logo; a resposta chega depois (a tela acompanha).
  function send(text) {
    const clean = String(text ?? '').trim();
    if (!clean) throw new Error('escreva a mensagem');
    if (clean.length > 4000) throw new Error('mensagem longa demais (o maximo e de 4000 caracteres)');
    if (!transport) throw conflict(offReason ?? 'a IA esta desligada');
    if (busy) throw conflict('a IA ainda esta respondendo a mensagem anterior');
    const stop = budgetProblem();
    if (stop) throw conflict(stop);
    const conversation = currentConversation(true);
    add(conversation, 'user', [{ type: 'text', text: situation() }, { type: 'text', text: clean }], { shown: clean });
    busy = true;
    onChange();
    const done = run(conversation)
      .catch((err) => {
        log(`ia: ${err.message}`);
        note(conversation, `Nao consegui falar com a IA: ${err.message}`);
      })
      .finally(() => {
        busy = false;
        doing = null;
        onChange();
      });
    return { conversation, done };
  }

  function reset() {
    if (busy) throw conflict('a IA ainda esta respondendo: espere terminar para comecar outra conversa');
    return db.aiConversationAdd({ symbol, startedAt: now(), model, setup });
  }

  function view() {
    const id = currentConversation(false);
    const rows = id === null ? [] : db.aiMessages(id);
    const messages = rows.filter((m) => m.shown !== null).map((m) => {
      const meta = m.meta ? JSON.parse(m.meta) : null;
      return { id: m.id, time: m.time, role: m.role === 'user' ? 'voce' : m.role === 'assistant' ? 'ia' : 'nota', text: m.shown, calls: meta?.calls ?? [], cost: m.cost };
    });
    // Tamanho da conversa: o que foi enviado na ultima chamada (ela e reenviada inteira a cada rodada).
    const lastUsage = rows.map((m) => (m.meta ? JSON.parse(m.meta).usage : null)).filter(Boolean).at(-1);
    const size = lastUsage ? (lastUsage.input_tokens ?? 0) + (lastUsage.cache_read_input_tokens ?? 0) + (lastUsage.cache_creation_input_tokens ?? 0) : 0;
    return {
      status: {
        on: !!transport, offReason: transport ? null : offReason, model, effort, busy, doing,
        spentToday: spentToday(), maxUsdPerDay, priced: model in PRICES, conversation: id, size,
        cost: rows.reduce((s, m) => s + (m.cost ?? 0), 0),
      },
      messages,
    };
  }

  return { send, reset, view };
}

// ---------- rotas HTTP ----------
export async function handleAi(req, res, url, { ai, json }) {
  if (!url.pathname.startsWith('/api/ai/')) return false;
  if (!ai) {
    json(res, 503, { error: 'a IA ainda nao foi iniciada' });
    return true;
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/ai/chat') {
      json(res, 200, ai.view());
      return true;
    }
    if (req.method === 'POST') {
      if (!isJson(req)) {
        json(res, 415, { error: 'envie JSON (content-type: application/json)' });
        return true;
      }
      const body = await readJson(req);
      if (url.pathname === '/api/ai/send') ai.send(body.text);
      else if (url.pathname === '/api/ai/new') ai.reset();
      else {
        json(res, 404, { error: 'rota da IA desconhecida' });
        return true;
      }
      json(res, 200, ai.view());
      return true;
    }
    json(res, 404, { error: 'rota da IA desconhecida' });
  } catch (err) {
    json(res, err.status ?? 400, { error: String(err?.message || err) });
  }
  return true;
}
