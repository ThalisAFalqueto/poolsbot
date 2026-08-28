// Quanto uma pool REALMENTE paga pra uma posição concentrada.
//
// POR QUE ISSO EXISTE — o apyBase da DefiLlama (e o "giro" que o /comparar
// usava) medem taxa ÷ TVL. Mas TVL é TODA a liquidez da pool, incluindo a que
// está fora de faixa e não ganha nada. Você não divide taxa com o TVL: você
// divide com quem está posicionado NO PREÇO DE AGORA.
//
// Caso real que expôs o erro (28/08/2026, WBTC/USDC 0.05% na Arbitrum):
//   DefiLlama:  V3 apyBase 24,1%  vs  V4 apyBase 10,9%  -> "V3 rende 2,2x"
//   medido:     as duas pools pagaram a MESMA coisa por unidade de liquidez
//               (V4 1,02x na janela de 23-27/08, V3 1,05x na de 27-28/08)
// O que explicava a diferença de apyBase era só a distribuição da liquidez:
// a V3 tinha 3,7x mais liquidez amontoada no preço corrente e ~5x mais volume.
// As duas coisas se cancelam. Ranquear por apyBase errou por ~2x.
//
// A medida certa sai direto do contrato: feeGrowthGlobal é a taxa acumulada
// POR UNIDADE DE LIQUIDEZ. A diferença entre dois blocos, dividida pelo tempo,
// é exatamente o que uma posição ganha por unidade de L por dia — sem passar
// por TVL nenhum.

/** Taxa acumulada por unidade de liquidez entre dois blocos, já convertida
 *  pra unidades HUMANAS de cada token (feeGrowthGlobal vem em Q128 e em
 *  unidades brutas; a conversão fica no leitor on-chain). */
export type FeeGrowthWindow = {
  /** Δ feeGrowthGlobal0, em unidades humanas de token0 por unidade de L. */
  perLiquidity0: number;
  /** Δ feeGrowthGlobal1, em unidades humanas de token1 por unidade de L. */
  perLiquidity1: number;
  /** Duração real da janela medida. */
  days: number;
};

/** Posição de referência usada pra comparar pools na mesma régua. Não é a
 *  posição do usuário — é um padrão fixo, senão pools ficam incomparáveis. */
export type ReferencePosition = {
  /** Valor em token1 (na prática, dólares quando token1 é stable). */
  valueToken1: number;
  /** Meia-largura da faixa em log-preço: 0.03 ≈ ±3%. */
  halfWidthLog: number;
};

export const DEFAULT_REFERENCE: ReferencePosition = { valueToken1: 1000, halfWidthLog: 0.03 };

// Liquidez L de uma posição de valor V numa faixa SIMÉTRICA de meia-largura
// δ (em log-preço) em torno do preço corrente.
//
// Partindo das fórmulas canônicas do V3 (amount0 = L(1/√p − 1/√pb),
// amount1 = L(√p − √pa)) e escrevendo o valor total em token1:
//   V = L/10^d1 · (2√p − √pa − p/√pb)
// Com pa = p·e^(−δ) e pb = p·e^(+δ), os dois termos colapsam no mesmo valor
// (√pa = p/√pb = √p·e^(−δ/2)), e sobra:
//   V = L/10^d1 · 2√p · (1 − e^(−δ/2))
// Conferido numericamente contra a posição real do usuário (V3 #5674258,
// L on-chain 57.148.856 -> valor implicado $48,73) e o atalho simétrico
// bate com a forma exata até a 6ª casa.
//
// `sqrtPriceRaw` é √(preço BRUTO) = sqrtPriceX96 / 2^96, sem ajuste de
// decimais — é nessa unidade que L é definida no contrato.
export function liquidityForValue(valueToken1: number, sqrtPriceRaw: number, halfWidthLog: number, decimals1: number): number {
  const denom = 2 * sqrtPriceRaw * (1 - Math.exp(-halfWidthLog / 2));
  if (denom <= 0) return 0;
  return (valueToken1 * 10 ** decimals1) / denom;
}

export type MeasuredYield = {
  /** Taxa por unidade de liquidez por dia, em token1 (≈ USD). */
  perLiquidityPerDay: number;
  /** Ganho diário da posição de referência, em token1. */
  dailyFees: number;
  /** Retorno anualizado da posição de referência, ENQUANTO EM FAIXA. */
  aprInRange: number;
  days: number;
  /** Fatia da liquidez ativa que a posição de referência passaria a ocupar
   *  (0.02 = 2%). Perto de 1 significa que ela É a pool — e aí o retorno
   *  medido no passado não sobrevive à própria entrada. */
  referenceShare: number;
};

// APR de uma posição de referência concentrada. É o número que responde
// "onde meu dinheiro rende mais", ao contrário do apyBase.
//
// ATENÇÃO ao significado: é o retorno ENQUANTO A POSIÇÃO ESTÁ EM FAIXA.
// Faixa mais estreita sempre produz APR maior aqui — e sai de faixa mais
// rápido. Comparar pools exige a MESMA meia-largura nos dois lados, que é
// justamente o que ReferencePosition fixa.
// DILUIÇÃO — a correção que faltava (28/08/2026).
//
// feeGrowthGlobal mede o que o pool pagou POR UNIDADE DE LIQUIDEZ ENQUANTO
// VOCÊ NÃO ESTAVA LÁ. Multiplicar isso pela sua liquidez só vale se a sua
// entrada não mudar o denominador — ou seja, se L_ref << L_ativa.
//
// Quando não vale, o erro é gigante e sempre pra cima. Caso real: um pool
// WETH-GMX na Arbitrum, com volume 24h de ~ZERO, aparecia com 212%/ano — a
// liquidez ativa dele é tão pequena que a taxa por unidade fica enorme, e a
// conta ingênua prometia esse retorno pra $1.000 que, ao entrar, virariam a
// maior parte da pool e diluiriam o próprio retorno.
//
// O total de taxa que o pool distribui por dia é (taxa por L) × L_ativa, e
// não muda porque você entrou. O que muda é a divisão:
//   suas taxas = (taxa por L) × L_ativa × L_ref / (L_ativa + L_ref)
// Com L_ref desprezível, o último termo tende a L_ref e recai na fórmula
// antiga. Com L_ref dominante, satura no total de taxa do pool — que é o
// teto físico, e é justamente o que a fórmula ingênua estourava.
export function measureYield(
  window: FeeGrowthWindow,
  sqrtPriceRaw: number,
  price: number,
  decimals1: number,
  ref: ReferencePosition = DEFAULT_REFERENCE,
  activeLiquidity: number | null = null
): MeasuredYield | null {
  if (window.days <= 0) return null;

  // Junta as duas pernas de taxa em token1: a perna de token0 é convertida
  // pelo preço corrente (mesma unidade do resto).
  const perLiquidity = window.perLiquidity0 * price + window.perLiquidity1;
  const perLiquidityPerDay = perLiquidity / window.days;

  const liquidity = liquidityForValue(ref.valueToken1, sqrtPriceRaw, ref.halfWidthLog, decimals1);

  // Sem a liquidez ativa não dá pra saber se a diluição importa. Assumir que
  // não importa é o erro que isso corrige, então o certo é não medir.
  if (activeLiquidity === null || activeLiquidity <= 0) return null;

  const referenceShare = liquidity / (activeLiquidity + liquidity);
  const dailyFees = perLiquidityPerDay * activeLiquidity * referenceShare;

  return {
    perLiquidityPerDay,
    dailyFees,
    aprInRange: (dailyFees * 365) / ref.valueToken1,
    days: window.days,
    referenceShare,
  };
}

// ---------------------------------------------------------------------
// Quanto tempo uma faixa aguenta.
//
// POR QUE ISSO É OBRIGATÓRIO AQUI e não um extra: ranquear pools pelo APR
// medido, sozinho, PREMIA PAR VOLÁTIL — volatilidade gera volume, volume gera
// taxa. Medido na Arbitrum em 28/08/2026, o topo da lista virou um RAIN-USDT
// com 1781%/ano, número verdadeiro e leitura mentirosa: uma faixa de ±3% nesse
// par não dura duas horas, e fora de faixa o retorno é ZERO.
//
// O APR medido é sempre "enquanto em faixa". Sem dizer quanto tempo é esse
// "enquanto", o número maior é o mais enganoso da lista.

/** Estimativa de σ (volatilidade diária em log-preço) a partir de uma série
 *  de ticks amostrados ao longo da janela de medição. */
export function volatilityFromTicks(ticks: { tick: number; seconds: number }[]): number | null {
  if (ticks.length < 3) return null;
  const ordenado = [...ticks].sort((a, b) => a.seconds - b.seconds);
  const TICK_LOG = Math.log(1.0001); // 1 tick nessa fração de log-preço

  const retornos: number[] = [];
  for (let i = 1; i < ordenado.length; i++) {
    const dias = (ordenado[i]!.seconds - ordenado[i - 1]!.seconds) / 86_400;
    if (dias <= 0) continue;
    retornos.push(((ordenado[i]!.tick - ordenado[i - 1]!.tick) * TICK_LOG) / Math.sqrt(dias));
  }
  if (retornos.length < 2) return null;

  const media = retornos.reduce((a, b) => a + b, 0) / retornos.length;
  const variancia = retornos.reduce((a, b) => a + (b - media) ** 2, 0) / (retornos.length - 1);
  return Math.sqrt(variancia);
}

/**
 * Quantos dias uma faixa de meia-largura `halfWidthLog` aguenta, com σ diário.
 *
 * Inverte a mesma difusão do /range (move = σ√t  →  t = (move/σ)²), então os
 * dois comandos contam a mesma história. É o tempo até o preço ANDAR a
 * distância da borda, não até ele encostar pela primeira vez — encostar
 * acontece antes, então isto é um TETO otimista. Serve pra ordem de grandeza
 * ("horas" vs "dias"), que é exatamente o que separa RAIN-USDT de WBTC-USDC.
 */
export function daysToLeaveRange(dailyVolatility: number, halfWidthLog: number): number | null {
  if (dailyVolatility <= 0) return null;
  return (halfWidthLog / dailyVolatility) ** 2;
}
