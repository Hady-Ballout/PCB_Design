// Physical-realizability checks over a built breadboard model. Pure and
// standalone (no imports from breadboardModel.js, to stay cycle-free).
// verifyBoardConnectivity asks "does the wiring realize the netlist?"; these
// ask "can the wiring exist on real hardware?" — a distinction the test
// campaign proved matters: same-net collisions pass connectivity (TC3).

const GROUND = '0';
const isRail = (holeOrKey) => String(holeOrKey.strip ?? holeOrKey).startsWith('rail');
const holeKey = (hole) => `${hole.strip}:${hole.row ?? 0}:${hole.column}`;
const holeName = (hole) => (isRail(hole) ? `${hole.strip} col${hole.column}` : `${hole.strip} r${hole.row} c${hole.column}`);

export function checkPhysicalModel(model) {
  const issues = [];
  checkOccupancy(model, issues);
  return issues;
}

function checkOccupancy(model, issues) {
  const occupants = new Map();
  const claim = (holeAddr, label) => {
    if (!holeAddr) return;
    const key = holeKey(holeAddr);
    if (!occupants.has(key)) occupants.set(key, []);
    occupants.get(key).push({ label, holeAddr });
  };
  (model.parts ?? []).forEach((part) =>
    (part.holes ?? []).forEach((holeAddr, index) => claim(holeAddr, `${part.ref}.pin${index + 1}`)));
  (model.jumpers ?? []).forEach((jumper, index) => {
    claim(jumper.from, `jumper#${index + 1}`);
    claim(jumper.to, `jumper#${index + 1}`);
  });
  (model.batteries ?? []).forEach((battery) => {
    claim(battery.plusHole, `${battery.ref}.+`);
    claim(battery.minusHole, `${battery.ref}.-`);
  });
  occupants.forEach((entries) => {
    if (entries.length < 2) return;
    issues.push(`OCCUPANCY: hole ${holeName(entries[0].holeAddr)} holds ${entries.length} conductors (${entries.map((entry) => entry.label).join(', ')}) — one hole seats one lead, even on the same net.`);
  });
}
