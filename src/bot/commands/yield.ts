import type { CommandContext, Context } from "grammy";
import { fetchAllPools } from "../../data/defillama/client.js";
import { MEASURE_WINDOW_DAYS, measurePoolYields, type PoolMeasurement } from "../../data/onchain/measure-pool-yield.js";
import { DEFAULT_REFERENCE } from "../../domain/market/fee-per-liquidity.js";
import { isConcentrated, isMeasurableConcentrated } from "../../domain/yield-optimizer/concentrated.js";
import { isEligiblePool, MAX_APY_VS_MEAN30D_RATIO, MIN_TVL_USD } from "../../domain/yield-optimizer/eligibility.js";

// /yield: pools de LIQUIDEZ CONCENTRADA de uma chain, ranqueadas pelo que
// pagam DE VERDADE (medido on-chain), não pelo apyBase da DefiLlama.
//
// DUAS MUDANÇAS DE 28/08/2026, as duas vindas de medição, não de opinião:
//
// 1. SÓ POOLS. O comando lia o catálogo inteiro da DefiLlama — empréstimo,
//    renda fixa tokenizada, GMX, Pendle, vaults. Medido na Arbitrum, o teto
//    de tudo que não é liquidez concentrada era 13,8% ao ano, abaixo do piso
//    de 36% da meta — e alcançável por caminhos bem mais simples que DeFi.
//    Listar isso junto era ruído. Ver domain/yield-optimizer/concentrated.ts.
//
// 2. RANQUEIA PELO NÚMERO MEDIDO. O piso de --min era aplicado sobre o apy da
//    DefiLlama (taxa ÷ TVL), que subestima posição concentrada em ~4x porque
//    o TVL inclui a liquidez fora de faixa. Consequência real: /yield arbitrum
//    no padrão (--min 36) devolvia ZERO pools, e a própria pool do usuário
//    (23,3% na DefiLlama, 101%/ano medida) era descartada. O filtro excluía
//    exatamente o que atendia a meta.
//
// 3. RANQUEIA PELO LÍQUIDO, não pela receita. Toda pool tem um custo que
//    cresce com σ²: quando o preço se move, um arbitrador compra dela barato
//    até realinhar (LVR — ver domain/market/fee-per-liquidity.ts). Ranquear só
//    pela taxa premiava par volátil duas vezes: volatilidade gera volume (mais
//    taxa) E gera arbitragem (mais custo). Medido na Arbitrum, a ordem
//    INVERTIA: a pool em 1º lugar (ETH-USDT, 135%/ano de taxa) sobrava 4%
//    depois do custo, enquanto a 3ª (WBTC-EVA, 94%) sobrava 71%.
//
// O ranking NÃO usa mais o score multiplicativo de score.ts. Com o número
// medido em mãos, multiplicá-lo por 5 fatores opacos volta a esconder de onde
// veio a ordem — e o usuário pediu explicitamente pra entender cada conta
// (ver /explicacoes). Segurança continua sendo tratada como FILTRO binário e
// explicável (TVL e pico de APY), não como peso invisível.

/** ~3%/mês em juros compostos — a meta declarada. Agora aplicado ao número
 *  MEDIDO, onde ele de fato significa alguma coisa. */
const DEFAULT_MIN_APY_PCT = 36;
const MAX_RESULTS = 6;

// Abaixo disso a faixa não dura um dia: você reposicionaria todo dia, pagando
// gas toda vez — custo que o modelo do LVR não inclui. Virou AVISO na linha,
// não seção separada: desde que o ranking passou a ser pelo líquido, esses
// pares se excluem sozinhos (o custo deles supera a taxa), e a separação
// virava uma segunda régua desnecessária.
const MIN_DIAS_UTILIZAVEL = 1;

// Acima disso, a posição de referência deixa de ser "mais um LP" e vira parte
// relevante do pool. O APR já sai corrigido pela diluição (ver measureYield),
// mas sobra o que a diluição não cobre: entrar e sair mexe no preço, e você
// fica dependente de um pool que praticamente só tem você. Vira ressalva
// explícita na linha, não motivo pra esconder.
const FATIA_QUE_MERECE_AVISO = 0.1;

function parseArgs(raw: string) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean);
  let minApyPct = DEFAULT_MIN_APY_PCT;
  const rest: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "--min" && tokens[i + 1] !== undefined) {
      const parsed = Number(tokens[i + 1]);
      if (!Number.isNaN(parsed)) minApyPct = parsed;
      i++; // pula o valor já consumido
      continue;
    }
    rest.push(tokens[i]!);
  }

  const [chain, ...symbolParts] = rest;
  return { chain, symbol: symbolParts.join(" ") || undefined, minApyPct };
}

const LARGURA_PCT = (DEFAULT_REFERENCE.halfWidthLog * 100).toFixed(0);

function formatDuracao(dias: number | null): string {
  if (dias === null) return "duração não medida";
  if (dias < 1) return `faixa dura ~${(dias * 24).toFixed(0)}h`;
  return `faixa dura ~${dias.toFixed(1)} dias`;
}

function linhaDePool(
  p: { symbol: string; project: string; poolMeta: string | null; tvlUsd: number; poolId: string },
  m: PoolMeasurement
): string {
  const projeto = p.project.replace("uniswap-", "uni ");
  const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

  // O líquido primeiro, a decomposição embaixo. O usuário precisa do número da
  // decisão de cara, mas sem "taxa − custo" à vista o líquido não é auditável
  // — e ele pediu explicitamente pra conseguir refazer cada conta.
  const cabeca = m.netApr !== null ? `${m.netApr > 0 ? "+" : ""}${pct(m.netApr)}/ano` : `${pct(m.aprInRange)}/ano de taxa (custo não medido)`;
  const conta = m.lvrApr !== null ? `taxas ${pct(m.aprInRange)} − custo ${pct(m.lvrApr)}` : `taxas ${pct(m.aprInRange)}`;

  const linhas = [
    `${cabeca} — ${p.symbol} (${projeto} ${p.poolMeta ?? "?"})`,
    `   ${conta} · ${formatDuracao(m.daysInRange)} · TVL $${(p.tvlUsd / 1e6).toFixed(1)}M`,
    `   id: ${p.poolId}`,
  ];
  if (m.referenceShare >= FATIA_QUE_MERECE_AVISO) {
    linhas.splice(2, 0, `   ⚠️ $1.000 aqui seriam ${(m.referenceShare * 100).toFixed(0)}% da liquidez ativa — pool raso, entrar e sair mexe no preço.`);
  }
  if (m.daysInRange !== null && m.daysInRange < MIN_DIAS_UTILIZAVEL) {
    linhas.splice(2, 0, `   ⚠️ a faixa não dura um dia — você reposicionaria diariamente, e o gas disso não está descontado acima.`);
  }
  return linhas.join("\n");
}

export async function yieldCommand(ctx: CommandContext<Context>) {
  const { chain, symbol, minApyPct } = parseArgs(ctx.match?.toString() ?? "");

  if (!chain) {
    await ctx.reply(
      [
        "Uso: /yield <chain> [par] [--min <%ao ano>]",
        `Ex: /yield arbitrum          (piso padrão de ${DEFAULT_MIN_APY_PCT}% ao ano = sua meta de 3%/mês)`,
        "Ex: /yield arbitrum WBTC     (só pares com WBTC)",
        "Ex: /yield base --min 15     (piso menor)",
        "",
        "Lista pools de liquidez concentrada (Uniswap V3/V4) ranqueadas pelo que pagam de verdade, medido on-chain. Empréstimo, renda fixa tokenizada e afins ficaram de fora de propósito: o teto deles é ~14% ao ano, longe da meta.",
      ].join("\n")
    );
    return;
  }

  const pools = await fetchAllPools();

  const doTipoCerto = pools
    .filter((p) => p.chain.toLowerCase() === chain.toLowerCase())
    .filter((p) => !symbol || p.symbol.toLowerCase().includes(symbol.toLowerCase()))
    .filter((p) => !p.outlier)
    .filter((p) => isConcentrated(p.project));

  if (doTipoCerto.length === 0) {
    await ctx.reply(
      [
        `Nenhuma pool de liquidez concentrada em ${chain}${symbol ? ` com "${symbol}"` : ""}.`,
        "",
        "Confira o nome da chain (ex: arbitrum, base, polygon, optimism) e a grafia do par. Sem o par, /yield lista as melhores da chain inteira.",
      ].join("\n")
    );
    return;
  }

  // Filtros de SEGURANÇA, mantidos: TVL protege contra pool fácil de
  // manipular, e apy vs média de 30d contra pico de wash trading. O segundo
  // continua valendo mesmo com o nível do apyBase errado, porque é uma RAZÃO
  // do pool contra ele mesmo — o viés de TVL se cancela nos dois lados.
  const elegiveis = doTipoCerto.filter((p) =>
    isEligiblePool({
      poolId: p.pool, chain: p.chain, project: p.project, symbol: p.symbol, apy: p.apy,
      tvlUsd: p.tvlUsd, ilRisk: p.ilRisk, sigma: p.sigma, apyMean30d: p.apyMean30d, volumeUsd7d: p.volumeUsd7d,
    })
  );
  const cortadasPorSeguranca = doTipoCerto.length - elegiveis.length;

  if (elegiveis.length === 0) {
    await ctx.reply(
      [
        `Achei ${doTipoCerto.length} pool(s) de liquidez concentrada em ${chain}, mas nenhuma passou nos filtros de segurança.`,
        "",
        `Os filtros: TVL ≥ $${MIN_TVL_USD.toLocaleString("pt-BR")} (pool pequena é barata de manipular) e APY no máximo ${MAX_APY_VS_MEAN30D_RATIO}x a própria média de 30 dias (corta pico de wash trading).`,
        "Eles não são ajustáveis — o --min só mexe no piso de retorno.",
      ].join("\n")
    );
    return;
  }

  const medicoes = await measurePoolYields(
    elegiveis
      .filter((p) => isMeasurableConcentrated(p.project))
      .map((p) => ({ poolId: p.pool, chain: p.chain, project: p.project, poolMeta: p.poolMeta, underlyingTokens: p.underlyingTokens }))
  );

  const medidas = elegiveis
    .map((p) => ({ p, m: medicoes.get(p.pool) }))
    .filter((x): x is { p: (typeof elegiveis)[number]; m: PoolMeasurement } => x.m !== undefined)
    // Ordena pelo LÍQUIDO. Pool sem σ medido (netApr null) cai pro fim: sem
    // custo estimado não dá pra comparar com quem tem, e chutar zero de custo
    // é justamente o erro que isso corrige.
    .sort((a, b) => (b.m.netApr ?? -Infinity) - (a.m.netApr ?? -Infinity));

  const naoMedidas = elegiveis.length - medidas.length;

  if (medidas.length === 0) {
    await ctx.reply(
      [
        `Achei ${elegiveis.length} pool(s) em ${chain} que passaram nos filtros, mas não consegui medir nenhuma on-chain.`,
        "",
        "Motivos possíveis: a chain não tem RPC configurado aqui, o protocolo não é Uniswap V3/V4, ou o pool V4 usa hook customizado.",
        "Prefiro não te dar o número da DefiLlama nesses casos: ele divide por TVL e subestima posição concentrada em ~4x. Ver /explicacoes pool.",
      ].join("\n")
    );
    return;
  }

  // Piso sobre o LÍQUIDO — é o que responde "vale a pena". Sem custo medido,
  // o pool não disputa o piso: aparece à parte, dito como tal.
  const acimaDoPiso = medidas.filter((x) => x.m.netApr !== null && x.m.netApr * 100 >= minApyPct);
  const semCusto = medidas.filter((x) => x.m.netApr === null);

  if (acimaDoPiso.length === 0) {
    const melhor = medidas.find((x) => x.m.netApr !== null);
    if (!melhor) {
      await ctx.reply(`Achei ${medidas.length} pool(s) em ${chain}, mas não consegui medir a volatilidade de nenhuma — sem ela não dá pra estimar o custo, e mostrar só a taxa engana. Tente de novo em alguns minutos.`);
      return;
    }
    const liquido = melhor.m.netApr! * 100;
    await ctx.reply(
      [
        `Nenhuma pool de ${chain} sobra mais de ${minApyPct}% ao ano depois do custo.`,
        "",
        `A melhor foi ${melhor.p.symbol} (${melhor.p.project.replace("uniswap-", "uni ")} ${melhor.p.poolMeta ?? "?"}): taxas ${(melhor.m.aprInRange * 100).toFixed(0)}% − custo ${(melhor.m.lvrApr! * 100).toFixed(0)}% = ${liquido > 0 ? "+" : ""}${liquido.toFixed(0)}%/ano.`,
        "",
        liquido > 0
          ? `Pra ver ela e as outras: /yield ${chain}${symbol ? ` ${symbol}` : ""} --min ${Math.max(1, Math.floor(liquido) - 5)}`
          : "Todas custam mais do que pagam agora. Isso acontece quando o mercado está volátil e o volume não acompanha — vale esperar.",
      ].join("\n")
    );
    return;
  }

  const mostradas = acimaDoPiso.slice(0, MAX_RESULTS);

  const linhas = [
    `Pools em ${chain}${symbol ? ` com "${symbol}"` : ""} — quanto SOBRA depois do custo, medido on-chain nos últimos ${MEASURE_WINDOW_DAYS} dias.`,
    "",
    `Referência: $${DEFAULT_REFERENCE.valueToken1.toLocaleString("pt-BR")} numa faixa de ±${LARGURA_PCT}%, enquanto a posição estiver em faixa.`,
    "",
    ...mostradas.map((x, i) => `${i + 1}. ${linhaDePool({ ...x.p, poolId: x.p.pool }, x.m)}`),
    "",
    "O QUE É O CUSTO",
    "Quando o preço se move lá fora, sua pool fica desatualizada e um arbitrador compra dela barato até realinhar. Isso acontece o dia inteiro e cresce com o QUADRADO da volatilidade — por isso par volátil rende mais em taxa e costuma sobrar menos. Detalhe: /explicacoes custo.",
    "",
    "Abrir mais largo NÃO resolve: taxa e custo caem juntos, na mesma proporção. A largura decide quanto tempo você fica em faixa, não se a pool vale a pena.",
    "",
    "MARGEM DE ERRO — leia antes de decidir",
    "O custo depende de σ², então erro na volatilidade dobra aqui. Medindo o mesmo pool com densidades de amostra diferentes, σ variou de 1,8% a 2,2%/dia — o que move o custo em ±25%. Quando taxa e custo estão perto, o SINAL do líquido é incerto: trate como 'empata', não como número exato.",
    "",
    `Não descontado: perda impermanente, gas, e o risco de sair de faixa. E o custo é o limite teórico (supõe arbitragem sem atrito) — o real tende a ser um pouco menor, porque o arbitrador só age quando o desalinhamento passa a taxa da pool.`,
    "",
    `Antes de abrir: /range <id> pra calibrar a faixa pela volatilidade real do par.`,
  ];

  if (semCusto.length > 0) {
    linhas.push("", `Outras ${semCusto.length} pool(s) foram medidas na taxa mas não na volatilidade — sem isso não dá pra estimar o custo, e listar só a receita ao lado de números líquidos compararia coisas diferentes.`);
  }
  if (naoMedidas > 0 || cortadasPorSeguranca > 0) {
    const partes: string[] = [];
    if (naoMedidas > 0) partes.push(`${naoMedidas} não deu pra medir on-chain`);
    if (cortadasPorSeguranca > 0) partes.push(`${cortadasPorSeguranca} cortada(s) por TVL < $${(MIN_TVL_USD / 1e6).toFixed(0)}M ou pico de APY`);
    linhas.push("", `Ficaram de fora: ${partes.join("; ")}.`);
  }

  await ctx.reply(linhas.join("\n"));
}
