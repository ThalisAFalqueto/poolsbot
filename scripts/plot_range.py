#!/usr/bin/env python3
"""Gera uma imagem PNG com o histórico de preço (linha do tempo) de uma
posição de LP, com a faixa (min-max) e o preço de entrada como linhas de
referência horizontais — no estilo do gráfico nativo da Uniswap. Chamado
como subprocesso pelo Node (ver src/data/chart/plot-range.ts) — não faz
parte do build TypeScript, fica fora de src/ de propósito.

Uso: python3 plot_range.py '<json>' <caminho_saida.png>

JSON esperado: symbolPair, low, high, entry (ou null), current,
history (lista de {recordedAt: ISO string, price: number}, pode ser vazia).
"""
import json
import sys
from datetime import datetime, timezone

import matplotlib

matplotlib.use("Agg")  # sem display — só gera arquivo, roda em servidor sem X11
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

IN_RANGE_COLOR = "#2e7d32"  # verde
OUT_OF_RANGE_COLOR = "#c62828"  # vermelho
RANGE_BAND_COLOR = "#90caf9"  # azul claro
RANGE_LINE_COLOR = "#1565c0"  # azul
ENTRY_COLOR = "#616161"  # cinza
PRICE_LINE_COLOR = "#424242"  # cinza escuro


def parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def main() -> None:
    payload = json.loads(sys.argv[1])
    out_path = sys.argv[2]

    symbol_pair = payload["symbolPair"]
    low = payload["low"]
    high = payload["high"]
    entry = payload.get("entry")
    current = payload["current"]
    history = payload.get("history") or []

    times = [parse_ts(p["recordedAt"]) for p in history]
    prices = [p["price"] for p in history]

    # Garante que a linha termine no preço fresco lido on-chain no momento
    # do comando — mais preciso que o último ponto do histórico, que pode
    # ter até 15min de atraso (job de manutenção roda nesse intervalo).
    now = datetime.now(timezone.utc)
    if not times or (now - times[-1]).total_seconds() > 60:
        times.append(now)
        prices.append(current)

    in_range = low <= current <= high
    current_color = IN_RANGE_COLOR if in_range else OUT_OF_RANGE_COLOR

    fig, ax = plt.subplots(figsize=(9, 4.5), dpi=150)

    ax.axhspan(low, high, color=RANGE_BAND_COLOR, alpha=0.35, label="Faixa da posição", zorder=0)
    ax.axhline(low, color=RANGE_LINE_COLOR, linewidth=1.2, zorder=1)
    ax.axhline(high, color=RANGE_LINE_COLOR, linewidth=1.2, zorder=1)

    if entry is not None:
        ax.axhline(entry, color=ENTRY_COLOR, linestyle="--", linewidth=1.5, label=f"Entrada: {entry:,.2f}", zorder=1)

    if len(times) >= 2:
        ax.plot(times, prices, color=PRICE_LINE_COLOR, linewidth=2, zorder=2, label="Preço")
    # rótulo usa prices[-1] (o valor efetivamente plotado), não `current` —
    # evita descolar o texto do ponto quando o último ponto do histórico já
    # está fresco o bastante pra não precisar do append acima.
    ax.scatter([times[-1]], [prices[-1]], color=current_color, s=60, zorder=3, label=f"Atual: {prices[-1]:,.2f}")

    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d/%m"))
    fig.autofmt_xdate()

    # eixo Y com folga, ajustado pra caber a faixa inteira e o histórico de preço
    values_to_fit = [low, high, current] + prices + ([entry] if entry is not None else [])
    y_min, y_max = min(values_to_fit), max(values_to_fit)
    y_span = y_max - y_min
    y_padding = max(y_span * 0.1, y_span * 0.01 if y_span > 0 else 1)
    ax.set_ylim(y_min - y_padding, y_max + y_padding)

    ax.set_ylabel(symbol_pair)
    status = "DENTRO da faixa" if in_range else "FORA da faixa"
    ax.set_title(f"{symbol_pair} — {status}", color=current_color, fontweight="bold")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.22), ncol=4, frameon=False, fontsize=9)
    ax.grid(True, alpha=0.2)

    fig.tight_layout()
    fig.savefig(out_path, format="png")
    plt.close(fig)


if __name__ == "__main__":
    main()
