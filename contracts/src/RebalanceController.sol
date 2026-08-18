// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";

/// @title RebalanceController
/// @notice RASCUNHO PARA TESTNET — não auditado, não usar com fundos reais.
///
/// Controlador NÃO-CUSTODIAL de rebalance de posições Uniswap V3: o dono da
/// posição NUNCA transfere o NFT pra este contrato. Em vez disso, aprova
/// este contrato como operador via `setApprovalForAll` no
/// NonfungiblePositionManager (padrão ERC-721) — o mesmo mecanismo nativo
/// do NFT já serve de "botão de pânico": revogar a aprovação (uma chamada
/// padrão, sem depender deste contrato cooperar) tira todo o acesso
/// instantaneamente.
///
/// O dono designa um endereço de automação (a chave operacional do bot,
/// SEM valor nenhum nela — só serve pra assinar chamadas de rebalance)
/// separado da própria wallet. Se essa chave de automação for comprometida,
/// o atacante só consegue chamar `rebalance()` dentro das regras abaixo —
/// nunca transferir fundos pra si, nunca sacar pra outro endereço.
///
/// Limitação conhecida (documentada, não escondida): a proteção contra
/// manipulação de preço aqui é a checagem de desvio contra o TWAP do
/// próprio pool (abaixo) — os `amountMin` da remoção de liquidez em si NÃO
/// são calculados a partir da matemática de liquidez do Uniswap (isso
/// exigiria portar TickMath/LiquidityAmounts pra Solidity), então essa
/// etapa aceita qualquer quantia. Hardening antes de produção: computar os
/// amountMin da remoção a partir do preço validado por TWAP.
contract RebalanceController is ReentrancyGuard {
    using SafeERC20 for IERC20;

    INonfungiblePositionManager public immutable npm;
    IUniswapV3Factory public immutable factory;

    /// @notice Intervalo mínimo entre rebalances da MESMA posição — trava
    /// contra uma chave de automação comprometida ficar rebalanceando em
    /// loop (cada ciclo custa gas real do dono, mesmo sem roubo direto).
    uint256 public immutable minRebalanceInterval;

    /// @notice Desvio máximo (em ticks) entre o tick atual e o TWAP antes de
    /// recusar o rebalance — sinal de manipulação de preço em andamento.
    /// ~100 ticks ≈ 1%. Trade-off: baixo demais rejeita rebalances legítimos
    /// durante volatilidade real; alto demais enfraquece a proteção.
    int24 public immutable maxTickDeviation;

    /// @notice Janela do TWAP (segundos) usada na checagem acima.
    uint32 public immutable twapWindow;

    mapping(address user => address automationKey) public automationKeyOf;
    mapping(address user => bool isPaused) public paused;

    /// @dev Chaveado por (owner, token0, token1, fee) — NÃO por tokenId.
    /// Cada rebalance queima o NFT antigo e cria um novo com ID diferente,
    /// então um cooldown por tokenId nunca protegeria nada de verdade (o
    /// "novo" tokenId sempre começaria com cooldown zerado). O que importa
    /// é limitar a frequência de rebalance da MESMA posição conceitual
    /// (mesmo dono, mesmo par/fee), independente de qual NFT a representa
    /// no momento.
    mapping(bytes32 positionKey => uint256 timestamp) public lastRebalanceAt;

    function _positionKey(address owner, address token0, address token1, uint24 fee) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(owner, token0, token1, fee));
    }

    event AutomationKeySet(address indexed user, address indexed automationKey);
    event PausedSet(address indexed user, bool isPaused);
    event Rebalanced(
        address indexed owner,
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        int24 newTickLower,
        int24 newTickUpper,
        uint256 removedAmount0,
        uint256 removedAmount1
    );

    error NotAuthorized();
    error UserPaused();
    error ControllerNotApproved();
    error CooldownActive();
    error NoLiquidity();
    error PriceDeviationTooHigh();
    error InsufficientPriceHistory();
    error ZeroMinAmount();

    constructor(
        INonfungiblePositionManager _npm,
        IUniswapV3Factory _factory,
        uint256 _minRebalanceInterval,
        int24 _maxTickDeviation,
        uint32 _twapWindow
    ) {
        npm = _npm;
        factory = _factory;
        minRebalanceInterval = _minRebalanceInterval;
        maxTickDeviation = _maxTickDeviation;
        twapWindow = _twapWindow;
    }

    /// @notice Define (ou troca) o endereço autorizado a chamar rebalance()
    /// em nome de quem chama. Só o próprio dono pode setar o seu.
    function setAutomationKey(address automationKey) external {
        automationKeyOf[msg.sender] = automationKey;
        emit AutomationKeySet(msg.sender, automationKey);
    }

    /// @notice Pausa/despausa toda automação pra quem chama — efeito
    /// imediato, some sem precisar revogar a aprovação do NFT.
    function setPaused(bool isPaused) external {
        paused[msg.sender] = isPaused;
        emit PausedSet(msg.sender, isPaused);
    }

    /// @notice Remove toda a liquidez de `tokenId`, coleta os tokens, e abre
    /// uma posição nova em [newTickLower, newTickUpper) com o mesmo par/fee
    /// — a nova posição vai direto pro dono original, nunca fica neste
    /// contrato. A posição antiga é fechada (burn) ao final.
    function rebalance(
        uint256 tokenId,
        int24 newTickLower,
        int24 newTickUpper,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external nonReentrant returns (uint256 newTokenId) {
        if (amount0Min == 0 || amount1Min == 0) revert ZeroMinAmount();

        address owner = npm.ownerOf(tokenId);
        if (msg.sender != owner && msg.sender != automationKeyOf[owner]) revert NotAuthorized();
        if (paused[owner]) revert UserPaused();
        if (!npm.isApprovedForAll(owner, address(this))) revert ControllerNotApproved();

        (,, address token0, address token1, uint24 fee,,, uint128 liquidity,,,,) = npm.positions(tokenId);
        if (liquidity == 0) revert NoLiquidity();

        bytes32 posKey = _positionKey(owner, token0, token1, fee);
        if (block.timestamp < lastRebalanceAt[posKey] + minRebalanceInterval) revert CooldownActive();

        _checkPriceNotManipulated(factory.getPool(token0, token1, fee));

        lastRebalanceAt[posKey] = block.timestamp;

        (uint256 removed0, uint256 removed1) = npm.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: 0, // ver limitação documentada no NatSpec do contrato
                amount1Min: 0,
                deadline: deadline
            })
        );

        (uint256 collected0, uint256 collected1) = npm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        IERC20(token0).forceApprove(address(npm), collected0);
        IERC20(token1).forceApprove(address(npm), collected1);

        uint256 used0;
        uint256 used1;
        (newTokenId,, used0, used1) = npm.mint(
            INonfungiblePositionManager.MintParams({
                token0: token0,
                token1: token1,
                fee: fee,
                tickLower: newTickLower,
                tickUpper: newTickUpper,
                amount0Desired: collected0,
                amount1Desired: collected1,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                recipient: owner,
                deadline: deadline
            })
        );

        // zera a allowance residual (boa prática — forceApprove já lida com
        // tokens tipo USDT que exigem zerar antes de re-aprovar um valor
        // diferente da próxima vez)
        IERC20(token0).forceApprove(address(npm), 0);
        IERC20(token1).forceApprove(address(npm), 0);

        if (collected0 > used0) IERC20(token0).safeTransfer(owner, collected0 - used0);
        if (collected1 > used1) IERC20(token1).safeTransfer(owner, collected1 - used1);

        npm.burn(tokenId);

        emit Rebalanced(owner, tokenId, newTokenId, newTickLower, newTickUpper, removed0, removed1);
    }

    /// @dev Compara o tick atual (spot) contra o TWAP da janela configurada
    /// — um desvio grande sugere manipulação de preço em andamento (ex.
    /// alguém acabou de mover o pool com um swap grande pra sandwichar este
    /// rebalance). Reverte se o pool não tiver histórico suficiente em vez
    /// de deixar passar sem checagem.
    function _checkPriceNotManipulated(address pool) internal view {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;

        try IUniswapV3Pool(pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives, uint160[] memory
        ) {
            // forge-lint: disable-next-line(unsafe-typecast)
            // seguro: tick sempre cabe em int24 (limite do próprio Uniswap V3, MIN/MAX_TICK)
            int24 twapTick = int24((tickCumulatives[1] - tickCumulatives[0]) / int56(uint56(twapWindow)));
            (, int24 currentTick,,,,,) = IUniswapV3Pool(pool).slot0();
            int24 delta = currentTick > twapTick ? currentTick - twapTick : twapTick - currentTick;
            if (delta > maxTickDeviation) revert PriceDeviationTooHigh();
        } catch {
            revert InsufficientPriceHistory();
        }
    }
}
