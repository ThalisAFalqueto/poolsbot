#!/usr/bin/env python3
"""Gera um PNG comparando o mesmo par de tokens entre chains — o gráfico do
/comparar. Barras horizontais por GIRO (volume 24h / TVL), que é a métrica que
responde "onde meu capital trabalha mais".

Substituiu uma tabela de texto: no Telegram a fonte é proporcional fora de
<pre>, e mesmo dentro dele a tabela ficava apertada no celular. Imagem não
depende de fonte nem de largura de tela.

Uso: python3 plot_pairs.py '<json>' <caminho_saida.png>

JSON esperado: pairKey (string), pools (lista de {label, turnover, tvlUsd,
apyBase, isMonitorable}).
"""
import json
import sys

import matplotlib

matplotlib.use("Agg")  # sem display — roda em servidor sem X11
import matplotlib.pyplot as plt

BG = "#131722"
GRID = "#2a2e39"
TEXT = "#d1d4dc"
BAR_OK = "#2962ff"       # chain que o bot monitora
BAR_OFF = "#4a4e5a"      # chain sem monitoramento — apagada de propósito
VALUE_TEXT = "#26a69a"


def main():
    payload = json.loads(sys.argv[1])
    out_path = sys.argv[2]

    pools = payload["pools"]
    if not pools:
        raise SystemExit("sem pools pra plotar")

    # Maior giro no topo: o eixo Y do matplotlib cresce pra cima, então a lista
    # é invertida pra a leitura ficar de cima pra baixo.
    pools = list(reversed(pools))

    labels = [p["label"] for p in pools]
    giros = [p["turnover"] or 0 for p in pools]
    colors = [BAR_OK if p["isMonitorable"] else BAR_OFF for p in pools]

    altura = max(3.0, 0.62 * len(pools) + 1.6)
    fig, ax = plt.subplots(figsize=(9.5, altura))
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)

    bars = ax.barh(range(len(pools)), giros, color=colors, height=0.62)

    limite = max(giros) if giros else 1
    for i, (bar, p) in enumerate(zip(bars, pools)):
        # TVL e taxa ficam NA barra, não numa coluna à parte: é o que elimina
        # a necessidade de alinhamento entre colunas.
        apy = f"{p['apyBase']:.1f}%" if p.get("apyBase") is not None else "n/d"
        tvl = p["tvlUsd"] / 1e6
        texto = f"  giro {giros[i]:.2f}  ·  TVL ${tvl:.1f}M  ·  taxa {apy}"
        ax.text(
            bar.get_width() + limite * 0.015,
            bar.get_y() + bar.get_height() / 2,
            texto,
            va="center",
            color=VALUE_TEXT if p["isMonitorable"] else TEXT,
            fontsize=9.5,
            fontweight="bold" if p["isMonitorable"] else "normal",
        )

    ax.set_yticks(range(len(pools)))
    ax.set_yticklabels(labels, color=TEXT, fontsize=10)
    ax.set_xlabel("giro = volume 24h ÷ TVL (quantas vezes o pool gira por dia)", color=TEXT, fontsize=9.5)
    ax.set_title(f"{payload['pairKey']} — onde o capital trabalha mais", color=TEXT, fontsize=13, fontweight="bold", pad=14)

    # Espaço à direita pros rótulos não serem cortados. O rótulo tem largura
    # ~constante ("giro X · TVL $YM · taxa Z%"), então a folga é proporcional
    # à maior barra. 1.62 cortava o texto da primeira linha.
    ax.set_xlim(0, limite * 1.85)
    ax.grid(True, axis="x", color=GRID, linewidth=0.6, alpha=0.7)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.tick_params(colors=TEXT, labelsize=9)

    tem_apagada = any(not p["isMonitorable"] for p in pools)
    # rect reserva a faixa de baixo pro rodapé — sem isso ele imprime EM CIMA
    # do rótulo do eixo x.
    fig.tight_layout(rect=(0, 0.06 if tem_apagada else 0, 1, 1))
    if tem_apagada:
        fig.text(
            0.5,
            0.018,
            "barras apagadas = chains que o bot não acompanha (sem alerta de faixa nem P&L)",
            color=BAR_OFF,
            fontsize=8.5,
            ha="center",
        )
    fig.savefig(out_path, dpi=130, facecolor=BG)


if __name__ == "__main__":
    main()
