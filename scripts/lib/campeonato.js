// O protocolo do "campeonato": dado um conjunto de situacoes (cada uma com os candles em que
// comeca), testa comprar E vender em cada uma, contra entrar as cegas, escolhendo num periodo
// (treino) e conferindo em outro (confirmacao). Comum a scripts/estudo-regras.js e
// scripts/estudo-baleias.js, para os dois usarem exatamente a mesma regua.
//
// O perigo deste tipo de estudo e achar "regras" por sorte: testando dezenas de combinacoes,
// algumas parecem otimas ou pessimas so por acaso. Por isso:
//   1. treino: uma regra e CANDIDATA se perde das cegas com folga estatistica (t <= -2) e tem
//      pelo menos `minTrain` operacoes; e "melhor que as cegas" se t >= 2;
//   2. confirmacao: periodo que nao foi usado para escolher nada. So vale a regra que la tambem
//      fica do mesmo lado das cegas (t alem de 1,64, pelo menos `minTest` operacoes).
// "As cegas" = entrar de meia em meia hora, do mesmo lado, no mesmo jeito e no mesmo periodo.
// Comparar com ela tira da conta as taxas e a direcao que o mercado teve.
//
// Cada regra opera uma posicao por vez (sinal que chega com operacao aberta e ignorado) e entra
// no fechamento do candle do sinal, com as contas do replay (scripts/lib/historico.js).
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MINUTE } from '../../src/config.js';
import { brt, simulate, utc } from './historico.js';

const DAY = 1440;
const erf = (x) => { // aproximacao de Abramowitz e Stegun (erro menor que 1,5e-7)
  const sg = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  return sg * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
};
export const pBelow = (t) => 0.5 * (1 + erf(t / Math.SQRT2)); // chance de dar t ou menos so por acaso

export function summary(values) {
  const n = values.length;
  if (!n) return { n: 0, media: 0, desvio: 0 };
  let s = 0, s2 = 0;
  for (const x of values) { s += x; s2 += x * x; }
  const mean = s / n;
  return { n, media: mean, desvio: n > 1 ? Math.sqrt(Math.max(0, (s2 - n * mean * mean) / (n - 1))) : 0, soma: s };
}

// situations: [{ key, nome, every, triggers }] - `triggers` sao os indices dos candles em que a
// situacao comeca. first/last: primeiro e ultimo indice em que se pode entrar. split: horario
// (ms) que separa treino de confirmacao. files: nomes dos arquivos de saida.
// extra: dados descritivos do estudo, gravados junto no JSON (opcional).
export function championship({ C, symbol, fee, configs, situations, first, last, split, out, files, title, horizons = [60, 240, 1440], minTrain = 50, minTest = 15, baseEvery = 30, extra = null }) {
  const N = C.length;
  const close = (i) => C[i].close;
  const endsBar = (i, min) => (C[i].openTime + MINUTE) % (min * MINUTE) === 0;
  const period = (time) => (time < split ? 'treino' : 'confirmacao');

  // Resultado de um grupo de operacoes contra a regua (`base`, as cegas do mesmo lado e periodo).
  function stats(list, base) {
    const sm = summary(list.map((t) => t.netPct));
    if (!sm.n) return { n: 0 };
    const losers = list.filter((t) => t.netPct < 0).length;
    const excess = sm.media - base.media;
    const t = sm.desvio > 0 ? excess / (sm.desvio / Math.sqrt(sm.n)) : 0;
    return {
      n: sm.n, perdas: losers, pctPerdas: (100 * losers) / sm.n, media: sm.media, soma: sm.soma, desvio: sm.desvio,
      noStop: list.filter((x) => x.exitKind === 'stop').length, noAlvo: list.filter((x) => x.exitKind === 'target').length,
      asCegas: base.media, asCegasPctPerdas: base.pctPerdas, excesso: excess, t, acaso: pBelow(t),
    };
  }
  // Uma posicao por vez: o sinal que chega com a operacao anterior ainda aberta e ignorado.
  function run(triggers, side, cfg) {
    const list = [];
    let busyUntil = -1;
    for (const i of triggers) {
      if (i < busyUntil) continue;
      const t = simulate(C, i, side, cfg, fee);
      list.push(t);
      busyUntil = t.exitIndex;
    }
    return list;
  }

  // A regua: entradas de meia em meia hora, cada uma simulada sozinha.
  const BASE = {};
  for (const side of ['buy', 'sell']) {
    BASE[side] = {};
    for (const cfg of configs) {
      const all = [];
      for (let i = first; i <= last; i++) if (endsBar(i, baseEvery)) all.push(simulate(C, i, side, cfg, fee));
      BASE[side][cfg.key] = {};
      for (const p of ['treino', 'confirmacao']) {
        const l = all.filter((t) => period(t.entryTime) === p);
        const sm = summary(l.map((t) => t.netPct));
        BASE[side][cfg.key][p] = { n: sm.n, media: sm.media, pctPerdas: (100 * l.filter((t) => t.netPct < 0).length) / sm.n };
      }
    }
  }

  const results = [];
  const allTrades = [];
  for (const s of situations) {
    for (const side of ['buy', 'sell']) {
      for (const cfg of configs) {
        const trades = run(s.triggers, side, cfg);
        const a = stats(trades.filter((t) => period(t.entryTime) === 'treino'), BASE[side][cfg.key].treino);
        const b = stats(trades.filter((t) => period(t.entryTime) === 'confirmacao'), BASE[side][cfg.key].confirmacao);
        const candidata = a.n >= minTrain && a.t <= -2;
        const melhor = a.n >= minTrain && a.t >= 2; // o espelho: ganha das cegas com folga
        results.push({
          situacao: s.key, nome: s.nome, lado: side === 'buy' ? 'comprar' : 'vender', jeito: cfg.key, treino: a, confirmacao: b,
          candidata, confirmada: candidata && b.n >= minTest && b.excesso < 0 && b.t <= -1.64,
          melhorQueAsCegas: melhor, melhorConfirmada: melhor && b.n >= minTest && b.excesso > 0 && b.t >= 1.64,
          // O que interessaria de verdade: resultado positivo DEPOIS das taxas, nos dois periodos.
          positivaNosDois: a.n >= minTrain && b.n >= minTest && a.media > 0 && b.media > 0,
        });
        for (const t of trades) allTrades.push({ s, side, cfg, t });
      }
    }
  }

  // O que o preco fez depois de cada situacao, sem stop nem alvo: a tendencia crua.
  const fwd = (i, h) => (close(i + h) / close(i) - 1) * 100;
  const baseFwd = {};
  for (const h of horizons) {
    baseFwd[h] = {};
    for (const p of ['treino', 'confirmacao']) {
      const v = [];
      for (let i = first; i <= last; i++) if (endsBar(i, baseEvery) && period(C[i].openTime + MINUTE) === p) v.push(fwd(i, h));
      baseFwd[h][p] = summary(v).media;
    }
  }
  const drift = situations.map((s) => ({
    situacao: s.key, nome: s.nome,
    horizontes: horizons.map((h) => {
      const one = (p) => {
        const sm = summary(s.triggers.filter((i) => period(C[i].openTime + MINUTE) === p).map((i) => fwd(i, h)));
        const excess = sm.media - baseFwd[h][p];
        return { n: sm.n, media: sm.media, normal: baseFwd[h][p], excesso: excess, t: sm.desvio > 0 ? excess / (sm.desvio / Math.sqrt(sm.n)) : 0 };
      };
      return { minutos: h, treino: one('treino'), confirmacao: one('confirmacao') };
    }),
  }));

  const tested = results.filter((r) => r.treino.n >= minTrain).length;
  const result = {
    meta: {
      par: symbol, taxaPorLadoPct: fee, candles: N, de: utc(C[first].openTime + MINUTE), corte: utc(split), ate: utc(C[last].openTime + MINUTE),
      diasDeTreino: Math.round((split - C[first].openTime) / (DAY * MINUTE)), diasDeConfirmacao: Math.round((C[last].openTime - split) / (DAY * MINUTE)),
      precoNoInicio: close(first), precoNoCorte: C.find((c) => c.openTime >= split).open, precoNoFim: close(last),
      combinacoes: results.length, comAmostraSuficiente: tested, minimoNoTreino: minTrain, minimoNaConfirmacao: minTest,
      candidatasEsperadasPorAcaso: tested * pBelow(-2), geradoEm: new Date().toISOString(),
    },
    jeitos: configs,
    asCegas: BASE,
    situacoes: situations.map((s) => ({
      chave: s.key, nome: s.nome, examinadaACada: s.every,
      sinaisNoTreino: s.triggers.filter((i) => period(C[i].openTime + MINUTE) === 'treino').length,
      sinaisNaConfirmacao: s.triggers.filter((i) => period(C[i].openTime + MINUTE) === 'confirmacao').length,
    })),
    regras: results,
    tendencia: drift,
    ...(extra ? { extra } : {}),
  };

  // ---------- arquivos ----------
  mkdirSync(out, { recursive: true });
  const num = (x, d = 2) => (x == null || Number.isNaN(x) ? '' : x.toFixed(d).replace('.', ','));
  const saida = { stop: 'stop', target: 'alvo', time: 'prazo' };
  const lines = [['situacao', 'o_que_e', 'acao', 'jeito', 'periodo', 'entrada_utc', 'entrada_brasilia', 'preco_entrada', 'stop', 'alvo', 'saida_utc', 'preco_saida', 'saiu_por', 'minutos', 'bruto_pct', 'liquido_pct'].join(';')];
  for (const { s, side, cfg, t } of allTrades) {
    lines.push([s.key, s.nome, side === 'buy' ? 'comprar' : 'vender', cfg.key, period(t.entryTime), utc(t.entryTime), brt(t.entryTime), num(t.entry), num(t.stop), num(t.target),
      utc(t.exitTime), num(t.exit), saida[t.exitKind], t.bars, num(t.grossPct, 3), num(t.netPct, 3)].join(';'));
  }
  writeFileSync(path.join(out, files.csv), `${String.fromCharCode(0xFEFF)}${lines.join('\r\n')}\r\n`);
  writeFileSync(path.join(out, files.json), JSON.stringify(result, null, 1));
  // Os horarios (UTC) de todos os sinais de cada situacao, para conferir por outro caminho.
  writeFileSync(path.join(out, 'sinais.json'), JSON.stringify(Object.fromEntries(situations.map((s) => [s.key, s.triggers.map((i) => utc(C[i].openTime + MINUTE))]))));

  // ---------- resumo na tela ----------
  const f = (x, d = 3) => (x >= 0 ? '+' : '') + x.toFixed(d);
  const m = result.meta;
  console.log(`${title} - ${m.par}`);
  console.log(`treino: ${m.de} a ${m.corte} UTC (${m.diasDeTreino} dias, ${m.precoNoInicio} -> ${m.precoNoCorte}) | confirmacao: ate ${m.ate} (${m.diasDeConfirmacao} dias, -> ${m.precoNoFim})`);
  for (const side of ['buy', 'sell']) for (const cfg of configs) console.log(`as cegas, ${side === 'buy' ? 'comprar' : 'vender'}, ${cfg.key}: treino ${f(BASE[side][cfg.key].treino.media)}% (${BASE[side][cfg.key].treino.pctPerdas.toFixed(1)}% perdem, n ${BASE[side][cfg.key].treino.n}) | confirmacao ${f(BASE[side][cfg.key].confirmacao.media)}% (${BASE[side][cfg.key].confirmacao.pctPerdas.toFixed(1)}% perdem)`);
  console.log('\nsinais por situacao (treino / confirmacao):');
  for (const s of result.situacoes) console.log(`  ${s.chave} ${s.nome.padEnd(58)} ${String(s.sinaisNoTreino).padStart(6)} / ${String(s.sinaisNaConfirmacao).padStart(5)}`);
  const line = (r) => `  ${r.situacao} ${r.lado.padEnd(7)} ${r.jeito.padEnd(5)} | treino n ${String(r.treino.n).padStart(5)} perdem ${r.treino.pctPerdas.toFixed(0).padStart(3)}% media ${f(r.treino.media)}% excesso ${f(r.treino.excesso)} t ${f(r.treino.t, 2)} | conf n ${String(r.confirmacao.n ?? 0).padStart(4)} media ${r.confirmacao.n ? f(r.confirmacao.media) : '   -  '}% excesso ${r.confirmacao.n ? f(r.confirmacao.excesso) : '  -  '} t ${r.confirmacao.n ? f(r.confirmacao.t, 2) : ' - '} | ${r.candidata ? (r.confirmada ? 'CONFIRMADA' : 'candidata, nao confirmou') : ''}${r.melhorQueAsCegas ? (r.melhorConfirmada ? 'melhor que as cegas, CONFIRMADA' : 'melhor no treino, nao confirmou') : ''}${r.positivaNosDois ? ' [positiva nos dois]' : ''} | ${r.nome}`;
  const ok = results.filter((r) => r.treino.n >= minTrain).sort((a, b) => a.treino.t - b.treino.t);
  console.log(`\ncombinacoes com amostra suficiente: ${tested} de ${results.length}; candidatas esperadas so por acaso: ${m.candidatasEsperadasPorAcaso.toFixed(1)}`);
  console.log(`candidatas a pior regra: ${results.filter((r) => r.candidata).length}; confirmadas: ${results.filter((r) => r.confirmada).length}`);
  console.log(`melhores que as cegas no treino: ${results.filter((r) => r.melhorQueAsCegas).length}; confirmadas: ${results.filter((r) => r.melhorConfirmada).length}; com resultado positivo depois das taxas nos dois periodos: ${results.filter((r) => r.positivaNosDois).length}`);
  console.log('\n== as 15 que mais perderam para as cegas no treino ==');
  for (const r of ok.slice(0, 15)) console.log(line(r));
  console.log('\n== as 10 que mais ganharam das cegas no treino ==');
  for (const r of ok.slice(-10).reverse()) console.log(line(r));
  console.log(`\narquivos em ${out}: ${files.json} e ${files.csv} (${lines.length - 1} operacoes)`);
  return result;
}
