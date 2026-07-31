/** ESTAR reference CSDA ranges for liquid water (NIST) */
export interface EstarEntry {
  E: number;     // eV
  csda: number;  // nm
  sp: number;    // eV/nm
}

export const ESTAR: readonly EstarEntry[] = [
  { E: 100,   csda: 2.4,    sp: 58.0 },
  { E: 300,   csda: 9.5,    sp: 35.0 },
  { E: 500,   csda: 16.8,   sp: 23.4 },
  { E: 1000,  csda: 48.2,   sp: 12.1 },
  { E: 3000,  csda: 293,    sp: 5.18 },
  { E: 5000,  csda: 685,    sp: 3.81 },
  { E: 10000, csda: 2515,   sp: 2.29 },
  { E: 20000, csda: 8570,   sp: 1.33 },
];
