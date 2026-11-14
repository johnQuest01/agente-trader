// Fase 2: livro de ofertas ao vivo.
//
// O livro local e montado como a Binance manda: uma foto (os 5000 melhores niveis de cada lado)
// mais as atualizacoes que chegam uma vez por segundo, cada uma numerada. Se um numero falta,
// o livro local deixou de ser confiavel e e refeito do zero. Alem disso, a cada 10 minutos ele
// e comparado nivel a nivel com uma foto nova: e a prova de que continua igual ao da Binance.
//
// Do livro guardamos um resumo por segundo (melhor compra, melhor venda e a quantidade
// ofertada de cada lado ate certas distancias do preco) e as maiores ofertas paradas.
import { MINUTE, BOOK_KEEP_DAYS } from './config.js';
import { fetchDepth, streamDepth } from './binance.js';

// Faixas de distancia em torno do preco medio (o meio entre a melhor compra e a melhor venda):
// 0,02%, 0,05%, 0,1%, 0,2%, 0,5% e 1%. A ordem e a das colunas b1..b6 / a1..a6 do banco.
export const BOOK_BANDS = [0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01];
const DEPTH_LIMIT = 5000;          // niveis por lado na foto (uns 2,4% do preco no BTCUSDT)
const WALLS = 5;                   // maiores ofertas guardadas por lado
const WALL_RANGE = 0.01;           // procuradas ate 1% do preco
const WALL_EVERY = 10_000;         // de 10 em 10 segundos
const CHECK_EVERY = 10 * MINUTE;   // conferencia contra uma foto nova
const HOUR = 60 * MINUTE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x) => (x === null ? null : Math.round(x * 1e8) / 1e8);

export function startBook({ db, symbol, log = () => {}, onStatus, onBook }) {
  const bids = new Map(); // preco -> quantidade
  const asks = new Map();
  let live = false;
  let synced = false;     // o livro local esta emendado com as atualizacoes
  let lastU = 0;          // numero da ultima atualizacao aplicada
  // Trecho de precos em que conhecemos TODOS os niveis (o que a ultima foto cobria).
  let known = { low: 0, high: Infinity };
  let pending = [];       // atualizacoes recebidas enquanto a foto nao chega
  const recent = [];      // ultimas atualizacoes aplicadas (para conferir contra uma foto nova)
  let syncing = null;
  let retryTimer = null;
  let stopped = false;
  let current = null;     // ultimo resumo
  let walls = { bids: [], asks: [] };
  let lastWalls = 0;
  let acc = null;         // acumulador da media do minuto
  const checks = { done: 0, levels: 0, different: 0, lastAt: null, lastOk: null };

  const emitStatus = () => onStatus?.({ live, synced });

  const setLevels = (map, rows) => {
    for (const [p, q] of rows) { if (q === 0) map.delete(p); else map.set(p, q); }
  };

  function apply(ev) {
    setLevels(bids, ev.bids);
    setLevels(asks, ev.asks);
    lastU = ev.u;
    recent.push(ev);
    if (recent.length > 180) recent.shift();
  }

  const rangeOf = (snap) => ({
    // Se a foto veio com menos niveis que o pedido, ela tem o lado inteiro.
    low: snap.bids.length < DEPTH_LIMIT ? 0 : snap.bids.at(-1)[0],
    high: snap.asks.length < DEPTH_LIMIT ? Infinity : snap.asks.at(-1)[0],
  });

  // ---------- montar o livro: foto + atualizacoes ----------
  function sync(why) {
    if (syncing) return syncing;
    clearTimeout(retryTimer);
    synced = false;
    emitStatus();
    syncing = (async () => {
      try {
        for (let tries = 0; tries < 20 && !stopped; tries++) {
          const snap = await fetchDepth(symbol, DEPTH_LIMIT);
          // Daqui ate o fim do bloco nao ha espera: nenhuma atualizacao chega no meio.
          const evs = pending.filter((e) => e.u > snap.lastUpdateId);
          // A foto tem que alcancar o comeco do que guardamos; se ela e mais velha, falta um
          // pedaco entre as duas. Pede outra.
          if (evs.length && evs[0].U > snap.lastUpdateId + 1) { await sleep(400); continue; }
          // As guardadas tem que ser seguidas entre si.
          const quebra = evs.findIndex((e, i) => i > 0 && e.U !== evs[i - 1].u + 1);
          if (quebra > 0) { pending = evs.slice(quebra); await sleep(400); continue; }
          bids.clear();
          asks.clear();
          setLevels(bids, snap.bids);
          setLevels(asks, snap.asks);
          lastU = snap.lastUpdateId;
          known = rangeOf(snap);
          recent.length = 0;
          for (const e of evs) apply(e);
          pending = [];
          synced = true;
          log(`livro em dia (${why}): ${bids.size} niveis de compra e ${asks.size} de venda`);
          return;
        }
        if (!stopped) throw new Error('a foto do livro nao emendou com as atualizacoes');
      } catch (err) {
        log(`livro: falha ao sincronizar (${err.message}); tento de novo em 30s`);
        retryTimer = setTimeout(() => sync('nova tentativa'), 30_000);
        retryTimer.unref();
      } finally {
        syncing = null;
        emitStatus();
      }
    })();
    return syncing;
  }

  // ---------- resumo do livro ----------
  function summarize() {
    let bid = -Infinity;
    let ask = Infinity;
    for (const p of bids.keys()) if (p > bid) bid = p;
    for (const p of asks.keys()) if (p < ask) ask = p;
    if (!(bid < ask)) return null; // livro vazio ou cruzado: nao e confiavel
    const mid = (bid + ask) / 2;
    const n = BOOK_BANDS.length;
    const b = new Array(n).fill(0);
    const a = new Array(n).fill(0);
    // Cada nivel entra em todas as faixas que o alcancam (as faixas sao cumulativas).
    for (const [p, q] of bids) {
      const d = (mid - p) / mid;
      for (let i = n - 1; i >= 0 && d <= BOOK_BANDS[i]; i--) b[i] += q;
    }
    for (const [p, q] of asks) {
      const d = (p - mid) / mid;
      for (let i = n - 1; i >= 0 && d <= BOOK_BANDS[i]; i--) a[i] += q;
    }
    for (let i = 0; i < n; i++) {
      // Faixa que passa do trecho conhecido do livro: a soma estaria incompleta. Fica sem valor.
      b[i] = mid * (1 - BOOK_BANDS[i]) < known.low ? null : round(b[i]);
      a[i] = mid * (1 + BOOK_BANDS[i]) > known.high ? null : round(a[i]);
    }
    return { bid, ask, mid, b, a };
  }

  function findWalls(mid) {
    const top = (map, inRange) => {
      const rows = [];
      for (const [p, q] of map) if (inRange(p)) rows.push({ price: p, qty: q });
      return rows.sort((x, y) => y.qty - x.qty).slice(0, WALLS);
    };
    return {
      bids: top(bids, (p) => p >= mid * (1 - WALL_RANGE)),
      asks: top(asks, (p) => p <= mid * (1 + WALL_RANGE)),
    };
  }

  const view = () => current && {
    time: current.time, bid: current.bid, ask: current.ask,
    bands: BOOK_BANDS.map((pct, i) => ({ pct, bid: current.b[i], ask: current.a[i] })),
    walls, live, synced,
    checks: { ...checks },
  };

  function closeMinute() {
    if (!acc) return;
    const avg = (sum, cnt) => sum.map((s, i) => (cnt[i] ? round(s / cnt[i]) : null));
    db.insertBookMinute({
      symbol, time: acc.time, samples: acc.n, spread: round(acc.spread / acc.n), bid: acc.bid, ask: acc.ask,
      b: avg(acc.b, acc.bn), a: avg(acc.a, acc.an),
    });
    acc = null;
  }

  // Chamado a cada atualizacao aplicada (uma por segundo).
  function tick(time) {
    const s = summarize();
    if (!s) {
      log('livro: compra e venda cruzadas; sincronizando de novo');
      pending = [];
      sync('livro cruzado');
      return;
    }
    const sec = Math.floor(time / 1000) * 1000;
    current = { time: sec, ...s };
    try {
      db.insertBook({ symbol, time: sec, bid: s.bid, ask: s.ask, b: s.b, a: s.a });
      if (sec - lastWalls >= WALL_EVERY) {
        lastWalls = sec;
        walls = findWalls(s.mid);
        db.insertWalls(symbol, sec, walls);
      }
      const min = Math.floor(sec / MINUTE) * MINUTE;
      if (acc && acc.time !== min) closeMinute();
      if (!acc) {
        const zeros = () => new Array(BOOK_BANDS.length).fill(0);
        acc = { time: min, n: 0, spread: 0, bid: s.bid, ask: s.ask, b: zeros(), bn: zeros(), a: zeros(), an: zeros() };
      }
      acc.n += 1;
      acc.spread += s.ask - s.bid;
      acc.bid = s.bid;
      acc.ask = s.ask;
      s.b.forEach((v, i) => { if (v !== null) { acc.b[i] += v; acc.bn[i] += 1; } });
      s.a.forEach((v, i) => { if (v !== null) { acc.a[i] += v; acc.an[i] += 1; } });
    } catch (err) {
      log(`livro: falha ao gravar (${err.message})`);
    }
    onBook?.(view());
  }

  function onEvent(ev) {
    if (!synced) {
      pending.push(ev);
      if (pending.length > 900) pending.shift();
      return;
    }
    if (ev.u <= lastU) return; // ja contida no livro
    if (ev.U > lastU + 1) {
      log('livro: faltou uma atualizacao; sincronizando de novo');
      pending = [ev];
      sync('salto nas atualizacoes');
      return;
    }
    apply(ev);
    tick(ev.time);
  }

  // ---------- conferencia contra a Binance ----------
  // Pega uma foto nova, leva a foto ate o mesmo ponto do livro local (aplicando nela as
  // atualizacoes que vieram depois) e compara nivel a nivel, no trecho que os dois conhecem
  // por inteiro. Com `replace`, o livro local passa a ser a foto nova, o que tambem renova o
  // trecho conhecido quando o preco andou.
  async function check(replace = false) {
    if (!synced) return { ok: false, reason: 'o livro ainda nao esta sincronizado' };
    const snap = await fetchDepth(symbol, DEPTH_LIMIT);
    // A foto costuma estar um pouco a frente do livro local: espera ele alcanca-la.
    for (let i = 0; i < 60 && synced && lastU < snap.lastUpdateId && !stopped; i++) await sleep(100);
    if (!synced) return { ok: false, reason: 'o livro foi refeito durante a conferencia' };
    if (lastU < snap.lastUpdateId) return { ok: false, reason: 'o livro local nao alcancou a foto' };
    // Daqui em diante nao ha espera: o livro local nao muda durante a comparacao.
    const later = recent.filter((e) => e.u > snap.lastUpdateId);
    if (later.length && later[0].U > snap.lastUpdateId + 1) {
      return { ok: false, reason: 'faltam atualizacoes entre a foto e o livro local' };
    }
    const eb = new Map(snap.bids);
    const ea = new Map(snap.asks);
    for (const e of later) { setLevels(eb, e.bids); setLevels(ea, e.asks); }
    const novo = rangeOf(snap);
    const low = Math.max(known.low, novo.low);
    const high = Math.min(known.high, novo.high);
    let levels = 0;
    let different = 0;
    const examples = [];
    const compare = (mine, expected, inRange, lado) => {
      for (const [p, q] of expected) {
        if (!inRange(p)) continue;
        levels += 1;
        if (mine.get(p) !== q) { different += 1; if (examples.length < 5) examples.push(`${lado} ${p}: local=${mine.get(p) ?? 'nao tem'} binance=${q}`); }
      }
      for (const [p, q] of mine) {
        if (!inRange(p) || expected.has(p)) continue;
        levels += 1;
        different += 1;
        if (examples.length < 5) examples.push(`${lado} ${p}: local=${q} binance=nao tem`);
      }
    };
    compare(bids, eb, (p) => p >= low, 'compra');
    compare(asks, ea, (p) => p <= high, 'venda');
    // As somas por faixa, refeitas por outro caminho a partir da foto (niveis em ordem de
    // preco, somando ate passar da faixa), tem que dar o mesmo que o resumo do livro local.
    const mine = summarize();
    if (mine && !different) {
      const somar = (map, perto, dentro) => {
        const ordenados = [...map].sort(perto);
        return BOOK_BANDS.map((pct) => {
          let s = 0;
          for (const [p, q] of ordenados) { if (!dentro(p, pct)) break; s += q; }
          return round(s);
        });
      };
      const eb2 = somar(eb, (x, y) => y[0] - x[0], (p, pct) => (mine.mid - p) / mine.mid <= pct);
      const ea2 = somar(ea, (x, y) => x[0] - y[0], (p, pct) => (p - mine.mid) / mine.mid <= pct);
      BOOK_BANDS.forEach((pct, i) => {
        for (const [lado, meu, outro] of [['compra', mine.b[i], eb2[i]], ['venda', mine.a[i], ea2[i]]]) {
          if (meu === null) continue; // faixa fora do trecho conhecido
          levels += 1;
          if (Math.abs(meu - outro) > 1e-6) { different += 1; examples.push(`soma ${lado} ate ${pct * 100}%: local=${meu} recalculada=${outro}`); }
        }
      });
    }
    checks.done += 1;
    checks.levels += levels;
    checks.different += different;
    checks.lastAt = Date.now();
    checks.lastOk = different === 0;
    if (different) log(`livro: ${different} de ${levels} niveis diferentes da Binance na conferencia (${examples.join('; ')})`);
    if (replace || different) {
      bids.clear();
      asks.clear();
      for (const [p, q] of eb) bids.set(p, q);
      for (const [p, q] of ea) asks.set(p, q);
      known = novo;
    }
    return { ok: different === 0, levels, different, examples, updateId: lastU };
  }

  function prune() {
    const n = db.deleteBookBefore(symbol, Date.now() - BOOK_KEEP_DAYS * 24 * HOUR);
    if (n) log(`livro: ${n} linhas antigas apagadas (ficam os ultimos ${BOOK_KEEP_DAYS} dias; a media por minuto fica para sempre)`);
  }

  const stopStream = streamDepth(symbol, {
    log,
    onOpen: () => {
      pending = []; // a foto vai ser emendada com o que chegar a partir de agora
      sync('conexao');
    },
    onStatus: (l) => {
      live = l;
      if (!l) synced = false; // sem conexao o livro local para de valer
      emitStatus();
    },
    onEvent,
  });

  const guard = (fn, what) => async () => {
    try { await fn(); } catch (err) { log(`livro: falha ${what} (${err.message})`); }
  };
  const checkTimer = setInterval(guard(() => check(true), 'na conferencia'), CHECK_EVERY);
  checkTimer.unref();
  const pruneTimer = setInterval(guard(prune, 'na limpeza'), HOUR);
  pruneTimer.unref();

  return {
    view,
    check: () => check(false),
    stop: () => {
      stopped = true;
      clearInterval(checkTimer);
      clearInterval(pruneTimer);
      clearTimeout(retryTimer);
      stopStream();
      try { closeMinute(); } catch {}
    },
  };
}
