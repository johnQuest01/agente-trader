// Testa a ligacao com a API da Anthropic (src/ai-client.js) com a biblioteca oficial de verdade
// falando com uma API de mentira que roda dentro do proprio teste, em 127.0.0.1. Nao usa a
// internet nem chave de verdade, e nao gasta nada.
//
//   node scripts/testar-ia-cliente.js      (precisa de "npm install" antes)

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.removeAllListeners('warning');
process.on('warning', (w) => { if (!/SQLite/i.test(w.message)) console.warn(w); });

try {
  await import('@anthropic-ai/sdk');
} catch {
  console.error('NAO RODOU: a biblioteca da Anthropic nao esta instalada. Rode "npm install" na pasta do projeto e tente de novo.');
  process.exit(1);
}

const { createAiTransport, assertAiUrl, AI_API_URL } = await import('../src/ai-client.js');
const { createAi } = await import('../src/ai.js');
const { createAgent } = await import('../src/agent.js');
const { openDb } = await import('../src/db.js');

let feitos = 0;
const caso = async (nome, fn) => { await fn(); feitos++; console.log(`ok  ${nome}`); };
const CHAVE = 'sk-ant-chave-de-teste-0000';

// ---------- API de mentira ----------
const recebidos = []; // { method, path, headers, body }
const roteiro = [];   // o que responder a cada pedido: { status, body, headers } ou funcao
const api = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const pedido = { method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    recebidos.push(pedido);
    const passo = roteiro.shift() ?? { status: 500, body: { type: 'error', error: { type: 'api_error', message: 'o roteiro do teste acabou' } } };
    const r = typeof passo === 'function' ? passo(pedido) : passo;
    res.writeHead(r.status ?? 200, { 'content-type': 'application/json', 'request-id': 'req_teste', ...(r.headers ?? {}) });
    res.end(JSON.stringify(r.body));
  });
});
await new Promise((r) => api.listen(0, '127.0.0.1', r));
const URL_API = `http://127.0.0.1:${api.address().port}`;
// Um segundo servidor, que nao pode receber nada: e para onde as variaveis do sistema apontam.
let noDesvio = 0;
const desvio = http.createServer((req, res) => { noDesvio++; res.end('{}'); });
await new Promise((r) => desvio.listen(0, '127.0.0.1', r));

const USO = { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const mensagem = (content, stop = 'end_turn') => ({ body: { id: 'msg_01', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: USO } });
const erro = (status, type, message, headers) => ({ status, headers, body: { type: 'error', error: { type, message }, request_id: 'req_teste' } });
const PEDIDO = {
  model: 'claude-opus-5-5', max_tokens: 16_000,
  system: [{ type: 'text', text: 'instrucoes', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'ver_livro', description: 'd', strict: true, input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }],
  cache_control: { type: 'ephemeral' },
  thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
  output_config: { effort: 'medium' },
  fallbacks: 'default',
  betas: ['thinking-binding-controls-2026-08-01', 'server-side-fallback-2026-07-01'],
};
const ligar = async (extra = {}) => (await createAiTransport({ baseUrl: URL_API, apiKey: CHAVE, ...extra })).transport;
// A chave que chegou a API. A versao 1.8.0 da biblioteca manda em "Authorization: Bearer ...";
// versoes antigas mandavam em "x-api-key". O que importa e que seja a nossa, e so ela.
const chaveRecebida = (p) => p.headers['x-api-key'] ?? String(p.headers.authorization ?? '').replace(/^Bearer /, '');

await caso('a chave so pode ir para a Anthropic ou para um teste nesta maquina', () => {
  assert.equal(assertAiUrl(AI_API_URL), 'https://api.anthropic.com');
  assert.equal(assertAiUrl('https://api.anthropic.com/v1/messages'), 'https://api.anthropic.com');
  assert.equal(assertAiUrl(URL_API), URL_API);
  for (const proibido of [
    'http://api.anthropic.com',                    // sem criptografia
    'https://api.anthropic.com.exemplo.com',       // parece, mas e outro endereco
    'https://api.anthropic.com@exemplo.com',
    'https://exemplo.com/api.anthropic.com',
    'https://api.anthropic.com:8443',
    'https://api.openai.com',
    'https://127.0.0.1:8443',
    'http://192.168.0.10:3000',
    'nao-e-endereco',
  ]) assert.throws(() => assertAiUrl(proibido), /nao permitido|invalido/, proibido);
});

await caso('sem chave, com endereco proibido ou sem a biblioteca: a IA fica desligada e diz por que', async () => {
  assert.deepEqual(await createAiTransport({ baseUrl: URL_API, apiKey: '' }), { transport: null, offReason: 'falta a chave ANTHROPIC_API_KEY no arquivo .env' });
  assert.deepEqual(await createAiTransport({ baseUrl: URL_API, apiKey: '   ' }), { transport: null, offReason: 'falta a chave ANTHROPIC_API_KEY no arquivo .env' });
  const r = await createAiTransport({ baseUrl: 'https://exemplo.com', apiKey: CHAVE });
  assert.equal(r.transport, null);
  assert.match(r.offReason, /nao permitido/);
  const semLib = await createAiTransport({ baseUrl: URL_API, apiKey: CHAVE, load: async () => { throw new Error('Cannot find package'); } });
  assert.deepEqual(semLib, { transport: null, offReason: 'falta instalar a biblioteca da Anthropic: rode "npm install" na pasta do projeto' });
});

await caso('o pedido chega a API como foi montado: chave e recursos no cabecalho, o resto no corpo', async () => {
  roteiro.push(mensagem([{ type: 'text', text: 'Olá.' }]));
  const t = await ligar();
  const m = await t.send(structuredClone(PEDIDO));
  assert.deepEqual([m.stop_reason, m.content, m.usage.input_tokens, m.model], ['end_turn', [{ type: 'text', text: 'Olá.' }], 900, 'claude-opus-5-5']);
  const p = recebidos.at(-1);
  assert.equal(p.method, 'POST');
  assert.match(p.path, /^\/v1\/messages(\?|$)/);
  assert.equal(chaveRecebida(p), CHAVE);
  assert.ok(p.headers['anthropic-version'], 'a biblioteca manda a versao da API');
  assert.deepEqual(p.headers['anthropic-beta'].split(',').map((s) => s.trim()).sort(), [...PEDIDO.betas].sort());
  const { betas, ...corpo } = PEDIDO;
  assert.equal(p.body.betas, undefined, 'os recursos em teste vao no cabecalho, nao no corpo');
  assert.equal(p.body.stream, undefined, 'pedido sem transmissao aos poucos');
  for (const [campo, valor] of Object.entries(corpo)) assert.deepEqual(p.body[campo], valor, campo);
});

await caso('variaveis do sistema nao desviam a chave: ANTHROPIC_BASE_URL e ANTHROPIC_AUTH_TOKEN sao ignoradas', async () => {
  const antes = { url: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${desvio.address().port}`;
  process.env.ANTHROPIC_AUTH_TOKEN = 'token-do-ambiente';
  try {
    roteiro.push(mensagem([{ type: 'text', text: 'ok' }]));
    const t = await ligar();
    await t.send(structuredClone(PEDIDO));
    assert.equal(noDesvio, 0, 'nada foi para o endereco da variavel do sistema');
    const p = recebidos.at(-1);
    assert.equal(chaveRecebida(p), CHAVE);
    assert.doesNotMatch(JSON.stringify(p.headers), /token-do-ambiente/);
    assert.equal(t.origin, URL_API);
  } finally {
    for (const [k, v] of [['ANTHROPIC_BASE_URL', antes.url], ['ANTHROPIC_AUTH_TOKEN', antes.token]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

await caso('erros viram frases claras, sem a chave no texto', async () => {
  const t = await ligar();
  const falha = async (passos, re, tentativas) => {
    const antes = recebidos.length;
    roteiro.push(...passos);
    await assert.rejects(t.send(structuredClone(PEDIDO)), (err) => {
      assert.match(err.message, re);
      assert.doesNotMatch(`${err.message} ${err.stack}`, new RegExp(CHAVE));
      return true;
    });
    assert.equal(recebidos.length - antes, tentativas, `tentativas para ${re}`);
    roteiro.length = 0;
  };
  const logo = { 'retry-after-ms': '5' };
  await falha([erro(401, 'authentication_error', 'invalid x-api-key')], /recusou a chave \(401\)\. Confira a linha ANTHROPIC_API_KEY/, 1);
  await falha([erro(402, 'billing_error', 'Your credit balance is too low')], /problema de cobranca na sua conta \(402\)/, 1);
  await falha([erro(403, 'permission_error', 'not allowed')], /negou o acesso \(403\): not allowed/, 1);
  await falha([erro(404, 'not_found_error', 'model: claude-opus-9')], /nao encontrou o modelo pedido.*\(404\): model: claude-opus-9/, 1);
  await falha([erro(400, 'invalid_request_error', 'Unexpected value(s) `x` for the `anthropic-beta` header.')], /recusou o pedido \(400\): Unexpected value\(s\) `x` for the `anthropic-beta` header\./, 1);
  await falha([erro(413, 'request_too_large', 'too large')], /grande demais para a API \(413\)\. Comece uma conversa nova/, 1);
  // Falhas passageiras: a biblioteca tenta mais uma vez sozinha antes de desistir.
  await falha([erro(429, 'rate_limit_error', 'slow down', logo), erro(429, 'rate_limit_error', 'slow down', logo)], /limitou as chamadas agora \(429\)/, 2);
  await falha([erro(529, 'overloaded_error', 'Overloaded', logo), erro(529, 'overloaded_error', 'Overloaded', logo)], /sobrecarregada \(529\)/, 2);
  await falha([erro(500, 'api_error', 'Internal server error', logo), erro(500, 'api_error', 'Internal server error', logo)], /respondeu com erro \(500\): Internal server error/, 2);
});

await caso('falha passageira seguida de sucesso: a resposta chega sem o usuario perceber', async () => {
  roteiro.push(erro(529, 'overloaded_error', 'Overloaded', { 'retry-after-ms': '5' }), mensagem([{ type: 'text', text: 'Agora foi.' }]));
  const m = await (await ligar()).send(structuredClone(PEDIDO));
  assert.equal(m.content[0].text, 'Agora foi.');
});

await caso('sem conexao: frase clara', async () => {
  const morto = http.createServer();
  await new Promise((r) => morto.listen(0, '127.0.0.1', r));
  const fechado = `http://127.0.0.1:${morto.address().port}`;
  await new Promise((r) => morto.close(r));
  const t = (await createAiTransport({ baseUrl: fechado, apiKey: CHAVE })).transport;
  await assert.rejects(t.send(structuredClone(PEDIDO)), /sem conexao com a API da Anthropic/);
});

await caso('conversa inteira pela biblioteca: consulta, resposta da consulta e resposta final, com o raciocinio voltando intacto', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ia-cliente-'));
  const db = await openDb(join(dir, 't.db'));
  const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);
  db.upsertMany(Array.from({ length: 30 }, (_, i) => ({ symbol: 'BTCUSDT', openTime: T0 - (29 - i) * 60_000, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10, quoteVolume: 1000, trades: 5, takerBuyVolume: 6, closed: i < 29 })));
  const agent = createAgent({ db, symbol: 'BTCUSDT', limits: { maxLossPerTradePct: 1, maxLossPerDayPct: 3, maxPositionPct: 50, maxTradesPerDay: 3 }, client: null, now: () => T0 });
  const ai = createAi({ db, symbol: 'BTCUSDT', agent, transport: await ligar(), now: () => T0 });
  const turno1 = [
    { type: 'thinking', thinking: '', signature: 'EqQBCkYIBBgCKkD-assinatura-opaca==' },
    { type: 'text', text: 'Vou olhar os candles.' },
    { type: 'tool_use', id: 'toolu_01A', name: 'ver_candles', input: { tempo: '1m', quantidade: 5 } },
  ];
  const antes = recebidos.length;
  roteiro.push(mensagem(turno1, 'tool_use'), mensagem([{ type: 'text', text: 'Subiu 4 dólares em 5 minutos.' }]));
  await ai.send('como está?').done;
  const [p1, p2] = recebidos.slice(antes);
  assert.equal(recebidos.length - antes, 2);
  assert.equal(p1.body.messages.length, 1);
  assert.equal(p1.body.tools.length, 7);
  assert.equal(p1.body.fallbacks, 'default');
  assert.deepEqual(p2.body.messages[1], { role: 'assistant', content: turno1 }); // a biblioteca nao mexe no turno que volta
  const [res] = p2.body.messages[2].content;
  assert.deepEqual([res.type, res.tool_use_id], ['tool_result', 'toolu_01A']);
  assert.match(res.content, /^Candles de 1m do BTCUSDT/);
  assert.equal(JSON.stringify(p2.body.system), JSON.stringify(p1.body.system));
  assert.equal(JSON.stringify(p2.body.tools), JSON.stringify(p1.body.tools));
  assert.equal(JSON.stringify(p2.body.messages[0]), JSON.stringify(p1.body.messages[0]));
  const v = ai.view();
  assert.deepEqual(v.messages.map((m) => [m.role, m.text]), [['voce', 'como está?'], ['ia', 'Vou olhar os candles.'], ['ia', 'Subiu 4 dólares em 5 minutos.']]);
  assert.ok(v.status.spentToday > 0);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

api.closeAllConnections();
api.close();
desvio.closeAllConnections();
desvio.close();
console.log(`\nTODOS OS ${feitos} CASOS PASSARAM`);
