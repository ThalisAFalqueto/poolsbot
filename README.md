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

Depois: `pm2 logs poolsbot` na VM e conferir se um ciclo completo (`ingest-pools`, `evaluate-alerts`, `check-positions`) roda limpo.

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
| `/mes [AAAA-MM]` | resultado do mês pelo patrimônio total da carteira |
| `/mercado` | gráfico do volume de DEXs + percentil vs 90 dias |
| `/comparar <par>` | gráfico do mesmo par entre chains, ranqueado pelo que cada pool **paga de verdade** (medido on-chain) |
| `/watchpair <par>` | acompanha um par a mais no resumo diário |
| `/range <poolId>` | sugere faixa **antes** de abrir a posição |
| `/find`, `/yield`, `/pool` | busca e ranqueia pools (dados da DefiLlama) |
| `/watch`, `/unwatch`, `/alerts`, `/unalert` | alertas de APY/TVL/volume |
| `/addwallet`, `/removewallet`, `/wallets` | wallets monitoradas (só endereço público) |
| `/status` | última execução de cada job |
| `/explicacoes [assunto]` | como cada conta do bot é feita: fórmula, exemplo real e o que o número **não** diz |

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

> Cross-chain, o mesmo token tem **contrato diferente em cada chain** — casar por endereço não funciona. A chave é o símbolo normalizado (ordenado, com um mapa mínimo de apelidos). `USDC.e` não é `USDC`: são ponte e nativo, com liquidez e risco distintos, e há teste garantindo que não sejam misturados.

Histórico: a DefiLlama devolve a série diária **desde 2014** numa chamada (~19 MB), então `src/scripts/backfill-market-volume.ts` preenche tudo de uma vez e o job diário só acrescenta. O dia em curso é sempre descartado — é parcial e distorceria percentil e médias.


> Tanto o `/mercado` quanto o `/comparar` respondem com **imagem** (matplotlib, mesma infra do `/graph`), não tabela de texto. Motivo concreto: o Telegram usa fonte proporcional fora de `<pre>`, então alinhamento por espaços sai torto — e o resumo diário chegou a mandar as tags HTML cruas na tela por não passar `parse_mode`. Imagem não depende de fonte, de largura de tela nem de modo de parse. Se o `.venv` não existir na máquina, os dois caem pro texto em vez de falhar.

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
