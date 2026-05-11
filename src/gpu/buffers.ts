/**
 * GPU buffer allocation with typed sizes.
 */
import { MAX_SEC, MAX_RAD, CHEM_N, VC, HASH_SIZE } from '../physics/constants';

export interface GPUBuffers {
  // Primary phase
  params: GPUBuffer;        // 64B uniform
  results: GPUBuffer;       // np × 32B
  resultsRB: GPUBuffer;     // readback
  rng: GPUBuffer;           // np × 16B
  dbg: GPUBuffer;           // 32B atomic counters
  dbgRB: GPUBuffer;

  // Shared (primary + secondary)
  dose: GPUBuffer;          // VC³ × 4B = 8MB
  doseRB: GPUBuffer;
  counters: GPUBuffer;      // 32B atomic
  countersRB: GPUBuffer;
  radBuf: GPUBuffer;        // MAX_RAD × 16B
  radBufRB: GPUBuffer;

  // Secondary phase
  secBuf: GPUBuffer;        // MAX_SEC × 48B
  secParams: GPUBuffer;     // 48B uniform
  secStats: GPUBuffer;      // 32B
  secStatsRB: GPUBuffer;

  // Chemistry phase
  chemUni: GPUBuffer;       // 16B uniform
  chemPos: GPUBuffer;       // CHEM_N × 16B
  chemPosRB: GPUBuffer;
  chemAlive: GPUBuffer;     // CHEM_N × 4B
  chemAliveRB: GPUBuffer;
  chemRng: GPUBuffer;       // CHEM_N × 16B
  chemStats: GPUBuffer;     // 128B
  chemStatsRB: GPUBuffer;
  chemCellHead: GPUBuffer;  // HASH_SIZE × 4B
  chemNextIdx: GPUBuffer;   // CHEM_N × 4B
}

const S = GPUBufferUsage.STORAGE;
const U = GPUBufferUsage.UNIFORM;
const C = GPUBufferUsage.COPY_SRC;
const D = GPUBufferUsage.COPY_DST;
const R = GPUBufferUsage.MAP_READ;

export function allocateBuffers(device: GPUDevice, np: number): GPUBuffers {
  const mk = (size: number, usage: number) =>
    device.createBuffer({ size, usage });

  const doseSize = VC * VC * VC * 4;

  return {
    params: mk(64, U | D),
    results: mk(np * 32, S | C),
    resultsRB: mk(np * 32, D | R),
    rng: mk(np * 16, S | D),
    dbg: mk(32, S | C | D),
    dbgRB: mk(32, D | R),

    dose: mk(doseSize, S | C | D),
    doseRB: mk(doseSize, D | R),
    counters: mk(32, S | C | D),
    countersRB: mk(32, D | R),
    radBuf: mk(MAX_RAD * 16, S | C | D),
    radBufRB: mk(MAX_RAD * 16, D | R),

    // COPY_SRC added 2026-05-11 so E8 can read back the secondary buffer for
    // the KE-spectrum experiment. Production Phase A/B never read sec_buf
    // CPU-side, so this is bench-only — small alignment cost, no behavior change.
    secBuf: mk(MAX_SEC * 48, S | C | D),
    secParams: mk(48, U | D),
    secStats: mk(32, S | C | D),
    secStatsRB: mk(32, D | R),

    chemUni: mk(16, U | D),
    chemPos: mk(CHEM_N * 16, S | C | D),
    chemPosRB: mk(CHEM_N * 16, D | R),
    chemAlive: mk(CHEM_N * 4, S | C | D),
    chemAliveRB: mk(CHEM_N * 4, D | R),
    chemRng: mk(CHEM_N * 16, S | D),
    chemStats: mk(128, S | C | D),
    chemStatsRB: mk(128, D | R),
    chemCellHead: mk(HASH_SIZE * 4, S | D),
    chemNextIdx: mk(CHEM_N * 4, S | D),
  };
}

/**
 * SplitMix-style deterministic seed for the per-primary RNG state buffer.
 * Matches seedRNG() in public/geant4dna.html exactly.
 */
export function seedPrimaryRNG(device: GPUDevice, rng: GPUBuffer, np: number, seed: number): void {
  const d = new Uint32Array(np * 4);
  for (let i = 0; i < np; i++) {
    let s = ((i + 1) * 2654435761 + seed * 1013904223) >>> 0;
    const b = i * 4;
    for (let j = 0; j < 4; j++) {
      s ^= s >>> 16;
      s = Math.imul(s, 0x45d9f3b);
      s ^= s >>> 16;
      d[b + j] = (s + j * 0x9E3779B9) >>> 0;
    }
  }
  device.queue.writeBuffer(rng, 0, d);
}

/** Seed the per-radical chemistry RNG. Matches the inline loop in runChemistry(). */
export function seedChemRNG(device: GPUDevice, chemRng: GPUBuffer, chemN: number): void {
  const rngSeed = new Uint32Array(chemN * 4);
  for (let i = 0; i < chemN; i++) {
    let s = ((i + 1) * 2246822519) >>> 0;
    for (let j = 0; j < 4; j++) {
      s ^= s >>> 16;
      s = Math.imul(s, 0x45d9f3b);
      s ^= s >>> 16;
      rngSeed[i * 4 + j] = (s + j * 0x9E3779B9) >>> 0;
    }
  }
  device.queue.writeBuffer(chemRng, 0, rngSeed);
}
