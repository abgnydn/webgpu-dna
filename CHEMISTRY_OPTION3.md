# Geant4-DNA `G4EmDNAChemistry_option3` reaction table (chem6's chemistry)

Extracted verbatim from `G4EmDNAChemistry_option3.cc` (Geant4 **11.4.1** — the
validation oracle). This is the chemistry `chem6` registers; the project's
`irt-worker.js` currently implements only the ~9 non-oxygen reactions. Porting
the **oxygen network** (O2, HO2, O2⁻, O3, O(³P), O⁻, …) is what unlocks the
oxygen effect / OER and realistic proton RBE. Rates in ×10¹⁰ M⁻¹s⁻¹ unless shown.

**52 reactions total; 43 involve the oxygen network.**

## Reactions the project ALREADY has (port target: keep)

- `0.503e10`  *H + *H -> H2
- `2.50e10`  e_aq + H* + H2O -> H2 + OH-
- `0.636e10`  e_aq + e_aq + 2H2O -> H2 + 2OH-
- `1.13e11`  H3O+ + OH- -> 2H2O
- `1.55e10`  *OH + *H -> H2O
- `2.51e7`  H + OH- -> eaq-
- `3.28e7`  OH + H2 -> H
- `2.95e10`  e_aq + *OH -> OH-
- `2.11e10`  e_aq + H3O+ -> H* + H2O

## Oxygen-network reactions to PORT (project has none)

- `2.02e10`  H + O(3p) -> OH
- `2.00e10`  H + O- -> OH-
- `2.02e10`  OH + O(3p) -> HO2
- `2.02e10`  HO2 + O(3p) -> O2
- `2.20e10`  O(3p) + O(3p) -> O2
- `9.0e10`  H3O+ + O3- -> OH + O2
- `3.50e7`  H + H2O2 -> OH
- `2.10e10`  H + O2 -> HO2
- `1.00e10`  H + HO2 -> H2O2
- `1.00e10`  H + O2- -> HO2-
- `0.55e10`  *OH + *OH -> H2O2
- `2.88e7`  OH + H2O2 -> HO2
- `6.30e9`  OH + OH- -> O-
- `7.90e9`  OH + HO2 -> O2
- `1.07e10`  OH + O2- -> O2 + OH-
- `8.32e9`  OH + HO2- -> HO2 + OH-
- `1.00e9`  OH + O- -> HO2-
- `8.50e9`  OH + O3- -> O2- + HO2
- `1.10e10`  e_aq + H2O2 -> OH- + *OH
- `4.71e8`  H2O2 + OH- -> HO2-
- `1.60e9`  H2O2 + O(3p) -> HO2 + OH
- `5.55e8`  H2O2 + O- -> HO2 + OH-
- `4.77e3`  H2 + O(3p) -> H + OH
- `1.21e8`  H2 + O- -> H + OH-
- `1.74e10`  eaq- + O2 -> O2-
- `1.29e10`  eaq + HO2 -> HO2-
- `6.30e9`  OH- + HO2 -> O2-
- `4.20e8`  OH- + O(3p) -> HO2-
- `4.00e9`  O2 + O(3p) -> O3
- `3.70e9`  O2 + O- -> O3-
- `9.80e5`  HO2 + HO2 -> H2O2 + O2
- `9.70e7`  HO2 + O2- -> HO2- + O2
- `5.30e9`  HO2- + O(3p) -> O2- + OH
- `1.29e10`  e_aq + O2- -> H2O2 + OH- + OH-
- `3.51e9`  e_aq + HO2- -> O- + OH-
- `2.31e10`  e_aq + O- -> OH- + OH-
- `4.78e10`  H3O+ + O2- -> HO2
- `5.00e10`  H3O+ + HO2- -> H2O2
- `4.78e10`  H3O+ + O- -> OH
- `6.00e8`  O2- + O- -> O2 + OH- + OH-
- `3.50e8`  HO2- + O- -> O2- + OH-
- `1.00e8`  O- + O- -> H2O2 + OH- + OH-
- `7.00e8`  O- + O3- -> O2- + O2-
