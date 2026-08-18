// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TickMath} from "./vendor/TickMath.sol";
import {LiquidityAmounts} from "./vendor/LiquidityAmounts.sol";
import {INonfungiblePositionManager} from "./interfaces/INonfungiblePositionManager.sol";
import {IUniswapV3Factory} from "./interfaces/IUniswapV3Factory.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";

// Nota de licença: TickMath e LiquidityAmounts (Uniswap Labs) são
// GPL-2.0-or-later, diferente da licença MIT deste arquivo — cada arquivo
// .sol carrega seu próprio SPDX, e reusar essas bibliotecas de matemática
// auditadas em vez de reimplementar é uma prática comum no ecossistema
// Solidity. Vale saber disso antes de relicenciar o projeto todo.

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
/// Os `amountMin` de CADA etapa (remoção de liquidez e criação da posição
/// nova) são calculados pelo próprio contrato — nunca recebidos como
/// parâmetro de quem chama — a partir do preço validado por TWAP
/// (biblioteca `LiquidityAmounts` original do Uniswap). Isso fecha uma
/// superfície de ataque real: numa versão anterior, uma chave de automação
/// comprometida poderia passar `amountMin` artificialmente baixo e
/// enfraquecer a proteção de slippage por fora. Agora nem o chamador
/// legítimo escolhe esse número.
///
/// Limitação conhecida que continua de pé (documentada, não escondida): a
/// checagem de TWAP protege contra usar um preço manipulado como
/// referência, mas não impede a transação em si de ser vista e
/// sanduichada num mempool público — isso depende de COMO a transação é
/// enviada pra rede (mempool privado), uma decisão do lado de quem chama
/// este contrato (o executor do bot), não algo que o contrato resolve
/// sozinho. Ver README.
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

    /// @notice Tolerância de slippage (em pontos-base, 10_000 = 100%)
    /// aplicada tanto no valor esperado da remoção de liquidez (calculado
    /// a partir do preço TWAP) quanto na nova posição (calculado a partir
    /// do que foi de fato coletado). Ex: 100 = 1%.
    uint256 public immutable slippageToleranceBps;

    uint256 private constant BPS_DENOMINATOR = 10_000;

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

    constructor(
        INonfungiblePositionManager _npm,
        IUniswapV3Factory _factory,
        uint256 _minRebalanceInterval,
        int24 _maxTickDeviation,
        uint32 _twapWindow,
        uint256 _slippageToleranceBps
    ) {
        npm = _npm;
        factory = _factory;
        minRebalanceInterval = _minRebalanceInterval;
        maxTickDeviation = _maxTickDeviation;
        twapWindow = _twapWindow;
        slippageToleranceBps = _slippageToleranceBps;
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
    function rebalance(uint256 tokenId, int24 newTickLower, int24 newTickUpper, uint256 deadline)
        external
        nonReentrant
        returns (uint256 newTokenId)
    {
        address owner = npm.ownerOf(tokenId);
        if (msg.sender != owner && msg.sender != automationKeyOf[owner]) revert NotAuthorized();
        if (paused[owner]) revert UserPaused();
        if (!npm.isApprovedForAll(owner, address(this))) revert ControllerNotApproved();

        (,, address token0, address token1, uint24 fee, int24 posTickLower, int24 posTickUpper, uint128 liquidity,,,,)
        = npm.positions(tokenId);
        if (liquidity == 0) revert NoLiquidity();

        bytes32 posKey = _positionKey(owner, token0, token1, fee);
        if (block.timestamp < lastRebalanceAt[posKey] + minRebalanceInterval) revert CooldownActive();

        int24 twapTick = _checkPriceNotManipulated(factory.getPool(token0, token1, fee));

        lastRebalanceAt[posKey] = block.timestamp;

        // amountMin da remoção calculado a partir do preço validado por
        // TWAP (não do preço spot, que poderia estar manipulado dentro da
        // margem tolerada pela checagem acima) — a mesma matemática que
        // o Uniswap usa pra derivar quanto de cada token uma liquidez
        // específica representa num dado preço.
        (uint256 expected0, uint256 expected1) = LiquidityAmounts.getAmountsForLiquidity(
            TickMath.getSqrtRatioAtTick(twapTick),
            TickMath.getSqrtRatioAtTick(posTickLower),
            TickMath.getSqrtRatioAtTick(posTickUpper),
            liquidity
        );

        (uint256 removed0, uint256 removed1) = npm.decreaseLiquidity(
            INonfungiblePositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidity,
                amount0Min: (expected0 * (BPS_DENOMINATOR - slippageToleranceBps)) / BPS_DENOMINATOR,
                amount1Min: (expected1 * (BPS_DENOMINATOR - slippageToleranceBps)) / BPS_DENOMINATOR,
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

        // amountMin da posição nova: NÃO é uma fração dos dois valores
        // coletados (o mint quase nunca usa perto de 100% dos dois lados —
        // ele consome só a proporção que a faixa nova exige no preço atual,
        // e sobra do lado que não encaixa, por design do Uniswap). O jeito
        // certo é simular a mesma conta que o mint faz por dentro: dado
        // (preço validado por TWAP, faixa nova, os dois valores
        // coletados), qual liquidez resultaria — e a partir dela, quais
        // amounts USADOS são esperados. Só então aplica a tolerância.
        uint128 expectedLiquidity = LiquidityAmounts.getLiquidityForAmounts(
            TickMath.getSqrtRatioAtTick(twapTick),
            TickMath.getSqrtRatioAtTick(newTickLower),
            TickMath.getSqrtRatioAtTick(newTickUpper),
            collected0,
            collected1
        );
        (uint256 expectedUsed0, uint256 expectedUsed1) = LiquidityAmounts.getAmountsForLiquidity(
            TickMath.getSqrtRatioAtTick(twapTick),
            TickMath.getSqrtRatioAtTick(newTickLower),
            TickMath.getSqrtRatioAtTick(newTickUpper),
            expectedLiquidity
        );

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
                amount0Min: (expectedUsed0 * (BPS_DENOMINATOR - slippageToleranceBps)) / BPS_DENOMINATOR,
                amount1Min: (expectedUsed1 * (BPS_DENOMINATOR - slippageToleranceBps)) / BPS_DENOMINATOR,
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
    /// de deixar passar sem checagem. Retorna o tick do TWAP pra quem
    /// chamar reusar como referência de preço confiável (ver `rebalance`).
    function _checkPriceNotManipulated(address pool) internal view returns (int24 twapTick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = twapWindow;
        secondsAgos[1] = 0;

        try IUniswapV3Pool(pool).observe(secondsAgos) returns (
            int56[] memory tickCumulatives, uint160[] memory
        ) {
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
