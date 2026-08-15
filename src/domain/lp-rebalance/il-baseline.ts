export type BaselineAction = "create" | "reset" | "keep";

// Comparação pura, testável sem banco — a orquestração (ler/gravar) mora no
// repositório, mesmo padrão de evaluatePosition (domínio puro) vs.
// updatePositionState (repositório) já usado no v3.
export function decideBaseline(existingLiquidity: bigint | null, currentLiquidity: bigint): BaselineAction {
  if (existingLiquidity === null) return "create";
  if (existingLiquidity !== currentLiquidity) return "reset";
  return "keep";
}
