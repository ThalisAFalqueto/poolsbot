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
npm run typecheck && npx vitest run test/domain test/integration test/data

rsync -avz -e "ssh -i ~/.ssh/oracle_poolsbot" \
  --exclude node_modules --exclude .git --exclude dist --exclude .venv \
  ./ opc@<ip-da-vm>:~/poolsbot/

ssh -i ~/.ssh/oracle_poolsbot opc@<ip-da-vm> \
  "cd ~/poolsbot && npm ci && npm run build && pm2 restart poolsbot"
```

Depois: `pm2 logs poolsbot` na VM e conferir se um ciclo completo (`ingest-pools`, `evaluate-alerts`, `check-positions`) roda limpo.

> Os scripts `pm2:*` do `package.json` agem na máquina **local**, não na VM — servem pra desenvolvimento. Rodar o bot local e o da VM ao mesmo tempo com o mesmo token quebra os dois: o Telegram só aceita um `getUpdates` por token (erro 409).

## Comandos do bot

| | |
|---|---|
| `/positions` | posições ativas: faixa, fees, IL, P&L, APR, TVL/volume do pool |
| `/graph [apelido]` | gráfico da faixa + histórico de preço |
| `/labelposition <tokenId> <nome>` | apelido pra usar no `/graph` |
| `/closed` | posições já fechadas, com P&L final e gas |
| `/range <poolId>` | sugere faixa **antes** de abrir a posição |
| `/find`, `/yield`, `/pool` | busca e ranqueia pools (dados da DefiLlama) |
| `/watch`, `/unwatch`, `/alerts`, `/unalert` | alertas de APY/TVL/volume |
| `/addwallet`, `/removewallet`, `/wallets` | wallets monitoradas (só endereço público) |
| `/status` | última execução de cada job |

## Estrutura

```
src/
  bot/          comandos do Telegram (grammY)
  domain/       regras puras, sem I/O — é aqui que mora a matemática
                (IL, P&L, APR, faixa por volatilidade, alertas)
  data/         adaptadores externos: RPC (viem), DefiLlama, Dune, matplotlib
  persistence/  schema e repositórios (Drizzle + Postgres)
  scheduler/    jobs de 15min (ingestão, alertas, posições)
  scripts/      backfills pontuais, rodados à mão
contracts/      RebalanceController.sol (Foundry) — rascunho de testnet,
                NÃO auditado, NÃO usado pelo bot
```

`domain/` não importa nada de `data/` nem de `persistence/` — é o que deixa a matemática testável sem RPC nem banco (`test/domain`). Testes de integração sobem um Postgres de verdade (porta 5433, banco `poolsbot_test`); `test/onchain` bate em RPC real e por isso fica fora da suíte padrão.

## Convenções

- **Comentários e commits em português.** Comentário explica *por quê*, não *o quê* — em especial quando a escolha foi contra-intuitiva ou veio de um erro real.
- **Nunca inventar número.** Se um dado não dá pra calcular com confiança, o texto diz "indisponível" e explica o motivo — não cai num valor plausível.
- **`tokenId` não é identificador único.** Ele só é único dentro de um contrato: V3 e V4 numeram separado e podem colidir. A identidade real é `(tokenId, chain, protocol)`.
- **`token1` é a unidade de conta.** Todo P&L é medido no token de cotação da própria posição — não há oráculo de preço em USD, e conversão entre posições de moedas diferentes é evitada de propósito.
