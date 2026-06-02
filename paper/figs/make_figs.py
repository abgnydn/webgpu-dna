#!/usr/bin/env python3
"""Generate the paper figures from committed experiment artifacts.
Run: python3 paper/figs/make_figs.py  (writes fig*.pdf into paper/figs/).
Every data array is annotated with its source artifact / README §Numbers row."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
import os

plt.rcParams.update({
    "font.family": "serif", "font.size": 9, "axes.linewidth": 0.6,
    "figure.dpi": 150, "savefig.bbox": "tight", "axes.grid": False,
})
OUT = os.path.dirname(__file__)
def save(fig, name):
    fig.savefig(os.path.join(OUT, name)); plt.close(fig)

# ---- Fig 1: pipeline schematic ----
fig, ax = plt.subplots(figsize=(6.2, 1.9)); ax.axis("off"); ax.set_xlim(0, 10); ax.set_ylim(0, 3)
boxes = [(0.3, "Phase A\nfused primaries", "one GPU thread/\nprimary, full\nhistory in a loop", "#dbe9ff"),
         (3.6, "Phase B\nsecondary wavefront", "1 dispatch per\nstep, all alive\nsecondaries", "#e7f5e0"),
         (6.9, "Phase C\nIRT chemistry", "Karamitros 9-rxn\nIRT, Web Worker\n(CPU)", "#fdeede")]
for x, title, sub, col in boxes:
    ax.add_patch(FancyBboxPatch((x, 0.7), 2.7, 1.6, boxstyle="round,pad=0.05",
                                fc=col, ec="#444", lw=0.8))
    ax.text(x + 1.35, 1.95, title, ha="center", va="center", fontsize=8.5, fontweight="bold")
    ax.text(x + 1.35, 1.15, sub, ha="center", va="center", fontsize=6.8)
for x0 in (3.0, 6.3):
    ax.add_patch(FancyArrowPatch((x0, 1.5), (x0 + 0.6, 1.5), arrowstyle="-|>",
                                 mutation_scale=12, color="#444", lw=1.0))
ax.text(5, 0.25, "atomic fixed-point voxel grid (dose / radicals)", ha="center", fontsize=6.5, style="italic", color="#555")
save(fig, "fig1_pipeline.pdf")

# ---- Fig 2: CSDA ratio vs energy, pre/post joint-fix  [artifact E5d] ----
E = [100, 300, 500, 1000, 3000, 5000, 10000, 20000]
pre = [0.588, 0.705, 0.776, 0.864, 0.965, 0.975, 0.988, 0.992]
post = [0.736, 0.810, 0.857, 0.912, 0.983, 0.984, 0.994, 0.996]
fig, ax = plt.subplots(figsize=(3.3, 2.5))
ax.axhline(1.0, color="#999", lw=0.7, ls="--")
ax.semilogx(E, pre, "o-", color="#c44", ms=4, lw=1.2, label="pre joint-fix")
ax.semilogx(E, post, "s-", color="#268", ms=4, lw=1.2, label="post joint-fix")
ax.set_xlabel("primary energy (eV)"); ax.set_ylabel("CSDA range  WebGPU / Geant4")
ax.set_ylim(0.5, 1.05); ax.legend(frameon=False, fontsize=7, loc="lower right")
save(fig, "fig2_csda.pdf")

# ---- Fig 3: G(t) WebGPU (parameter-free, RECOMB=1.0) vs chem6 1us  [artifact E10r] ----
t = [1e-4, 1e-3, 1e-2, 0.1, 1, 10, 100, 1000]
G = {"OH": [4.333,4.318,4.222,3.842,3.079,2.372,1.890,1.563],
     "e$^-_{aq}$": [3.754,3.742,3.680,3.460,3.013,2.423,1.862,1.453],
     "H": [0.657,0.657,0.652,0.636,0.619,0.640,0.658,0.659],
     "H$_2$": [0.136,0.139,0.146,0.168,0.216,0.295,0.387,0.461],
     "H$_2$O$_2$": [0.028,0.032,0.054,0.148,0.346,0.493,0.555,0.589]}
chem6 = {"OH": 1.710, "e$^-_{aq}$": 1.694, "H": 0.710, "H$_2$": 0.622, "H$_2$O$_2$": 0.850}
cols = {"OH": "#268", "e$^-_{aq}$": "#c44", "H": "#693", "H$_2$": "#92c", "H$_2$O$_2$": "#e80"}
fig, ax = plt.subplots(figsize=(3.5, 2.6))
for k, v in G.items():
    ax.semilogx(t, v, "-", color=cols[k], lw=1.3, label=k)
    ax.plot(1000, chem6[k], "o", mfc="none", mec=cols[k], ms=7, mew=1.3)
ax.set_xlabel("time (ns)"); ax.set_ylabel("G (molecules / 100 eV)")
ax.legend(frameon=False, fontsize=6.5, ncol=2, loc="upper right")
ax.text(0.02, 0.02, "lines = WebGPU,  open ○ = chem6 @ 1 µs", transform=ax.transAxes, fontsize=6, style="italic")
save(fig, "fig3_gvalues.pdf")

# ---- Fig 4: G(eaq) V-shape vs energy  [artifact E10] ----
Ev = [1, 3, 5, 10, 20]; geaq = [1.181, 1.029, 1.144, 1.379, 1.613]
fig, ax = plt.subplots(figsize=(3.2, 2.4))
ax.semilogx(Ev, geaq, "o-", color="#c44", ms=5, lw=1.3)
ax.annotate("1→3 keV dip\n(126σ, E10b)", xy=(3, 1.029), xytext=(4.2, 1.10),
            fontsize=6.5, arrowprops=dict(arrowstyle="->", lw=0.7))
ax.set_xlabel("primary energy (keV)"); ax.set_ylabel("G(e$^-_{aq}$) @ 1 µs")
ax.set_xticks(Ev); ax.set_xticklabels([str(x) for x in Ev])
save(fig, "fig4_vshape.pdf")

# ---- Fig 5: kill criterion — bridge convergence vs dt, separation-independent  [E10Q] ----
dt = [4, 1, 0.25, 0.05]
R = {"1 nm": [0.142,0.259,0.449,0.735], "10 nm": [0.317,0.374,0.500,0.720],
     "30 nm": [0.302,0.390,0.512,0.749], "100 nm": [0.284,0.383,0.446,0.735]}
fig, ax = plt.subplots(figsize=(3.3, 2.4))
ax.axhline(1.0, color="#999", lw=0.7, ls="--")
for k, v in R.items():
    ax.semilogx(dt, v, "o-", ms=4, lw=1.1, label="r$_0$ = " + k)
ax.set_xlabel("time step Δt (ns)"); ax.set_ylabel("SBS / analytic reaction prob.")
ax.set_ylim(0, 1.05); ax.legend(frameon=False, fontsize=6.5, loc="upper left")
ax.text(0.97, 0.05, "curves overlap →\nbound set by σ, not r$_0$", transform=ax.transAxes,
        ha="right", fontsize=6, style="italic")
save(fig, "fig5_killcrit.pdf")

# ---- Fig 6: performance  [§Numbers E15b/E15c/E16/E15b] ----
labels = ["tracking\nvs G4 ST", "tracking\nvs G4 MT-8", "kernel\nfusion", "end-to-end\nvs G4 ST"]
vals = [455, 280, 40, 1.48]; colsb = ["#268", "#39a", "#693", "#c44"]
fig, ax = plt.subplots(figsize=(3.3, 2.4))
bars = ax.bar(labels, vals, color=colsb, width=0.6)
ax.set_yscale("log"); ax.set_ylabel("speedup ×  (log scale)")
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width()/2, v*1.1, f"{v:g}×", ha="center", fontsize=7.5, fontweight="bold")
ax.tick_params(axis="x", labelsize=7); ax.set_ylim(1, 1000)
save(fig, "fig6_perf.pdf")

print("wrote 6 figures to", OUT)
