// Fragmentos escritos à mão, só com o que o bot usa — mesmo padrão de
// abis.ts (V3). Não traz @uniswap/v4-periphery como dependência, mesma
// razão já documentada em price-math.ts pra não trazer @uniswap/v3-sdk
// (arrasta ethers.js, conflita com viem).
//
// Uniswap V4 usa 1 contrato SINGLETON (PoolManager) pra todos os pools, em
// vez de 1 contrato por pool como o V3 — por isso não existe um
// "uniswapV4PoolAbi" equivalente ao uniswapV3PoolAbi: o estado do pool é
// lido via StateView (lens read-only), chaveado por PoolId (hash do
// PoolKey), não por endereço de contrato próprio.
export const uniswapV4PositionManagerAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    // ATENÇÃO: o PositionManager do V4 NÃO é ERC721Enumerable (confirmado
    // ao vivo: tokenOfOwnerByIndex reverte) — balanceOf funciona, mas achar
    // QUAIS tokenIds exige escanear eventos Transfer (ver client-v4.ts),
    // não iterar por índice como o NPM do V3.
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    // PoolKey = {currency0, currency1, fee, tickSpacing, hooks}. info é um
    // uint256 compactado (tickLower/tickUpper bit-packed) — decodificar via
    // decodePositionInfo em domain/lp-rebalance/position-info-v4.ts, não é
    // uma tupla como o positions() do V3.
    type: "function",
    name: "getPoolAndPositionInfo",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "info", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getPositionLiquidity",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "uint128" }],
  },
  {
    // Padrão ERC-721 — usado pra achar tokenIds via eth_getLogs (tokenId é
    // "id", indexado), já que não dá pra enumerar por índice.
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "id", type: "uint256", indexed: true },
    ],
  },
] as const;

// Lens read-only "for offchain clients" (NatSpec do próprio contrato) —
// equivalente ao slot0()/positions() do pool V3, mas contra o PoolManager
// singleton via PoolId em vez de ler um contrato de pool próprio.
export const uniswapV4StateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
  {
    type: "function",
    name: "getPositionInfo",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "positionId", type: "bytes32" },
    ],
    outputs: [
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
    ],
  },
  {
    // Recalculado ao vivo (diferente do getPositionInfo, que devolve o
    // último valor GRAVADO na posição) — a diferença entre os dois, vezes a
    // liquidez, é a fee não-coletada (mesma matemática Q128 do V3).
    type: "function",
    name: "getFeeGrowthInside",
    stateMutability: "view",
    inputs: [
      { name: "poolId", type: "bytes32" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
    ],
    outputs: [
      { name: "feeGrowthInside0X128", type: "uint256" },
      { name: "feeGrowthInside1X128", type: "uint256" },
    ],
  },
] as const;
