// Fase 5: a ligacao com a API da Anthropic. E o UNICO lugar do projeto que usa a chave dela.
//
// Usa a biblioteca oficial (@anthropic-ai/sdk), a unica dependencia do projeto, e so para isto:
// sem ela instalada ("npm install") ou sem a chave no arquivo .env a IA fica desligada, a tela
// diz por que, e o resto do programa funciona igual.
//
// Travas (scripts/testar-ia-cliente.js confere):
//   1. O endereco e sempre passado por nos e conferido: so o da Anthropic, ou um servidor de
//      teste nesta mesma maquina. A variavel ANTHROPIC_BASE_URL do sistema e ignorada de
//      proposito: ha programas que a definem, e sem isso a chave iria parar em outro endereco.
//   2. A chave vem so de ANTHROPIC_API_KEY (arquivo .env) e nunca vai para log, tela ou
//      mensagem de erro.
export const AI_API_URL = 'https://api.anthropic.com';

export function assertAiUrl(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch { throw new Error(`endereco invalido para a API da Anthropic: ${baseUrl}`); }
  const localTest = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
  if (u.origin !== AI_API_URL && !localTest) {
    throw new Error(`endereco nao permitido para a API da Anthropic: ${u.origin}. A chave so e enviada a ${AI_API_URL}`);
  }
  return u.origin;
}

// Troca o erro da biblioteca por uma frase que o Bruno entenda na tela. Do mais especifico
// para o mais geral. O texto que a propria Anthropic manda entra quando ajuda; a chave, nunca.
function explain(err, Anthropic) {
  const api = err instanceof Anthropic.APIError && typeof err.apiMessage === 'string' ? `: ${err.apiMessage.slice(0, 400)}` : '';
  const say = (text) => Object.assign(new Error(text), { status: err?.status ?? null });
  if (err instanceof Anthropic.AuthenticationError) return say('a Anthropic recusou a chave (401). Confira a linha ANTHROPIC_API_KEY do arquivo .env');
  if (err instanceof Anthropic.PermissionDeniedError) return say(`a Anthropic negou o acesso (403)${api}`);
  if (err instanceof Anthropic.NotFoundError) return say(`a Anthropic nao encontrou o modelo pedido, ou a sua conta nao tem acesso a ele (404)${api}`);
  if (err instanceof Anthropic.ContentTooLargeError) return say('a conversa ficou grande demais para a API (413). Comece uma conversa nova');
  if (err instanceof Anthropic.RateLimitError) return say('a Anthropic limitou as chamadas agora (429). Espere um pouco e tente de novo');
  if (err instanceof Anthropic.BadRequestError) return say(`a Anthropic recusou o pedido (400)${api}`);
  if (err instanceof Anthropic.OverloadedError) return say('a API da Anthropic esta sobrecarregada (529). Tente de novo em instantes');
  if (err instanceof Anthropic.APIConnectionTimeoutError) return say('a Anthropic demorou demais para responder');
  if (err instanceof Anthropic.APIConnectionError) return say('sem conexao com a API da Anthropic (confira a internet)');
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) return say('a Anthropic acusou um problema de cobranca na sua conta (402). Confira os creditos em platform.claude.com');
    return say(`a API da Anthropic respondeu com erro${err.status ? ` (${err.status})` : ''}${api}`);
  }
  return say(`erro inesperado ao falar com a Anthropic (${err?.name ?? 'sem nome'})`);
}

//   baseUrl - endereco da API (o padrao e o da Anthropic; os testes passam um servidor local)
//   apiKey  - a chave; o padrao e a variavel ANTHROPIC_API_KEY, que vem do arquivo .env
//   load    - como carregar a biblioteca (os testes trocam para simular "nao instalada")
// Devolve { transport, offReason }: transport e null quando a IA nao pode ser ligada.
export async function createAiTransport({ baseUrl = AI_API_URL, apiKey = process.env.ANTHROPIC_API_KEY, load = () => import('@anthropic-ai/sdk') } = {}) {
  const off = (offReason) => ({ transport: null, offReason });
  const key = String(apiKey ?? '').trim();
  if (!key) return off('falta a chave ANTHROPIC_API_KEY no arquivo .env');
  let origin;
  try { origin = assertAiUrl(baseUrl); } catch (err) { return off(err.message); }
  let Anthropic;
  try { ({ default: Anthropic } = await load()); } catch { return off('falta instalar a biblioteca da Anthropic: rode "npm install" na pasta do projeto'); }
  // Chave e endereco passados aqui valem mais que qualquer variavel do sistema. Uma tentativa a
  // mais em falha passageira (rede, 429, 5xx), com ate 5 minutos de espera por tentativa.
  const client = new Anthropic({ apiKey: key, baseURL: origin, maxRetries: 1, timeout: 5 * 60_000 });
  return {
    offReason: null,
    transport: {
      origin,
      // Recebe o pedido montado em src/ai.js e devolve a mensagem da API como ela veio.
      async send({ betas, ...body }) {
        try {
          return await client.beta.messages.create({ ...body, betas });
        } catch (err) {
          throw explain(err, Anthropic);
        }
      },
    },
  };
}
