// WebWorker: generates a custom preset by simulating all weapon/tier/attachment combos
// using weapons.json + attachments.json.
importScripts("sim_core.js");

const {
  clamp01,
  mulberry32,
  buildWeaponBase,
  applyTierMods,
  groupAttachmentsByWeapon,
  getTypeMapForWeapon,
  combosForTypes,
  applyAttachments,
  unapplyMods,
  shotsToKillTrial,
  ttkAndReloadsFromShots,
  percentile
} = self.SimCore;


// Shared helper: apply one bullet to the target state
// state: { hp, sh, dr }
// zone: 'miss' | 'body' | 'head' | 'limbs'
function applyMultiBulletShot(stats, state, zone){
  if(zone === 'miss') return;
  let mult = 1.0;
  if(zone === 'head') mult = stats.headshot_mult;
  else if(zone === 'limbs') mult = stats.limbs_mult;
  // body stays 1.0
  const dmgPerBullet = stats.damage_per_bullet * mult;
  if(state.sh > 0){
    state.sh = Math.max(0, state.sh - dmgPerBullet);
    state.hp -= dmgPerBullet * (1 - state.dr);
  } else {
    state.hp -= dmgPerBullet;
  }
}

// Deterministic zone sequence generator, length `len`.
// Emits array of zones using probabilities, stable for given rng.
function makeZoneSequence(pBody, pHead, pLimbs, pMiss, len, rng){
  const seq = new Array(len);
  for(let i=0;i<len;i++){
    const rMiss = rng();
    if(rMiss < pMiss){ seq[i] = 'miss'; continue; }
    const r = rng();
    if(r < pBody){ seq[i] = 'body'; }
    else if(r < pBody + pHead){ seq[i] = 'head'; }
    else { seq[i] = 'limbs'; }
  }
  return seq;
}



// Build a compatibility map for patch.json like attachments map, so we can reuse getTypeMapForWeapon.
// Map<compatibleWeaponName, Map<"patch", patchItems[]>>
function groupPatchByWeapon(patchArr){
  const m = new Map();
  for (const it of (patchArr || [])){
    const compat = it && it.compatible;
    if (!Array.isArray(compat) || !compat.length) continue;
    for (const wName of compat){
      const key = String(wName || "").trim();
      if (!key) continue;
      if (!m.has(key)) m.set(key, new Map([["patch", []]]));
      m.get(key).get("patch").push(it);
    }
  }
  return m;
}

function hasPatchForWeapon(patchMap, weaponName){
  const tm = getTypeMapForWeapon(patchMap, weaponName);
  const arr = tm ? tm.get("patch") : null;
  return Array.isArray(arr) && arr.length > 0;
}

function zForCL(cl){
  if (cl >= 0.99) return 2.575829; // 99%
  if (cl >= 0.95) return 1.959964; // 95%
  if (cl >= 0.90) return 1.644854; // 90%
  return 1.959964;
}

// UI CI helpers (fallback)
function zForCI(ciLevel){
  const cl = Number(ciLevel);
  if (cl >= 0.99) return 2.575829;
  if (cl >= 0.95) return 1.959964;
  if (cl >= 0.90) return 1.644854;
  if (cl >= 0.80) return 1.281552;
  return 1.959964;
}
function ciHalfFallback(sd, nTrials, ciLevel){
  const sdN = Number(sd), n = Number(nTrials);
  if (!Number.isFinite(sdN) || !Number.isFinite(n) || n <= 1) return NaN;
  return zForCI(ciLevel) * sdN / Math.sqrt(n);
}

function mean(arr){
  let s = 0;
  for(const x of arr) s += x;
  return s / arr.length;
}

function stddev(arr, m){
  // population stddev for consistency with UI request
  let s2 = 0;
  for(const x of arr){
    const d = x - m;
    s2 += d * d;
  }
  return Math.sqrt(s2 / arr.length);
}

function quantileCI(sorted, q, z){
  const n = sorted.length;
  if(n === 0) return [NaN, NaN];
  if(n === 1) return [sorted[0], sorted[0]];

  const mu = n * q;
  const sigma = Math.sqrt(n * q * (1 - q));

  let kLow = Math.floor(mu - z * sigma);
  let kHigh = Math.ceil(mu + z * sigma);

  kLow = Math.max(0, Math.min(n - 1, kLow));
  kHigh = Math.max(0, Math.min(n - 1, kHigh));

  if(kHigh < kLow){ const t = kLow; kLow = kHigh; kHigh = t; }
  return [sorted[kLow], sorted[kHigh]];
}


function simulateRowStats(stats, tgt, nBody, nHead, nLimbs, pMiss, trials, rng, cl){
  const ttks = new Array(trials);
  const shotsArr = new Array(trials);
  const reloadsArr = new Array(trials);
  const reloadTimeArr = new Array(trials);
  const fireTimeArr = new Array(trials);

  let shotsSum = 0;
  let reloadsSum = 0;

  for (let k = 0; k < trials; k++){
    const shotsInfo = shotsToKillTrial(stats, tgt, nBody, nHead, nLimbs, pMiss, rng);
    const shots =
      (typeof shotsInfo === "number")
        ? shotsInfo
        : (Number.isFinite(shotsInfo?.bullets_to_kill)
            ? shotsInfo.bullets_to_kill
            : (shotsInfo?.shots ?? NaN));
    const tr = ttkAndReloadsFromShots(shotsInfo, stats);
    const ttkVal = tr.ttk;
    const rels = tr.reloads;
    const rTime = rels * stats.reload_time_s;
    const fTime = ttkVal - rTime;

    ttks[k] = ttkVal;
    shotsArr[k] = shots;
    reloadsArr[k] = rels;
    reloadTimeArr[k] = rTime;
    fireTimeArr[k] = fTime;

    shotsSum += shots;
    reloadsSum += rels;
  }

  ttks.sort((a,b)=>a-b);
  shotsArr.sort((a,b)=>a-b);
  reloadsArr.sort((a,b)=>a-b);
  reloadTimeArr.sort((a,b)=>a-b);
  fireTimeArr.sort((a,b)=>a-b);

  const z = zForCL(cl);

  const ttk_mean = mean(ttks);
  const ttk_sd = stddev(ttks, ttk_mean);
  const ttk_se = ttk_sd / Math.sqrt(ttks.length);
  const ttk_mean_ci_low = ttk_mean - z * ttk_se;
  const ttk_mean_ci_high = ttk_mean + z * ttk_se;

  const ttk_p50 = percentile(ttks, 0.50);
  const ttk_p95 = percentile(ttks, 0.95);
  const [ttk_p50_ci_low, ttk_p50_ci_high] = quantileCI(ttks, 0.50, z);
  const [ttk_p95_ci_low, ttk_p95_ci_high] = quantileCI(ttks, 0.95, z);

  const sShots_mean = shotsSum / trials;
  const sShots_std = stddev(shotsArr, sShots_mean);
  const sShots_half = ciHalfFallback(sShots_std, trials, cl);

  const sRel_mean = reloadsSum / trials;
  const sRel_std = stddev(reloadsArr, sRel_mean);
  const sRel_half = ciHalfFallback(sRel_std, trials, cl);

  const sRTime_mean = mean(reloadTimeArr);
  const sRTime_std = stddev(reloadTimeArr, sRTime_mean);
  const sRTime_half = ciHalfFallback(sRTime_std, trials, cl);

  const sFire_mean = mean(fireTimeArr);
  const sFire_std = stddev(fireTimeArr, sFire_mean);
  const sFire_half = ciHalfFallback(sFire_std, trials, cl);

  const shots_p50 = percentile(shotsArr, 0.50);
  const [shots_p50_ci_low, shots_p50_ci_high] = quantileCI(shotsArr, 0.50, z);

  const reloads_p50 = percentile(reloadsArr, 0.50);
  const [reloads_p50_ci_low, reloads_p50_ci_high] = quantileCI(reloadsArr, 0.50, z);

  const reload_time_p50 = percentile(reloadTimeArr, 0.50);
  const [reload_time_p50_ci_low, reload_time_p50_ci_high] = quantileCI(reloadTimeArr, 0.50, z);

  const fire_time_p50 = percentile(fireTimeArr, 0.50);
  const [fire_time_p50_ci_low, fire_time_p50_ci_high] = quantileCI(fireTimeArr, 0.50, z);

  return {
    ttk_mean, ttk_mean_ci_low, ttk_mean_ci_high,
    ttk_p50, ttk_p50_ci_low, ttk_p50_ci_high,
    ttk_p95, ttk_p95_ci_low, ttk_p95_ci_high,
    ttk_std: ttk_sd,
    ttk_std_pct: (ttk_mean > 0 ? (ttk_sd / ttk_mean) : null),

    shots_mean: sShots_mean,
    shots_std: sShots_std,
    shots_ci_half: sShots_half,
    reloads_mean: sRel_mean,
    reloads_std: sRel_std,
    reloads_ci_half: sRel_half,
    reload_time_mean: sRTime_mean,
    reload_time_std: sRTime_std,
    reload_time_ci_half: sRTime_half,
    fire_time_mean: sFire_mean,
    fire_time_std: sFire_std,
    fire_time_ci_half: sFire_half,

    shots_p50, shots_p50_ci_low, shots_p50_ci_high,
    reloads_p50, reloads_p50_ci_low, reloads_p50_ci_high,
    reload_time_p50, reload_time_p50_ci_low, reload_time_p50_ci_high,
    fire_time_p50, fire_time_p50_ci_low, fire_time_p50_ci_high,
  };
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if(msg.type !== "RUN_SIM") return;

  try{
    const { weapons, attachments, shields, patch, params } = msg;
    const { target, targets, tiers, body, head, limbs, miss, trials, seed, confidence, fullSweep } = params;
    const doFullSweep = (fullSweep !== false);

    // Normalize accuracy inputs and miss rate
    const b = Number(body ?? 0);
    const h = Number(head ?? 0);
    const l = Number(limbs ?? 0);
    const totalAcc = b + h + l;
    const nBody = totalAcc > 0 ? (b / totalAcc) : 0;
    const nHead = totalAcc > 0 ? (h / totalAcc) : 0;
    const nLimbs = totalAcc > 0 ? (l / totalAcc) : 0;
    const pMiss = clamp01(Number(miss ?? 0));

    // Build configs across weapons, tiers, and attachment combos
    const tierList = doFullSweep
      ? [1,2,3,4]
      : (Array.isArray(tiers) && tiers.length ? tiers.map(Number) : [1,2,3,4]);
    const attachMap = groupAttachmentsByWeapon(attachments || []);
    // Build patch compatibility map for patch.json (may be empty)
    const patchMap = groupPatchByWeapon(patch || []);
    const configs = [];

    for(const w of (weapons || [])){
      for(const t of tierList){
const basePost = applyTierMods(buildWeaponBase(w), t);

// If this weapon is affected by patch.json, compute a pre-patch baseline by reversing patch mods
let basePre = null;
const patchTypeMap = getTypeMapForWeapon(patchMap, w.name);
const patchItems = patchTypeMap ? patchTypeMap.get("patch") : null;
if (Array.isArray(patchItems) && patchItems.length){
  basePre = buildWeaponBase(w);
  // patch.json represents deltas applied in the latest patch; reverse them to get previous baseline
  basePre = unapplyMods(basePre, patchItems);
  basePre = applyTierMods(basePre, t);
}
        const typeMap = getTypeMapForWeapon(attachMap, w.name);
        if(typeMap){
          const combos = combosForTypes(typeMap);
          for(const combo of combos){
const stats = applyAttachments(basePost, combo);
const stats_pre = basePre ? applyAttachments(basePre, combo) : null;
configs.push({ weapon:w.name, tier:t, attachments:stats.attachments, stats, stats_pre });
          }
        } else {
          const stats = basePost;
          const stats_pre = basePre;
          configs.push({ weapon:w.name, tier:t, attachments:"none", stats, stats_pre });
        }
      }
    }
    // If target is "ALL" (or missing), simulate all shields.
    // You can also pass params.targets = ["NoShield","Light",...]
    const targetsMap = shields || TARGETS;
    const targetList = doFullSweep
      ? Object.keys(targetsMap)
      : (Array.isArray(targets)
          ? targets
          : (target === "ALL" || target == null ? Object.keys(targetsMap) : [target]));

    for (const tName of targetList){
      if (!targetsMap[tName]) throw new Error(`Unknown target: ${tName}`);
    }
    const total = configs.length * targetList.length;
    const rows = [];
    const prepatchRows = [];
    let done = 0;

    for (let i = 0; i < configs.length; i++){
      const cfg = configs[i];

      for (let ti = 0; ti < targetList.length; ti++){
        const targetName = targetList[ti];
        const tgt = targetsMap[targetName];

        // Different deterministic RNG stream per (config, target)
        const rng = mulberry32((seed + i*1013904223 + ti*374761393) >>> 0);

const cl = confidence ?? 0.95;

const post = simulateRowStats(cfg.stats, tgt, nBody, nHead, nLimbs, pMiss, trials, rng, cl);

// If this weapon is affected by patch.json, cfg.stats_pre is populated.
// Use an independent deterministic RNG stream for the pre-patch run.
let pre = null;
if (cfg.stats_pre){
  const rngPre = mulberry32(((seed + 0x9e3779b9 + i*1013904223 + ti*374761393) >>> 0));
  pre = simulateRowStats(cfg.stats_pre, tgt, nBody, nHead, nLimbs, pMiss, trials, rngPre, cl);
}

        rows.push({
  weapon: cfg.weapon,
  tier: cfg.tier,
  attachments: cfg.attachments,

  accuracy_profile: "CustomSim",
  acc_body: nBody, acc_head: nHead, acc_limbs: nLimbs,
  miss: pMiss,

  target: targetName,
  ci_level: cl,

  ...post,

  damage_per_bullet: cfg.stats.damage_per_bullet,
  fire_rate_bps: cfg.stats.fire_rate_bps,
  mag_size: cfg.stats.mag_size,
  reload_time_s: cfg.stats.reload_time_s,
  reload_amount: cfg.stats.reload_amount,
  headshot_mult: cfg.stats.headshot_mult,
  limbs_mult: cfg.stats.limbs_mult,
});

if (pre){
  prepatchRows.push({
    weapon: cfg.weapon,
    tier: cfg.tier,
    attachments: cfg.attachments,

    accuracy_profile: "CustomSim",
    acc_body: nBody, acc_head: nHead, acc_limbs: nLimbs,
    miss: pMiss,

    target: targetName,
    ci_level: cl,

    ...pre,

    damage_per_bullet: cfg.stats_pre.damage_per_bullet,
    fire_rate_bps: cfg.stats_pre.fire_rate_bps,
    mag_size: cfg.stats_pre.mag_size,
    reload_time_s: cfg.stats_pre.reload_time_s,
    reload_amount: cfg.stats_pre.reload_amount,
    headshot_mult: cfg.stats_pre.headshot_mult,
    limbs_mult: cfg.stats_pre.limbs_mult,
  });
}

        done++;
        if (done % 10 === 0) self.postMessage({ type:"PROGRESS", done, total });
      }
    }

    self.postMessage({ type:"DONE", rows, prepatchRows });

  }catch(e){
    self.postMessage({ type:"ERROR", error: String(e?.message || e) });
  }
};
