// Fase 5: trava de risco. Toda proposta de operacao passa por aqui antes de virar ordem.
//
// Sao funcoes puras: recebem os limites (src/limits.js), a situacao da conta e a proposta, e
// devolvem se pode, o tamanho permitido e, quando nao pode, todos os motivos. Nao ha caminho
// para uma ordem sair sem passar por `checkProposal` (scripts/testar-risco.js confere os casos).
//
// So compra (conta a vista, sem alavancagem e sem venda a descoberto), sempre com stop, uma
// posicao aberta por vez.

const LIMIT_NAMES = {
  maxLossPerTradePct: 'perda maxima por operacao',
  maxLossPerDayPct: 'perda maxima por dia',
  maxPositionPct: 'tamanho maximo da posicao',
  maxTradesPerDay: 'operacoes por dia',
};

// Devolve null se os limites estao completos e coerentes; senao, o problema, em texto.
export function limitsProblem(limits) {
  const missing = Object.keys(LIMIT_NAMES).filter((k) => !(typeof limits?.[k] === 'number' && Number.isFinite(limits[k]) && limits[k] > 0));
  if (missing.length) return `limites de risco ainda nao definidos: ${missing.map((k) => LIMIT_NAMES[k]).join(', ')}`;
  if (limits.maxLossPerTradePct > limits.maxLossPerDayPct) return 'a perda maxima por operacao nao pode ser maior que a perda maxima por dia';
  if (limits.maxPositionPct > 100) return 'o tamanho maximo da posicao nao pode passar de 100% do saldo (nao ha alavancagem)';
  if (!Number.isInteger(limits.maxTradesPerDay)) return 'operacoes por dia tem que ser um numero inteiro';
  return null;
}

// Casas decimais de um passo da corretora: "0.00001000" -> 5; "0.01000000" -> 2; "1.00000000" -> 0.
export function decimalsOf(step) {
  const s = String(step).replace(/0+$/, '');
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : s.length - dot - 1;
}

// Arredonda PARA BAIXO ao multiplo do passo (a corretora recusa quantidade ou preco fora dele).
// A folga cobre o erro de arredondamento da divisao (0,3 / 0,1 da 2,9999...); ela cresce com o
// numero porque, em precos altos, esse erro passa de um bilionesimo.
export function floorToStep(value, step) {
  const st = Number(step);
  if (!(st > 0)) return value;
  const q = value / st;
  return Number((Math.floor(q + 1e-9 + Math.abs(q) * 1e-12) * st).toFixed(decimalsOf(step)));
}

// O mesmo, como texto com as casas decimais do passo (e assim que a corretora quer receber).
export const formatStep = (value, step) => floorToStep(value, step).toFixed(decimalsOf(step));

// Confere uma proposta e calcula o tamanho da ordem.
//   limits         - src/limits.js
//   equity         - valor da conta agora, em USDT
//   dayStartEquity - valor da conta no comeco do dia (UTC)
//   realizedToday  - resultado ja realizado hoje, em USDT (negativo = perda)
//   tradesToday    - operacoes abertas hoje
//   openPositions  - posicoes abertas agora
//   proposal       - { side, entry, stop, target }
//   filters        - regras da corretora para o par: { stepSize, minQty, tickSize, minNotional }
//   feePct         - taxa por lado, em %
//
// O tamanho e o MENOR entre: o que a perda maxima por operacao permite, o que ainda cabe na
// perda maxima do dia e o tamanho maximo da posicao. A perda considerada vai da entrada ate o
// stop, mais as taxas dos dois lados.
export function checkProposal({ limits, equity, dayStartEquity, realizedToday = 0, tradesToday = 0, openPositions = 0, proposal, filters, feePct = 0.1 }) {
  const reasons = [];
  const problem = limitsProblem(limits);
  if (problem) return { ok: false, reasons: [problem] };
  if (!(Number(filters?.stepSize) > 0) || !(Number(filters?.tickSize) > 0)) {
    return { ok: false, reasons: ['regras do par desconhecidas (passo de quantidade e passo de preco)'] };
  }
  if (!(feePct >= 0)) return { ok: false, reasons: ['taxa invalida'] };

  const { side, entry } = proposal ?? {};
  // O stop e o alvo entram na conta do jeito que vao para a corretora: ja arredondados para o
  // passo de preco dela. Assim a perda calculada e a do stop que sera realmente colocado.
  const stop = proposal?.stop > 0 ? floorToStep(proposal.stop, filters.tickSize) : NaN;
  const target = proposal?.target == null ? null : floorToStep(Number(proposal.target), filters.tickSize);
  if (side !== 'buy') reasons.push('so compra e permitida: a conta e a vista, sem venda a descoberto');
  if (!(entry > 0)) reasons.push('preco de entrada invalido');
  if (!(stop > 0)) reasons.push('toda operacao precisa de stop');
  else if (entry > 0 && stop >= entry) reasons.push('o stop tem que ficar abaixo do preco de entrada');
  if (target != null && entry > 0 && !(target > entry)) reasons.push('o alvo tem que ficar acima do preco de entrada');
  if (!(equity > 0) || !(dayStartEquity > 0)) reasons.push('saldo da conta desconhecido');
  if (openPositions > 0) reasons.push('ja existe uma posicao aberta');
  if (tradesToday >= limits.maxTradesPerDay) reasons.push(`limite de ${limits.maxTradesPerDay} operacoes por dia atingido`);
  if (reasons.length) return { ok: false, reasons };

  // Quanto ainda pode ser perdido hoje sem passar do limite do dia.
  const dayBudget = (dayStartEquity * limits.maxLossPerDayPct) / 100 + Math.min(0, realizedToday);
  if (dayBudget <= 0) return { ok: false, reasons: ['perda maxima do dia atingida: nenhuma operacao nova ate o proximo dia (UTC)'] };
  const tradeBudget = (equity * limits.maxLossPerTradePct) / 100;
  const lossPerUnit = entry - stop + (feePct / 100) * (entry + stop); // por unidade, com as taxas
  const byTrade = tradeBudget / lossPerUnit;
  const byDay = dayBudget / lossPerUnit;
  const byPosition = (equity * limits.maxPositionPct) / 100 / entry;
  const raw = Math.min(byTrade, byDay, byPosition);
  const limitedBy = raw === byPosition ? 'tamanho maximo da posicao' : raw === byDay ? 'perda maxima do dia' : 'perda maxima por operacao';
  const qty = floorToStep(raw, filters.stepSize);
  const notional = qty * entry;
  if (!(qty > 0) || qty < Number(filters.minQty) || notional < Number(filters.minNotional)) {
    return { ok: false, reasons: [`com os limites atuais a ordem ficaria em ${notional.toFixed(2)} USDT, abaixo do minimo da corretora (${Number(filters.minNotional)} USDT)`] };
  }
  return {
    ok: true, reasons: [], qty, notional, limitedBy, entry, stop, target,
    maxLoss: qty * lossPerUnit, // a perda se o stop for executado no preco, com as taxas
  };
}

// Arredonda PARA CIMA ao multiplo do passo (usado no preco maximo aceito numa compra).
export function ceilToStep(value, step) {
  const st = Number(step);
  if (!(st > 0)) return value;
  const q = value / st;
  return Number((Math.ceil(q - 1e-9 - Math.abs(q) * 1e-12) * st).toFixed(decimalsOf(step)));
}
