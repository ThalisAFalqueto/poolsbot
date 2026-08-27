#!/usr/bin/env python3
"""Gera um PNG com o histórico de volume agregado de DEXs — o gráfico do
/mercado. Mesmo desenho do plot_range.py (chamado como subprocesso pelo Node,
ver src/data/chart/plot-market.ts, fora de src/ de propósito).

Uso: python3 plot_market.py '<json>' <caminho_saida.png>

JSON esperado: history (lista de {date: "YYYY-MM-DD", volumeUsd: number}),
percentile (0-1), label (string).
"""
import json
import sys
from datetime import datetime

import matplotlib

matplotlib.use("Agg")  # sem display — roda em servidor sem X11
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

# Paleta escura, no espírito dos gráficos de trading que o usuário citou — e
# que combina com o tema escuro do Telegram, onde a imagem vai ser vista.
BG = "#131722"
GRID = "#2a2e39"
AREA = "#2962ff"
LINE = "#2962ff"
MA7 = "#ff9800"
MA30 = "#787b86"
TEXT = "#d1d4dc"
LAST_DOT = "#26a69a"


def moving_average(values, window):
    """Média móvel simples. Devolve None nas posições sem janela cheia, pra a
    linha simplesmente não ser desenhada ali em vez de começar distorcida."""
    out = []
    for i in range(len(values)):
        if i + 1 < window:
            out.append(None)
        else:
            out.append(sum(values[i + 1 - window : i + 1]) / window)
    return out


def main():
    payload = json.loads(sys.argv[1])
    out_path = sys.argv[2]

    history = payload["history"]
    if not history:
        raise SystemExit("histórico vazio — nada pra plotar")

    dates = [datetime.strptime(p["date"], "%Y-%m-%d") for p in history]
    volumes = [p["volumeUsd"] / 1e9 for p in history]  # em bilhões
    ma7 = moving_average(volumes, 7)
    ma30 = moving_average(volumes, 30)

    fig, ax = plt.subplots(figsize=(10, 5))
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)

    ax.fill_between(dates, volumes, color=AREA, alpha=0.18)
    ax.plot(dates, volumes, color=LINE, linewidth=1.2, label="volume diário")
    ax.plot(dates, ma7, color=MA7, linewidth=1.6, label="média 7d")
    ax.plot(dates, ma30, color=MA30, linewidth=1.4, linestyle="--", label="média 30d")

    # Último ponto destacado: é o número que o texto da mensagem cita.
    ax.scatter([dates[-1]], [volumes[-1]], color=LAST_DOT, s=45, zorder=5)
    ax.annotate(
        f"${volumes[-1]:.1f}B",
        (dates[-1], volumes[-1]),
        textcoords="offset points",
        xytext=(-16, 20),
        color=LAST_DOT,
        fontsize=10,
        fontweight="bold",
        ha="right",
    )

    pct = payload.get("percentile")
    label = payload.get("label", "")
    titulo = f"Volume de DEXs — {label}"
    if pct is not None:
        titulo += f" (percentil {pct * 100:.0f}% dos últimos 90 dias)"
    ax.set_title(titulo, color=TEXT, fontsize=13, fontweight="bold", pad=14)

    ax.set_ylabel("volume diário (US$ bilhões)", color=TEXT, fontsize=10)
    ax.grid(True, color=GRID, linewidth=0.6, alpha=0.8)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.tick_params(colors=TEXT, labelsize=9)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%d/%m"))
    fig.autofmt_xdate(rotation=0, ha="center")

    legend = ax.legend(loc="upper left", frameon=False, fontsize=9)
    for text in legend.get_texts():
        text.set_color(TEXT)

    fig.tight_layout()
    fig.savefig(out_path, dpi=130, facecolor=BG)


if __name__ == "__main__":
    main()
