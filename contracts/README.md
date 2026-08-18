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
- **Pausa por usuário**: `setPaused(true)` bloqueia toda automação na hora, sem precisar revogar a aprovação do NFT.
- **`amount0Min`/`amount1Min` obrigatórios** (nunca zero) na nova posição.

## Limitação conhecida (documentada, não escondida)

Os `amountMin` da **remoção** de liquidez (não da nova posição) hoje são `0` — a proteção contra manipulação nessa etapa é só a checagem de TWAP acima. Proteger isso também exigiria portar a matemática de `LiquidityAmounts`/`TickMath` do Uniswap pra Solidity, calculando o valor esperado a partir do preço validado por TWAP. Fica como hardening necessário antes de qualquer uso com fundos reais.

Falta também: submissão via mempool privado (proteção real contra sandwich attack no envio da transação — a checagem de TWAP protege contra usar um preço manipulado como referência, mas não impede a transação em si de ser vista e sanduichada num mempool público), gestão de nonce/retry, e pinagem de versão exata das dependências (`forge install` hoje pega a branch padrão).

## Rodando

```bash
forge install                        # busca as dependências (lib/, gitignored)
forge build
ARBITRUM_RPC_URL=<sua-key> forge test -vv
```

Os testes rodam contra um **fork real da Arbitrum** (nenhuma transação de verdade é enviada) usando uma posição real conhecida da wallet de referência do projeto — incluindo um teste que simula manipulação de preço de verdade (swap grande no pool) pra provar que a proteção de TWAP realmente bloqueia, não só que não atrapalha o caso normal.
