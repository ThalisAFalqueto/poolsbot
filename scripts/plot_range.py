#!/usr/bin/env python3
"""Gera uma imagem PNG mostrando a faixa de uma posição de LP (min-max)
contra o preço de entrada e o preço atual. Chamado como subprocesso pelo
Node (ver src/data/chart/plot-range.ts) — não faz parte do build TypeScript,
fica fora de src/ de propósito.

Uso: python3 plot_range.py '<json com symbolPair, low, high, entry, current>' <caminho_saida.png>
"""
import json
import sys

import matplotlib

matplotlib.use("Agg")  # sem display — só gera arquivo, roda em servidor sem X11
import matplotlib.pyplot as plt

IN_RANGE_COLOR = "#2e7d32"  # verde
OUT_OF_RANGE_COLOR = "#c62828"  # vermelho
RANGE_BAND_COLOR = "#90caf9"  # azul claro
ENTRY_COLOR = "#616161"  # cinza


def main() -> None:
    payload = json.loads(sys.argv[1])
    out_path = sys.argv[2]

    symbol_pair = payload["symbolPair"]
    low = payload["low"]
    high = payload["high"]
    entry = payload.get("entry")
    current = payload["current"]

    in_range = low <= current <= high
    current_color = IN_RANGE_COLOR if in_range else OUT_OF_RANGE_COLOR

    # eixo X cobre a faixa com uma folga de 15% de cada lado, ajustado se o
    # preço atual (ou de entrada) cair fora da faixa, pra nunca cortar um
    # marcador fora da área visível do gráfico.
    span = high - low
    padding = max(span * 0.15, span * 0.01 if span > 0 else 1)
    values_to_fit = [low, high, current] + ([entry] if entry is not None else [])
    x_min = min(values_to_fit) - padding
    x_max = max(values_to_fit) + padding

    fig, ax = plt.subplots(figsize=(8, 3), dpi=150)

    ax.axvspan(low, high, color=RANGE_BAND_COLOR, alpha=0.5, label="Faixa da posição")
    ax.axvline(low, color=RANGE_BAND_COLOR, linewidth=2)
    ax.axvline(high, color=RANGE_BAND_COLOR, linewidth=2)

    if entry is not None:
        ax.axvline(entry, color=ENTRY_COLOR, linestyle="--", linewidth=2, label=f"Entrada: {entry:,.2f}")

    ax.axvline(current, color=current_color, linewidth=3, label=f"Atual: {current:,.2f}")

    ax.set_xlim(x_min, x_max)
    ax.set_yticks([])
    ax.set_xlabel(symbol_pair)
    status = "DENTRO da faixa" if in_range else "FORA da faixa"
    ax.set_title(f"{symbol_pair} — {status}", color=current_color, fontweight="bold")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.25), ncol=3, frameon=False, fontsize=9)

    fig.tight_layout()
    fig.savefig(out_path, format="png")
    plt.close(fig)


if __name__ == "__main__":
    main()
