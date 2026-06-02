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

## Status

- **Figures: real.** All six are generated from the committed artifacts by
  `figs/make_figs.py` (run it to regenerate `figs/fig*.pdf`). No placeholders.
- **References: verified.** Every entry in `refs.bib` was checked against the
  publisher (exact pages + DOI), 2026-06. No `[VERIFY]` tags remain. Two minor
  residuals are noted in the `.bib` header (a page range taken as the article
  span; one page range deferred to the DOI).

## Before submission — the remaining substantive item

- **`RECOMB_BOOST = 2.0` is an empirical knob with no physical basis**, and the
  chemistry $G$-values depend on it. The paper now states this explicitly and
  reports the yields as *agreement after tuning*, not a parameter-free
  validation (§3.3). The stronger fix a chemistry referee will want is to
  **remove the knob and report the parameter-free yields** — i.e. re-run the
  chemistry validation with `RECOMB_BOOST = 1.0` (and/or implement the
  super-excitation-autoionisation / Onsager-escape replacement). That is a
  GPU/worker re-run, not a text edit, and is the recommended next step before
  submitting the chemistry claims.

## Provenance

Every quantitative value in `main.tex` traces to `README.md` §Numbers and its
JSON artifacts. Insert the Zenodo DOI into the "Data and code availability"
section and the `\cite` placeholder once the v0.4.0 deposit mints one.
