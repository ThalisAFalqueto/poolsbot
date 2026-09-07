import { and, asc, desc, eq, ilike, not, or, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import {
  closedLpPositions,
  lpPositionIlAlertState,
  lpPositionIlBaseline,
  lpPositions,
  lpPositionState,
  userWallets,
  users,
} from "../schema/index.js";
import { decideBaseline } from "../../domain/lp-rebalance/il-baseline.js";
import type { IlAlertState } from "../../domain/lp-rebalance/evaluate-il-alert.js";
import type { OnchainPosition, PositionState } from "../../domain/lp-rebalance/types.js";

// Uma linha por par (usuário, wallet) — um usuário com N wallets vinculadas
// aparece N vezes. Quem chama agrupa por userId quando precisa processar
// todas as wallets de um usuário de uma vez (ver check-positions.job.ts).
export type UserWalletRow = { userId: number; telegramChatId: string; address: string };

export async function listUserWallets(): Promise<UserWalletRow[]> {
  return db
    .select({ userId: users.id, telegramChatId: users.telegramChatId, address: userWallets.address })
    .from(userWallets)
    .innerJoin(users, eq(userWallets.userId, users.id));
}

export type PositionUpsertInput = {
  userId: number;
  chain: string;
  tokenId: string;
  // tokenId só é único DENTRO de um contrato — o NPM V3 e o PositionManager
  // V4 são contratos diferentes na mesma chain, podem colidir em tokenId
  // (achado real ao dar suporte a V4). Índice único vira (tokenId, chain,
  // protocol) em vez de só (tokenId, chain).
  protocol: string;
  poolAddress: string;
  token0Address: string;
  token1Address: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals: number;
  token1Decimals: number;
  fee: number;
  tickLower: number;
  tickUpper: number;
};

export type UpsertedPosition = { id: number; chain: string; tokenId: string; isNew: boolean };

// Cada posição é resolvida individualmente (select -> branch insert/update)
// em vez de um único onConflictDoUpdate, pra poder criar a linha de estado
// inicial (lpPositionState) só quando a posição é realmente nova, e pra
// devolver `isNew` de forma direta pro chamador. Escala bem = número de
// posições de uma wallet (dezenas, não milhares) por ciclo de 15min.
export async function upsertPositions(inputs: PositionUpsertInput[]): Promise<UpsertedPosition[]> {
  const results: UpsertedPosition[] = [];

  for (const input of inputs) {
    const [existing] = await db
      .select({ id: lpPositions.id })
      .from(lpPositions)
      .where(and(eq(lpPositions.tokenId, input.tokenId), eq(lpPositions.chain, input.chain), eq(lpPositions.protocol, input.protocol)))
      .limit(1);

    if (existing) {
      await db
        .update(lpPositions)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(lpPositions.id, existing.id));
      results.push({ id: existing.id, chain: input.chain, tokenId: input.tokenId, isNew: false });
      continue;
    }

    const [inserted] = await db.insert(lpPositions).values(input).returning({ id: lpPositions.id });
    if (inserted) {
      await db.insert(lpPositionState).values({ lpPositionId: inserted.id, status: "in_range" });
      results.push({ id: inserted.id, chain: input.chain, tokenId: input.tokenId, isNew: true });
    }
  }

  return results;
}

// Todo token que o usuário já teve numa pool nesta chain — ativa ou fechada.
// É a base da allowlist que protege o NAV de airdrop de scam (ver
// domain/portfolio/token-allowlist.ts): token que nunca passou por uma
// posição sua não entra no patrimônio.
export async function listKnownTokenAddresses(userId: number, chain: string): Promise<string[]> {
  const active = await db
    .select({ token0: lpPositions.token0Address, token1: lpPositions.token1Address })
    .from(lpPositions)
    .where(and(eq(lpPositions.userId, userId), eq(lpPositions.chain, chain)));
  // closed_lp_positions só guarda token1Address (o token0 nunca foi
  // necessário lá) — ainda assim entra, pra não perder a moeda de cotação de
  // uma posição encerrada cujo par não existe mais entre as ativas.
  const closed = await db
    .select({ token1: closedLpPositions.token1Address })
    .from(closedLpPositions)
    .where(and(eq(closedLpPositions.userId, userId), eq(closedLpPositions.chain, chain)));

  const tokens = new Set<string>();
  for (const row of active) {
    tokens.add(row.token0.toLowerCase());
    tokens.add(row.token1.toLowerCase());
  }
  for (const row of closed) tokens.add(row.token1.toLowerCase());
  return [...tokens];
}

// Pares (por SÍMBOLO) que o usuário tem ou já teve em posição — base do
// acompanhamento automático na comparação entre chains. Símbolo, e não
// endereço, porque a comparação é cross-chain: o mesmo token tem contrato
// diferente em cada chain (ver domain/market/pair-compare.ts).
export async function listPositionPairSymbols(userId: number): Promise<string[]> {
  const active = await db
    .select({ t0: lpPositions.token0Symbol, t1: lpPositions.token1Symbol })
    .from(lpPositions)
    .where(eq(lpPositions.userId, userId));
  const closed = await db
    .select({ t0: closedLpPositions.token0Symbol, t1: closedLpPositions.token1Symbol })
    .from(closedLpPositions)
    .where(eq(closedLpPositions.userId, userId));

  const pairs = new Set<string>();
  for (const r of [...active, ...closed]) pairs.add(`${r.t0}-${r.t1}`);
  return [...pairs];
}

export type PositionSnapshot = {
  entryValueToken1: number;
  positionValueToken1: number;
  feesValueToken1: number;
  hodlValueToken1: number;
  ilToken1: number;
  totalPnlToken1: number;
  entryDate: Date;
};

// Grava o "último P&L conhecido" — chamado só pelo /positions (não pelo job
// de 15min, que não busca fees por custo de RPC extra por posição). É essa
// gravação que permite arquivar a posição quando ela fechar (ver
// archiveAndDeleteStalePositions abaixo); sem nenhum /positions rodado
// antes do fechamento, não há o que arquivar.
export async function updatePositionSnapshot(lpPositionId: number, snapshot: PositionSnapshot): Promise<void> {
  await db
    .update(lpPositions)
    .set({
      lastKnownEntryValueToken1: snapshot.entryValueToken1,
      lastKnownPositionValueToken1: snapshot.positionValueToken1,
      lastKnownFeesValueToken1: snapshot.feesValueToken1,
      lastKnownHodlValueToken1: snapshot.hodlValueToken1,
      lastKnownIlToken1: snapshot.ilToken1,
      lastKnownTotalPnlToken1: snapshot.totalPnlToken1,
      lastKnownEntryDate: snapshot.entryDate,
      lastSnapshotAt: new Date(),
    })
    .where(eq(lpPositions.id, lpPositionId));
}

// Grava o custo REAL de gas do mint (não estimativa) — chamado 1x, no
// momento em que upsertPositions sinaliza isNew=true (ver findMintGasCost
// em data/onchain/position-gas.ts).
export async function setMintGas(lpPositionId: number, mintGas: { gasNative: number; txHash: string }): Promise<void> {
  await db
    .update(lpPositions)
    .set({ mintGasNative: mintGas.gasNative, mintGasTxHash: mintGas.txHash })
    .where(eq(lpPositions.id, lpPositionId));
}

export type StalePositionCandidate = typeof lpPositions.$inferSelect;

// Identidade COMPLETA de uma posição dentro de uma chain. tokenId sozinho não
// basta: ele só é único DENTRO de um contrato, e o NPM do V3 e o
// PositionManager do V4 numeram de forma independente (mesma razão de o índice
// único ser (tokenId, chain, protocol), ver schema/index.ts).
export type ActivePositionKey = { tokenId: string; protocol: string };

// Casar staleness só por tokenId (como era antes) deixava uma posição ATIVA de
// um protocolo "proteger" uma posição JÁ FECHADA do outro protocolo com o
// mesmo tokenId: ela nunca seria detectada como stale, nunca seria arquivada
// em closed_lp_positions e ficaria pra sempre no banco. Comparar o par
// (tokenId, protocol) elimina isso.
function stalePositionsWhere(userId: number, chain: string, active: ActivePositionKey[]): SQL | undefined {
  const scope = and(eq(lpPositions.userId, userId), eq(lpPositions.chain, chain));
  if (active.length === 0) return scope; // nada ativo on-chain: tudo que estiver no banco é stale

  const matchesSomeActive = or(
    ...active.map((p) => and(eq(lpPositions.tokenId, p.tokenId), eq(lpPositions.protocol, p.protocol)))
  );
  return and(scope, not(matchesSomeActive!));
}

// SELECT puro (sem decidir nem escrever nada) — quem chama decide o que
// fazer com cada candidato ANTES de arquivar/deletar. Existe separado de
// archiveStalePositions/deleteStalePositions porque o gas de fechamento
// precisa de uma chamada RPC (data/onchain/position-gas.ts) que não pode
// acontecer dentro do repositório (repositório é só banco) — o chamador
// (check-positions.job.ts) busca o gas de close PRA CADA CANDIDATO entre
// esse SELECT e a chamada de archiveStalePositions.
export async function listStalePositionCandidates(
  userId: number,
  chain: string,
  active: ActivePositionKey[]
): Promise<StalePositionCandidate[]> {
  return db.select().from(lpPositions).where(stalePositionsWhere(userId, chain, active));
}

// Mesmo critério de "tem snapshot completo pra arquivar" de sempre —
// exportado pra quem chama poder decidir se vale a pena gastar uma chamada
// RPC buscando o gas de close pra esse candidato específico (sem snapshot,
// ele não vai ser arquivado de qualquer forma).
export function hasCompleteSnapshot(
  p: StalePositionCandidate
): p is StalePositionCandidate & { lastSnapshotAt: Date; lastKnownEntryDate: Date } {
  return (
    p.lastSnapshotAt !== null &&
    p.lastKnownEntryValueToken1 !== null &&
    p.lastKnownPositionValueToken1 !== null &&
    p.lastKnownFeesValueToken1 !== null &&
    p.lastKnownHodlValueToken1 !== null &&
    p.lastKnownIlToken1 !== null &&
    p.lastKnownTotalPnlToken1 !== null &&
    p.lastKnownEntryDate !== null
  );
}

export type CloseGasResult = { closeGasNative: number; closeGasTxHashes: string[] };

// Arquiva em closed_lp_positions qualquer candidato com snapshot completo
// (ver hasCompleteSnapshot) — sem isso, fechar uma posição apagava todo o
// histórico dela (achado real, 21/08/2026: usuário ia fechar a posição
// WBTC/USDC real e perder IL/fees/P&L acumulados sem nenhum rastro).
// closeGasByPositionId é opcional por posição — nem toda posição tem gas de
// close encontrado (ver findCloseGasCost), e isso não impede o arquivamento
// do resto do P&L. Desde o upgrade da Alchemy pra Pay As You Go (range
// ilimitado de eth_getLogs, 23/08/2026), essa busca é rápida — quem chama
// já espera (await) o resultado antes de arquivar, sem precisar de nenhum
// mecanismo de preenchimento posterior.
export async function archiveStalePositions(
  candidates: StalePositionCandidate[],
  closeGasByPositionId: Map<number, CloseGasResult>,
  nativeGasSymbol: string
): Promise<void> {
  const toArchive = candidates.filter(hasCompleteSnapshot);
  if (toArchive.length === 0) return;

  await db.insert(closedLpPositions).values(
    toArchive.map((p) => {
      const closeGas = closeGasByPositionId.get(p.id);
      return {
        userId: p.userId,
        chain: p.chain,
        tokenId: p.tokenId,
        protocol: p.protocol,
        label: p.label,
        token0Symbol: p.token0Symbol,
        token1Symbol: p.token1Symbol,
        token1Address: p.token1Address,
        openedAt: p.lastKnownEntryDate,
        entryValueToken1: p.lastKnownEntryValueToken1!,
        finalPositionValueToken1: p.lastKnownPositionValueToken1!,
        finalFeesValueToken1: p.lastKnownFeesValueToken1!,
        hodlValueToken1: p.lastKnownHodlValueToken1!,
        ilToken1: p.lastKnownIlToken1!,
        totalPnlToken1: p.lastKnownTotalPnlToken1!,
        mintGasNative: p.mintGasNative,
        mintGasTxHash: p.mintGasTxHash,
        closeGasNative: closeGas?.closeGasNative ?? null,
        closeGasTxHashes: closeGas ? closeGas.closeGasTxHashes.join(",") : null,
        nativeGasSymbol,
      };
    })
  );
}

// Reconciliação: remove qualquer posição do usuário/chain cujo tokenId não
// esteja mais no conjunto ativo on-chain (fechada ou transferida pra outra
// wallet) — cascade limpa lp_position_state junto. Deleta TODAS as stale
// (arquivadas ou não em archiveStalePositions) — mesmo comportamento de
// sempre, só separado em função própria pra caber a etapa de gas de close
// no meio do fluxo (ver listStalePositionCandidates acima).
export async function deleteStalePositions(userId: number, chain: string, active: ActivePositionKey[]): Promise<void> {
  await db.delete(lpPositions).where(stalePositionsWhere(userId, chain, active));
}

// Escreve o apelido — ÚNICO lugar que deveria tocar essa coluna (ver
// comentário em schema/index.ts sobre por que não pode entrar em
// PositionUpsertInput). O identificador que o usuário digita é só o tokenId,
// que NÃO é único sozinho (pode repetir entre chains e entre protocolos V3/V4
// — ver ActivePositionKey acima), então atualiza todas as linhas que baterem e
// devolve QUANTAS foram: quem chama avisa o usuário quando for mais de uma, em
// vez de fingir que rotulou exatamente a que ele queria.
export async function setPositionLabel(userId: number, tokenId: string, label: string): Promise<number> {
  const updated = await db
    .update(lpPositions)
    .set({ label, updatedAt: new Date() })
    .where(and(eq(lpPositions.userId, userId), eq(lpPositions.tokenId, tokenId)))
    .returning({ id: lpPositions.id });
  return updated.length;
}

export type PositionRef = { id: number; tokenId: string; chain: string; protocol: string };

const POSITION_REF_COLS = {
  id: lpPositions.id,
  tokenId: lpPositions.tokenId,
  chain: lpPositions.chain,
  protocol: lpPositions.protocol,
};

// Tenta achar por apelido primeiro (case-insensitive), senão trata o
// identificador como tokenId cru. null se não achar dos dois jeitos.
// `orderBy(id)` não é decoração: sem ordem explícita, um identificador ambíguo
// (mesmo tokenId em 2 chains, ou em V3 e V4) faria o Postgres devolver
// qualquer uma das linhas, e o /graph podia plotar uma posição diferente a
// cada chamada com o mesmo comando. Com a ordem fixa, pelo menos é sempre a
// mesma (a mais antiga) — e `protocol` volta junto pra quem chama poder
// mostrar de qual se trata.
export async function findPositionByLabelOrTokenId(userId: number, identifier: string): Promise<PositionRef | null> {
  const [byLabel] = await db
    .select(POSITION_REF_COLS)
    .from(lpPositions)
    .where(and(eq(lpPositions.userId, userId), ilike(lpPositions.label, identifier)))
    .orderBy(asc(lpPositions.id))
    .limit(1);
  if (byLabel) return byLabel;

  const [byTokenId] = await db
    .select(POSITION_REF_COLS)
    .from(lpPositions)
    .where(and(eq(lpPositions.userId, userId), eq(lpPositions.tokenId, identifier)))
    .orderBy(asc(lpPositions.id))
    .limit(1);
  return byTokenId ?? null;
}

// Lista todas as posições do usuário — usado por /graph sem argumento, pra
// decidir entre "usa a única" e "pede pra especificar" sem precisar de outra
// função inteira só pra contar.
export async function listPositionRefs(userId: number): Promise<PositionRef[]> {
  return db.select(POSITION_REF_COLS).from(lpPositions).where(eq(lpPositions.userId, userId)).orderBy(asc(lpPositions.id));
}

export async function getPositionState(lpPositionId: number): Promise<PositionState> {
  const [row] = await db
    .select()
    .from(lpPositionState)
    .where(eq(lpPositionState.lpPositionId, lpPositionId))
    .limit(1);
  if (!row) {
    throw new Error(`Estado não encontrado pra posição ${lpPositionId}`);
  }
  return { status: row.status, outOfRangeSince: row.outOfRangeSince, lastNotifiedAt: row.lastNotifiedAt };
}

export async function updatePositionState(lpPositionId: number, next: PositionState): Promise<void> {
  await db
    .update(lpPositionState)
    .set({
      status: next.status,
      outOfRangeSince: next.outOfRangeSince,
      lastNotifiedAt: next.lastNotifiedAt,
      updatedAt: new Date(),
    })
    .where(eq(lpPositionState.lpPositionId, lpPositionId));
}

// Helper compartilhado entre check-positions.job.ts e bot/commands/positions.ts,
// pra não duplicar a montagem do PositionUpsertInput nos dois call sites.
export function toPositionUpsertInput(userId: number, chain: string, p: OnchainPosition): PositionUpsertInput {
  return {
    userId,
    chain,
    tokenId: p.tokenId.toString(),
    protocol: p.protocol,
    poolAddress: p.poolAddress,
    token0Address: p.token0.address,
    token1Address: p.token1.address,
    token0Symbol: p.token0.symbol,
    token1Symbol: p.token1.symbol,
    token0Decimals: p.token0.decimals,
    token1Decimals: p.token1.decimals,
    fee: p.fee,
    tickLower: p.tickLower,
    tickUpper: p.tickUpper,
  };
}

export type IlBaseline = { liquidity: bigint; sqrtPriceX96: bigint; tick: number; recordedAt: Date; wasReset: boolean };

export async function getIlBaseline(lpPositionId: number): Promise<IlBaseline | null> {
  const [row] = await db
    .select()
    .from(lpPositionIlBaseline)
    .where(eq(lpPositionIlBaseline.lpPositionId, lpPositionId))
    .limit(1);
  if (!row) return null;
  return {
    liquidity: BigInt(row.liquidity),
    sqrtPriceX96: BigInt(row.sqrtPriceX96),
    tick: row.tick,
    recordedAt: row.recordedAt,
    wasReset: row.wasReset,
  };
}

// Lê o baseline existente, decide via decideBaseline (domínio puro), e grava
// create/reset quando necessário. Deve ser chamado pra TODA posição em todo
// ciclo (não só quando há notificação) — senão uma mudança de liquidez numa
// posição que continua in-range nunca seria detectada.
export async function syncIlBaseline(
  lpPositionId: number,
  current: { liquidity: bigint; sqrtPriceX96: bigint; tick: number }
): Promise<IlBaseline> {
  const existing = await getIlBaseline(lpPositionId);
  const action = decideBaseline(existing?.liquidity ?? null, current.liquidity);
  if (action === "keep" && existing) return existing;

  const wasReset = action === "reset";
  const recordedAt = new Date();
  const values = {
    lpPositionId,
    liquidity: current.liquidity.toString(),
    sqrtPriceX96: current.sqrtPriceX96.toString(),
    tick: current.tick,
    wasReset,
    recordedAt,
  };

  await db
    .insert(lpPositionIlBaseline)
    .values(values)
    .onConflictDoUpdate({ target: lpPositionIlBaseline.lpPositionId, set: values });

  return { liquidity: current.liquidity, sqrtPriceX96: current.sqrtPriceX96, tick: current.tick, recordedAt, wasReset };
}

const DEFAULT_IL_ALERT_STATE: IlAlertState = { status: "ok", triggeredAt: null, lastNotifiedAt: null };

// Diferente de lp_position_state (sempre criado junto com a posição em
// upsertPositions), o estado de alerta de IL não tem uma linha garantida —
// retorna o default "ok" se ainda não foi avaliado nenhuma vez.
export async function getIlAlertState(lpPositionId: number): Promise<IlAlertState> {
  const [row] = await db
    .select()
    .from(lpPositionIlAlertState)
    .where(eq(lpPositionIlAlertState.lpPositionId, lpPositionId))
    .limit(1);
  if (!row) return DEFAULT_IL_ALERT_STATE;
  return { status: row.status, triggeredAt: row.triggeredAt, lastNotifiedAt: row.lastNotifiedAt };
}

export async function updateIlAlertState(lpPositionId: number, next: IlAlertState): Promise<void> {
  const values = {
    lpPositionId,
    status: next.status,
    triggeredAt: next.triggeredAt,
    lastNotifiedAt: next.lastNotifiedAt,
    updatedAt: new Date(),
  };
  await db
    .insert(lpPositionIlAlertState)
    .values(values)
    .onConflictDoUpdate({ target: lpPositionIlAlertState.lpPositionId, set: values });
}

export type ClosedPositionRow = {
  chain: string;
  tokenId: string;
  protocol: string;
  label: string | null;
  token0Symbol: string;
  token1Symbol: string;
  token1Address: string;
  openedAt: Date;
  closedAt: Date;
  entryValueToken1: number;
  finalPositionValueToken1: number;
  finalFeesValueToken1: number;
  hodlValueToken1: number;
  ilToken1: number;
  totalPnlToken1: number;
  mintGasNative: number | null;
  mintGasTxHash: string | null;
  closeGasNative: number | null;
  closeGasTxHashes: string | null;
  nativeGasSymbol: string | null;
};

export async function listClosedPositions(userId: number): Promise<ClosedPositionRow[]> {
  return db
    .select({
      chain: closedLpPositions.chain,
      tokenId: closedLpPositions.tokenId,
      protocol: closedLpPositions.protocol,
      label: closedLpPositions.label,
      token0Symbol: closedLpPositions.token0Symbol,
      token1Symbol: closedLpPositions.token1Symbol,
      token1Address: closedLpPositions.token1Address,
      openedAt: closedLpPositions.openedAt,
      closedAt: closedLpPositions.closedAt,
      entryValueToken1: closedLpPositions.entryValueToken1,
      finalPositionValueToken1: closedLpPositions.finalPositionValueToken1,
      finalFeesValueToken1: closedLpPositions.finalFeesValueToken1,
      hodlValueToken1: closedLpPositions.hodlValueToken1,
      ilToken1: closedLpPositions.ilToken1,
      totalPnlToken1: closedLpPositions.totalPnlToken1,
      mintGasNative: closedLpPositions.mintGasNative,
      mintGasTxHash: closedLpPositions.mintGasTxHash,
      closeGasNative: closedLpPositions.closeGasNative,
      closeGasTxHashes: closedLpPositions.closeGasTxHashes,
      nativeGasSymbol: closedLpPositions.nativeGasSymbol,
    })
    .from(closedLpPositions)
    .where(eq(closedLpPositions.userId, userId))
    .orderBy(desc(closedLpPositions.closedAt));
}

// ---------------------------------------------------------------------
// Aviso de aproximação da borda. Cadência PRÓPRIA, separada de
// lastNotifiedAt: são dois eventos diferentes (chegando na borda vs já fora),
// e dividir o mesmo relógio faria um silenciar o outro.

export async function getNearEdgeNotifiedAt(lpPositionId: number): Promise<Date | null> {
  const [row] = await db
    .select({ at: lpPositionState.nearEdgeNotifiedAt })
    .from(lpPositionState)
    .where(eq(lpPositionState.lpPositionId, lpPositionId))
    .limit(1);
  return row?.at ?? null;
}

export async function setNearEdgeNotifiedAt(lpPositionId: number, at: Date | null): Promise<void> {
  await db.update(lpPositionState).set({ nearEdgeNotifiedAt: at }).where(eq(lpPositionState.lpPositionId, lpPositionId));
}
