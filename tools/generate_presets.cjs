// node tools/generate_presets.cjs
const fs = require("fs");
const path = require("path");
// Shared core module

const ROOT = process.cwd();

// Load data
const weapons = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data/weapons.json"), "utf8")
);
const attachments = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data/attachments.json"), "utf8")
);
const SimCore = require("../sim_core.js");

// Load shields
const shieldsRaw = JSON.parse(
  fs.readFileSync(path.join(ROOT, "data/shields.json"), "utf8")
);
function normalizeShields(json){
  if (Array.isArray(json)){
    const map = {};
    for (const s of json){
      const id = s?.id || s?.name;
      if (!id) continue;
      map[id] = { name:id, hp:+s.hp, shield:+s.shield, dr:+s.dr, label:s.label || id };
    }
    return map;
  }
  return json || {};
}
const TARGETS = normalizeShields(shieldsRaw);

const {
  clamp01,
  mulberry32,
  buildWeaponBase,
  applyTierMods,
  groupAttachmentsByWeapon,
  combosForTypes,
  applyAttachments,
  shotsToKillTrial,
  shotsToKillWithSeq,
  ttkAndReloadsFromShots,
  mean,
  stddev,
  percentile,
  zForCL,
  quantileCI,
} = SimCore;

// (removed regex/eval import; using VM sandbox functions above)

// --------- helpers ---------
function parseArgs(argv){
  const out = { trials: 100000, confidence: 0.95, seed: 1337 };
  for (let i = 2; i < argv.length; i++){
    const a = argv[i];
    const [k, vRaw] = a.includes("=") ? a.split("=", 2) : [a, argv[i+1]];
    const v = vRaw;
    if (k === "--trials") out.trials = Math.max(100, parseInt(v, 10));
    if (k === "--confidence") out.confidence = Math.max(0.5, Math.min(0.999, parseFloat(v)));
    if (k === "--seed") out.seed = (parseInt(v, 10) >>> 0);
    if (!a.includes("=") && (k === "--trials" || k === "--confidence" || k === "--seed")) i++;
  }
  return out;
}

const OPT = parseArgs(process.argv);
console.log("Preset generation options:", OPT);
const PRECOMP_TRIALS = 100000;
const PRECOMP_CI = OPT.confidence ?? 0.95;
function meanCIFromSd(mu, sd, n, z){
  const se = sd / Math.sqrt(n);
  return [mu - z * se, mu + z * se];
}
// zForCL, mean, stddev, quantileCI, mulberry32, percentile imported from SimCore
function maxTier(w) {
  const tm = w.tier_mods || {};
  let m = 0;
  for (const v of Object.values(tm)) if (Array.isArray(v)) m = Math.max(m, v.length);
  return Math.max(1, 1 + m);
}

// Removed local applyTier/groupAttachmentsByWeapon/combosForTypes/applyAttachments;
// using worker versions imported from sandbox.

// Deterministic hit sequences (simple fixed sequences)
function makeZoneSequence(bodyW, headW, limbsW, length = 100) {
  const parts = [
    ["body", bodyW],
    ["head", headW],
    ["limb", limbsW],
  ].filter(([, w]) => w > 0);
  if (!parts.length) return ["body"];
  const sum = parts.reduce((s, [, w]) => s + w, 0);
  const norm = parts.map(([z, w]) => [z, w / sum]);
  const counts = Object.fromEntries(norm.map(([z, w]) => [z, Math.round(w * length)]));
  const total = Object.values(counts).reduce((s, x) => s + x, 0);
  const mainZone = norm.slice().sort((a, b) => b[1] - a[1])[0][0];
  counts[mainZone] += (length - total);
  let bag = [];
  for (const [z] of norm.slice().sort((a, b) => b[1] - a[1])) {
    bag = bag.concat(Array(Math.max(0, counts[z])).fill(z));
  }
  if (!bag.length) return ["body"];
  const out = new Array(bag.length).fill(null);
  const step = 7;
  let i = 0;
  for (const item of bag) {
    while (out[i] !== null) i = (i + 1) % out.length;
    out[i] = item;
    i = (i + step) % out.length;
  }
  return out;
}

function runPresetMonteCarlo(profileName, w, trials, ciLevel, seedBase, miss = 0) {
  const sum = w.body + w.head + w.limbs;
  const pBody = w.body / sum;
  const pHead = w.head / sum;
  const pLimbs = w.limbs / sum;
  const z = zForCL(ciLevel);
  const attByWeapon = groupAttachmentsByWeapon(attachments);

  const rows = [];
  let rowIndex = 0;
  let totalConfigs = 0;

  for (const wpn of weapons) {
    const base0 = buildWeaponBase(wpn);
    const base = { ...base0, attachments: "none" };

    const tmap = attByWeapon.get(wpn.name) || new Map();
    const combos = combosForTypes(tmap);

    const tiers = maxTier(wpn);
    for (let tier = 1; tier <= tiers; tier++) {
      const tiered = applyTierMods(base, tier);

      for (const combo of combos) {
        const stats = applyAttachments(tiered, combo);

        const targetNames = Object.keys(TARGETS);
        for (let i = 0; i < targetNames.length; i++) {
          const tName = targetNames[i];
          const tgt = TARGETS[tName];
          const rng = mulberry32((seedBase + rowIndex * 1013904223) >>> 0);
          const ttks = [];
          const shotsArr = [];
          const reloadsArr = [];
          const reloadTimeArr = [];
          const fireTimeArr = [];
          let reloadsSum = 0;

                  for(let k=0;k<trials;k++){
                    const shotsInfo = shotsToKillTrial(stats, tgt, pBody, pHead, pLimbs, miss, rng);
                    const shotsForUi = (typeof shotsInfo === "number")
                      ? shotsInfo
                      : (shotsInfo?.bullets_to_kill ?? shotsInfo?.shots ?? NaN);
                    const sim = ttkAndReloadsFromShots(shotsInfo, stats);
            const ttkVal = sim.ttk;
            const rels = sim.reloads;
            const rTime = rels * stats.reload_time_s;
            const fTime = ttkVal - rTime;
            ttks.push(ttkVal);
                    shotsArr.push(shotsForUi);
            reloadsArr.push(rels);
            reloadTimeArr.push(rTime);
            fireTimeArr.push(fTime);
            reloadsSum += rels;
          }

          ttks.sort((a,b)=>a-b);
          shotsArr.sort((a,b)=>a-b);
          reloadsArr.sort((a,b)=>a-b);
          reloadTimeArr.sort((a,b)=>a-b);
          fireTimeArr.sort((a,b)=>a-b);

          const n = ttks.length;
          const ttk_mean = mean(ttks);
          const sd = stddev(ttks, ttk_mean);
          const [ttk_mean_ci_low, ttk_mean_ci_high] = meanCIFromSd(ttk_mean, sd, n, z);

          const ttk_p50 = percentile(ttks, 0.50);
          const ttk_ci = quantileCI(ttks, ciLevel);
          const ttk_p50_ci_low = ttk_ci.lo;
          const ttk_p50_ci_high = ttk_ci.hi;

          const shots_mean = mean(shotsArr);
          const shots_sd = stddev(shotsArr, shots_mean);
          const [shots_mean_ci_low, shots_mean_ci_high] = meanCIFromSd(shots_mean, shots_sd, n, z);
          const shots_p50 = percentile(shotsArr, 0.50);
          const shots_ci = quantileCI(shotsArr, ciLevel);
          const shots_p50_ci_low = shots_ci.lo;
          const shots_p50_ci_high = shots_ci.hi;

          const reloads_mean = mean(reloadsArr);
          const reloads_sd = stddev(reloadsArr, reloads_mean);
          const [reloads_mean_ci_low, reloads_mean_ci_high] = meanCIFromSd(reloads_mean, reloads_sd, n, z);
          const reloads_p50 = percentile(reloadsArr, 0.50);
          const rel_ci = quantileCI(reloadsArr, ciLevel);
          const reloads_p50_ci_low = rel_ci.lo;
          const reloads_p50_ci_high = rel_ci.hi;

          const reload_time_mean = mean(reloadTimeArr);
          const reload_time_sd = stddev(reloadTimeArr, reload_time_mean);
          const [reload_time_mean_ci_low, reload_time_mean_ci_high] = meanCIFromSd(reload_time_mean, reload_time_sd, n, z);
          const reload_time_p50 = percentile(reloadTimeArr, 0.50);
          const rtime_ci = quantileCI(reloadTimeArr, ciLevel);
          const reload_time_p50_ci_low = rtime_ci.lo;
          const reload_time_p50_ci_high = rtime_ci.hi;

          const fire_time_mean = mean(fireTimeArr);
          const fire_time_sd = stddev(fireTimeArr, fire_time_mean);
          const [fire_time_mean_ci_low, fire_time_mean_ci_high] = meanCIFromSd(fire_time_mean, fire_time_sd, n, z);
          const fire_time_p50 = percentile(fireTimeArr, 0.50);
          const ftime_ci = quantileCI(fireTimeArr, ciLevel);
          const fire_time_p50_ci_low = ftime_ci.lo;
          const fire_time_p50_ci_high = ftime_ci.hi;

          const row = {
            weapon: stats.weapon,
            tier,
            attachments: stats.attachments,

            accuracy_profile: profileName,
            acc_body: w.body, acc_head: w.head, acc_limbs: w.limbs,

            ci_level: ciLevel,
            n_trials: trials,

            target: tName,
            target_hp: tgt.hp, target_shield: tgt.shield, target_dr: tgt.dr,

            ttk_p50,
            ttk_p50_ci_low,
            ttk_p50_ci_high,

            ttk_mean,
            ttk_mean_ci_low,
            ttk_mean_ci_high,
            ttk_std: sd,
            ttk_std_pct: (ttk_mean > 0 ? (sd / ttk_mean) : null),
            n_trials: trials,

            // per-metric stats (mean/std/mean-CI) for shots, reloads, reload time, fire time
            shots_mean,
            shots_mean_ci_low,
            shots_mean_ci_high,
            shots_std: shots_sd,
            shots_std_pct: (shots_mean > 0 ? (shots_sd / shots_mean) : null),
            shots_p50,
            shots_p50_ci_low,
            shots_p50_ci_high,

            reloads_mean,
            reloads_mean_ci_low,
            reloads_mean_ci_high,
            reloads_std: reloads_sd,
            reloads_std_pct: (reloads_mean > 0 ? (reloads_sd / reloads_mean) : null),
            reloads_p50,
            reloads_p50_ci_low,
            reloads_p50_ci_high,

            reload_time_mean,
            reload_time_mean_ci_low,
            reload_time_mean_ci_high,
            reload_time_std: reload_time_sd,
            reload_time_std_pct: (reload_time_mean > 0 ? (reload_time_sd / reload_time_mean) : null),
            reload_time_p50,
            reload_time_p50_ci_low,
            reload_time_p50_ci_high,

            fire_time_mean,
            fire_time_mean_ci_low,
            fire_time_mean_ci_high,
            fire_time_std: fire_time_sd,
            fire_time_std_pct: (fire_time_mean > 0 ? (fire_time_sd / fire_time_mean) : null),
            fire_time_p50,
            fire_time_p50_ci_low,
            fire_time_p50_ci_high,

            

            damage_per_bullet: stats.damage_per_bullet,
            fire_rate_bps: stats.fire_rate_bps,
            mag_size: stats.mag_size,
            reload_time_s: stats.reload_time_s,
            reload_amount: stats.reload_amount,
            headshot_mult: stats.headshot_mult,
            limbs_mult: stats.limbs_mult,
          };

          row.miss = miss;
          row.n_trials = trials;
          row.ci_level = ciLevel;
          rows.push(row);

          rowIndex++;
          totalConfigs++;
          if (totalConfigs % 100 === 0) {
            console.log(`[status] ${profileName}: processed ${totalConfigs} configs...`);
          }
        }
      }
    }
  }

  return rows;
}

function runPresetDeterministic(profileName, w){
  // Use interleaved deterministic sequence
  const seq = makeZoneSequence(w.body, w.head, w.limbs, 100);
  const attByWeapon = groupAttachmentsByWeapon(attachments);

  const rows = [];
  let totalConfigs = 0;
  for (const wpn of weapons) {
    const base0 = buildWeaponBase(wpn);
    const base = { ...base0, attachments: "none" };

    const tmap = attByWeapon.get(wpn.name) || new Map();
    const combos = combosForTypes(tmap);

    const tiers = maxTier(wpn);
    for (let tier = 1; tier <= tiers; tier++) {
      const tiered = applyTierMods(base, tier);

      for (const combo of combos) {
        const stats = applyAttachments(tiered, combo);
        for (const tName of Object.keys(TARGETS)) {
          const tgt = TARGETS[tName];
          const shotsInfo = shotsToKillWithSeq(stats, tgt, seq);

          // What the UI should display as “shots”:
          // - burst weapons: count bullets up to the killing bullet
          // - others: count shots
          const bullets = (typeof shotsInfo === "number")
            ? shotsInfo
            : (shotsInfo?.bullets_to_kill ?? shotsInfo?.shots ?? NaN);

          // Keep full info for correct mid-burst timing
          const sim = ttkAndReloadsFromShots(shotsInfo, stats);

          const ttk = sim.ttk;

          rows.push({
            weapon: stats.weapon,
            tier,
            attachments: stats.attachments,

            accuracy_profile: profileName,
            acc_body: w.body,
            acc_head: w.head,
            acc_limbs: w.limbs,

            target: tName,
            target_hp: tgt.hp,
            target_shield: tgt.shield,
            target_dr: tgt.dr,

            // Deterministic base value
            ttk_s: ttk,

            // Fill MC-style fields so the UI & graphs work
            n_trials: 1,
            ci_level: 1.0,

            ttk_p50: ttk,
            ttk_p50_ci_low: ttk,
            ttk_p50_ci_high: ttk,

            ttk_mean: ttk,
            ttk_mean_ci_low: ttk,
            ttk_mean_ci_high: ttk,

            ttk_std: 0,
            ttk_std_pct: 0,

            shots_p50: bullets,
            shots_mean: bullets,
            shots_std: 0,

            reloads_mean: sim.reloads,
            reloads_std: 0,

            // Base stats (unchanged)
            damage_per_bullet: stats.damage_per_bullet,
            fire_rate_bps: stats.fire_rate_bps,
            mag_size: stats.mag_size,
            reload_time_s: stats.reload_time_s,
            reload_amount: stats.reload_amount,
            headshot_mult: stats.headshot_mult,
            limbs_mult: stats.limbs_mult,

            // No miss in deterministic presets
            miss: 0,
          });
          totalConfigs++;
          if (totalConfigs % 100 === 0) {
            console.log(`[status] ${profileName}: processed ${totalConfigs} configs...`);
          }
        }
      }
    }
  }
  return rows;
}

function writeJSON(rel, obj) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  console.log("Wrote", rel, `(${obj.length} rows)`);
}
const presets = [
  { id:"preset_body_only", name:"Body only (precomputed)", file:"preset_body_only.json", mode:"det", profile:"Body only", w:{body:1, head:0, limbs:0} },
  { id:"preset_head_only", name:"Head only (precomputed)", file:"preset_head_only.json", mode:"det", profile:"Head only", w:{body:0, head:1, limbs:0} },

  {
    id: "preset_typical",
    name: "Typical 70/10/20/5 (precomputed)",
    file: "preset_typical.json",
    mode: "mc",
    profile: "Typical",
    w: { body: 0.70, head: 0.10, limbs: 0.20 },
    miss: 0.05,
    trials: PRECOMP_TRIALS,
    ci: PRECOMP_CI,
    seed: OPT.seed
  },

  {
    id: "preset_good_aim",
    name: "Good Aim 45/50/5/0 (precomputed)",
    file: "preset_good_aim.json",
    mode: "mc",
    profile: "Good Aim",
    w: { body: 0.45, head: 0.50, limbs: 0.05 },
    miss: 0.00,
    trials: PRECOMP_TRIALS,
    ci: PRECOMP_CI,
    seed: OPT.seed
  },

  {
    id: "preset_bad_aim",
    name: "Bad Aim 55/5/40/20 (precomputed)",
    file: "preset_bad_aim.json",
    mode: "mc",
    profile: "Bad Aim",
    w: { body: 0.55, head: 0.05, limbs: 0.40 },
    miss: 0.20,
    trials: PRECOMP_TRIALS,
    ci: PRECOMP_CI,
    seed: OPT.seed
  },
];

writeJSON("data/presets/presets.json", presets.map(p => ({
  id: p.id,
  name: p.name,
  file: p.file,
  kind: "precomputed",
  mode: p.mode,
  miss: p.mode === "mc" ? p.miss : null,
  n_trials: p.mode === "mc" ? p.trials : null,
  ci_level: p.mode === "mc" ? p.ci : null,
})));

let bodyRows = null;
let typicalRows = null;

for (const p of presets) {
  console.log(`[status] Generating preset: ${p.id} (${p.profile})`);
  const rows = p.mode === "mc"
    ? runPresetMonteCarlo(p.profile, p.w, p.trials, p.ci, p.seed, p.miss)
    : runPresetDeterministic(p.profile, p.w);

  // write the actual precomputed data for the website
  writeJSON(path.join("data/presets", p.file), rows);
  console.log(`[status] Wrote ${p.file}: ${rows.length} rows`);

  if (p.profile === "Body only") bodyRows = rows;
  if (p.profile === "Typical") typicalRows = rows;
}

// Optional sanity check comparing Typical vs Body only
if (bodyRows && typicalRows) {
  const key = r => `${r.weapon}|${r.tier}|${r.attachments}|${r.target}`;
  const bm = new Map(bodyRows.map(r => [key(r), r]));
  let diff = 0;
  for (const r of typicalRows) {
    const b = bm.get(key(r));
    if (!b) continue;
    const bt = b.ttk_p50 ?? b.ttk_s ?? 0;
    const rt = r.ttk_p50 ?? r.ttk_s ?? 0;
    const bs = b.shots_p50 ?? b.bullets_to_kill;
    const rs = r.shots_p50 ?? r.bullets_to_kill;
    if (Math.abs(bt - rt) > 1e-9 || bs !== rs) diff++;
  }
  console.log(`Typical vs Body differences: ${diff}/${typicalRows.length}`);
}