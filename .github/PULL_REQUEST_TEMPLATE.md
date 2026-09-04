# Pull request

## What changed
<!-- One paragraph: the physics/code/docs change. Link the protocol or diagnosis section if this is experiment work. -->

## Verification evidence (required — see `EXTENDING.md` §4)
<!-- Every claim below must be measured, not reasoned. Paste command + output tail. -->

- [ ] `npm run check` green (typecheck + lint + vitest): _paste tail_
- [ ] `npm run build` succeeds (if `src/`, `public/`, or shaders touched)
- [ ] Experiment artifacts (if physics changed): _list IDs + `experiments/results/<date>/` paths_
- [ ] README §Numbers row added/updated (if any number changed anywhere else): _link row_
- [ ] Honest negatives declared (if any experiment failed): _status + diagnosis_

```text
# paste: npm run check tail + artifact summary line(s) here
```

## Checklist (mirrors `EXTENDING.md` §4 — check each)
- [ ] New shader constants live in `src/shaders/helpers.wgsl` (visible in `env.shaderHashes`)
- [ ] Existing code paths preserved (new models are additive/selectable, not silent replacements)
- [ ] L1 bit-match artifact lands before any kernel change depending on it
- [ ] L2 track-structure validation passes, or fails honestly with a `PHYSICS_DIAGNOSIS.md` row
- [ ] No number in README/CLAUDE.md/index.html that isn't sourced from a committed JSON artifact
- [ ] No silent re-baselining (new artifact emitted, never overwritten)
- [ ] Commit message states `pass` / `noisy` / `fail (honest negative)` / `marquee closure`

## Risk notes for the reviewer
<!-- Buffer sizes, new fallbacks, changed gates, dropped events, anything a reviewer should stress. If none, write "none". -->
