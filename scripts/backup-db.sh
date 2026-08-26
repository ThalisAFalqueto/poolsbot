#!/usr/bin/env bash
# Backup diário do Postgres de produção pro Object Storage da Oracle.
#
# Por que existe: o banco guarda o que NÃO dá pra reconstruir da blockchain —
# histórico de preço (pool_price_history), posições fechadas
# (closed_lp_positions) e os baselines de IL, que são a âncora de todo o P&L.
# Perder a VM sem isso significa perder o histórico inteiro. O código está no
# GitHub; o banco não estava em lugar nenhum fora da própria VM.
#
# Roda via systemd timer (ver scripts/systemd/). Falha ALTO: qualquer erro
# manda mensagem no Telegram, porque backup que quebra em silêncio é pior que
# não ter backup — você para de checar achando que está coberto.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/home/opc/poolsbot}"
BACKUP_DIR="${BACKUP_DIR:-/home/opc/backups}"
PAR_URL_FILE="${PAR_URL_FILE:-/home/opc/.oci-par-url}"
CONTAINER="${CONTAINER:-poolsbot-postgres-1}"
KEEP_DAYS="${KEEP_DAYS:-30}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
FILE="$BACKUP_DIR/poolsbot-$STAMP.dump"

# Avisa no Telegram e sai. Reaproveita o token do bot (mesmo .env) e busca o
# chat do usuário no próprio banco — sem duplicar credencial em outro lugar.
# Best-effort: se o alerta falhar, ainda assim sai com erro pro systemd
# registrar (`systemctl status poolsbot-backup`).
fail() {
  local message="⚠️ Backup do banco FALHOU em $(date -u '+%d/%m %H:%M UTC'): $1"
  echo "$message" >&2
  local token chat_id
  token="$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
  chat_id="$(docker exec "$CONTAINER" psql -U poolsbot -d poolsbot -tAc \
    'select telegram_chat_id from users order by id limit 1' 2>/dev/null || true)"
  if [ -n "$token" ] && [ -n "$chat_id" ]; then
    curl -sS --max-time 20 -X POST "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat_id}" \
      --data-urlencode "text=${message}" >/dev/null || echo "alerta no Telegram também falhou" >&2
  fi
  exit 1
}

mkdir -p "$BACKUP_DIR"

# 1. Dump. `-F c` (formato custom) em vez de SQL puro: comprimido e restaurável
#    seletivamente com pg_restore.
docker exec "$CONTAINER" pg_dump -U poolsbot -d poolsbot -F c > "$FILE" 2>/dev/null \
  || fail "pg_dump não completou"

# 2. Sanidade de tamanho — pega o caso "arquivo criado mas vazio/truncado", que
#    passaria batido se só checássemos o código de saída.
SIZE="$(stat -c%s "$FILE")"
[ "$SIZE" -gt 10000 ] || fail "dump suspeito, só $SIZE bytes"

# 3. Sanidade de conteúdo — `pg_restore -l` lê o índice interno do arquivo.
#    Um dump corrompido falha aqui, não daqui a 6 meses na hora que você
#    precisar restaurar de verdade.
docker exec -i "$CONTAINER" pg_restore -l < "$FILE" > /dev/null 2>&1 \
  || fail "dump não é restaurável (pg_restore -l falhou)"

# 4. Upload. A PAR (Pre-Authenticated Request) é uma URL de ESCRITA no bucket —
#    é segredo, fica em arquivo separado com permissão 600, nunca no
#    repositório. `-f` faz o curl retornar erro em resposta HTTP 4xx/5xx.
[ -r "$PAR_URL_FILE" ] || fail "PAR não configurada em $PAR_URL_FILE"
PAR_URL="$(tr -d '[:space:]' < "$PAR_URL_FILE")"
curl -sSf --max-time 120 -T "$FILE" "${PAR_URL}$(basename "$FILE")" >/dev/null \
  || fail "upload pro Object Storage falhou"

# 5. Rotação local. O remoto NÃO é limpo por aqui de propósito: a PAR é
#    write-only, então nem se alguém roubar a URL consegue apagar histórico.
#    Limpeza do bucket, se um dia precisar, é manual pelo console.
find "$BACKUP_DIR" -name 'poolsbot-*.dump' -mtime "+$KEEP_DAYS" -delete

echo "backup OK: $(basename "$FILE") ($((SIZE / 1024)) KB) enviado ao Object Storage"
