// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "./vendor/TickMath.sol";
import {LiquidityAmounts} from "./vendor/LiquidityAmounts.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";

// Nota de licença: TickMath e LiquidityAmounts (Uniswap Labs) são
// GPL-2.0-or-later, diferente da licença MIT deste arquivo. Ver a mesma nota
// em RebalanceController.sol.

/// @title CloseOnlyController
/// @notice RASCUNHO PARA TESTNET — não auditado, não usar com fundos reais.
///
/// Fecha posições Uniswap V3 em nome do dono, e SÓ ISSO. Não abre posição, não
/// rebalanceia, não transfere pra lugar nenhum além da wallet do dono.
///
/// POR QUE ESTE CONTRATO EXISTE, separado do RebalanceController.
///
/// Fechar é literalmente a primeira metade do `rebalance()` — remover liquidez
/// e coletar. Daria pra ser mais uma função lá. Não é, de propósito:
/// `setApprovalForAll` entrega controle de TODAS as posições Uniswap do dono ao
/// contrato aprovado. Aprovar um contrato que só sabe fechar é categoricamente
/// diferente de aprovar um que também sabe abrir posição em ticks arbitrários.
///
/// A garantia fica ESTRUTURAL (não existe código de mint aqui) em vez de
/// configurável. Foi um pedido explícito do usuário: "impossibilito que o bot
/// faça uma pool nova, liberando ele apenas pra encerrar".
///
/// COMO O DONO MANTÉM O CONTROLE
///
///   1. `setApprovalForAll` no NonfungiblePositionManager é o que liga. Revogar
///      é uma chamada ERC-721 padrão, que NÃO depende deste contrato cooperar —
///      é o botão de pânico que sempre funciona.
///   2. `setAutomationKey` designa a chave operacional do bot, separada da
///      wallet do dono e sem valor nenhum nela.
///   3. `setPaused` desliga na hora, sem mexer na aprovação.
///
/// O QUE UMA CHAVE DE AUTOMAÇÃO COMPROMETIDA CONSEGUE FAZER
///
/// Fechar suas posições na hora errada. Não consegue roubar: o destino do
/// `collect` é `npm.ownerOf(tokenId)`, lido do contrato na hora, nunca um
/// parâmetro. É prejuízo possível, roubo não.
///
/// LIMITAÇÃO CONHECIDA, a mesma do RebalanceController: a checagem de TWAP
/// impede usar um preço manipulado como referência do `amountMin`, mas não
/// impede a transação em si de ser vista e sanduichada num mempool público.
/// Isso depende de COMO o executor envia a transação (mempool privado), não do
/// contrato.
contract CloseOnlyController is ReentrancyGuard {
    INonfungiblePositionManager public immutable npm;
    IUniswapV3Factory public immutable factory;

    /// @notice Desvio máximo (em ticks) entre o tick atual e o TWAP antes de
    /// recusar o fechamento — sinal de manipulação de preço em andamento.
    /// ~100 ticks ≈ 1%.
    int24 public immutable maxTickDeviation;

    /// @notice Janela do TWAP (segundos) usada na checagem acima.
    uint32 public immutable twapWindow;

    /// @notice Tolerância de slippage (bps, 10_000 = 100%) aplicada ao valor
    /// esperado da remoção de liquidez, calculado a partir do preço do TWAP.
    uint256 public immutable slippageToleranceBps;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    mapping(address user => address automationKey) public automationKeyOf;
    mapping(address user => bool isPaused) public paused;

    event AutomationKeySet(address indexed user, address indexed automationKey);
    event PausedSet(address indexed user, bool isPaused);
    event Closed(
        address indexed owner, uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1
    );

    error NotAuthorized();
    error UserPaused();
    error ControllerNotApproved();
    error NoLiquidity();
    error PriceDeviationTooHigh();
    error InsufficientPriceHistory();

    constructor(
        INonfungiblePositionManager _npm,
        IUniswapV3Factory _factory,
        int24 _maxTickDeviation,
        uint32 _twapWindow,
        uint256 _slippageToleranceBps
    ) {
        npm = _npm;
        factory = _factory;
        maxTickDeviation = _maxTickDeviation;
        twapWindow = _twapWindow;
        slippageToleranceBps = _slippageToleranceBps;
    }

    /// @notice Define (ou troca) o endereço autorizado a chamar `close()` em
    /// nome de quem chama. Só o próprio dono seta o seu.
    function setAutomationKey(address automationKey) external {
        automationKeyOf[msg.sender] = automationKey;
        emit AutomationKeySet(msg.sender, automationKey);
    }

    /// @notice Pausa/despausa a automação de quem chama — efeito imediato, sem
    /// precisar revogar a aprovação do NFT.
    function setPaused(bool isPaused) external {
        paused[msg.sender] = isPaused;
        emit PausedSet(msg.sender, isPaused);
    }

    /// @notice Remove TODA a liquidez de `tokenId` e manda os tokens (mais as
    /// taxas acumuladas) direto pro dono da posição.
    ///
    /// Não há cooldown aqui, ao contrário do rebalance: fechar é idempotente —
    /// depois de fechada não sobra liquidez, e a segunda chamada reverte em
    /// `NoLiquidity`. Cooldown não protegeria de nada.
    ///
    /// O NFT não é queimado. Queimar adiciona superfície (mais uma chamada
    /// externa, mais um estado a considerar) sem ganho: um NFT vazio não
    /// representa capital em risco, e o dono queima quando quiser.
    function close(uint256 tokenId, uint256 deadline) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        address owner = npm.ownerOf(tokenId);
        if (msg.sender != owner && msg.sender != automationKeyOf[owner]) revert NotAuthorized();
        if (paused[owner]) revert UserPaused();
        if (!npm.isApprovedForAll(owner, address(this))) revert ControllerNotApproved();

        (,, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity,,,,) =
            npm.positions(tokenId);
        if (liquidity == 0) revert NoLiquidity();

        int24 twapTick = _checkPriceNotManipulated(factory.getPool(token0, token1, fee));

        // amountMin calculado a partir do preço validado por TWAP, nunca
        // recebido como parâmetro. Se viesse de fora, uma chave de automação
        // comprometida passaria zero e desligaria a proteção de slippage.
        (uint256 expected0, uint256 expected1) = LiquidityAmounts.getAmountsForLiquidity(
            TickMath.getSqrtRatioAtTick(twapTick),
            TickMath.getSqrtRatioAtTick(tickLower),
            TickMath.getSqrtRatioAtTick(tickUpper),
            liquidity
        );

        npm.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: (expected0 * (BPS_DENOMINATOR - slippageToleranceBps)) / BPS_DENOMINATOR,
                amount1Min: (expected1 * (BPS_DENOMINATOR - slippageToleranceBps)) / BPS_DENOMINATOR,
                deadline: deadline
            })
        );

        // A TRAVA CENTRAL DESTE CONTRATO: o destino é lido do NFT na hora, não
        // é parâmetro. Não existe caminho de código que mande valor pra outro
        // endereço — nem pra este contrato, que nunca custodia nada.
        (amount0, amount1) = npm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: owner,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        emit Closed(owner, tokenId, liquidity, amount0, amount1);
    }

    /// @dev Recusa agir se o tick atual estiver longe demais do TWAP — sinal de
    /// preço sendo manipulado agora. Pool sem histórico suficiente reverte em
    /// vez de passar sem checagem. Devolve o tick do TWAP pra ser usado como
    /// referência confiável de preço.
    function _checkPriceNotManipulated(address pool) internal view returns (int24 twapTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;

        try IUniswapV3Pool(pool).observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            // forge-lint: disable-next-line(unsafe-typecast)
            // seguro: tick sempre cabe em int24 (limite do próprio Uniswap V3, MIN/MAX_TICK)
            twapTick = int24((tickCumulatives[1] - tickCumulatives[0]) / int56(uint56(twapWindow)));
            (, int24 currentTick,,,,,) = IUniswapV3Pool(pool).slot0();
            int24 delta = currentTick > twapTick ? currentTick - twapTick : twapTick - currentTick;
            if (delta > maxTickDeviation) revert PriceDeviationTooHigh();
        } catch {
            revert InsufficientPriceHistory();
        }
    }
}
