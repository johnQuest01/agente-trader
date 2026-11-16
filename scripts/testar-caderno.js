// Testa o caderno (src/notes.js): as contas com candles montados a mao, a gravacao (hora e minuto
// de referencia carimbados pelo servidor) e a garantia de que nada e alterado nem apagado.
// Nao usa a internet.
//
//   node scripts/testar-caderno.js
//
// Sai com codigo 1 se algum caso falhar.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { normalizeNote, score, luck, summarize, addNote, listNotes, liveRef, handleNotes, NOTE_HORIZONS, MAX_FEED_AGE } from '../src/notes.js';

process.removeAllListeners('warning');
const { openDb } = await import('../src/db.js');
const MIN = 60_000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);
const FEE = 0.1;
let feitos = 0;
const perto = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg}: esperado ${b}, veio ${a}`);
const caso = async (nome, fn) => { await fn(); feitos++; console.log(`ok  ${nome}`); };
const minuto = (i) => T0 + i * MIN;

// Candles de 1m: o minuto i fecha em 1000 + i, com maxima 0,5 acima e minima 0,5 abaixo.
function fonte(total, mudar = () => {}) {
  const candles = new Map();
  for (let i = 0; i < total; i++) candles.set(minuto(i), { openTime: minuto(i), close: 1000 + i, high: 1000.5 + i, low: 999.5 + i, volume: 10, closed: 1 });
  mudar(candles);
  return {
    lastClosedTime: Math.max(...[...candles.values()].filter((c) => c.closed).map((c) => c.openTime)),
    candleAt: (t) => candles.get(t) ?? null,
    windowStats: (from, to) => {
      let n = 0, high = null, low = null, volume = 0;
      for (const c of candles.values()) {
        if (c.openTime < from || c.openTime >= to) continue;
        n++; volume += c.volume;
        high = high === null ? c.high : Math.max(high, c.high);
        low = low === null ? c.low : Math.min(low, c.low);
      }
      return { n, high, low, volume };
    },
  };
}
// Uma previsao gravada enquanto o minuto i estava em formacao: a referencia e o fechamento dele.
const nota = (i, side, horizonMin, mais = {}) => ({ id: i, text: 'x', kind: 'geral', side, horizonMin, refTime: minuto(i), ...mais });
const dia = fonte(3000);

// ---------- entrada ----------
await caso('anotacao sem texto e recusada; assunto vazio vira "geral" e vai em minusculas', () => {
  assert.throws(() => normalizeNote({ text: '   ' }), /escreva a anotacao/);
  assert.equal(normalizeNote({ text: 'oi' }).kind, 'geral');
  assert.equal(normalizeNote({ text: 'oi', kind: '  Petroleo ' }).kind, 'petroleo');
});

await caso('lado invalido e prazo invalido sao recusados', () => {
  assert.throws(() => normalizeNote({ text: 'oi', side: 'compra' }), /lado invalido/);
  assert.throws(() => normalizeNote({ text: 'oi', side: 'alta' }), /prazo invalido/);
  assert.throws(() => normalizeNote({ text: 'oi', side: 'alta', horizonMin: 30 }), /prazo invalido/);
  assert.deepEqual(NOTE_HORIZONS.map((h) => h.minutes), [60, 240, 1440, 10080]);
});

await caso('sem lado e so anotacao: o prazo e ignorado', () => {
  const n = normalizeNote({ text: 'lembrete', side: '', horizonMin: 60, source: ' jornal ' });
  assert.deepEqual([n.side, n.horizonMin, n.source], [null, null, 'jornal']);
  assert.equal(normalizeNote({ text: 'a', side: 'nenhum' }).side, null);
});

// ---------- conferencia ----------
await caso('previsao de alta que acertou: do fechamento do minuto de referencia ate o fim do prazo', () => {
  const s = score(dia, nota(1000, 'alta', 60), FEE);
  assert.equal(s.status, 'ok');
  perto(s.refPrice, 2000, 'preco de referencia');             // fechamento do minuto 1000
  perto(s.exitPrice, 2060, 'preco de saida');                 // 60 minutos de preco depois
  perto(s.retPct, (2060 / 2000 - 1) * 100, 'variacao');
  perto(s.favorPct, 3, 'a favor');
  assert.equal(s.hit, true);
  assert.equal(s.dueAt, minuto(1061));                         // o prazo termina quando o candle 1060 fecha
});

await caso('o tranco que ja estava na tela nao entra na conta', () => {
  // O preco esta parado em 1000, pula para 1100 dentro do minuto 1000 (a noticia) e fica la.
  // Quem escreve "alta" durante esse minuto, vendo o pulo, nao leva o pulo: a referencia e o
  // fechamento do proprio minuto (1100), nao o do minuto anterior (1000).
  const pulo = fonte(1200, (m) => {
    for (const c of m.values()) {
      const p = c.openTime < minuto(1000) ? 1000 : 1100;
      Object.assign(c, { close: p, high: p, low: p });
    }
    m.get(minuto(1000)).low = 1000;
  });
  const s = score(pulo, nota(1000, 'alta', 60), FEE);
  perto(s.refPrice, 1100, 'preco de referencia');
  perto(s.favorPct, 0, 'a favor');
  assert.equal(s.hit, false, 'preco igual no fim do prazo nao e acerto');
});

await caso('antes de o minuto de referencia fechar nao ha preco de referencia nem conta', () => {
  const s = score(dia, nota(3000, 'alta', 60), FEE);           // o ultimo fechado e o 2999
  assert.deepEqual(s, { status: 'aguardando o minuto fechar' });
  const provisorio = fonte(3000, (m) => { m.get(minuto(1000)).closed = 0; });
  assert.equal(score(provisorio, nota(1000, 'alta', 60), FEE).status, 'sem preco de referencia');
});

await caso('resultado com taxa: como entrar na referencia e sair no fim do prazo, pagando os dois lados', () => {
  const s = score(dia, nota(1000, 'alta', 60), FEE);
  perto(s.netPct, 3 - FEE * (1 + 2060 / 2000), 'liquido');
});

await caso('previsao de baixa no mesmo trecho: errou, e o resultado a favor e negativo', () => {
  const s = score(dia, nota(1000, 'baixa', 60), FEE);
  perto(s.favorPct, -3, 'a favor');
  assert.equal(s.hit, false);
  perto(s.netPct, -3 - FEE * (1 + 2060 / 2000), 'liquido');
});

await caso('pior momento contra a previsao dentro do prazo', () => {
  perto(score(dia, nota(1000, 'alta', 60), FEE).worstPct, 0, 'alta num trecho que so subiu');         // nunca ficou contra
  perto(score(dia, nota(1000, 'baixa', 60), FEE).worstPct, -(2060.5 / 2000 - 1) * 100, 'baixa');     // a maxima do prazo
  const queda = fonte(3000, (m) => { m.get(minuto(1010)).low = 1900; });
  perto(score(queda, nota(1000, 'alta', 60), FEE).worstPct, (1900 / 2000 - 1) * 100, 'alta com um mergulho no meio');
});

await caso('prazo ainda correndo: sem veredito, so onde esta agora', () => {
  const s = score(dia, nota(2990, 'baixa', 60), FEE);
  assert.equal(s.status, 'ainda nao venceu');
  assert.equal(s.dueAt, minuto(3051));
  perto(s.refPrice, 3990, 'preco de referencia');
  perto(s.favorNowPct, -((1000 + 2999) / (1000 + 2990) - 1) * 100, 'ate agora');
  assert.equal(s.hit, undefined);
});

await caso('o prazo vence exatamente quando o ultimo candle do prazo fecha', () => {
  assert.equal(score(dia, nota(2939, 'alta', 60), FEE).status, 'ok');                 // candle final = 2999, o ultimo fechado
  assert.equal(score(dia, nota(2940, 'alta', 60), FEE).status, 'ainda nao venceu');   // candle final = 3000, ainda nao existe
});

await caso('faltam candles: sem o ultimo, ou com mais de 2% de buraco, nao ha resultado', () => {
  const semFinal = fonte(3000, (m) => m.delete(minuto(1060)));
  assert.equal(score(semFinal, nota(1000, 'alta', 60), FEE).status, 'faltam candles');
  const umBuraco = fonte(3000, (m) => m.delete(minuto(1030)));                        // 1 de 60 = 1,7%: tolerado
  assert.equal(score(umBuraco, nota(1000, 'alta', 60), FEE).status, 'ok');
  const doisBuracos = fonte(3000, (m) => { m.delete(minuto(1030)); m.delete(minuto(1031)); });
  assert.equal(score(doisBuracos, nota(1000, 'alta', 60), FEE).status, 'faltam candles');
});

await caso('anotacao sem previsao nao e conferida; sem minuto de referencia tambem nao', () => {
  assert.equal(score(dia, nota(1000, null, null), FEE).status, 'sem previsao');
  assert.equal(score(dia, nota(1000, 'alta', 60, { refTime: null }), FEE).status, 'sem preco de referencia');
});

// ---------- placar ----------
await caso('chance de acertar por sorte: conta da moeda, tambem com milhares de previsoes', () => {
  perto(luck(10, 10), 1 / 1024, '10 de 10');
  perto(luck(4, 2), 11 / 16, '2 ou mais de 4');
  assert.equal(luck(10, 0), 1);
  assert.equal(luck(0, 0), null);
  perto(luck(5001, 2501), 0.5, 'metade ou mais de um numero impar');   // 0,5^5001 direto seria zero
  assert.ok(luck(5000, 2600) > 0.002 && luck(5000, 2600) < 0.003, `2600 de 5000: ${luck(5000, 2600)}`); // 2,8 desvios
});

const comPlacar = (lista) => lista.map((n) => ({ ...n, score: score(dia, n, FEE) }));
const quatro = comPlacar([
  nota(1000, 'alta', 60, { kind: 'petroleo' }),   // +3,000
  nota(1500, 'alta', 60, { kind: 'petroleo' }),   // +2,400
  nota(1200, 'baixa', 240, { kind: 'china' }),    // -(2440/2200-1) = -10,909...
  nota(2990, 'alta', 60, { kind: 'china' }),      // em aberto
  nota(3000, 'alta', 60, { kind: 'china' }),      // minuto de referencia ainda nao fechou: em aberto
  nota(1100, null, null, { kind: 'geral' }),      // so anotacao
]);

await caso('placar: media no lado previsto, com taxa, pior previsao; acertos por ultimo', () => {
  const p = summarize(quatro);
  const favor = [3, (2560 / 2500 - 1) * 100, -(2440 / 2200 - 1) * 100];
  assert.equal(p.conferidas, 3);
  perto(p.mediaNoLadoPct, favor.reduce((a, b) => a + b) / 3, 'media no lado');
  perto(p.piorPct, favor[2], 'pior');
  assert.equal(p.acertos, 2);
  perto(p.acertoPct, 200 / 3, 'taxa de acerto');
  perto(p.sorte, luck(3, 2), 'sorte');
  assert.ok(p.mediaComTaxaPct < p.mediaNoLadoPct - 0.19, 'a taxa tira cerca de 0,2 ponto');
  const chaves = Object.keys(p);
  assert.ok(chaves.indexOf('mediaNoLadoPct') < chaves.indexOf('acertoPct') && chaves.indexOf('piorPct') < chaves.indexOf('acertos'), 'ordem do projeto');
});

await caso('placar: em aberto e anotacoes sem previsao ficam de fora da conta; poucas previsoes nao provam nada', () => {
  const p = summarize(quatro);
  assert.deepEqual([p.emAberto, p.anotacoesSemPrevisao, p.semConferencia, p.prova, p.minimoParaProvar], [2, 1, 0, false, 20]);
  const vazio = summarize([]);
  assert.deepEqual([vazio.conferidas, vazio.mediaNoLadoPct, vazio.acertoPct, vazio.sorte], [0, null, null, null]);
});

await caso('placar por assunto e por prazo', () => {
  const p = summarize(quatro);
  assert.deepEqual(p.porAssunto.map((k) => [k.kind, k.conferidas, k.acertos]), [['china', 1, 0], ['petroleo', 2, 2]]);
  assert.deepEqual(p.porPrazo.map((k) => [k.key, k.conferidas]), [['1h', 2], ['4h', 1], ['1d', 0], ['1sem', 0]]);
});

// ---------- gravacao (banco de verdade, num arquivo temporario) ----------
const dir = mkdtempSync(join(tmpdir(), 'caderno-teste-'));
const arquivo = join(dir, 'caderno.db');
const db = await openDb(arquivo);
const S = 'BTCUSDT';
const candle = (i, mais = {}) => ({ symbol: S, openTime: minuto(i), open: 1000 + i, high: 1000.5 + i, low: 999.5 + i, close: 1000 + i, volume: 10, quoteVolume: 1000, trades: 5, takerBuyVolume: 5, closed: true, ...mais });
// 100 minutos fechados (0 a 99) e o minuto 100 em formacao, com 1100,5 na tela.
db.upsertMany(Array.from({ length: 100 }, (_, i) => candle(i)));
db.upsert(candle(100, { close: 1100.5, trades: 3, closed: false }));
const agora = minuto(100) + 20_000;
const VIVO = { now: agora, feedAgeMs: 1500 }; // o ultimo candle ao vivo chegou ha 1,5 s

await caso('a hora e o minuto de referencia sao carimbados pelo servidor, nao por quem chama', () => {
  const id = addNote(db, S, { text: 'Fed falou', kind: 'Juros', side: 'alta', horizonMin: 60, time: 1, refTime: 2, seenPrice: 3, refPrice: 4, id: 999 }, VIVO);
  const [n] = db.noteList(S);
  assert.deepEqual([n.id, n.time, n.refTime, n.seenPrice, n.side, n.horizonMin, n.kind], [id, agora, minuto(100), 1100.5, 'alta', 60, 'juros']);
  assert.equal(id, 1);
});

await caso('a referencia e o minuto em formacao, nunca um que ja acabou', () => {
  // Virada de minuto: o fechamento do 99 chegou e o primeiro negocio do 100 ainda nao.
  db.upsertMany(Array.from({ length: 100 }, (_, i) => candle(i, { symbol: 'VIRADA' })));
  assert.deepEqual(liveRef(db, 'VIRADA', 500), { fresh: true, refTime: minuto(100), price: 1099 });
  // Fechamento perdido: o 99 ficou provisorio no banco e o 100 ja esta em formacao.
  db.upsertMany(Array.from({ length: 99 }, (_, i) => candle(i, { symbol: 'PERDIDO' })));
  db.upsert(candle(99, { symbol: 'PERDIDO', closed: false }));
  db.upsert(candle(100, { symbol: 'PERDIDO', closed: false }));
  assert.equal(liveRef(db, 'PERDIDO', 500).refTime, minuto(100));
  assert.deepEqual(liveRef(db, 'VAZIO', 500), { fresh: false, refTime: null, price: null });
});

await caso('preco ao vivo parado ou sem conexao: a previsao e recusada, a anotacao simples entra sem referencia', () => {
  const previsao = { text: 'x', side: 'baixa', horizonMin: 60 };
  assert.throws(() => addNote(db, S, previsao, { now: agora, feedAgeMs: 30_000 }), /parado ha 30 s/);
  assert.throws(() => addNote(db, S, previsao, { now: agora, feedAgeMs: MAX_FEED_AGE + 1 }), /parado ha 10 s/);
  assert.throws(() => addNote(db, S, previsao, { now: agora }), /sem preco ao vivo/);
  assert.equal(db.noteList(S).length, 1, 'nenhuma das recusadas foi gravada');
  const id = addNote(db, S, { text: 'so um lembrete' }, { now: agora });
  const [n] = db.noteList(S);
  assert.deepEqual([n.id, n.side, n.refTime, n.seenPrice], [id, null, null, null]);
});

await caso('uma anotacao gravada nao pode ser alterada nem apagada (o banco recusa)', () => {
  const cru = new DatabaseSync(arquivo);
  assert.throws(() => cru.exec("UPDATE notes SET side = 'baixa' WHERE id = 1"), /nao pode ser alterada/);
  assert.throws(() => cru.exec('DELETE FROM notes WHERE id = 1'), /nao pode ser apagada/);
  cru.close();
  assert.equal(db.noteList(S).length, 2);
});

await caso('a conta espera o minuto de referencia fechar e depois os candles do prazo', () => {
  const previsao = () => listNotes(db, S, { feePct: FEE }).notes.find((n) => n.side);
  assert.equal(previsao().score.status, 'aguardando o minuto fechar');
  assert.equal(previsao().refPrice, null);
  // O minuto 100 fecha em 1100: e esse o preco de referencia, nao o 1100,5 que estava na tela
  // nem o 1099 do minuto anterior.
  db.upsert(candle(100));
  db.upsert(candle(101, { trades: 1, closed: false }));
  assert.equal(previsao().score.status, 'ainda nao venceu');
  assert.equal(previsao().refPrice, 1100);
  db.upsertMany(Array.from({ length: 60 }, (_, i) => candle(101 + i)));
  const v = listNotes(db, S, { feePct: FEE, feedAgeMs: 1000 });
  const p = v.notes.find((n) => n.side);
  assert.equal(p.score.status, 'ok');
  perto(p.score.favorPct, (1160 / 1100 - 1) * 100, 'a favor');
  assert.equal(v.summary.conferidas, 1);
  assert.equal(v.summary.anotacoesSemPrevisao, 1);
  assert.deepEqual(v.live, { fresh: true, refTime: minuto(161), price: 1160, feedAgeMs: 1000 });
  assert.deepEqual(listNotes(db, S).live, { fresh: false, refTime: null, price: null, feedAgeMs: null });
  assert.deepEqual(v.kinds, ['geral', 'juros'], 'os assuntos ja usados');
});

await caso('o resultado final fica guardado: a lista repete a mesma conta, e ela e igual a feita na hora', () => {
  const src = { candleAt: (t) => db.candleAt(S, t), windowStats: (a, b) => db.windowStats(S, a, b), lastClosedTime: db.lastClosedTime(S) };
  const a = listNotes(db, S, { feePct: FEE }).notes.find((n) => n.side);
  const b = listNotes(db, S, { feePct: FEE }).notes.find((n) => n.side);
  assert.equal(a.score, b.score, 'a segunda consulta reaproveita o resultado');
  assert.deepEqual(a.score, score(src, a, FEE), 'e ele e igual a conta feita na hora');
  assert.equal(a.refPrice, 1100);
  // Outra taxa nao reaproveita o resultado guardado com a taxa antiga.
  const c = listNotes(db, S, { feePct: 0.5 }).notes.find((n) => n.side);
  perto(c.score.netPct, c.score.favorPct - 0.5 * (1 + 1160 / 1100), 'liquido com a outra taxa');
});

// ---------- rotas ----------
function pedido(method, corpo, tipo = 'application/json') {
  const req = Readable.from(corpo === undefined ? [] : [typeof corpo === 'string' ? corpo : JSON.stringify(corpo)]);
  req.method = method;
  req.headers = { 'content-type': tipo };
  return req;
}
async function rota(method, corpo, { tipo, feedAgeMs, caminho = '/api/notes' } = {}) {
  let saida = null;
  const json = (res, code, body) => { saida = { code, body }; };
  const tratou = await handleNotes(pedido(method, corpo, tipo), {}, new URL(`http://localhost${caminho}`), { db, symbol: S, json, feedAgeMs });
  return { tratou, ...saida };
}

await caso('rotas: so ler e gravar; so JSON; nada de alterar ou apagar', async () => {
  assert.equal((await rota('GET')).code, 200);
  assert.equal((await rota('POST', 'text=oi', { tipo: 'application/x-www-form-urlencoded' })).code, 415);
  assert.equal((await rota('POST', { text: '' })).code, 400);
  assert.equal((await rota('DELETE', { id: 1 })).code, 405);
  assert.equal((await rota('PUT', { id: 1, side: 'baixa' })).code, 405);
  const ok = await rota('POST', { text: 'mais uma' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.notes[0].text, 'mais uma');
  let outra = null;
  const fora = await handleNotes(pedido('GET'), {}, new URL('http://localhost/api/outra'), { db, symbol: S, json: () => { outra = 1; } });
  assert.deepEqual([fora, outra], [false, null]);
});

await caso('rotas: previsao so com o preco ao vivo chegando', async () => {
  const previsao = { text: 'vai cair', side: 'baixa', horizonMin: 240 };
  const semVivo = await rota('POST', previsao);
  assert.equal(semVivo.code, 400);
  assert.match(semVivo.body.error, /sem preco ao vivo/);
  const comVivo = await rota('POST', previsao, { feedAgeMs: () => 800 });
  assert.equal(comVivo.code, 200);
  const n = comVivo.body.notes[0];
  assert.deepEqual([n.id, n.side, n.horizonMin, n.refTime, n.score.status], [comVivo.body.added, 'baixa', 240, minuto(161), 'aguardando o minuto fechar']);
  assert.equal(comVivo.body.summary.emAberto, 1);
});

await caso('rotas: a tela pergunta o que seria carimbado agora; qualquer outra rota do caderno nao existe', async () => {
  const vivo = await rota('GET', undefined, { caminho: '/api/notes/now', feedAgeMs: () => 2100.4 });
  assert.deepEqual([vivo.code, vivo.body], [200, { fresh: true, refTime: minuto(161), price: 1160, feedAgeMs: 2100 }]);
  const parado = await rota('GET', undefined, { caminho: '/api/notes/now' });
  assert.deepEqual(parado.body, { fresh: false, refTime: null, price: null, feedAgeMs: null });
  for (const [m, c] of [['POST', '/api/notes/now'], ['POST', '/api/notes/delete'], ['GET', '/api/notes/1'], ['POST', '/api/notes/update']]) {
    const r = await rota(m, { id: 1 }, { caminho: c });
    assert.deepEqual([r.tratou, r.code], [true, 404], `${m} ${c}`);
  }
  assert.equal(db.noteList(S).length, 4, 'nada mudou no banco');
});

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(`\nTODOS OS ${feitos} CASOS PASSARAM`);
