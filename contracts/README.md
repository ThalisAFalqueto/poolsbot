# poolsbot contracts

**Rascunho para testnet. Não auditado. Não usar com fundos reais.**

Primeira peça da futura Fase 2 (execução semi-automatizada) do poolsbot — hoje o bot é 100% não-custodial (só lê dados e recomenda, ver `../src/`). Este diretório contém o desenho de como uma automação futura poderia agir sobre posições de LP **sem nunca tomar posse delas**.

## Modelo de custódia

`RebalanceController.sol` é um contrato **controlador por aprovação**, não um cofre de depósito:

- O dono da posição nunca transfere o NFT da posição pra este contrato — continua dono o tempo todo.
- O dono aprova o controller via `setApprovalForAll` no `NonfungiblePositionManager` do Uniswap V3 (mecanismo padrão ERC-721).
- **Revogar é nativo do NFT**: chamar `setApprovalForAll(controller, false)` direto no NPM tira todo o acesso na hora — não depende deste contrato cooperar, não tem um "kill switch" customizado pra confiar.
- O dono designa um endereço de automação separado (a chave operacional do bot) via `setAutomationKey`. Essa chave só consegue chamar `rebalance()`, dentro das regras do contrato — nunca transferir fundos pra si.

## Limites de segurança embutidos

- **Cooldown por posição** (não por tokenId — cada rebalance queima o NFT antigo e cria um novo; o cooldown é chaveado por `(dono, token0, token1, fee)` pra sobreviver à troca de ID).
- **Checagem de manipulação de preço via TWAP**: compara o tick atual contra a média dos últimos N segundos (configurável no deploy) usando o oráculo nativo do próprio pool Uniswap V3. Reverte se o desvio for grande demais, ou se o pool não tiver histórico suficiente.
- **`amountMin` calculado pelo próprio contrato, nunca recebido de quem chama**: tanto na remoção de liquidez quanto na posição nova, os valores mínimos aceitáveis são derivados do preço validado por TWAP (biblioteca `LiquidityAmounts` original do Uniswap) — uma chave de automação comprometida não tem como enfraquecer essa proteção passando um `amountMin` artificialmente baixo, porque ela não escolhe esse número.
- **Pausa por usuário**: `setPaused(true)` bloqueia toda automação na hora, sem precisar revogar a aprovação do NFT.

## Bibliotecas vendorizadas (`src/vendor/`)

`TickMath`, `FixedPoint96` e `LiquidityAmounts` são portadas de `Uniswap/v3-core@v1.0.0` e `Uniswap/v3-periphery@v1.3.0` (licença original GPL-2.0-or-later preservada — diferente da licença MIT do resto deste projeto, cada arquivo carrega seu próprio SPDX). O código original é Solidity 0.7.6 e não compila direto em 0.8.x; os patches aplicados (documentados no topo de cada arquivo) são mínimos:

- `TickMath.sol`: 1 conversão implícita `int24→uint256` virou explícita.
- `FullMath.sol` (do original): **não foi vendorizado** — usava negação unária em `uint256`, um padrão arriscado de repatchar à mão. `LiquidityAmounts.sol` foi ajustado pra usar `Math.mulDiv` da OpenZeppelin (mesma assinatura, já nativo pra 0.8.x, já auditado, já é dependência deste projeto).

## Limitação conhecida que continua de pé

A checagem de TWAP e os `amountMin` calculados protegem contra usar um **preço manipulado como referência**, mas não impedem que a transação em si seja **vista e sanduichada num mempool público** — isso depende de COMO a transação é enviada pra rede, uma decisão de quem chama este contrato (o executor do bot), não algo que o contrato resolve sozinho. Hoje **não existe executor real no projeto** (`../src/execution/noop-executor.ts` é um stub) — quando ele for construído, o plano é:

- Arbitrum e Base (chains ativas hoje no poolsbot) têm sequenciador centralizado, não um mempool público tradicional — a exposição a sandwich attack já é estruturalmente menor que na Ethereum mainnet, mas não nula (MEV a nível de sequenciador é uma área ativa, não uma garantia).
- Se algum dia a Ethereum mainnet for ativada (o registry de chains já suporta, só falta configurar), usar um endpoint de envio privado (tipo Flashbots Protect) em vez de um RPC público ali é obrigatório, não opcional.

## Rodando

```bash
forge install                        # busca as dependências pinadas em versão (lib/, gitignored)
forge build
ARBITRUM_RPC_URL=<sua-key> forge test -vv    # ~2min — o teste de manipulação de preço simula um swap gigante
```

Dependências e versões pinadas (`forge install <repo>@<tag>` — não é gratuito, evita que uma atualização de dependência mude o comportamento sem ninguém perceber):

| Dependência | Versão | Uso |
|---|---|---|
| `OpenZeppelin/openzeppelin-contracts` | `v5.7.0` | `ReentrancyGuard`, `SafeERC20`, `Math.mulDiv` |
| `foundry-rs/forge-std` | `v1.16.2` | Framework de teste |

(`Uniswap/v3-core`/`v3-periphery` NÃO são mais dependências do projeto — só foram usados uma vez como fonte pra vendorizar os 4 arquivos de `src/vendor/`, que já estão commitados.)

Os testes rodam contra um **fork real da Arbitrum** (nenhuma transação de verdade é enviada) usando uma posição real conhecida da wallet de referência do projeto — incluindo um teste que simula manipulação de preço de verdade (swap grande no pool) pra provar que a proteção de TWAP realmente bloqueia, não só que não atrapalha o caso normal.
