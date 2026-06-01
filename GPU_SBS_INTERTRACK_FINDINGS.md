# GPU step-by-step (SBS) chemistry as the inter-track path — findings

Status: prototype + measurement, 2026-06-01. Outcome: **promising but not yet
a win at the IRT/chem6 accuracy bar on laptop WebGPU.** Honest-negative, with
a concrete path forward. Production default stays `DEFAULT_CHEM_BACKEND =
'worker'` (IRT). Kernel changes are additive and behind the GPU backend.

## Why this was tried

The cross-primary IRT fix is blocked (CROSS_PRIMARY_IRT addendum: the 551 nm
reaction horizon spans the whole point-source blob → O(N²)-hard, ~71 hr
in-browser, no spatial decomposition prunes it). The field-standard
alternative for inter-track radiolysis is **step-by-step (SBS)
diffusion-reaction on GPU (gMicroMC, MPEXS2.1)**, which maps onto the repo's
existing GPU chemistry kernel (`src/shaders/chemistry.wgsl`). Goal: keep IRT
for intra-track, add GPU-SBS for the inter-track coupling, stay browser-native.
First question: **can laptop WebGPU handle the SBS step count?**

## Experiments

All at 10 keV, N=4096 (the `dumps/rad_E10000_N4096.bin` dump, 4.97 M radicals),
compared to the cached IRT worker result. Artifacts under
`experiments/results/2026-06-01/level-4/`.

### E10L — per-step cost / step-count feasibility
Drove the existing SBS kernel with single-block schedules of increasing step
count; linear-fit wall-clock.

- **~110 ms/step** over the full 4.97 M-radical set (fixed overhead ~6 s).
  Cross-checks E11 (133 steps in 14.2 s → ~107 ms/step).
- The `np` knob does **not** reduce chemistry work — `chem_n = min(radN,
  CHEM_N)` always loads the full bin. So "reduced N" via `np` is a no-op;
  reducing primaries needs a smaller bin.
- **IRT parity budget = ~1,750 steps.** Naive uniform fine-stepping (the
  ~8,000 steps needed to stop H₃O⁺ teleporting past the 4.5 nm search radius
  at large dt) → **~15 min, 4.6× slower than IRT.** E11's "13.6× faster" was
  an artifact of running only 133 coarse (physically broken) steps.

### E10M — reaction-probability accuracy vs IRT
The 30 ns-step undercount is because the kernel used a naive end-position
contact test. Replaced it with (v1) the cumulative first-passage CDF, then
(v2) the correct per-step **Brownian-bridge** probability
`W = (σ/r₁)·exp[−(r₀−σ)(r₁−σ)/(D·dt)]` (needs pre-step positions → added
`chem_pos_old` buffer + binding 8; `diffuse` snapshots, `react` uses it).

G(species)/G(IRT) at 1 µs:

| schedule | steps | wall | OH | eaq | H | H₂ | H₂O₂ |
|---|---:|---:|---:|---:|---:|---:|---:|
| prod133 (bridge) | 133 | 10 s | 1.17× | 0.87× | 1.21× | 0.97× | 1.07× |
| fine (bridge) | 730 | 30 s | 0.62× | **0.27×** | 0.90× | 1.51× | 1.36× |

The bridge **improved the low-step result** (prod133 eaq 0.74→0.87×, H₂O₂
1.26→1.07×; most species within ~20% at **19× faster than IRT**) — but the
scheme is **non-convergent**: more steps → systematic over-reaction. A
low-step result that doesn't converge isn't controlled accuracy; it's
cancellation. So prod133 "looking good" cannot be trusted as physics.

### E10N — single-pair convergence (isolates the reaction model)
One diffusing OH+OH pair, bridge rule, vs the analytic Smoluchowski reaction
probability `W(T|r₀) = (σ/r₀)·erfc[(r₀−σ)/√(4·D·T)] = 0.433`:

| dt (ns) | steps | P_react | vs analytic |
|---:|---:|---:|---:|
| 4.0 | 25 | 0.060 | 0.14× |
| 1.0 | 100 | 0.112 | 0.26× |
| 0.25 | 400 | 0.191 | 0.44× |
| 0.05 | 2000 | 0.319 | 0.74× |
| 0.01 | 10000 | 0.403 | **0.93×** |

The bridge **converges to the exact value — but only as dt→0** (needs
~0.01 ns steps), and **under-reacts severely at large dt**. So the per-pair
model is correct in the small-dt limit; it is not a large-dt shortcut. The
multi-pair over-reaction in E10M at the same dt is a separate density effect
(fast per-step jumps re-sample many partners), compounding the problem.

### E10P — per-step cost vs radical count (the compaction lever)
Fixed 200-step schedule, swept the loaded radical count (proxy for late-time
compaction). Per-step cost vs N:

| radicals | ms/step |
|---:|---:|
| 0.5 M | 6.9 |
| 1.5 M | 16.3 |
| 3.0 M | 37.2 |
| 5.0 M | 68.9 |

- Fit: **~14 ms / million radicals, fixed floor ≈ 0** (−2.8 ms).
- **Refutes the "clear_hash is the floor" hypothesis** — clearing 8 M buckets
  every step is negligible; cost is ~entirely per-radical dispatch+react. So
  **compaction (dispatch only over alive radicals) cuts cost proportionally**,
  no hash surgery needed.
- But the win is bounded by how much the system dilutes: at 10 keV the track
  is dense and only ~half the radicals have reacted by 1 µs, so compaction
  buys only ~2× on late steps. Projected late per-step @ 2.5 M alive ≈ 32 ms
  → IRT-parity budget rises from ~1,750 to **~6,000 steps**.

## Verdict

**Naive GPU-SBS is not faster than IRT at the IRT/chem6 accuracy bar on
laptop WebGPU — and compaction alone does not close the gap.** The two
measurements collide:
- per-pair accuracy needs **dt ≈ 0.01–0.05 ns** (E10N) → **~20k–100k uniform
  steps** to reach 1 µs,
- the wall-clock budget to match IRT is **~1,750 steps** uncompacted (E10L),
  rising to only **~6,000 steps** with full compaction (E10P) — because the
  10 keV track barely dilutes by 1 µs.

So even with the biggest speed lever fully applied, the accuracy step-count
(~20k+) is still 3–10× over the wall-clock budget (~6k). There is no naive or
uniformly-compacted schedule that is both convergent-accurate and faster than
the existing IRT worker for this radical count. gMicroMC/MPEXS get their speed
from datacenter-GPU parallelism over many independent histories + variable dt
+ accepted approximations — not from a small step count.

### E10Q — the dt bound is set by σ, not density (closes the hybrid too)
The hybrid (`HYBRID_IRT_SBS_DESIGN.md`) bet that the sparse inter-track
residual would tolerate large dt. E10Q tested single-pair bridge convergence
across separations:

| r₀ (nm) | dt=4 | dt=1 | dt=0.25 | dt=0.05 |
|---:|---:|---:|---:|---:|
| 1 | 0.14× | 0.26× | 0.45× | 0.74× |
| 10 | 0.32× | 0.37× | 0.50× | 0.72× |
| 100 | 0.28× | 0.38× | 0.45× | 0.74× |

The convergence ratio is **independent of separation**. The SBS step must
resolve the encounter radius: `dt ≲ σ²/(2D) ≈ 0.02 ns` whatever the pair
distance. **Dilution lowers per-step cost (E10P) but not step count** — far
pairs need the same ~50k steps as close ones. This closes the *hybrid* path
as well as full-SBS: on laptop WebGPU there is no SBS schedule (full or
inter-track-only) that beats the IRT worker at the accuracy bar.

## Convergent conclusion across both design docs

`CROSS_PRIMARY_IRT_DESIGN.md` (O(N²) horizon) and this doc (σ-bounded step
count) reach the **same** end: the inter-track chemistry physics (E10f's
ΔG(H₂)=+0.149, the last big chem6 gap) is **not reachable browser-native** —
it needs a **native runtime** (Node/Deno + wgpu-native), where either the
naive cross-primary IRT (RAM is cheap) or GPU-SBS parallelised over the ~50k
steps becomes tractable. The browser stays the demo/validation surface; the
inter-track production run moves off-browser.

## What would make it competitive (not yet done)

1. **Per-step cost ≪ 110 ms.** The kernel clears all 8 M hash buckets and
   dispatches over all 5 M slots every step, even when most radicals have
   reacted. **Compaction** (drop dead radicals; dilute late steps become
   cheap) + occupied-cell-only clearing + a smaller/adaptive hash could cut
   per-step cost by 1–2 orders at late times, where most steps live.
2. **Variable dt tied to local density**, with the small-dt regime only where
   pairs are close. This is the actual gMicroMC/MPEXS scheme.
3. **The hybrid is still attractive for a different reason:** run IRT for the
   dense intra-track chemistry (where it's accurate and the SBS would need the
   tiniest dt), and GPU-SBS *only* for the sparse inter-track residual — few
   pairs, larger dt tolerable, the bridge is in its accurate regime. This
   needs a clean intra/inter split (the temporal-concurrency problem noted in
   the cross-primary doc) but sidesteps both the O(N²) IRT blowup and the
   tiny-dt cost wall.

## State of the code

- `chemistry.wgsl`: `react` now uses the Brownian-bridge probability (correct
  in the dt→0 limit; a strict improvement over naive contact for the GPU
  backend). `erfc_ns`/`Dk` helpers added. `chem_pos_old` snapshot in `diffuse`.
- `buffers.ts` / `pipelines.ts`: additive `chemPosOld` buffer + binding 8.
- `schedule.ts` / `bench-chem.ts`: additive `scheduleOverride` for the probes.
- `DEFAULT_CHEM_BACKEND` unchanged (`'worker'`). **46/46 unit tests pass.**
- No §Numbers rows added — these are method-prototype measurements, not
  validated physics ratios.
