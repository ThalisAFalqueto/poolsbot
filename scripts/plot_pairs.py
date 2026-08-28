#!/usr/bin/env python3
"""Gera um PNG comparando o mesmo par de tokens entre chains — o gráfico do
/comparar.

Duas métricas possíveis, e o gráfico NUNCA mistura as duas (ver PairPlotMetric
em plot-pairs.ts):

  metric="apr"       barras = retorno MEDIDO on-chain de uma posição de
                     referência ($1.000 numa faixa de ±3%), enquanto em faixa.
                     É o número que decide quanto você ganha de verdade.
  metric="turnover"  barras = giro (volume 24h / TVL), estimado da DefiLlama.
                     Só usado quando não houve medição suficiente.

Uso: python3 plot_pairs.py '<json>' <caminho_saida.png>

JSON esperado: pairKey (string), metric (string), pools (lista de {label,
turnover, tvlUsd, apyBase, aprInRange, isMonitorable}).
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
LLAMA = "#f0a35e"        # o número da DefiLlama, pra contraste


def main():
    payload = json.loads(sys.argv[1])
    out_path = sys.argv[2]

    pools = payload["pools"]
    metric = payload.get("metric", "turnover")
    if not pools:
        raise SystemExit("sem pools pra plotar")

    # Maior valor no topo: o eixo Y do matplotlib cresce pra cima, então a
    # lista é invertida pra a leitura ficar de cima pra baixo.
    pools = list(reversed(pools))

    labels = [p["label"] for p in pools]
    if metric == "apr":
        valores = [(p.get("aprInRange") or 0) * 100 for p in pools]
        eixo = "retorno anualizado de $1.000 numa faixa de ±3%, ENQUANTO em faixa (%)"
        titulo = f"{payload['pairKey']} — quanto cada pool paga de verdade"
    else:
        valores = [p["turnover"] or 0 for p in pools]
        eixo = "giro = volume 24h ÷ TVL (quantas vezes o pool gira por dia)"
        titulo = f"{payload['pairKey']} — onde o capital trabalha mais"

    colors = [BAR_OK if p["isMonitorable"] else BAR_OFF for p in pools]

    altura = max(3.0, 0.62 * len(pools) + 1.7)
    fig, ax = plt.subplots(figsize=(9.5, altura))
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)

    bars = ax.barh(range(len(pools)), valores, color=colors, height=0.62)

    limite = max(valores) if valores else 1
    for i, (bar, p) in enumerate(zip(bars, pools)):
        # Os detalhes ficam NA barra, não numa coluna à parte: é o que elimina
        # a necessidade de alinhamento entre colunas.
        apy = f"{p['apyBase']:.1f}%" if p.get("apyBase") is not None else "n/d"
        tvl = p["tvlUsd"] / 1e6
        if metric == "apr":
            # O apyBase aparece ao lado DE PROPÓSITO: a diferença entre os dois
            # é a coisa mais informativa do gráfico (a DefiLlama divide por TVL
            # e ignora a liquidez fora de faixa).
            texto = f"  {valores[i]:.0f}%/ano  ·  TVL ${tvl:.1f}M  ·  DefiLlama dizia {apy}"
        else:
            texto = f"  giro {valores[i]:.2f}  ·  TVL ${tvl:.1f}M  ·  taxa {apy}"
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
    ax.set_xlabel(eixo, color=TEXT, fontsize=9.5)
    ax.set_title(titulo, color=TEXT, fontsize=13, fontweight="bold", pad=14)

    # Espaço à direita pros rótulos não serem cortados. O rótulo tem largura
    # ~constante, então a folga é proporcional à maior barra.
    ax.set_xlim(0, limite * 1.95)
    ax.grid(True, axis="x", color=GRID, linewidth=0.6, alpha=0.7)
    ax.set_axisbelow(True)
    for spine in ax.spines.values():
        spine.set_color(GRID)
    ax.tick_params(colors=TEXT, labelsize=9)

    rodape = []
    if any(not p["isMonitorable"] for p in pools):
        rodape.append("barras apagadas = chains que o bot não acompanha")
    if metric == "apr":
        rodape.append("medido on-chain (feeGrowthGlobal, janela de 3 dias) — não é o apyBase da DefiLlama")
    # rect reserva a faixa de baixo pro rodapé — sem isso ele imprime EM CIMA
    # do rótulo do eixo x.
    fig.tight_layout(rect=(0, 0.07 if rodape else 0, 1, 1))
    if rodape:
        fig.text(0.5, 0.018, "  ·  ".join(rodape), color=BAR_OFF, fontsize=8.5, ha="center")
    fig.savefig(out_path, dpi=130, facecolor=BG)


if __name__ == "__main__":
    main()
