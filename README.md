# poolsbot

Bot de Telegram **não-custodial** pra acompanhar posições de liquidez (LP) em DeFi. Lê posições Uniswap **V3 e V4** direto da blockchain e reporta faixa, fees, impermanent loss, P&L e custo real de gas — além de alertar quando uma posição sai de faixa.

Não-custodial no sentido literal: o bot só **lê** dados on-chain e nunca movimenta fundos. Não guarda chave privada nenhuma.

## Como rodar

Pré-requisitos: Node 24+, Docker (pro Postgres) e Python 3.11+ (pro `/graph`).

```bash
cp .env.example .env        # preencher token do Telegram e as RPC URLs
docker compose up -d        # sobe o Postgres em 127.0.0.1:5433
npm ci
npm run db:migrate

python3 -m venv .venv                       # só pro /graph (matplotlib)
.venv/bin/pip install -r requirements.txt

npm run dev                 # ou: npm run build && npm start
```

O `/graph` gera a imagem chamando `.venv/bin/python3` como subprocesso (ver `src/data/chart/plot-range.ts`). **Esse venv não é versionado** — precisa ser criado em toda máquina onde o bot rodar, senão só esse comando falha (o resto do bot funciona normal). Atenção à versão: o `requirements.txt` pina uma versão de matplotlib que exige Python ≥ 3.11.

## Onde isso roda (produção)

Desde 26/08/2026 o bot **não roda mais na máquina de desenvolvimento** — vive numa VM Oracle Cloud (camada Always Free), pra não depender do notebook estar ligado. O scheduler roda de 15 em 15 minutos; com a máquina desligada, o histórico de preço ficava com buracos.

- **Acesso**: `ssh -i ~/.ssh/oracle_poolsbot opc@<ip-da-vm>` — o IP público está no console da Oracle Cloud (Compute → Instances → `poolsbot-vm`); não fica versionado aqui de propósito
- **Onde**: `/home/opc/poolsbot` (mesmo layout deste repositório)
- **Processo**: pm2 sob systemd (`pm2-opc.service`), religa sozinho se o processo morrer ou a VM reiniciar
- **Banco**: Postgres em container, publicado só em `127.0.0.1` (ver comentário no `docker-compose.yml`)

### Deploy

Não há CI: o deploy é um `rsync` seguido de rebuild e restart. Sempre rodar `npm run typecheck` e os testes **antes**.

```bash
npm run typecheck && npm run test:ci

rsync -avz -e "ssh -i ~/.ssh/oracle_poolsbot" \
  --exclude node_modules --exclude .git --exclude dist --exclude .venv \
  ./ opc@<ip-da-vm>:~/poolsbot/

ssh -i ~/.ssh/oracle_poolsbot opc@<ip-da-vm> \
  "cd ~/poolsbot && npm ci && npm run build && pm2 restart poolsbot"
```

Depois: `pm2 logs poolsbot` na VM e conferir se um ciclo completo (`ingest-pools`, `check-positions`, `snapshot-nav`) roda limpo.

### Backups

Duas coisas precisam sobreviver à perda da VM, e cada uma tem uma cópia própria:

- **Código**: este repositório, num GitHub privado. `git push` depois de commitar.
- **Banco**: dump diário no Object Storage da Oracle (abaixo). É o que **não dá pra reconstruir da blockchain** — histórico de preço, posições fechadas e os baselines de IL, que ancoram todo o P&L.

`scripts/backup-db.sh` roda todo dia via systemd timer, faz `pg_dump`, valida o arquivo (tamanho + `pg_restore -l`, que detecta dump corrompido na hora e não seis meses depois) e envia pro Object Storage da Oracle. Mantém 30 dias de cópias locais na VM. **Se qualquer etapa falhar, manda mensagem no Telegram** — backup que quebra em silêncio é pior que não ter, porque você para de checar.

Instalação (uma vez, na VM):

```bash
# 1. Bucket + PAR no console da OCI: Storage → Buckets → criar bucket →
#    aba Management → Pre-Authenticated Requests → criar com:
#    Target=Bucket, Access Type=Permit object writes, listing desmarcado,
#    expiração bem distante (o padrão de 7 dias faria o backup parar sem aviso).
#    A URL aparece UMA vez só.

# 2. Guardar a PAR na VM (é segredo: dá acesso de escrita ao bucket)
echo 'https://objectstorage.<região>.oraclecloud.com/p/.../o/' > ~/.oci-par-url
chmod 600 ~/.oci-par-url

# 3. Instalar o timer
sudo cp ~/poolsbot/scripts/systemd/poolsbot-backup.* /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now poolsbot-backup.timer

# 4. Testar de verdade antes de confiar
sudo systemctl start poolsbot-backup.service
journalctl -u poolsbot-backup.service -n 5 --output=cat   # espera "backup OK: ..."
```

Restaurar um backup:

```bash
docker cp <arquivo>.dump poolsbot-postgres-1:/tmp/restore.dump
docker exec poolsbot-postgres-1 pg_restore -U poolsbot -d poolsbot \
  --clean --if-exists --no-owner /tmp/restore.dump
```

> A PAR é **só de escrita** de propósito: se a URL vazar, ninguém lê nem apaga os backups. O outro lado disso é que baixar um backup exige o console da OCI (ou o `oci` CLI autenticado) — a URL sozinha não serve pra restaurar.

> Os scripts `pm2:*` do `package.json` agem na máquina **local**, não na VM — servem pra desenvolvimento. Rodar o bot local e o da VM ao mesmo tempo com o mesmo token quebra os dois: o Telegram só aceita um `getUpdates` por token (erro 409).

## Comandos do bot

| | |
|---|---|
| `/positions` | posições ativas: faixa, fees, IL, P&L, APR, TVL/volume do pool |
| `/graph [apelido]` | gráfico da faixa + histórico de preço |
| `/labelposition <tokenId> <nome>` | apelido pra usar no `/graph` |
| `/closed` | posições já fechadas, com P&L final e gas |
| `/dia`, `/semana`, `/mes` | resultado do período pelo patrimônio total (Modified Dietz); o semanal também chega sozinho às segundas |
| `/range <poolId>` | sugere faixa **antes** de abrir a posição |
| `/yield <chain>` | pools de liquidez concentrada ranqueadas pelo que pagam **de verdade** + quanto a faixa dura |
| `/addwallet`, `/removewallet`, `/wallets` | wallets monitoradas (só endereço público) |
| `/comparar <par>` | mesmo par entre chains, medido on-chain (+ gráfico) |
| `/watch <id>`, `/unwatch <id>` | grava o histórico de APY/TVL de uma pool |
| `/sites` | onde olhar pool na internet, e o aviso sobre a coluna de APR |
| `/status` | última execução de cada job |
| `/explicacoes [assunto]` | como cada conta do bot é feita: fórmula, exemplo real e o que o número **não** diz |
| `/fechar <tokenId> abaixo <preço> acima <preço>` | fecha a posição sozinho quando o preço bate no limite (`/fechamentos` lista o que está armado) |
| `/bordaalerta on\|off` | aviso quando o preço entra nos 15% finais da faixa — **desligado por padrão** |

## Dois jeitos de medir resultado

O bot mede desempenho de duas formas, que respondem a perguntas diferentes e **não devem ser somadas**:

| | `/positions` | `/mes` |
|---|---|---|
| Escopo | uma posição | a carteira inteira |
| Unidade | token de cotação da posição (exato) | USDC (aproximado, preço de pool) |
| Custos | só gas de abrir/fechar | **todos** — gas, slippage, taxa de swap |
| Capital parado | ignorado | conta, e puxa o retorno pra baixo |

O `/mes` usa **diferença de patrimônio**: `nav_fim − nav_início − depósitos + saques`. A vantagem é que nenhum custo precisa ser enumerado — tudo sai de algum saldo, então já está embutido na diferença. Somar componentes (fees − gas − IL…) esquece em silêncio qualquer custo que ninguém programou.

Pra isso funcionar, duas coisas são detectadas automaticamente:

- **Aporte**: token que chegou numa transação que a carteira **não assinou** (quem assina é a exchange). Se a própria carteira assinou, é resultado de operação dela — swap, retirada de pool —, não dinheiro novo.
- **Saque**: token que saiu pra um endereço **sem código** (carteira comum); pool e router são contratos.

Um filtro por endereço (`trustedTokens` + tokens que já passaram por posições suas) impede que airdrop de scam entre como aporte — ele chega exatamente como um depósito legítimo.

## Como a faixa é calibrada

O `/range` estima volatilidade a partir do **histórico de preço que o próprio bot guarda** (`pool_price_history`: backfill + um ponto a cada 15min), e só recorre ao oráculo TWAP do pool quando não há histórico suficiente.

A ordem importa, e a razão é metodológica. O oráculo do Uniswap V3 guarda observações num buffer **circular de tamanho fixo**: quanto mais negociado o pool, mais rápido as posições antigas são sobrescritas e **menor** fica o alcance histórico. Usar "a primeira janela que responder" escolhe a base de cálculo por disponibilidade, não por qualidade — com dois efeitos ruins:

1. quanto mais o preço se move, menos tempo se observa, e **mais estreita** sai a faixa — o inverso do correto;
2. duas pools ficam comparadas em bases diferentes sem que isso apareça.

Medido em 27/08/2026 no WBTC/USDC 0.05% da Arbitrum ($9,4M de TVL, $10M/dia): o oráculo alcançava **4,9 horas** e produzia uma faixa de **2,0%** — enquanto a volatilidade real do par, sobre 37 dias do banco, é **1,67%/dia**. Essa faixa não sobreviveria um dia.

O histórico de **todos os pools do mesmo par na chain** (V3 e V4) é unificado antes de estimar: são o mesmo preço (a arbitragem os mantém alinhados), e usar só um faz a amostra depender de qual deles o bot acompanhou por mais tempo — o mesmo par chegou a dar 1,87%/dia pelo V3 e 1,05% pelo V4.

A resposta é por **horizonte** ("pra durar ~3 dias, use X–Y"), porque é essa a decisão real, e declara sempre a base: quantos pontos, quantos dias, qual volatilidade medida. Largura escala com √t — dobrar o horizonte aumenta a faixa ~41%, não 100%.

> O centro da faixa vem do preço **on-chain ao vivo**, nunca do último ponto do histórico. Bug real: o histórico do pool V3 parou quando a posição migrou pro V4, e centrar nele gerou uma faixa que não continha o preço atual.

## Contexto de mercado

O `/mercado` responde "o momento está bom?" pelo volume agregado de todas as DEXs. A leitura é por **percentil contra os últimos 90 dias**, não por um rótulo inventado: "percentil 84%" é verificável, "bull market" é opinião.

Duas métricas que parecem brigar e não brigam:

- **Percentil** = patamar. Onde o volume de hoje está frente aos últimos 3 meses.
- **Variação 1d/7d** = direção. Pra onde vem andando.

Um mercado pode estar num patamar alto **e** caindo — e é justamente essa combinação que interessa. Por isso as duas aparecem juntas, e o campo que compara semana vs mês se chama `weekVsMonth`, não "tendência": ele mede nível, não direção.

**O bot nunca altera a meta de 3%/mês.** Ele mostra o contexto ao lado dela e para por aí — um número que baliza decisão precisa ser estável entre meses pra comparação fazer sentido.

### Comparar pools: por que não pelo apyBase

O `/comparar` ranqueia o mesmo par entre chains pelo que cada pool **paga por unidade de liquidez**, lido do contrato — não pelo `apyBase` da DefiLlama nem pelo giro (volume ÷ TVL).

Os dois critérios antigos dividem por **TVL**, e TVL conta toda a liquidez da pool, inclusive a que está **fora de faixa e não ganha nada**. Uma posição concentrada não divide taxa com o TVL: divide com quem está posicionado no preço de agora.

O erro foi medido, não suposto (28/08/2026, WBTC-USDC):

| pool | apyBase (DefiLlama) | medido on-chain |
|---|---|---|
| Arbitrum uni v3 0.3% | 16,2% | **105%/ano** |
| Arbitrum uni v4 0.05% | 10,9% | **102%/ano** |
| Arbitrum uni v3 0.05% | 24,1% | **101%/ano** |
| Polygon uni v3 0.3% | 30,1% | **97%/ano** |

O `apyBase` espalhava as quatro de 10,9% a 30,1% (razão 2,8x) e teria mandado trocar de pool. Medidas, elas pagam quase igual — 9% de diferença. Faz sentido em equilíbrio: se uma pool do mesmo par pagasse bem mais por unidade de liquidez, os LPs migrariam pra lá até nivelar. **Escolher a pool importa pouco; escolher a largura da faixa importa muito.**

Como é medido (`src/domain/market/fee-per-liquidity.ts` + `src/data/onchain/fee-growth.ts`):

1. `feeGrowthGlobal` é a taxa acumulada **por unidade de liquidez**. A diferença entre dois blocos ÷ tempo é o que a posição ganha, sem passar por TVL.
2. A comparação usa uma **posição de referência fixa** ($1.000 em ±3%) — faixa mais estreita sempre dá APR maior, então larguras diferentes não comparam nada.
3. O APR resultante é **enquanto em faixa**, não desconta IL nem gas, e a janela é de 3 dias (as mesmas pools pagaram 40% menos em 20h que na média dos 4 dias anteriores — janela curta engana).

Pool que não dá pra medir (chain sem RPC aqui, protocolo fora do Uniswap V3/V4, V4 com hook customizado) fica **fora do ranking** em vez de entrar com um número de régua diferente; o texto diz quantas ficaram. Sem nenhuma medição, cai pro giro — rotulado como estimativa.

#### Diluição: o termo sem o qual a conta mente

`feeGrowthGlobal` mede o que o pool pagou **enquanto você não estava lá**. Multiplicar isso pela sua liquidez só vale se a sua entrada não mudar o denominador:

```
suas taxas = (taxa por L) × L_ativa × L_ref / (L_ativa + L_ref)
```

Sem esse último termo o erro é enorme e sempre pra cima. Real: um `WETH-GMX` com volume 24h de ~zero aparecia com **212%/ano** — $1.000 ali seriam **91% da liquidez ativa**. Corrigido, cai pra 19%. Na `WBTC-USDC` do usuário ($1.000 = 0,06% da liquidez) o termo não muda nada, que é exatamente o comportamento certo: a correção só morde onde o pool é raso.

Por isso `measureYield` **se recusa a medir** sem a liquidez ativa, em vez de assumir diluição zero.

### Por que o retorno é bruto

Houve uma versão que descontava um custo de arbitragem (LVR, `(σ²/4)·L·√P`) de cada número e ranqueava pelo líquido. **Foi revertida.**

A fórmula está certa — verificada, recai em `σ²V/8` no caso full-range — mas é derivada supondo arbitragem **sem atrito**. A taxa da pool cria uma região onde arbitrar não compensa, e [Milionis, Moallemi & Roughgarden (arXiv:2305.14604)](https://arxiv.org/abs/2305.14604) mostram que isso corta a perda pela fração de blocos com oportunidade real; em pools de 0,3% e 1% a maior parte volta pro LP nas taxas que os próprios arbitradores pagam.

Era **teto, não estimativa**, e o desvio depende de fee tier e tempo de bloco, que não estão modelados. Ranquear por um número assim é pior que não ranquear por ele. O que barra par volátil hoje é a **duração da faixa**, que é medida em vez de modelada.

O custo existe e é real — `/explicacoes custo` explica o mecanismo e por que o bot não o subtrai.

### Que largura usar: backtest, não fórmula

O `/range` responde qual largura **rende mais**, simulando cada uma contra o histórico real do par em janelas móveis (`src/domain/lp-rebalance/width-backtest.ts`).

| largura | tempo em faixa | taxa bruta | efetivo |
|---|---|---|---|
| ±1% | 43% | 282% | **121%** |
| ±2% | 74% | 141% | 105% |
| ±3% | 92% | 95% | 87% |
| ±8,3% | 99% | 35% | 34% |

Ficar parado fora da faixa custa **menos** que perder concentração — contra a intuição, e por isso a tabela existe em vez de uma regra. O que o backtest **não** conta é o custo de reposicionar: faixa com 43% de tempo dentro sai de faixa várias vezes por semana. O texto do comando diz isso.

### /yield: só pools

O `/yield` lista só liquidez concentrada. Medido na Arbitrum (28/08/2026), entre as 107 opções que passavam os filtros de segurança, o teto de tudo que **não** é concentrado era **13,8%/ano** (empréstimo 0–6%, renda fixa tokenizada 3–7%, GMX 4,7–13,8%, Pendle 1,3–10,9%) — longe da meta de 36%.

Antes da mudança o comando estava **quebrado no próprio padrão**: `/yield arbitrum` com `--min 36` devolvia **zero pools** em 3 das 4 chains, porque o piso era aplicado sobre o `apy` da DefiLlama. A pool em que o usuário estava (23,3% na DefiLlama, 100%/ano medida) era descartada — o filtro excluía exatamente o que atendia a meta.

O ranking é pela **taxa medida**, e o resultado sai em duas listas:

| lista | critério |
|---|---|
| utilizáveis | faixa de ±3% dura ≥ 1 dia |
| faixa curta | dura menos que isso |

Sem a separação, o topo virava um `RAIN-USDT` com 1781%/ano cuja faixa dura 1 hora. A duração vem de `dias = (δ/σ)²`, a inversa do `move = σ√t` do `/range`, com σ de 49 amostras de tick na janela (um multicall por bloco, por chain).

> **O flag `outlier` da DefiLlama é ignorado** nas pools que o bot mede on-chain. Ele sinaliza APY estatisticamente estranho — derivado do mesmo `apyBase` que já não serve pra posição concentrada, e que numa pool concentrada é ruidoso por construção. Medido em 05/09/2026, ele barrava **8 pools na Arbitrum ($60M)** e **21 na Base ($171M)**, incluindo as maiores de ETH (`WETH-USDC` v3 0.05% de $36,1M na Arbitrum, e a de $116,7M na Base). Na Base era mais da metade das pools concentradas. Onde o bot não mede, o flag continua valendo — ver `src/domain/yield-optimizer/outlier.ts`.

> O `score` multiplicativo (`apy × 5 fatores`) foi **removido**: existia pra ajustar o `apy` da DefiLlama, e com o número medido em mãos multiplicá-lo por fatores opacos só esconderia de onde veio a ordem. Segurança continua como **filtro binário e explicável** (TVL ≥ $1M, APY ≤ 1,5x a média de 30d).

> Cross-chain, o mesmo token tem **contrato diferente em cada chain** — casar por endereço não funciona. A chave é o símbolo normalizado (ordenado, com um mapa mínimo de apelidos). `USDC.e` não é `USDC`: são ponte e nativo, com liquidez e risco distintos, e há teste garantindo que não sejam misturados.

Histórico: a DefiLlama devolve a série diária **desde 2014** numa chamada (~19 MB), então `src/scripts/backfill-market-volume.ts` preenche tudo de uma vez e o job diário só acrescenta. O dia em curso é sempre descartado — é parcial e distorceria percentil e médias.


> Tanto o `/mercado` quanto o `/comparar` respondem com **imagem** (matplotlib, mesma infra do `/graph`), não tabela de texto. Motivo concreto: o Telegram usa fonte proporcional fora de `<pre>`, então alinhamento por espaços sai torto — e o resumo diário chegou a mandar as tags HTML cruas na tela por não passar `parse_mode`. Imagem não depende de fonte, de largura de tela nem de modo de parse. Se o `.venv` não existir na máquina, os dois caem pro texto em vez de falhar.

## O bot deu uma posição aberta como fechada (03/09/2026)

Bug com perda de dado, corrigido em 07/09.

`fetchPositionsForWallet` lia as posições com `multicall({ allowFailure: true })` e **filtrava** as chamadas que falhavam. Numa falha parcial de RPC a lista encolhia sem erro nenhum — e `check-positions` trata essa lista como verdade: o que não está nela foi fechado. A `WBTC/USDC #5674258` foi arquivada em `closed_lp_positions` às 16:00 e recriada às 16:15, perdendo gas de mint, data de abertura e baseline de IL, e criando um P&L falso de −$0,90 no `/closed`.

Duas camadas de correção, porque uma só fecharia a causa e não a classe:

1. **`assertNoPartialFailure`** (`data/onchain/client.ts`) — falha parcial vira erro, e `fetchPositionsAcrossChains` omite a chain inteira, que é o caminho seguro que já existia pra falha total.
2. **`confirmPositionClosed`** (`data/onchain/confirm-closed.ts`) — antes de arquivar, lê a liquidez direto do contrato. Só arquiva com liquidez zero (ou NFT queimado). **Leitura que falha devolve indeterminado e NÃO arquiva**: manter um registro a mais custa uma linha, apagar custa dado que não volta.

`deleteStalePositions` virou `deleteConfirmedClosedPositions` e recebe a lista explícita do que foi confirmado, em vez de derivar de "não está no conjunto ativo".

O dado foi recuperado com dois scripts:

- `src/scripts/repair-false-close.ts` — data de abertura e gas de mint, que tinham sobrevivido na própria linha fantasma;
- `src/scripts/repair-il-baseline.ts` — o **baseline de IL**, relido da chain. O baseline guarda o preço do pool na abertura; recriado, ele nasce com o preço de hoje e o IL passa a medir a partir da data errada. O preço certo está no bloco da transação de mint, cujo hash está em `lp_positions.mint_gas_tx_hash` — mesma leitura histórica de `slot0` que o `backfill-price-onchain.ts` já fazia.

## Fechamento automático

Única parte do bot que **escreve** na blockchain. Você arma um preço-limite por posição; quando o preço cruza, o bot fecha e os fundos vão pra sua wallet.

**Desligado por padrão.** Sem `CLOSE_AUTOMATION_PRIVATE_KEY` e `CLOSE_CONTROLLER_ARBITRUM` no `.env`, o `/fechar` responde que não está configurado e o bot segue 100% somente-leitura.

### Por que um contrato separado

`contracts/src/CloseOnlyController.sol` é quase a primeira metade do `RebalanceController` — remove liquidez e coleta. Podia ser mais uma função lá. **Não é, de propósito:** `setApprovalForAll` entrega controle de *todas* as posições Uniswap do dono ao contrato aprovado. Aprovar um que só sabe fechar é categoricamente diferente de aprovar um que também sabe abrir posição em ticks arbitrários.

A garantia é **estrutural** (não existe código de mint no arquivo), não configurável.

| o bot consegue | |
|---|---|
| fechar sua posição | sim |
| abrir posição | **não** — não existe esse código |
| mandar fundos pra outro endereço | **não** — o destino é `npm.ownerOf(tokenId)`, lido na hora, nunca parâmetro |

O pior caso de uma chave de automação vazada é alguém fechar posições na hora errada. Prejuízo possível, roubo não.

### As três travas, todas do dono

1. **`setApprovalForAll`** — é o que liga. Revogar é chamada ERC-721 padrão e **não depende do contrato cooperar**: é o botão de pânico que sempre funciona.
2. **`setAutomationKey`** — designa a chave do bot, separada da wallet do dono e sem fundos além do gas.
3. **`setPaused`** — desliga na hora, sem mexer na aprovação.

`amountMin` é calculado **dentro do contrato** a partir do preço validado por TWAP, nunca recebido como parâmetro — uma chave comprometida não consegue passar zero e desligar a proteção de slippage.

### Limitações, ditas no próprio comando

- **15 minutos de ciclo.** O preço pode atravessar o limite e voltar, ou despencar bem além dele, entre duas checagens. Serve pra sair num preço sem pressa; **não** é proteção contra queda rápida.
- **Contrato não auditado.** O TWAP impede agir sobre preço manipulado, mas não impede a transação ser sanduichada num mempool público — isso depende de como o executor envia a transação.
- Falha na transação **mantém** o gatilho armado e tenta de novo; só desarma depois de confirmar com sucesso.

## O que foi removido, e por quê

Limpeza de 07/09/2026. O critério: **fica o que o bot faz melhor que um site.**

| saiu | substituído por |
|---|---|
| `/find`, `/pool` | DefiLlama Yields, GeckoTerminal |
| `/mercado` | DefiLlama DEXs (o gráfico continua no resumo diário) |
| `/alerts`, `/unalert` | — alertas de queda de APY/TVL de pool, nunca usados |
| `/watchpair`, `/unwatchpair` | os pares saem das próprias posições |
| job `evaluate-alerts` | — só servia às regras removidas |
| tabelas `alert_rules`, `alert_state`, `watched_pairs` | — |
| tabela `pool_volume_history` | — escrita e **nunca lida**, achado da auditoria de agosto |

`/watch` continua, mas mudou de sentido: antes criava 3 regras de alerta, agora só registra a pool pra o `ingest-pools` gravar o histórico de APY/TVL dela. É a única coisa ali que nenhum site faz por você.

Ficaram `/yield`, `/comparar` e `/range` — são os únicos lugares que medem **taxa por unidade de liquidez ativa** em vez de taxa ÷ TVL, e essa diferença chega a 4x.

## Estrutura

```
src/
  bot/          comandos do Telegram (grammY)
  domain/       regras puras, sem I/O — é aqui que mora a matemática
                (IL, P&L, APR, faixa por volatilidade, alertas)
  data/         adaptadores externos: RPC (viem), DefiLlama, Dune, matplotlib
  persistence/  schema e repositórios (Drizzle + Postgres)
  scheduler/    jobs de 15min (ingestão, alertas, posições)
  scripts/      backfills pontuais em TS, rodados à mão (via Dune)
scripts/        ferramental fora do Node: plot_range.py (o /graph),
                backup-db.sh e as units de systemd que o agendam
contracts/      RebalanceController.sol (Foundry) — rascunho de testnet,
                NÃO auditado, NÃO usado pelo bot
```

> São dois `scripts/` diferentes: `src/scripts/` é TypeScript rodado pelo `tsx` (backfills); o `scripts/` da raiz é o que não é Node (Python e shell).

`domain/` não importa nada de `data/` nem de `persistence/` — é o que deixa a matemática testável sem RPC nem banco (`test/domain`). `test/bot` cobre a montagem das mensagens: é lógica pura, e foi onde apareceram os bugs que o usuário percebeu lendo o Telegram. Testes de integração sobem um Postgres de verdade (porta 5433, banco `poolsbot_test`); `test/onchain` bate em RPC real e por isso fica fora da suíte padrão.

## Convenções

- **Comentários e commits em português.** Comentário explica *por quê*, não *o quê* — em especial quando a escolha foi contra-intuitiva ou veio de um erro real.
- **Nunca inventar número.** Se um dado não dá pra calcular com confiança, o texto diz "indisponível" e explica o motivo — não cai num valor plausível.
- **`tokenId` não é identificador único.** Ele só é único dentro de um contrato: V3 e V4 numeram separado e podem colidir. A identidade real é `(tokenId, chain, protocol)`.
- **`token1` é a unidade de conta.** Todo P&L é medido no token de cotação da própria posição — não há oráculo de preço em USD, e conversão entre posições de moedas diferentes é evitada de propósito.
- **`/explicacoes` faz parte do cálculo, não da documentação.** `src/bot/commands/explicacoes.ts` guarda a fórmula de cada conta que o bot mostra. Mudou o cálculo, muda o verbete **no mesmo commit** — texto desatualizado ali é pior que texto nenhum, porque tem cara de autoridade. Todo verbete usa número real já medido (nunca exemplo que fecha bonito) e termina no que aquele número **não** diz; há teste garantindo a seção "NÃO DIZ" e o limite de 4096 chars do Telegram.
