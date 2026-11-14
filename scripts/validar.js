// Valida o banco local contra a API publica da Binance.
//
//   node scripts/validar.js             (precisa do servidor rodando em http://localhost:3333)
//   node scripts/validar.js --sem-api   (pula a parte que usa /api/candles; so banco x Binance)
//   node scripts/validar.js --completo  (compara TODOS os candles de 1m, nao so 20; 45
//                                        requisicoes de peso baixo para 30 dias: de ~20 s a
//                                        alguns minutos, conforme a conexao)
//
// O que confere:
//   0. Cobertura (o historico comeca onde deveria) e frescor (o ultimo candle e o minuto atual),
//      relogio local x Binance.
//   1. Candles fechados de 1m do banco x Binance (O, H, L, C, volume, taker buy, quote volume e
//      numero de negocios). Precisa ser identico. Padrao: 20 sorteados; --completo: todos.
//   2. Candles de 1h e 1d calculados pelo nosso /api/candles x candles de 1h e 1d da Binance.
//      Confere a flag `complete`: o primeiro e o ultimo bucket podem ser parciais e tem que vir
//      marcados; qualquer bucket do meio marcado como parcial e buraco; qualquer bucket marcado
//      como completo tem que ter todos os minutos.
//      Mais o primeiro candle de 5m, 15m, 1h, 4h e 1d (a borda do historico) x Binance: se o
//      banco comecar no meio de um candle maior, o nosso sai sem os minutos anteriores.
//   3. Buracos: lista qualquer minuto faltando entre o primeiro e o ultimo candle do banco.
//   4. Sanidade: duplicados, candles marcados como abertos.
//   5. Fase 2 (se houver negocios no banco): ids dos negocios sem buraco; fluxo por minuto x
//      candles (volume, agressao compradora e numero de negocios tem que bater exatamente em
//      todo minuto marcado como completo); amostra de negocios crus x Binance; ordens grandes
//      recalculadas a partir dos negocios crus.
//
// Teste de retomada (parar, esperar, subir de novo) e manual: rode este script antes e depois;
// a contagem deve crescer so pelos minutos que passaram, sem buraco e sem duplicado.
//
// Sai com codigo 1 se achar qualquer diferenca.

import { fileURLToPath } from 'node:url';

const SYMBOL = (process.env.SYMBOL || 'BTCUSDT').toUpperCase();
const REST = process.env.BINANCE_REST || 'https://api.binance.com';
const API = process.env.API || 'http://localhost:3333';
const BACKFILL_DAYS = Number(process.env.BACKFILL_DAYS || 30);
const MINUTE = 60_000;
const DAY = 86_400_000;
const SEM_API = process.argv.includes('--sem-api');
const COMPLETO = process.argv.includes('--completo');

const { DatabaseSync } = await import('node:sqlite');
const dbFile = process.env.DB_FILE || fileURLToPath(new URL('../data/market.db', import.meta.url));
const db = new DatabaseSync(dbFile, { readOnly: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
let falhas = 0;
const falha = (msg) => { falhas++; console.log(`  FALHA: ${msg}`); };

async function binance(interval, startTime, limit = 1) {
  const url = `${REST}/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&startTime=${startTime}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Binance ${res.status} em ${url}`);
  const rows = await res.json();
  await sleep(120);
  return rows.map((k) => ({
    openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    closeTime: k[6], quoteVolume: +k[7], trades: k[8], takerBuyVolume: +k[9],
  }));
}

// Campos comparados e como: 'exato' exige igualdade; 'tol' aceita erro de arredondamento
// (soma de 60 ou 1440 numeros em ponto flutuante pode diferir do total da Binance em ~1e-9;
// o lote minimo da Binance e 1e-5 BTC, bem acima da tolerancia, e `trades` exato pega qualquer
// negocio faltando).
const CAMPOS = [
  ['open', 'exato'], ['high', 'exato'], ['low', 'exato'], ['close', 'exato'],
  ['volume', 'tol'], ['takerBuyVolume', 'tol'], ['quoteVolume', 'tol'], ['trades', 'exato'],
];

function comparar(nosso, deles, tolerante) {
  const difs = [];
  for (const [campo, modo] of CAMPOS) {
    const a = nosso[campo], b = deles[campo];
    let igual;
    if (modo === 'tol' && tolerante) igual = Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 1e-9);
    else igual = a === b;
    if (!igual) difs.push(`${campo}: nosso=${a} binance=${b}`);
  }
  return difs;
}

function tabela(linhas) {
  if (!linhas.length) return;
  const cols = Object.keys(linhas[0]);
  const w = cols.map((c) => Math.max(c.length, ...linhas.map((l) => String(l[c]).length)));
  const fmt = (l) => cols.map((c, i) => String(l[c]).padEnd(w[i])).join('  ');
  console.log(fmt(Object.fromEntries(cols.map((c) => [c, c]))));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const l of linhas) console.log(fmt(l));
}

function sortear(arr, n) {
  const copia = [...arr];
  for (let i = copia.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copia[i], copia[j]] = [copia[j], copia[i]];
  }
  return copia.slice(0, n).sort((a, b) => a.openTime - b.openTime);
}

// ---------- 0. visao geral, cobertura, frescor e relogio ----------
const geral = db.prepare(
  'SELECT COUNT(*) n, MIN(open_time) f, MAX(open_time) l, SUM(closed) fechados FROM candles WHERE symbol = ?',
).get(SYMBOL);
console.log(`\n== 0. Banco (${SYMBOL}) ==`);
if (!geral.n) { console.log('banco vazio'); process.exit(1); }
console.log(`candles: ${geral.n}  fechados: ${geral.fechados}  abertos: ${geral.n - geral.fechados}`);
console.log(`primeiro: ${iso(geral.f)} UTC   ultimo: ${iso(geral.l)} UTC`);
const esperado = (geral.l - geral.f) / MINUTE + 1;
console.log(`esperado sem buracos: ${esperado}  ${esperado === geral.n ? 'OK' : `DIFERENTE (faltam ${esperado - geral.n})`}`);

const antes = Date.now();
const { serverTime } = await (await fetch(`${REST}/api/v3/time`)).json();
const desvio = (antes + (Date.now() - antes) / 2) - serverTime;
console.log(`relogio local - Binance: ${(desvio / 1000).toFixed(1)} s ${Math.abs(desvio) > 30_000 ? '<< RELOGIO DESSINCRONIZADO (o coletor compensa, mas sincronize o Windows)' : 'OK'}`);

// Cobertura: o backfill alinha o inicio ao dia UTC, entao o primeiro candle deve ser 00:00 UTC
// de (agora - BACKFILL_DAYS dias), ou antes.
const inicioEsperado = Math.floor((serverTime - BACKFILL_DAYS * DAY) / DAY) * DAY;
if (geral.f > inicioEsperado) falha(`historico comeca em ${iso(geral.f)}, esperado ate ${iso(inicioEsperado)} (${BACKFILL_DAYS} dias alinhados ao dia UTC)`);
else console.log(`cobertura: comeca em ${iso(geral.f)} <= ${iso(inicioEsperado)} OK`);
// Frescor: o ultimo candle tem que ser o minuto atual da Binance (ou o anterior, na virada).
const minutoAtual = Math.floor(serverTime / MINUTE) * MINUTE;
if (geral.l < minutoAtual - MINUTE) falha(`ultimo candle e ${iso(geral.l)}, mas agora e ${iso(minutoAtual)}: coletor parado ou WebSocket mudo`);
else console.log(`frescor: ultimo candle ${iso(geral.l)} = minuto atual OK`);

// ---------- 1. candles de 1m ----------
const fechados = db.prepare(
  `SELECT open_time openTime, open, high, low, close, volume, quote_volume quoteVolume, trades,
          taker_buy_volume takerBuyVolume FROM candles WHERE symbol = ? AND closed = 1 ORDER BY open_time`,
).all(SYMBOL);

if (COMPLETO) {
  console.log(`\n== 1. TODOS os ${fechados.length} candles fechados de 1m: banco x Binance ==`);
  const porTempo = new Map(fechados.map((c) => [c.openTime, c]));
  let cursor = fechados[0].openTime;
  let conferidos = 0, diferentes = 0, faltandoNoBanco = 0, paginas = 0;
  const exemplos = [];
  while (cursor <= fechados.at(-1).openTime) {
    const rows = await binance('1m', cursor, 1000);
    paginas++;
    if (!rows.length) break;
    for (const b of rows) {
      if (b.openTime > fechados.at(-1).openTime) break;
      const c = porTempo.get(b.openTime);
      if (!c) { faltandoNoBanco++; if (exemplos.length < 10) exemplos.push(`${iso(b.openTime)}: falta no banco`); continue; }
      const difs = comparar(c, b, false);
      conferidos++;
      if (difs.length) { diferentes++; if (exemplos.length < 10) exemplos.push(`${iso(b.openTime)}: ${difs.join('; ')}`); }
    }
    cursor = rows.at(-1).openTime + MINUTE;
    if (paginas % 10 === 0) console.log(`  ${conferidos} conferidos...`);
  }
  console.log(`conferidos: ${conferidos}  diferentes: ${diferentes}  faltando no banco: ${faltandoNoBanco}  (${paginas} paginas)`);
  for (const e of exemplos) console.log('  ', e);
  if (diferentes || faltandoNoBanco) falhas++;
} else {
  console.log('\n== 1. 20 candles fechados de 1m sorteados: banco x Binance ==');
  const amostra = sortear(fechados, 20);
  const linhas1 = [];
  for (const c of amostra) {
    const [b] = await binance('1m', c.openTime, 1);
    const difs = b && b.openTime === c.openTime ? comparar(c, b, false) : ['Binance nao devolveu esse minuto'];
    if (difs.length) falhas++;
    linhas1.push({
      'abertura (UTC)': iso(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close,
      volume: c.volume, takerBuy: c.takerBuyVolume, trades: c.trades,
      resultado: difs.length ? 'DIFERENTE: ' + difs.join('; ') : 'identico',
    });
  }
  tabela(linhas1);
}

// ---------- 2. 1h e 1d via /api/candles ----------
if (!SEM_API) {
  console.log('\n== 2. candles de 1h e 1d calculados por /api/candles x Binance ==');
  let apiOk = true;
  try { await fetch(`${API}/api/info`, { signal: AbortSignal.timeout(3000) }); } catch { apiOk = false; }
  if (!apiOk) {
    falha(`servidor nao responde em ${API}; pulei esta parte (use --sem-api para nao avisar)`);
  } else {
    for (const [tf, ms, qtd] of [['1h', 3600_000, 5], ['1d', DAY, 2]]) {
      const rows = await (await fetch(`${API}/api/candles?tf=${tf}&limit=5000`)).json();
      const porBucket = ms / MINUTE;
      if (!rows.length || rows[0].complete === undefined) {
        falha(`${tf}: a API nao devolve o campo "complete" (servidor antigo? reinicie com npm start)`);
        continue;
      }
      // Flags: primeiro e ultimo podem ser parciais, o meio nao; "complete" exige todos os minutos.
      rows.forEach((r, i) => {
        const meio = i > 0 && i < rows.length - 1;
        if (r.complete && r.minutes !== porBucket) falha(`${tf} ${iso(r.openTime)}: complete=true com ${r.minutes}/${porBucket} minutos`);
        if (meio && !r.complete) falha(`${tf} ${iso(r.openTime)}: bucket do meio incompleto (${r.minutes}/${porBucket} minutos) = buraco`);
      });
      const primeiro = rows[0], ultimo = rows.at(-1);
      console.log(`${tf}: ${rows.length} buckets | primeiro ${iso(primeiro.openTime)} ${primeiro.minutes}/${porBucket} min complete=${primeiro.complete} | ultimo ${iso(ultimo.openTime)} ${ultimo.minutes}/${porBucket} min complete=${ultimo.complete}`);
      if (ultimo.complete) falha(`${tf}: o ultimo bucket (em formacao) veio como complete=true`);

      const completos = rows.filter((r) => r.complete);
      const escolhidos = sortear(completos, qtd);
      const linhas = [];
      for (const c of escolhidos) {
        const [b] = await binance(tf, c.openTime, 1);
        const difs = b && b.openTime === c.openTime ? comparar(c, b, true) : ['Binance nao devolveu esse candle'];
        if (difs.length) falhas++;
        linhas.push({
          tf, 'abertura (UTC)': iso(c.openTime), open: c.open, high: c.high, low: c.low, close: c.close,
          volume: +c.volume.toFixed(5), 'volume Binance': b ? b.volume : '-', trades: c.trades,
          resultado: difs.length ? 'DIFERENTE: ' + difs.join('; ') : 'identico (volumes dentro do arredondamento)',
        });
      }
      tabela(linhas);
      console.log('');
    }

    // Borda do historico: o primeiro candle de cada tempo grafico. Se o banco comecar no meio
    // de um candle maior, o nosso sai so com os minutos que temos e difere da Binance. A amostra
    // acima nao pega isso, porque so sorteia buckets marcados como completos. O backfill
    // completa o primeiro dia do banco, entao aqui tem que dar identico.
    console.log('== 2b. primeiro candle de cada tempo grafico (borda do historico) x Binance ==');
    const borda = [];
    for (const [tf, ms] of [['5m', 300_000], ['15m', 900_000], ['1h', 3600_000], ['4h', 14_400_000], ['1d', DAY]]) {
      const inicio = Math.floor(geral.f / ms) * ms;
      let c = null, b = null, resultado;
      if (inicio + ms > serverTime) {
        resultado = 'ainda aberto, nao comparado';
      } else {
        [c] = await (await fetch(`${API}/api/candles?tf=${tf}&limit=1&to=${inicio + ms - MINUTE}`)).json();
        [b] = await binance(tf, inicio, 1);
        const difs = c && b && b.openTime === c.openTime ? comparar(c, b, true) : ['Binance nao devolveu esse candle'];
        if (difs.length) falhas++;
        resultado = difs.length ? 'DIFERENTE: ' + difs.join('; ') : 'identico (volumes dentro do arredondamento)';
      }
      borda.push({
        tf, 'abertura (UTC)': iso(inicio), open: c?.open ?? '-', high: c?.high ?? '-', low: c?.low ?? '-',
        close: c?.close ?? '-', volume: c ? +c.volume.toFixed(5) : '-', 'volume Binance': b ? b.volume : '-',
        trades: c?.trades ?? '-', resultado,
      });
    }
    tabela(borda);
    console.log('');
  }
}

// ---------- 3. buracos ----------
console.log('== 3. buracos entre o primeiro e o ultimo candle ==');
const tempos = db.prepare('SELECT open_time t FROM candles WHERE symbol = ? ORDER BY open_time').all(SYMBOL).map((r) => r.t);
const buracos = [];
for (let i = 1; i < tempos.length; i++) {
  const salto = tempos[i] - tempos[i - 1];
  if (salto !== MINUTE) buracos.push({ de: iso(tempos[i - 1] + MINUTE), ate: iso(tempos[i] - MINUTE), minutos: salto / MINUTE - 1 });
}
if (buracos.length) { falhas++; tabela(buracos); } else console.log('nenhum buraco');

// A Binance pode nao ter candle em minutos de manutencao; um buraco so e erro nosso
// se a Binance tiver o candle. Confere ate 5 buracos.
for (const b of buracos.slice(0, 5)) {
  const inicio = Date.parse(b.de.replace(' ', 'T') + ':00Z');
  const deles = await binance('1m', inicio, Math.min(1000, b.minutos));
  console.log(`  buraco ${b.de}: Binance tem ${deles.length} candle(s) nesse trecho ${deles.length ? '<< ERRO NOSSO' : '(manutencao da Binance, nao e erro)'}`);
}

// ---------- 4. sanidade ----------
console.log('\n== 4. sanidade ==');
const dup = db.prepare('SELECT open_time, COUNT(*) c FROM candles WHERE symbol = ? GROUP BY open_time HAVING c > 1').all(SYMBOL);
console.log(`duplicados: ${dup.length} ${dup.length ? '<< ERRO' : 'OK'}`);
if (dup.length) falhas++;
const abertos = db.prepare('SELECT open_time t FROM candles WHERE symbol = ? AND closed = 0 ORDER BY open_time').all(SYMBOL);
const velhos = abertos.filter((r) => r.t + MINUTE <= serverTime - MINUTE);
console.log(`candles marcados como abertos: ${abertos.length} (deveria ser 0 ou 1, o minuto atual)`);
if (velhos.length) falha(`${velhos.length} ja fechados na Binance mas com closed=0 no banco: ${velhos.map((r) => iso(r.t)).join(', ')}`);

// ---------- 5. fase 2: negocios, fluxo por minuto e ordens grandes ----------
console.log('\n== 5. negocios e fluxo (fase 2) ==');
const temFase2 = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type = 'table' AND name = 'agg_trades'").get().n;
const neg = temFase2
  ? db.prepare('SELECT COUNT(*) n, MIN(id) a, MAX(id) b, MIN(time) f, MAX(time) l FROM agg_trades WHERE symbol = ?').get(SYMBOL)
  : { n: 0 };
if (!neg.n) {
  console.log('sem negocios no banco (coletor da fase 2 desligado, ou ainda nao rodou)');
} else {
  const U = (x) => Math.round(x * 1e8); // compara quantidades em inteiros de 1e-8, sem erro de arredondamento
  const hms = (ms) => new Date(ms).toISOString().slice(11, 19);
  console.log(`negocios crus: ${neg.n}  de ${iso(neg.f)} a ${iso(neg.l)} UTC  (ids ${neg.a} a ${neg.b})`);

  // 5a. Buracos de id. Um buraco e aceitavel so se os minutos em volta estiverem marcados
  // como incompletos (o coletor nao baixa o que ficou parado por tempo demais).
  const saltos = db.prepare(`
    SELECT id, time, nxt, nxt_time FROM (
      SELECT id, time, LEAD(id) OVER w nxt, LEAD(time) OVER w nxt_time
      FROM agg_trades WHERE symbol = ? WINDOW w AS (ORDER BY time, id)
    ) WHERE nxt IS NOT NULL AND nxt != id + 1
  `).all(SYMBOL);
  if (!saltos.length) console.log(`ids sem buraco: ${neg.b - neg.a + 1 === neg.n ? 'OK' : 'CONTAGEM NAO BATE'}`);
  else {
    console.log(`buracos de id: ${saltos.length}`);
    for (const s of saltos.slice(0, 5)) console.log(`  entre ${iso(s.time)} e ${iso(s.nxt_time)} UTC faltam ${s.nxt - s.id - 1} negocios`);
  }
  if (!saltos.length && neg.b - neg.a + 1 !== neg.n) falha('a quantidade de negocios nao bate com o intervalo de ids');

  // 5b. Fluxo por minuto x candles. Os candles vem de outra fonte da Binance (klines) e ja
  // foram conferidos acima; se a soma dos negocios de um minuto bate com o candle dele em
  // volume, agressao compradora e numero de negocios, nao falta nem sobra negocio naquele minuto.
  const fluxo = db.prepare(`
    SELECT f.open_time t, f.buy_qty bq, f.sell_qty sq, f.buy_trades bt, f.sell_trades st, f.complete ok,
           c.volume v, c.taker_buy_volume tb, c.trades n, c.closed fechado
    FROM flow_1m f LEFT JOIN candles c ON c.symbol = f.symbol AND c.open_time = f.open_time
    WHERE f.symbol = ? ORDER BY f.open_time
  `).all(SYMBOL);
  let completos = 0, incompletos = 0, iguais = 0, semCandle = 0;
  const difs = [];
  for (const r of fluxo) {
    if (!r.ok) { incompletos++; continue; }
    completos++;
    if (r.v === null || !r.fechado) { semCandle++; continue; }
    const d = [];
    if (U(r.bq) + U(r.sq) !== U(r.v)) d.push(`volume: fluxo=${(U(r.bq) + U(r.sq)) / 1e8} candle=${r.v}`);
    if (U(r.bq) !== U(r.tb)) d.push(`agressao compradora: fluxo=${r.bq} candle=${r.tb}`);
    if (r.bt + r.st !== r.n) d.push(`negocios: fluxo=${r.bt + r.st} candle=${r.n}`);
    if (d.length) difs.push(`${iso(r.t)}: ${d.join('; ')}`); else iguais++;
  }
  console.log(`fluxo por minuto: ${fluxo.length} minutos  completos: ${completos}  incompletos: ${incompletos}`);
  console.log(`minutos completos x candles: ${iguais} identicos  ${difs.length} diferentes  ${semCandle} sem candle fechado para comparar`);
  for (const d of difs.slice(0, 10)) console.log('  ', d);
  if (difs.length) falhas++;
  // Um buraco de id tem que aparecer como minuto incompleto dos dois lados.
  const completo = new Map(fluxo.map((r) => [r.t, r.ok]));
  for (const s of saltos) {
    for (const t of [Math.floor(s.time / MINUTE) * MINUTE, Math.floor(s.nxt_time / MINUTE) * MINUTE]) {
      if (completo.get(t)) falha(`minuto ${iso(t)} esta marcado como completo, mas ha um buraco de negocios nele`);
    }
  }
  // Minuto com candle fechado e com negocios, dentro do periodo do fluxo, mas sem linha de fluxo.
  if (fluxo.length) {
    const faltam = db.prepare(`
      SELECT COUNT(*) n FROM candles c
      WHERE c.symbol = ? AND c.closed = 1 AND c.trades > 0 AND c.open_time > ? AND c.open_time < ?
        AND NOT EXISTS (SELECT 1 FROM flow_1m f WHERE f.symbol = c.symbol AND f.open_time = c.open_time)
    `).get(SYMBOL, fluxo[0].t, fluxo.at(-1).t).n;
    console.log(`minutos com candle e sem fluxo, dentro do periodo: ${faltam}${faltam ? ' (trecho em que o coletor de negocios ficou parado)' : ''}`);
  }

  // 5c. Amostra de negocios crus x Binance: 3 paginas de 1000, campo a campo.
  const umNegocio = db.prepare('SELECT price, qty, trades, taker_buy tb FROM agg_trades WHERE symbol = ? AND time = ? AND id = ?');
  let conferidos = 0, ruins = 0, ausentes = 0;
  for (let i = 0; i < 3 && neg.b - neg.a > 1000; i++) {
    const de = neg.a + Math.floor(Math.random() * (neg.b - neg.a - 1000));
    const res = await fetch(`${REST}/api/v3/aggTrades?symbol=${SYMBOL}&fromId=${de}&limit=1000`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) { falha(`Binance ${res.status} ao buscar negocios`); break; }
    for (const b of await res.json()) {
      const c = umNegocio.get(SYMBOL, b.T, b.a);
      if (!c) { ausentes++; continue; }
      conferidos++;
      if (c.price !== +b.p || c.qty !== +b.q || c.trades !== b.l - b.f + 1 || !!c.tb !== !b.m) ruins++;
    }
    await sleep(120);
  }
  console.log(`amostra de negocios crus x Binance: ${conferidos} conferidos  ${ruins} diferentes  ${ausentes} que nao estao no banco`);
  if (ruins) falhas++;
  if (ausentes && !saltos.length) falha(`${ausentes} negocios da Binance nao estao no banco, e nao ha buraco de id que explique`);

  // 5d. Ordens grandes: refaz o agrupamento (negocios seguidos, no mesmo milissegundo e do
  // mesmo lado) a partir dos negocios crus e compara com a tabela.
  const PISO = Number(process.env.BIG_ORDER_USDT || 25_000);
  const refeitas = new Map();
  let g = null, antes = null;
  const fecha = () => { if (g && g.quote >= PISO && g.time > neg.f && g.time < neg.l) refeitas.set(g.firstId, g); g = null; };
  for (const r of db.prepare('SELECT time, id, price, qty, taker_buy tb FROM agg_trades WHERE symbol = ? ORDER BY time, id').iterate(SYMBOL)) {
    const emenda = antes !== null && r.id === antes + 1;
    if (g && emenda && g.time === r.time && g.tb === r.tb) { g.quote += r.price * r.qty; g.prints++; }
    else { fecha(); g = { firstId: r.id, time: r.time, tb: r.tb, quote: r.price * r.qty, prints: 1 }; }
    antes = r.id;
  }
  fecha();
  const gravadas = db.prepare('SELECT first_id firstId, quote, prints FROM big_orders WHERE symbol = ? AND time > ? AND time < ?').all(SYMBOL, neg.f, neg.l);
  let ordensOk = 0, ordensRuins = 0;
  for (const o of gravadas) {
    const r = refeitas.get(o.firstId);
    if (r && Math.abs(r.quote - o.quote) < 1e-6 && r.prints === o.prints) ordensOk++; else ordensRuins++;
    refeitas.delete(o.firstId);
  }
  console.log(`ordens grandes (>= ${PISO} USDT) no periodo dos negocios crus: ${gravadas.length} gravadas  ${ordensOk} conferem  ${ordensRuins} diferentes  ${refeitas.size} que deveriam estar e nao estao`);
  if (ordensRuins || refeitas.size) {
    falhas++;
    for (const r of [...refeitas.values()].slice(0, 5)) console.log(`   falta: ${hms(r.time)} UTC  ${r.quote.toFixed(0)} USDT`);
  }
}

console.log(`\n${falhas ? `FALHOU: ${falhas} problema(s)` : 'TUDO OK'}`);
process.exit(falhas ? 1 : 0);
