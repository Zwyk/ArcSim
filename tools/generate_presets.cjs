// node tools/generate_presets.cjs
const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const weapons = JSON.parse(fs.readFileSync(path.join(ROOT, "data/weapons.json"), "utf8"));
const attachments = JSON.parse(fs.readFileSync(path.join(ROOT, "data/attachments.json"), "utf8"));

const TARGETS = [
  { name: "NoShield", hp: 100, shield: 0,  dr: 0.0 },
  { name: "Light",    hp: 100, shield: 40, dr: 0.4 },
  { name: "Medium",   hp: 100, shield: 70, dr: 0.425 },
  { name: "Heavy",    hp: 100, shield: 80, dr: 0.525 },
];

// --------- helpers ---------
function parseArgs(argv){
  const out = { trials: 2000, confidence: 0.95, seed: 1337 };
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
function zForCL(cl){
  if (cl >= 0.99) return 2.575829;
  if (cl >= 0.95) return 1.959964;
  if (cl >= 0.90) return 1.644854;
  return 1.959964;
}

function mean(arr){ let s=0; for(const x of arr) s+=x; return s/arr.length; }

function stddev(arr, m){
  if(arr.length < 2) return 0;
  let s2=0;
  for(const x of arr){ const d=x-m; s2 += d*d; }
  return Math.sqrt(s2/(arr.length-1));
}

function quantileCI(sorted, q, z){
  const n = sorted.length;
  if(n <= 1) return [sorted[0], sorted[0]];
  const mu = n*q;
  const sigma = Math.sqrt(n*q*(1-q));
  let kLow = Math.floor(mu - z*sigma);
  let kHigh = Math.ceil(mu + z*sigma);
  kLow = Math.max(0, Math.min(n-1, kLow));
  kHigh = Math.max(0, Math.min(n-1, kHigh));
  if(kHigh < kLow){ const t=kLow; kLow=kHigh; kHigh=t; }
  return [sorted[kLow], sorted[kHigh]];
}
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function shotsToKillTrial(stats, target, pBody, pHead, pLimbs, rng){
  let hp = target.hp;
  let sh = target.shield;
  const dr = target.dr;

  let shots = 0;
  while(hp >= 1.0){
    shots++;

    // pick zone
    const r = rng();
    let mult = 1.0;
    if(r < pBody) mult = 1.0;
    else if(r < pBody + pHead) mult = stats.headshot_mult;
    else mult = stats.limbs_mult;

    const dmg = stats.damage_per_bullet * mult;

    if(sh > 0){
      sh = Math.max(0, sh - dmg);   // full to shield
      hp -= dmg * (1 - dr);        // mitigated to HP
    }else{
      hp -= dmg;                   // full to HP
    }

    if(shots > 200000) return Infinity;
  }
  return shots;
}

function percentile(sorted, p){
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}
function maxTier(w) {
  const tm = w.tier_mods || {};
  let m = 0;
  for (const v of Object.values(tm)) if (Array.isArray(v)) m = Math.max(m, v.length);
  return Math.max(1, 1 + m);
}

function applyTier(stats, w, tier) {
  const tm = w.tier_mods || {};
  const idx = tier - 2; // tier2 => 0
  if (idx < 0) return { ...stats };

  const out = { ...stats };

  if (Array.isArray(tm.fire_rate_pct) && tm.fire_rate_pct[idx] != null) {
    out.fire_rate_bps *= (1 + tm.fire_rate_pct[idx] / 100);
  }
  if (Array.isArray(tm.reload_time_reduction_pct) && tm.reload_time_reduction_pct[idx] != null) {
    out.reload_time_s *= (1 - tm.reload_time_reduction_pct[idx] / 100);
  }
  if (Array.isArray(tm.mag_add) && tm.mag_add[idx] != null) {
    out.mag_size += tm.mag_add[idx];
  }
  return out;
}

function groupAttachmentsByWeapon(atts) {
  const map = new Map(); // weapon -> type -> list
  for (const a of atts) {
    for (const w of (a.compatible || [])) {
      if (!map.has(w)) map.set(w, new Map());
      const tmap = map.get(w);
      const type = a.type || "misc";
      if (!tmap.has(type)) tmap.set(type, []);
      tmap.get(type).push(a);
    }
  }
  return map;
}

function combosForTypes(typeMap) {
  const types = [...typeMap.keys()].sort();
  const lists = types.map(t => [{ name: "none", type: t, _none: true }, ...typeMap.get(t)]);
  const out = [];

  function rec(i, acc) {
    if (i === lists.length) { out.push(acc.slice()); return; }
    for (const item of lists[i]) { acc.push(item); rec(i + 1, acc); acc.pop(); }
  }
  rec(0, []);
  return out.length ? out : [[]];
}

function applyAttachments(stats, combo) {
  const out = { ...stats };
  const names = [];

  for (const a of combo) {
    if (a._none) continue;
    names.push(a.name);

    if (a.mag_add != null) out.mag_size += a.mag_add;
    if (a.fire_rate_mult != null) out.fire_rate_bps *= a.fire_rate_mult;
    // add more modifiers here later if you introduce them
  }

  out.attachments = names.length ? names.join(" + ") : "none";
  return out;
}

// Deterministic sequence with LOWERCASE labels (prevents the “Head vs head” bug)
function makeZoneSequence(bodyW, headW, limbsW, length = 100) {
  const parts = [
    ["body", bodyW],
    ["head", headW],
    ["limbs", limbsW],
  ].filter(([, w]) => w > 0);

  if (!parts.length) return ["body"];

  const sum = parts.reduce((s, [, w]) => s + w, 0);
  const norm = parts.map(([z, w]) => [z, w / sum]);

  // How many of each zone in a fixed-length sequence
  const counts = Object.fromEntries(norm.map(([z, w]) => [z, Math.round(w * length)]));
  const total = Object.values(counts).reduce((s, x) => s + x, 0);
  const mainZone = norm.slice().sort((a, b) => b[1] - a[1])[0][0];
  counts[mainZone] += (length - total);

  // Build a "bag" of zones
  let bag = [];
  for (const [z] of norm.slice().sort((a, b) => b[1] - a[1])) {
    bag = bag.concat(Array(Math.max(0, counts[z])).fill(z));
  }
  if (!bag.length) return ["body"];

  // Spread them out so head/limbs appear early too (not in one block)
  const out = new Array(bag.length).fill(null);
  const step = 7; // co-prime-ish with 100, gives good distribution
  let i = 0;

  for (const item of bag) {
    while (out[i] !== null) i = (i + 1) % out.length;
    out[i] = item;
    i = (i + step) % out.length;
  }

  return out;
}

function shotsToKillWithSeq(stats, target, seq) {
  let hp = target.hp;
  let sh = target.shield;
  const dr = target.dr;

  let shots = 0;
  const n = seq.length || 1;

  while (hp >= 1.0) {
    shots++;
    const z = seq[(shots - 1) % n]; // 'body'|'head'|'limbs'

    let mult = 1.0;
    if (z === "head") mult = stats.headshot_mult;
    else if (z === "limbs") mult = stats.limbs_mult;

    const dmg = stats.damage_per_bullet * mult;

    // your rule
    if (sh > 0) {
      sh = Math.max(0, sh - dmg);     // full to shield
      hp -= dmg * (1 - dr);          // mitigated to HP
    } else {
      hp -= dmg;                      // full to HP
    }

    if (shots > 200000) return Infinity;
  }
  return shots;
}

function ttkFromShots(shotsNeeded, stats) {
  if (!Number.isFinite(shotsNeeded)) return { ttk: NaN, reloads: NaN };

  const magSize = stats.mag_size;
  const fr = stats.fire_rate_bps;
  const rt = stats.reload_time_s;
  const ra = stats.reload_amount;

  const shotInterval = fr > 0 ? 1 / fr : 0;

  let shotsDone = 0;
  let mag = magSize;
  let t = 0;
  let reloads = 0;

  while (shotsDone < shotsNeeded) {
    if (mag === 0) {
      const remaining = shotsNeeded - shotsDone;
      if (ra <= 0) {
        reloads += 1;
        t += rt;
        mag = magSize;
      } else {
        const toLoad = Math.min(remaining, magSize);
        const actions = Math.ceil(toLoad / ra);
        reloads += actions;
        t += actions * rt;
        mag = Math.min(magSize, actions * ra);
      }
      continue;
    }

    shotsDone++;
    mag--;

    if (shotsDone >= shotsNeeded) break;
    if (mag > 0 && shotInterval > 0) t += shotInterval;
  }

  return { ttk: t, reloads };
}

function shotsToKillTrial(stats, target, pBody, pHead, pLimbs, rng){
  let hp = target.hp;
  let sh = target.shield;
  const dr = target.dr;

  let shots = 0;
  while(hp >= 1.0){
    shots++;

    const r = rng();
    let mult = 1.0;
    if(r < pBody) mult = 1.0;
    else if(r < pBody + pHead) mult = stats.headshot_mult;
    else mult = stats.limbs_mult;

    const dmg = stats.damage_per_bullet * mult;

    if(sh > 0){
      sh = Math.max(0, sh - dmg);
      hp -= dmg * (1 - dr);
    }else{
      hp -= dmg;
    }

    if(shots > 200000) return Infinity;
  }
  return shots;
}

function runPresetMonteCarlo(profileName, w, trials, ciLevel, seedBase) {
  const sum = w.body + w.head + w.limbs;
  const pBody = w.body / sum;
  const pHead = w.head / sum;
  const pLimbs = w.limbs / sum;
  const z = zForCL(ciLevel);
  const attByWeapon = groupAttachmentsByWeapon(attachments);

  const rows = [];
  let rowIndex = 0;

  for (const wpn of weapons) {
    const base = {
      weapon: wpn.name,
      damage_per_bullet: wpn.damage,
      fire_rate_bps: wpn.fire_rate,
      mag_size: wpn.mag_size,
      reload_time_s: wpn.reload_time_s,
      reload_amount: wpn.reload_amount ?? 0,
      headshot_mult: (wpn.headshot_mult == null || wpn.headshot_mult <= 1.0) ? 2.0 : wpn.headshot_mult,
      limbs_mult: (wpn.limbs_mult == null || wpn.limbs_mult === 1.0) ? 0.9 : wpn.limbs_mult,
      attachments: "none",
    };

    const tmap = attByWeapon.get(wpn.name) || new Map();
    const combos = combosForTypes(tmap);

    const tiers = maxTier(wpn);
    for (let tier = 1; tier <= tiers; tier++) {
      const tiered = applyTier(base, wpn, tier);

      for (const combo of combos) {
        const stats = applyAttachments(tiered, combo);

        for (let i = 0; i < TARGETS.length; i++) {
          const tgt = TARGETS[i];
          const rng = mulberry32((seedBase + rowIndex * 1013904223) >>> 0);
          const ttks = [];
          const shotsArr = [];
          let reloadsSum = 0;

          for(let k=0;k<trials;k++){
            const shots = shotsToKillTrial(stats, tgt, pBody, pHead, pLimbs, rng);
            const sim = ttkFromShots(shots, stats);
            ttks.push(sim.ttk);
            shotsArr.push(shots);
            reloadsSum += sim.reloads;
          }

          ttks.sort((a,b)=>a-b);
          shotsArr.sort((a,b)=>a-b);

          const ttk_mean = mean(ttks);
          const sd = stddev(ttks, ttk_mean);
          const se = sd / Math.sqrt(ttks.length);

          const ttk_p50 = percentile(ttks, 0.50);
          const [ttk_p50_ci_low, ttk_p50_ci_high] = quantileCI(ttks, 0.50, z);

          rows.push({
            weapon: stats.weapon,
            tier,
            attachments: stats.attachments,

            accuracy_profile: profileName,
            acc_body: w.body, acc_head: w.head, acc_limbs: w.limbs,

            ci_level: ciLevel,
            n_trials: trials,

            target: tgt.name,
            target_hp: tgt.hp, target_shield: tgt.shield, target_dr: tgt.dr,

            ttk_p50,
            ttk_p50_ci_low,
            ttk_p50_ci_high,

            ttk_mean,
            ttk_mean_ci_low: ttk_mean - z*se,
            ttk_mean_ci_high: ttk_mean + z*se,

            shots_p50: percentile(shotsArr, 0.50),
            shots_mean: mean(shotsArr),
            reloads_mean: reloadsSum / trials,

            damage_per_bullet: stats.damage_per_bullet,
            fire_rate_bps: stats.fire_rate_bps,
            mag_size: stats.mag_size,
            reload_time_s: stats.reload_time_s,
            reload_amount: stats.reload_amount,
            headshot_mult: stats.headshot_mult,
            limbs_mult: stats.limbs_mult,
          });

          rowIndex++;
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
  for (const wpn of weapons) {
    const base = {
      weapon: wpn.name,
      damage_per_bullet: wpn.damage,
      fire_rate_bps: wpn.fire_rate,
      mag_size: wpn.mag_size,
      reload_time_s: wpn.reload_time_s,
      reload_amount: wpn.reload_amount ?? 0,
      headshot_mult: (wpn.headshot_mult == null || wpn.headshot_mult <= 1.0) ? 2.0 : wpn.headshot_mult,
      limbs_mult: (wpn.limbs_mult == null || wpn.limbs_mult === 1.0) ? 0.9 : wpn.limbs_mult,
      attachments: "none",
    };

    const tmap = attByWeapon.get(wpn.name) || new Map();
    const combos = combosForTypes(tmap);

    const tiers = maxTier(wpn);
    for (let tier = 1; tier <= tiers; tier++) {
      const tiered = applyTier(base, wpn, tier);

      for (const combo of combos) {
        const stats = applyAttachments(tiered, combo);
        for (const tgt of TARGETS) {
          const shots = shotsToKillWithSeq(stats, tgt, seq);
          const sim = ttkFromShots(shots, stats);
          rows.push({
            weapon: stats.weapon,
            tier,
            attachments: stats.attachments,
            accuracy_profile: profileName,
            acc_body: w.body, acc_head: w.head, acc_limbs: w.limbs,
            target: tgt.name,
            target_hp: tgt.hp, target_shield: tgt.shield, target_dr: tgt.dr,
            ttk_s: sim.ttk,
            bullets_to_kill: shots,
            reloads: sim.reloads,
            damage_per_bullet: stats.damage_per_bullet,
            fire_rate_bps: stats.fire_rate_bps,
            mag_size: stats.mag_size,
            reload_time_s: stats.reload_time_s,
            reload_amount: stats.reload_amount,
            headshot_mult: stats.headshot_mult,
            limbs_mult: stats.limbs_mult,
          });
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

// --------- presets to generate ---------
const presets = [
  { id:"preset_body_only", name:"Body only (precomputed)", file:"preset_body_only.json", mode:"det", profile:"Body only", w:{body:1, head:0, limbs:0} },
  { id:"preset_head_only", name:"Head only (precomputed)", file:"preset_head_only.json", mode:"det", profile:"Head only", w:{body:0, head:1, limbs:0} },
  { id:"preset_typical", name:`Typical 70/10/20 (precomputed, ${OPT.trials} trials, ${Math.round(OPT.confidence*100)}% CI)`, file:"preset_typical.json", mode:"mc", profile:"Typical", w:{body:0.7, head:0.1, limbs:0.2}, trials: OPT.trials, ci: OPT.confidence, seed: OPT.seed },
];

writeJSON("data/presets/presets.json", presets.map(p => ({
  id: p.id,
  name: p.name,
  file: p.file,
  kind: "precomputed",
  mode: p.mode,
  n_trials: p.mode === "mc" ? p.trials : null,
  ci_level: p.mode === "mc" ? p.ci : null,
})));

let bodyRows = null;
let typicalRows = null;

for (const p of presets) {
  const rows = p.mode === "mc"
    ? runPresetMonteCarlo(p.profile, p.w, p.trials, p.ci, p.seed)
    : runPresetDeterministic(p.profile, p.w);
  writeJSON(path.join("data/presets", p.file), rows);

  if (p.profile === "Body only") bodyRows = rows;
  if (p.profile === "Typical") typicalRows = rows;
}

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
