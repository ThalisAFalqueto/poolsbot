// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ABI mínimo do pool Uniswap V3 — só slot0() (preço/tick atual) e
/// observe() (oráculo TWAP, já embutido no próprio pool desde o V3, sem
/// contrato de oráculo externo).
interface IUniswapV3Pool {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}
