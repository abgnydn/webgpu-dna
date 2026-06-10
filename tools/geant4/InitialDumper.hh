#ifndef InitialDumper_h
#define InitialDumper_h 1
#include "G4UserTimeStepAction.hh"
#include "G4ITTrackHolder.hh"
#include "G4Scheduler.hh"
#include "G4Molecule.hh"
#include "G4Track.hh"
#include "G4SystemOfUnits.hh"
#include <fstream>

class InitialDumper : public G4UserTimeStepAction {
  bool fDumped = false;
public:
  InitialDumper() = default;
  ~InitialDumper() override = default;
  void StartProcessing() override { fDumped = false; }
  void UserPreTimeStepAction() override {
    if (fDumped) return;
    auto* holder = G4ITTrackHolder::Instance();
    if (!holder) return;
    auto* list = holder->GetMainList();
    if (!list) return;
    // dump only once the water cation/excited parents have all decayed to radicals
    bool hasWaterParent = false;
    for (auto it = list->begin(); it != list->end(); ++it) {
      G4Molecule* mol = GetMolecule(*it);
      if (mol && mol->GetName().rfind("H2O", 0) == 0) { hasWaterParent = true; break; }
    }
    if (hasWaterParent) return;
    fDumped = true;
    double t = G4Scheduler::Instance()->GetGlobalTime()/CLHEP::picosecond;
    std::ofstream f("/tmp/chem6_initial.txt", std::ios::app);
    f << "# dumped at t=" << t << " ps\n";
    for (auto it = list->begin(); it != list->end(); ++it) {
      G4Track* trk = *it;
      if (!trk) continue;
      G4Molecule* mol = GetMolecule(trk);
      if (!mol) continue;
      G4ThreeVector p = trk->GetPosition();
      f << mol->GetName() << " " << p.x()/nm << " " << p.y()/nm << " " << p.z()/nm << "\n";
    }
  }
};
#endif
