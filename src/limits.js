// Limites de risco da fase 5. FIXOS EM CODIGO.
//
// Quem define estes numeros e o Bruno. O agente de IA nao tem como altera-los: ele so produz
// propostas (dados), e toda ordem, antes de sair, passa pela trava de src/risk.js com os
// valores daqui. Nao ha variavel de ambiente, tela nem comando que mude um limite: so editando
// este arquivo.
//
// Enquanto algum deles estiver `null`, nenhuma ordem e enviada.
export const LIMITS = Object.freeze({
  // Perda maxima em UMA operacao (do preco de entrada ate o stop, com as taxas), em % do
  // saldo da conta de demonstracao.
  maxLossPerTradePct: null,
  // Perda maxima somada no dia (dia UTC), em % do saldo do comeco do dia. Atingida, nenhuma
  // operacao nova abre ate o dia seguinte.
  maxLossPerDayPct: null,
  // Tamanho maximo de uma posicao, em % do saldo. No maximo 100: nao ha alavancagem.
  maxPositionPct: null,
  // Quantas operacoes podem ser abertas por dia (dia UTC).
  maxTradesPerDay: null,
});
