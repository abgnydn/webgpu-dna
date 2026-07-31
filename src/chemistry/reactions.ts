/**
 * Reaction tables + analytical sampling helpers.
 *
 * The contact-probability variant (`IRT_REACTIONS`) is what the GPU chemistry
 * kernel uses (and the unused reference `irtChemistry()` in irt.ts).
 * The Onsager variant (`IRT_RXN_ONSAGER`) is used only by the unused reference
 * `runChemistryIRT()` in irt.ts — neither is a runtime fallback.
 */

import type { ReactionTuple } from '../physics/types';
import { IRT_D, IRT_REACTIONS, IRT_RXN_ONSAGER } from '../physics/constants';

export { IRT_D, IRT_REACTIONS, IRT_RXN_ONSAGER };

/** Find a contact-probability reaction for an unordered species pair. */
export function findReaction(sa: number, sb: number): ReactionTuple | undefined {
  const a = Math.min(sa, sb);
  const b = Math.max(sa, sb);
  for (const r of IRT_REACTIONS) if (r[0] === a && r[1] === b) return r;
  return undefined;
}

/** Find an Onsager-screened reaction (used by the long-time IRT fallback). */
export function findReactionOnsager(sa: number, sb: number): ReactionTuple | undefined {
  const a = Math.min(sa, sb);
  const b = Math.max(sa, sb);
  for (const r of IRT_RXN_ONSAGER) if (r[0] === a && r[1] === b) return r;
  return undefined;
}

/** Winitzki inverse error function — |x| < 1, accurate to ~1e-4. */
export function erfinv(x: number): number {
  const a = 0.147;
  const ln1mx2 = Math.log(1 - x * x);
  const t1 = 2 / (Math.PI * a) + ln1mx2 / 2;
  const t2 = ln1mx2 / a;
  const sign = x >= 0 ? 1 : -1;
  return sign * Math.sqrt(Math.sqrt(t1 * t1 - t2) - t1);
}

/** Inverse complementary error function — built on erfinv. */
export function erfcInv(p: number): number {
  return erfinv(1 - p);
}

/**
 * Rational approximation of erfcinv used by the `runChemistryIRT` fallback
 * (matches the HTML exactly — slightly different numerical regime than
 * `erfcInv` above).
 */
export function erfcinv(x: number): number {
  if (x <= 0 || x >= 2) return 0;
  const p = x > 1 ? 2 - x : x;
  const t = Math.sqrt(-2 * Math.log(p / 2));
  let y = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) /
              (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
  y *= 0.7071067811865475; // /sqrt(2)
  return x > 1 ? -y : y;
}

/**
 * Smoluchowski first-passage time sampling with optional Onsager screening.
 * Returns t ≥ 0 if a reaction will occur, -1 otherwise.
 */
export function sampleIRT(r0: number, sigma: number, rc: number, D: number): number {
  if (sigma <= 0 || D <= 0) return -1;
  if (r0 <= sigma) return 0;
  let r0e = r0;
  if (rc !== 0) r0e = -rc / (1 - Math.exp(rc / r0));
  const Winf = sigma / r0e;
  const U = Math.random();
  if (U <= 0 || U >= Winf) return -1;
  const ei = erfcinv(r0e * U / sigma);
  if (Math.abs(ei) < 1e-10) return -1;
  const dr = r0e - sigma;
  return 0.25 * dr * dr / (D * ei * ei);
}
