// tools/shield_effect.cjs
// Usage:  node tools/shield_effect.cjs
//
// Prints the average extra TTK caused by each shield compared to NoShield,
// AND the relative increase vs the previous shield tier:
//
//   Light  vs NoShield
//   Medium vs Light
//   Heavy  vs Medium
//
// Aggregated per precomputed preset and overall.

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();

// ---------- helpers ----------

const presetsMetaPath = path.join(ROOT, "data", "presets", "presets.json");
if (!fs.existsSync(presetsMetaPath)) {
  console.error("Cannot find", presetsMetaPath);
  process.exit(1);
}
const presetsMeta = JSON.parse(fs.readFileSync(presetsMetaPath, "utf8"));
const PRESETS = presetsMeta.filter(p => p.kind === "precomputed");

// Load shields.json for ordering
const shieldsPath = path.join(ROOT, "data", "shields.json");
let TARGETS = ["NoShield", "Light", "Medium", "Heavy"];
if (fs.existsSync(shieldsPath)){
  try{
    const raw = JSON.parse(fs.readFileSync(shieldsPath, "utf8"));
    if (Array.isArray(raw)){
      TARGETS = raw.map(s => s.id || s.name).filter(Boolean);
    } else {
      TARGETS = Object.keys(raw || {});
    }
  }catch(e){
    // keep default order on error
  }
}

function getTTK(row) {
  if (typeof row.ttk_mean === "number") return row.ttk_mean;
  if (typeof row.ttk_p50 === "number") return row.ttk_p50;
  if (typeof row.ttk_s === "number") return row.ttk_s;
  throw new Error("No TTK field on row: " + JSON.stringify(row).slice(0, 200));
}

// Base stats: vs NoShield
// Prev stats: vs previous shield (Light vs NoShield, Medium vs Light, Heavy vs Medium)
function emptyStats() {
  return {
    countBase: 0,
    sumDiffBase: 0,
    sumRelBase: 0,
    countPrev: 0,
    sumRelPrev: 0,
  };
}

function addBase(stats, diffSec, relBase) {
  stats.countBase += 1;
  stats.sumDiffBase += diffSec;
  stats.sumRelBase += relBase;
}

function addPrev(stats, relPrev) {
  stats.countPrev += 1;
  stats.sumRelPrev += relPrev;
}

function formatPct(x) {
  return (x * 100).toFixed(1) + "%";
}

function formatSec(x) {
  return x.toFixed(3) + "s";
}

// ---------- main aggregation ----------

const overall = {
  Light: emptyStats(),
  Medium: emptyStats(),
  Heavy: emptyStats(),
};

const byPreset = {}; // presetName -> { Light, Medium, Heavy }

for (const p of PRESETS) {
  const presetName = p.name || p.id;
  const file = p.file || (p.id + ".json");
  const filePath = path.join(ROOT, "data", "presets", file);

  if (!fs.existsSync(filePath)) {
    console.warn("Skipping missing preset file:", filePath);
    continue;
  }

  const rows = JSON.parse(fs.readFileSync(filePath, "utf8"));

  // Map (weapon|tier|attachments|profile) -> target -> TTK
  const combos = new Map();

  for (const r of rows) {
    const key = [
      r.weapon,
      r.tier,
      r.attachments,
      r.accuracy_profile || "",
    ].join("|");

    if (!combos.has(key)) combos.set(key, {});
    const tgtMap = combos.get(key);

    const targetName = r.target;
    if (!TARGETS.includes(targetName)) continue;

    tgtMap[targetName] = getTTK(r);
  }

  const presetStats = {
    Light: emptyStats(),
    Medium: emptyStats(),
    Heavy: emptyStats(),
  };

  for (const [, tgtMap] of combos) {
    const tNone   = tgtMap.NoShield;
    const tLight  = tgtMap.Light;
    const tMedium = tgtMap.Medium;
    const tHeavy  = tgtMap.Heavy;

    if (!Number.isFinite(tNone) || tNone <= 0) continue;

    // --- Light vs NoShield (base + prev are same pair) ---
    if (Number.isFinite(tLight) && tLight > 0) {
      const diffL = tLight - tNone;
      const relBaseL = tLight / tNone - 1;   // vs None
      const relPrevL = relBaseL;             // Light's "previous" is None

      addBase(presetStats.Light,  diffL,   relBaseL);
      addBase(overall.Light,      diffL,   relBaseL);
      addPrev(presetStats.Light,  relPrevL);
      addPrev(overall.Light,      relPrevL);
    }

    // --- Medium vs NoShield; and vs Light if Light exists ---
    if (Number.isFinite(tMedium) && tMedium > 0) {
      const diffM = tMedium - tNone;
      const relBaseM = tMedium / tNone - 1; // vs None

      addBase(presetStats.Medium, diffM,  relBaseM);
      addBase(overall.Medium,     diffM,  relBaseM);

      if (Number.isFinite(tLight) && tLight > 0) {
        const relPrevM = tMedium / tLight - 1; // vs Light
        addPrev(presetStats.Medium, relPrevM);
        addPrev(overall.Medium,     relPrevM);
      }
    }

    // --- Heavy vs NoShield; and vs Medium if Medium exists ---
    if (Number.isFinite(tHeavy) && tHeavy > 0) {
      const diffH = tHeavy - tNone;
      const relBaseH = tHeavy / tNone - 1; // vs None

      addBase(presetStats.Heavy, diffH,  relBaseH);
      addBase(overall.Heavy,     diffH,  relBaseH);

      if (Number.isFinite(tMedium) && tMedium > 0) {
        const relPrevH = tHeavy / tMedium - 1; // vs Medium
        addPrev(presetStats.Heavy, relPrevH);
        addPrev(overall.Heavy,     relPrevH);
      }
    }
  }

  byPreset[presetName] = presetStats;
}

// ---------- output ----------

function printStats(title, statsMap) {
  console.log("\n" + title);
  console.log("Shield      N(base)  ΔTTK vs none   Δ% vs none   N(prev)  Δ% vs prev");
  console.log("---------------------------------------------------------------------");
  for (const shield of ["Light", "Medium", "Heavy"]) {
    const s = statsMap[shield];
    if (!s || s.countBase === 0) {
      console.log(
        shield.padEnd(10),
        "  0        (n/a)        (n/a)      0      (n/a)"
      );
      continue;
    }

    const avgDiffBase = s.sumDiffBase / s.countBase;
    const avgRelBase  = s.sumRelBase  / s.countBase;

    let prevStrCount = "0";
    let prevStrPct   = "(n/a)";
    if (s.countPrev > 0) {
      const avgRelPrev = s.sumRelPrev / s.countPrev;
      prevStrCount = String(s.countPrev);
      prevStrPct   = formatPct(avgRelPrev);
    }

    console.log(
      shield.padEnd(10),
      String(s.countBase).padStart(6),
      "  " + formatSec(avgDiffBase).padStart(12),
      "  " + formatPct(avgRelBase).padStart(10),
      "  " + prevStrCount.padStart(6),
      "  " + prevStrPct.padStart(9)
    );
  }
}

console.log("Overall TTK impact of shields vs NoShield (all precomputed presets)");
console.log("Averages over weapon/tier/attachment setups where both shields exist.\n");

for (const [name, stats] of Object.entries(byPreset)) {
  printStats(`Preset: ${name}`, stats);
}

printStats("OVERALL (all presets combined)", overall);
console.log("\nDone.");
