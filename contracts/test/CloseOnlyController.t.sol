// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CloseOnlyController} from "../src/CloseOnlyController.sol";
import {INonfungiblePositionManager} from "../src/interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "../src/interfaces/IUniswapV3Factory.sol";

/// @notice Testes contra um FORK real da Arbitrum (roda localmente, nenhuma
/// transação de verdade é enviada) usando uma posição real conhecida da wallet
/// de referência do projeto. Precisa de ARBITRUM_RPC_URL no ambiente.
///
/// Mesma posição do RebalanceController.t.sol de propósito: se os dois
/// contratos divergirem no comportamento contra o MESMO estado real, a
/// diferença é do código, não do cenário.
contract CloseOnlyControllerTest is Test {
    address constant NPM_ADDRESS = 0xC36442b4a4522E871399CD717aBDD847Ab11FE88;
    address constant FACTORY_ADDRESS = 0x1F98431c8aD98523631AE4a59f267346ea31F984;

    // Wallet de referência — posição #430 WETH/LINK 0.3%, em range.
    address constant POSITION_OWNER = 0x4bE3ea1967d4117C93A39048316c058025e237C4;
    uint256 constant TOKEN_ID = 430;

    INonfungiblePositionManager npm;
    CloseOnlyController controller;
    address automationBot = address(0xB07);
    address estranho = address(0xBAD);

    function setUp() public {
        vm.createSelectFork(vm.envString("ARBITRUM_RPC_URL"));

        npm = INonfungiblePositionManager(NPM_ADDRESS);
        controller = new CloseOnlyController({
            _npm: npm,
            _factory: IUniswapV3Factory(FACTORY_ADDRESS),
            _maxTickDeviation: 100,
            _twapWindow: 600,
            _slippageToleranceBps: 200 // 2%
        });

        vm.prank(POSITION_OWNER);
        npm.setApprovalForAll(address(controller), true);

        vm.prank(POSITION_OWNER);
        controller.setAutomationKey(automationBot);
    }

    function _tokens() internal view returns (IERC20 token0, IERC20 token1) {
        (,, address t0, address t1,,,,,,,,) = npm.positions(TOKEN_ID);
        return (IERC20(t0), IERC20(t1));
    }

    // O CONTRATO INTEIRO EXISTE PRA ESTA GARANTIA: o dinheiro só pode ir pro
    // dono da posição. Não há parâmetro de destino, e o contrato nunca custodia.
    function test_close_sendsEverythingToOwnerAndNothingStaysInController() public {
        (IERC20 token0, IERC20 token1) = _tokens();
        uint256 antes0 = token0.balanceOf(POSITION_OWNER);
        uint256 antes1 = token1.balanceOf(POSITION_OWNER);

        vm.prank(automationBot);
        (uint256 amount0, uint256 amount1) = controller.close(TOKEN_ID, block.timestamp + 300);

        assertGt(amount0 + amount1, 0, "fechou sem devolver nada");
        assertEq(token0.balanceOf(POSITION_OWNER) - antes0, amount0, "token0 nao chegou ao dono");
        assertEq(token1.balanceOf(POSITION_OWNER) - antes1, amount1, "token1 nao chegou ao dono");
        assertEq(token0.balanceOf(address(controller)), 0, "sobrou token0 no controller");
        assertEq(token1.balanceOf(address(controller)), 0, "sobrou token1 no controller");

        (,,,,,,, uint128 liquidity,,,,) = npm.positions(TOKEN_ID);
        assertEq(liquidity, 0, "liquidez nao foi zerada");
        assertEq(npm.ownerOf(TOKEN_ID), POSITION_OWNER, "NFT mudou de dono");
    }

    function test_close_ownerCanCloseDirectly() public {
        vm.prank(POSITION_OWNER);
        controller.close(TOKEN_ID, block.timestamp + 300);

        (,,,,,,, uint128 liquidity,,,,) = npm.positions(TOKEN_ID);
        assertEq(liquidity, 0);
    }

    function test_close_revertsForUnauthorizedCaller() public {
        vm.prank(estranho);
        vm.expectRevert(CloseOnlyController.NotAuthorized.selector);
        controller.close(TOKEN_ID, block.timestamp + 300);
    }

    // Botão de pânico que não exige revogar a aprovação do NFT.
    function test_close_revertsWhenUserPaused() public {
        vm.prank(POSITION_OWNER);
        controller.setPaused(true);

        vm.prank(automationBot);
        vm.expectRevert(CloseOnlyController.UserPaused.selector);
        controller.close(TOKEN_ID, block.timestamp + 300);
    }

    // O botão de pânico que SEMPRE funciona: é uma chamada ERC-721 padrão, não
    // depende deste contrato cooperar.
    function test_close_revertsAfterApprovalRevoked() public {
        vm.prank(POSITION_OWNER);
        npm.setApprovalForAll(address(controller), false);

        vm.prank(automationBot);
        vm.expectRevert(CloseOnlyController.ControllerNotApproved.selector);
        controller.close(TOKEN_ID, block.timestamp + 300);
    }

    // Fechar é idempotente: a segunda chamada não tem o que fechar.
    function test_close_revertsOnSecondCall() public {
        vm.prank(automationBot);
        controller.close(TOKEN_ID, block.timestamp + 300);

        vm.prank(automationBot);
        vm.expectRevert(CloseOnlyController.NoLiquidity.selector);
        controller.close(TOKEN_ID, block.timestamp + 300);
    }

    // Chave trocada = chave antiga perde o acesso na hora.
    function test_close_revertsForPreviousAutomationKey() public {
        vm.prank(POSITION_OWNER);
        controller.setAutomationKey(address(0xC0FFEE));

        vm.prank(automationBot);
        vm.expectRevert(CloseOnlyController.NotAuthorized.selector);
        controller.close(TOKEN_ID, block.timestamp + 300);
    }

    // A chave de automação é POR DONO: quem seta a sua não ganha acesso à
    // posição de outra pessoa.
    function test_automationKeyIsScopedPerOwner() public {
        vm.prank(estranho);
        controller.setAutomationKey(estranho);

        vm.prank(estranho);
        vm.expectRevert(CloseOnlyController.NotAuthorized.selector);
        controller.close(TOKEN_ID, block.timestamp + 300);
    }
}
