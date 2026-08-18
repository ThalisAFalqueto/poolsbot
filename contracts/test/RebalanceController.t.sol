// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {RebalanceController} from "../src/RebalanceController.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3Factory.sol";

interface IUniswapV3PoolSwap {
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
}

/// @notice Testes contra um FORK real da Arbitrum (não mainnet-affecting —
/// roda localmente, nenhuma transação de verdade é enviada) usando uma
/// posição real conhecida da wallet de referência do projeto (ver memória
/// reference_test_wallet). Precisa de ARBITRUM_RPC_URL no ambiente.
contract RebalanceControllerTest is Test {
    address constant NPM_ADDRESS = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant FACTORY_ADDRESS = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

    // Wallet de referência (ver memória reference_test_wallet) — posição
    // #430 WETH/LINK 0.3%, tickLower=41280, tickUpper=55140, em range.
    address constant POSITION_OWNER = 0x4bE3ea1967d4117C93A39048316c058025e237C4;
    uint256 constant TOKEN_ID = 430;
    int24 constant OLD_TICK_LOWER = 41280;
    int24 constant OLD_TICK_UPPER = 55140;

    INonfungiblePositionManager npm;
    RebalanceController controller;
    address automationBot = address(0xB07);

    function setUp() public {
        vm.createSelectFork(vm.envString("ARBITRUM_RPC_URL"));

        npm = INonfungiblePositionManager(NPM_ADDRESS);
        controller = new RebalanceController({
            _npm: npm,
            _factory: IUniswapV3Factory(FACTORY_ADDRESS),
            _minRebalanceInterval: 1 hours,
            _maxTickDeviation: 500,
            _twapWindow: 600
        });

        vm.prank(POSITION_OWNER);
        npm.setApprovalForAll(address(controller), true);

        vm.prank(POSITION_OWNER);
        controller.setAutomationKey(automationBot);
    }

    function test_rebalance_movesLiquidityToNewRangeOwnedByOriginalOwner() public {
        int24 newTickLower = OLD_TICK_LOWER + 60;
        int24 newTickUpper = OLD_TICK_UPPER + 60;

        vm.prank(automationBot);
        uint256 newTokenId = controller.rebalance({
            tokenId: TOKEN_ID,
            newTickLower: newTickLower,
            newTickUpper: newTickUpper,
            amount0Min: 1,
            amount1Min: 1,
            deadline: block.timestamp + 1
        });

        assertEq(npm.ownerOf(newTokenId), POSITION_OWNER, "nova posicao deveria ir direto pro dono original");

        (,,,,, int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) = npm.positions(newTokenId);
        assertEq(tickLower, newTickLower);
        assertEq(tickUpper, newTickUpper);
        assertGt(liquidity, 0, "nova posicao deveria ter liquidez > 0");

        // posição antiga foi fechada (burn) — ownerOf deve reverter
        vm.expectRevert();
        npm.ownerOf(TOKEN_ID);
    }

    function test_rebalance_revertsWhenCalledTooSoonAgain() public {
        vm.prank(automationBot);
        uint256 newTokenId = controller.rebalance(TOKEN_ID, OLD_TICK_LOWER + 60, OLD_TICK_UPPER + 60, 1, 1, block.timestamp + 1);

        vm.prank(POSITION_OWNER);
        npm.setApprovalForAll(address(controller), true); // aprovação é por dono, já vale pra nova posição também

        vm.prank(automationBot);
        vm.expectRevert(RebalanceController.CooldownActive.selector);
        controller.rebalance(newTokenId, OLD_TICK_LOWER + 120, OLD_TICK_UPPER + 120, 1, 1, block.timestamp + 1);
    }

    function test_rebalance_revertsWhenUserPaused() public {
        vm.prank(POSITION_OWNER);
        controller.setPaused(true);

        vm.prank(automationBot);
        vm.expectRevert(RebalanceController.UserPaused.selector);
        controller.rebalance(TOKEN_ID, OLD_TICK_LOWER + 60, OLD_TICK_UPPER + 60, 1, 1, block.timestamp + 1);
    }

    function test_rebalance_revertsForUnauthorizedCaller() public {
        address stranger = address(0xBAD);
        vm.prank(stranger);
        vm.expectRevert(RebalanceController.NotAuthorized.selector);
        controller.rebalance(TOKEN_ID, OLD_TICK_LOWER + 60, OLD_TICK_UPPER + 60, 1, 1, block.timestamp + 1);
    }

    function test_rebalance_revertsWithZeroMinAmounts() public {
        vm.prank(automationBot);
        vm.expectRevert(RebalanceController.ZeroMinAmount.selector);
        controller.rebalance(TOKEN_ID, OLD_TICK_LOWER + 60, OLD_TICK_UPPER + 60, 0, 1, block.timestamp + 1);
    }

    function test_revokeApproval_blocksFutureRebalance() public {
        vm.prank(POSITION_OWNER);
        npm.setApprovalForAll(address(controller), false); // "botão de pânico" nativo do ERC-721

        vm.prank(automationBot);
        vm.expectRevert(RebalanceController.ControllerNotApproved.selector);
        controller.rebalance(TOKEN_ID, OLD_TICK_LOWER + 60, OLD_TICK_UPPER + 60, 1, 1, block.timestamp + 1);
    }

    // Constante conhecida do Uniswap V3 core (TickMath.MIN_SQRT_RATIO + 1) —
    // limite mais permissivo possível pro swap, só pra garantir que a
    // ordem de grandeza usada abaixo realmente move o preço bastante.
    uint160 constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;

    /// @notice Prova que a proteção de TWAP funciona de verdade: sem um
    /// swap grande antes, o rebalance passa normal (já provado no teste
    /// principal); com um swap grande movendo o spot pra longe do TWAP
    /// (mesma janela de 10min, então o TWAP mal se move), o rebalance
    /// precisa reverter.
    function test_rebalance_revertsWhenPriceManipulated() public {
        (,, address token0, address token1, uint24 fee,,,,,,,) = npm.positions(TOKEN_ID);
        address pool = IUniswapV3Factory(FACTORY_ADDRESS).getPool(token0, token1, fee);

        // financia este contrato de teste com bastante token0 e faz um
        // swap gigante — empurra o preço spot longe do TWAP dos últimos 10min.
        deal(token0, address(this), 1_000_000 ether);
        IUniswapV3PoolSwap(pool).swap(address(this), true, 1_000_000 ether, MIN_SQRT_RATIO_PLUS_ONE, "");

        vm.prank(automationBot);
        vm.expectRevert(RebalanceController.PriceDeviationTooHigh.selector);
        controller.rebalance(TOKEN_ID, OLD_TICK_LOWER + 60, OLD_TICK_UPPER + 60, 1, 1, block.timestamp + 1);
    }

    /// @dev Callback exigido pelo Uniswap V3 durante swap() — paga o token
    /// devido de volta pro pool.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        (,, address token0, address token1,,,,,,,,) = npm.positions(TOKEN_ID);
        if (amount0Delta > 0) IERC20(token0).transfer(msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) IERC20(token1).transfer(msg.sender, uint256(amount1Delta));
    }

    function test_ownerCanAlwaysCallDirectly() public {
        vm.prank(POSITION_OWNER);
        uint256 newTokenId = controller.rebalance(TOKEN_ID, OLD_TICK_LOWER + 60, OLD_TICK_UPPER + 60, 1, 1, block.timestamp + 1);
        assertEq(npm.ownerOf(newTokenId), POSITION_OWNER);
    }
}
