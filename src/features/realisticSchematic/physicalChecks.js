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
  checkRigidGeometry(model, issues);
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

function checkRigidGeometry(model, issues) {
  (model.parts ?? []).forEach((part) => {
    if (part.meta?.slot) return; // off-board module: flying leads may go anywhere
    const holes = (part.holes ?? []).filter(Boolean);
    if (holes.length <= 2) return; // two-lead parts bend; Task 15 bounds their span
    const railHoles = holes.filter(isRail);
    if (railHoles.length) {
      issues.push(`GEOMETRY: ${part.ref} has ${railHoles.length} pin(s) on a power rail (${railHoles.map(holeName).join(', ')}) while its body sits in the terminal strips — a rigid package cannot reach the board edge; those pins need jumpers instead.`);
    }
    const columns = [...new Set(holes.filter((h) => !isRail(h)).map((h) => h.column))].sort((a, b) => a - b);
    if (columns.length && columns[columns.length - 1] - columns[0] + 1 !== columns.length) {
      issues.push(`GEOMETRY: ${part.ref}'s pins occupy non-contiguous columns (${columns.join(', ')}) — a rigid package has consecutive legs.`);
    }
  });
}
