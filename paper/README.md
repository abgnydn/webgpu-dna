# Paper — WebGPU Geant4-DNA preprint

arXiv-style LaTeX manuscript for the project. **Draft** — see the two caveats
below before submission.

## Build

```bash
# TinyTeX / TeX Live with latexmk:
latexmk -pdf main.tex          # → main.pdf (runs pdflatex + bibtex + 2×pdflatex)
latexmk -C main.tex            # clean aux files

# or manually:
pdflatex main && bibtex main && pdflatex main && pdflatex main
```

Requires the `siunitx` package (`tlmgr install siunitx` on a minimal TinyTeX).

## Before submission — two must-dos

1. **Verify every `[VERIFY]` reference in `refs.bib`.** Several entries have
   author/venue/year at best-effort confidence but unconfirmed volume/pages.
   A wrong citation is a hard error — confirm each against the publisher. Only
   `agostinelli2003geant4`, `hissoiny2011gpumcd`, and `icru31` are marked
   `[HIGH]` confidence.
2. **Replace the figure placeholders with real plots.** Figures 1–6 are framed
   placeholders whose captions specify exactly which committed artifact under
   `experiments/results/` to plot (e.g. Fig.~2 from E5b/E5d, Fig.~4 from
   E10/E10b/E10d, Fig.~6 from E15*/E16). The numbers in the *tables* are final
   and sourced from README §Numbers.

## Provenance

Every quantitative value in `main.tex` traces to `README.md` §Numbers and its
JSON artifacts. Insert the Zenodo DOI into the "Data and code availability"
section and the `\cite` placeholder once the v0.4.0 deposit mints one.
