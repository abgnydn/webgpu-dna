# Hybrid IRT (intra-track) + GPU-SBS (inter-track) — design doc

> **STATUS: CLOSED by the E10Q kill criterion (2026-06-01).** The design's
> central bet — that far, dilute inter-track pairs tolerate large dt — is
> **false**. E10Q measured the single-pair bridge convergence at r₀ = 1, 10,
> 30, 100 nm and found the SBS/analytic ratio depends on dt but **not on
> separation** (≈0.74× at dt=0.05 ns for *all* r₀; none converge until
> dt ≲ 0.02 ns). The reason is fundamental: the time step must resolve the
> **encounter radius σ ≈ 0.44 nm**, giving `dt ≲ σ²/(2D) ≈ 0.02 ns`
> **independent of pair separation or density**. So the inter-track residual
> needs the *same* ~50k steps as the dense core — there is no cheap C2 phase.
> Combined with the cross-primary doc (O(N²) → native), this settles it:
> **the inter-track physics needs a native runtime.** Artifact:
> `experiments/results/2026-06-01/level-4/E10Q-farpair-killcriterion.json`.
> The design below is retained for provenance; do not implement formulation B.

Status: design only (CLOSED — see banner). Successor to two dead ends:
- `CROSS_PRIMARY_IRT_DESIGN.md` — cross-primary IRT is O(N²)-hard for a
  point source (E10k: 551 nm horizon spans the whole ~5 µm blob, ~71 hr
  in-browser, no spatial decomposition prunes it).
- `GPU_SBS_INTERTRACK_FINDINGS.md` — full GPU-SBS at the IRT/chem6 accuracy
  bar is not a win on laptop WebGPU (E10L/M/N/P: per-pair accuracy needs
  dt≈0.01–0.05 ns → ~20k+ steps; wall-clock budget is ~6k steps even fully
  compacted).

This doc proposes the one path neither wall rules out: **keep the validated
per-primary IRT for the dense intra-track chemistry, and use GPU-SBS only for
the sparse inter-track residual** — the reactions E10f showed close 96% of the
1 µs G(H₂) gap (ΔG(H₂) = +0.149).

## Why the split is physically well-posed

The intra/inter split is, to good approximation, a **time + density split**,
and that is exactly what makes each method land in its good regime:

- **Inter-track coupling is intrinsically late and dilute.** E10k stage B:
  >50% of cross-primary reactions come from pairs >100 nm apart. Two radicals
  100 nm apart only reach contact by diffusing ~100 nm, i.e. at
  t ≈ r²/(6D) ≈ 100²/(6·5) ≈ **330 ns**. So inter-track reactions are
  predominantly a 10 ns–1 µs phenomenon, in a population that has already
  ~halved (IRT @ 10 ns: G(OH) 2.3 vs 4.1 initial).
- **That regime is SBS's good one, per the measurements:**
  - sparse, well-separated pairs → large dt tolerable (the dt→0 accuracy
    constraint in E10N was measured at r₀=1 nm; far pairs admit larger dt —
    *this is the key open validation, see below*);
  - few eligible radicals + heavy compaction → cheap per-step (E10P:
    ~14 ms/Mrad, ~0 fixed floor);
  - the dense, close-pair chemistry that *forces* tiny dt is handled by IRT,
    not SBS.

So the hybrid hands each method the work it is good at. IRT keeps owning the
expensive-for-SBS dense core; SBS only adds the cheap-for-SBS dilute coupling.

## The core obstacle (state it up front)

**IRT and SBS are different representations and do not compose for free.** IRT
samples reaction *times* analytically and never moves radicals — a radical
that survives to 1 µs in the IRT worker still sits at its birth position.
SBS is *trajectory*-based and needs real positions to diffuse. So there is no
free handoff: the IRT survivors handed to SBS have no physically-diffused
positions.

Two ways to resolve this, with the recommendation:

- **(A) Inter-eligible SBS from t=0.** Run SBS (not IRT) from t=0 on the
  subset of radicals that can participate in inter-track coupling. Clean
  representation, but it re-does intra-track diffusion for those radicals and
  needs a rule for "inter-eligible" up front — and a radical's eligibility
  isn't known until it survives intra-track. Rejected as primary path:
  reintroduces the tiny-dt intra cost we're trying to avoid.
- **(B) IRT → position-reconstruction handoff → SBS. (recommended)** Run
  per-primary IRT to a handoff time `t_h` (e.g. 10 ns). For each radical still
  alive at `t_h`, reconstruct a diffused position by Brownian sampling
  consistent with survival: `x(t_h) = x₀ + N(0, 2·D·t_h)` per axis (this is
  the same displacement model the IRT worker already uses for product
  re-pairing, lines 524–531 of `irt-worker.js`). Seed GPU-SBS with that
  global pool and run the bridge-react SBS from `t_h` → 1 µs with large dt.
  The reconstruction is an approximation and **must be gated experimentally**
  (below), but it is the pragmatic bridge between the two representations.

## Algorithm (formulation B)

```
Phase C1 — per-primary IRT, t=0 → t_h   (existing worker, unchanged path)
  for each primary p:
    run IRT to t_h
    record: per-primary G-contribution at the standard checkpoints ≤ t_h
            survivors[p] = {pos0, species, birth_t} for radicals alive at t_h
  (radicals consumed intra-track before t_h are owned by C1 — never seen by C2)

Phase C2 — global GPU-SBS, t_h → 1 µs   (chemistry.wgsl bridge react)
  seed chem_pos from ALL primaries' survivors, with reconstructed positions
    x = pos0 + gauss()·sqrt(2·D·t_h)             // Brownian handoff sample
  run SBS with a growing dt schedule (large dt — dilute regime):
    diffuse → build_hash → bridge-react → compact(periodic)
  record G at checkpoints t_h < t ≤ 1 µs from the global pool

Reconcile
  G_total(t) = C1 checkpoints for t ≤ t_h
             = C2 global pool for t > t_h
  Both intra- AND inter-track reactions happen in C2 after t_h (the global
  pool mixes primaries), so C2 naturally captures the inter-track increment
  on top of continued intra-track. No subtraction needed — the handoff
  transfers ownership of all t>t_h chemistry to C2.
```

Double-counting is avoided by **ownership-by-time**: every reaction before
`t_h` is C1's, every reaction after is C2's. The only shared object is the
survivor set at `t_h`, transferred once.

## Cost projection (from measured numbers)

- Eligible population at `t_h`=10 ns ≈ survivors ≈ ~2–3 M of 5 M (IRT G-values
  at 10 ns are ~half initial). Conservatively 2.5 M.
- C2 step count: t_h→1 µs is ~3 decades; with growing dt in the dilute regime,
  target ~300–800 steps (vs the ~20k a *uniform* small-dt run would need —
  the dense phase that demanded small dt is already done in C1).
- C2 per-step @ 2.5 M, with compaction dropping it as radicals react:
  ~35 ms → falling. Total C2 ≈ 300–800 × ~20 ms (avg) ≈ **6–16 s**.
- C1 to 10 ns is a *fraction* of the full IRT run (the worker's 139 s is
  dominated by the long-time tail; stopping at 10 ns is far cheaper —
  needs measurement).

Net: the inter-track increment costs ~seconds on top of a *shortened* IRT
run. The hybrid is plausibly **faster than today's full IRT worker (194 s
end-to-end)** while adding the inter-track physics — the opposite of the
full-SBS result. This is the projection the prototype must confirm or refute.

## Validation chain

| Experiment | What | Pass bar |
|---|---|---|
| **E10N′ (NEW, cheap, do FIRST)** | single-pair bridge convergence at inter-track separations (r₀=50, 100, 200 nm), find the largest dt that still converges to analytic | establishes the C2 dt schedule; if even far pairs need tiny dt, formulation B is dead — kill here before building |
| E-handoff (NEW) | C1-to-10ns cost + survivor count + position-reconstruction sanity (reconstructed radial distribution vs a full-SBS-from-0 reference at 10 ns) | reconstruction within MC noise of full-SBS positions |
| E10M′ | hybrid G(species) @ 1 µs vs IRT worker AND vs the E10f no-partition reference | match E10f ΔG(H₂)=+0.149 within 5%; G(eaq)/G(OH) not worse than per-primary |
| convergence | hybrid G-values vs C2 step count | **converge** as steps rise (the test E10M failed for full-SBS) |
| primary-phase rows | E5d / E7b / E13c unchanged | CSDA/cascade/SSB are primary-phase; must not move |

The first row is the **kill criterion**: the entire hybrid rests on large dt
being accurate for *far* pairs. E10N proved it fails for close pairs; if it
also fails for far pairs, there is no cheap C2 and the browser-native inter-
track path is closed (→ native runtime, per the cross-primary doc). This is
~30 lines of Node (extend E10N), runs in seconds, and must pass before any
GPU/worker plumbing.

## Open problems / risks

1. **Position reconstruction at handoff.** IRT survivors have no trajectories;
   the Gaussian handoff is an approximation. Gated by E-handoff. If the
   reconstructed spatial correlations are wrong, the inter-track pair statistics
   (and thus the increment) are wrong.
2. **`t_h` choice.** Too early → C2 inherits the dense phase that needs tiny dt
   (cost wall returns). Too late → miss inter-track reactions that start
   before `t_h`. Likely a sweep; ~10 ns is the starting guess from the
   330 ns / >100 nm argument.
3. **Continued intra-track in C2.** After handoff, C2's global pool also
   re-runs intra-track chemistry (same-primary pairs) via SBS — which E10N
   says SBS does *less* accurately than IRT for close pairs. Mitigation: by
   `t_h` the surviving same-primary pairs are already the dilute tail, so the
   close-pair inaccuracy is small — but this must be checked (it's why the
   convergence + E10f-match rows both matter).
4. **Reduced GPU reaction set.** `chemistry.wgsl` models 7 reactions, missing
   eaq+H₂O₂ and H₃O⁺+OH⁻. For a production hybrid these must be added to C2.

## Effort

- E10N′ kill-criterion test: ~30 min (extend E10N). **Do this before anything
  else** — it can close the whole approach for the cost of one Node run.
- E-handoff cost/positions: ~1–2 hr (shorten the IRT worker to `t_h`, dump
  survivors, compare reconstruction to a full-SBS snapshot).
- Hybrid wiring (worker stop-at-`t_h` + survivor export + SBS seed + reconcile)
  + E10M′/convergence: ~1 day.

Recommended sequence: **E10N′ first.** If far-pair large-dt converges, the
projection holds and the build is worth a day. If not, document the closure
and the browser-native inter-track path is settled as "needs native runtime."

## What this does NOT claim

This is a design, not a result. The only measured inputs are E10L/M/N/P and
E10f/E10k. The cost projection (~6–16 s C2) and the "faster than full IRT"
claim are projections from those numbers, not measurements. The kill-criterion
test exists precisely so the approach can be falsified cheaply before the
day-long build.
