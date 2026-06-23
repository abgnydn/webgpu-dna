# `ci/` — staged workflow (pending activation)

## `webgpu-smoke.yml`

This is the **headless WebGPU smoke** GitHub Actions workflow. It lives here, not
in `.github/workflows/`, only because the automation token that authored it lacks
the GitHub `workflow` OAuth scope (both `git push` and the contents API refuse to
write `.github/workflows/*` without it). It is otherwise complete and ready.

**To activate it** (needs a token/login with `workflow` scope, e.g. your own):

```bash
git mv ci/webgpu-smoke.yml .github/workflows/webgpu-smoke.yml
git commit -m "ci: activate headless WebGPU smoke workflow"
git push
```

(Or paste the file via GitHub's web *Add file → Create new file* editor at
`.github/workflows/webgpu-smoke.yml`.)

It is marked `continue-on-error: true` (non-blocking), so it cannot fail PRs while
the software-WebGPU bring-up is proven on a real runner. Once it has a first green
run, remove that line to make it gating. What it does: runs the real shipped WGSL
shaders on a software WebGPU adapter — see `experiments/tools/webgpu-smoke.mjs`
and README §Numbers (reproducibility tiers, "GPU coverage in CI").
