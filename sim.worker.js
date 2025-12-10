// WebWorker: generates a custom preset by simulating all weapon/tier/attachment combos
// using weapons.json + attachments.json.

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

// mulberry32 PRNG (seeded)
function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const TARGETS = {
  "NoShield": { hp:100, shield:0,  dr:0.0 },
  "Light":    { hp:100, shield:40, dr:0.4 },
  "Medium":   { hp:100, shield:70, dr:0.425 },
  "Heavy":    { hp:100, shield:80, dr:0.525 },
};

function applyTierMods(base, tier){
  // tier=1 => no mod, tier=2 => index0, tier=3 => index1, tier=4 => index2
  const idx = tier - 2;
  const out = { ...base };

  if(idx < 0) return out;

  const tm = base.tier_mods || {};
  // fire_rate_pct: [10,20,30] means +10%/+20%/+30%
  if(Array.isArray(tm.fire_rate_pct) && tm.fire_rate_pct[idx] != null){
    out.fire_rate_bps *= (1 + (tm.fire_rate_pct[idx] / 100));
  }

  // reload_time_reduction_pct: reduces reload time
  if(Array.isArray(tm.reload_time_reduction_pct) && tm.reload_time_reduction_pct[idx] != null){
    out.reload_time_s *= (1 - (tm.reload_time_reduction_pct[idx] / 100));
  }

  // mag_add: adds mag size
  if(Array.isArray(tm.mag_add) && tm.mag_add[idx] != null){
    out.mag_size += tm.mag_add[idx];
  }

  return out;
}

function buildWeaponBase(w){
  return {
    weapon: w.name,
    damage_per_bullet: w.damage,
    fire_rate_bps: w.fire_rate,
    mag_size: w.mag_size,
    reload_time_s: w.reload_time_s,
    reload_amount: w.reload_amount ?? 0,
    headshot_mult: w.headshot_mult ?? 2.0, // fallback
    limbs_mult: w.limbs_mult ?? 0.75,
    tier_mods: w.tier_mods || {},
  };
}

function groupAttachmentsByWeapon(attachments){
  const map = new Map(); // weapon -> type -> list
  for(const a of attachments){
    for(const w of (a.compatible || [])){
      if(!map.has(w)) map.set(w, new Map());
      const tmap = map.get(w);
      const type = a.type || "misc";
      if(!tmap.has(type)) tmap.set(type, []);
      tmap.get(type).push(a);
    }
  }
  return map;
}

function combosForTypes(typeMap){
  // typeMap: Map(type -> list of attachments)
  const types = [...typeMap.keys()].sort();
  const lists = types.map(t => [{ name:"none", type:t, _none:true }, ...typeMap.get(t)]);
  const out = [];

  function rec(i, acc){
    if(i === lists.length){
      out.push(acc.slice());
      return;
    }
    for(const item of lists[i]){
      acc.push(item);
      rec(i+1, acc);
      acc.pop();
    }
  }
  rec(0, []);
  return out;
}

function applyAttachments(stats, combo){
  const out = { ...stats };
  const names = [];

  for(const a of combo){
    if(a._none) continue;
    names.push(a.name);

    if(a.mag_add != null) out.mag_size += a.mag_add;
    if(a.fire_rate_mult != null) out.fire_rate_bps *= a.fire_rate_mult;

    // leave room for future mods:
    // if(a.reload_time_mult) out.reload_time_s *= a.reload_time_mult;
    // if(a.damage_mult) out.damage_per_bullet *= a.damage_mult;
  }

  out.attachments = names.length ? names.join(" + ") : "none";
  return out;
}

function shotsToKillTrial(stats, target, pBody, pHead, pLimbs, pMiss, rng){
  let hp = target.hp;
  let sh = target.shield;
  const dr = target.dr;

  let shots = 0;

  while(hp >= 1.0){
    shots++;

    if(rng() < pMiss){
      if(shots > 200000) return Infinity;
      continue;
    }

    const r = rng();
    let mult = 1.0;
    if(r < pBody){
      mult = 1.0;
    } else if(r < pBody + pHead){
      mult = stats.headshot_mult;
    } else {
      mult = stats.limbs_mult;
    }

    const dmg = stats.damage_per_bullet * mult;

    if(sh > 0){
      sh = Math.max(0, sh - dmg);       // full to shield
      hp -= dmg * (1 - dr);            // mitigated to HP
    } else {
      hp -= dmg;                       // full to HP
    }

    if(shots > 200000) return Infinity;
  }

  return shots;
}

function ttkAndReloadsFromShots(shotsNeeded, stats){
  if(!Number.isFinite(shotsNeeded)) return { ttk: NaN, reloads: NaN };

  const magSize = stats.mag_size;
  const fr = stats.fire_rate_bps;
  const rt = stats.reload_time_s;
  const ra = stats.reload_amount;

  const shotInterval = fr > 0 ? (1 / fr) : 0;

  let shotsDone = 0;
  let mag = magSize;
  let t = 0;
  let reloads = 0;

  while(shotsDone < shotsNeeded){
    if(mag === 0){
      const remaining = shotsNeeded - shotsDone;

      if(ra <= 0){
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

    if(shotsDone >= shotsNeeded) break;

    // No cadence wait around reload; only between shots while still in mag.
    if(mag > 0 && shotInterval > 0) t += shotInterval;
  }

  return { ttk: t, reloads };
}

function percentile(sorted, p){
  if(!sorted.length) return NaN;
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
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

self.onmessage = (ev) => {
  const msg = ev.data;
  if(msg.type !== "RUN_SIM") return;

  try{
    const { weapons, attachments, params } = msg;
    const { target, targets, tiers, body, head, limbs, miss, trials, seed, confidence } = params;

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
    const tierList = Array.isArray(tiers) && tiers.length ? tiers.map(Number) : [1,2,3,4];
    const attachMap = groupAttachmentsByWeapon(attachments || []);
    const configs = [];

    for(const w of (weapons || [])){
      for(const t of tierList){
        const base = applyTierMods(buildWeaponBase(w), t);
        const typeMap = attachMap.get(w.name);
        if(typeMap){
          const combos = combosForTypes(typeMap);
          for(const combo of combos){
            const stats = applyAttachments(base, combo);
            configs.push({ weapon:w.name, tier:t, attachments:stats.attachments, stats });
          }
        } else {
          configs.push({ weapon:w.name, tier:t, attachments:"none", stats:base });
        }
      }
    }
    // If target is "ALL" (or missing), simulate all shields.
    // You can also pass params.targets = ["NoShield","Light",...]
    const targetList = Array.isArray(targets)
      ? targets
      : (target === "ALL" || target == null ? Object.keys(TARGETS) : [target]);

    for (const tName of targetList){
      if (!TARGETS[tName]) throw new Error(`Unknown target: ${tName}`);
    }
    const total = configs.length * targetList.length;
    const rows = [];
    let done = 0;

    for (let i = 0; i < configs.length; i++){
      const cfg = configs[i];

      for (let ti = 0; ti < targetList.length; ti++){
        const targetName = targetList[ti];
        const tgt = TARGETS[targetName];

        // Different deterministic RNG stream per (config, target)
        const rng = mulberry32((seed + i*1013904223 + ti*374761393) >>> 0);

        const ttks = new Array(trials);
        const shotsArr = new Array(trials);
        const reloadsArr = new Array(trials);
        const reloadTimeArr = new Array(trials);
        const fireTimeArr = new Array(trials);
        let shotsSum = 0;
        let reloadsSum = 0;

        for (let k = 0; k < trials; k++){
          const shots = shotsToKillTrial(cfg.stats, tgt, nBody, nHead, nLimbs, pMiss, rng);
          const tr = ttkAndReloadsFromShots(shots, cfg.stats);
          const ttkVal = tr.ttk;
          const rels = tr.reloads;
          const rTime = rels * cfg.stats.reload_time_s;
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

        const cl = confidence ?? 0.95;
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
        const ttk_ci_half = (ttk_p50_ci_high - ttk_p50_ci_low) / 2;
        const ttk_ci_rel = ttk_p50 ? (ttk_ci_half / ttk_p50) : NaN;

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

        rows.push({
          weapon: cfg.weapon,
          tier: cfg.tier,
          attachments: cfg.attachments,

          accuracy_profile: "CustomSim",
          acc_body: nBody, acc_head: nHead, acc_limbs: nLimbs,
          miss: pMiss,

          target: targetName,
          ci_level: cl,

          ttk_mean,
          ttk_mean_ci_low,
          ttk_mean_ci_high,
          ttk_p50,
          ttk_p50_ci_low,
          ttk_p50_ci_high,
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

          shots_p50,
          shots_p50_ci_low,
          shots_p50_ci_high,
          reloads_p50,
          reloads_p50_ci_low,
          reloads_p50_ci_high,
          reload_time_p50,
          reload_time_p50_ci_low,
          reload_time_p50_ci_high,
          fire_time_p50,
          fire_time_p50_ci_low,
          fire_time_p50_ci_high,

          damage_per_bullet: cfg.stats.damage_per_bullet,
          fire_rate_bps: cfg.stats.fire_rate_bps,
          mag_size: cfg.stats.mag_size,
          reload_time_s: cfg.stats.reload_time_s,
          reload_amount: cfg.stats.reload_amount,
          headshot_mult: cfg.stats.headshot_mult,
          limbs_mult: cfg.stats.limbs_mult,
        });

        done++;
        if (done % 10 === 0) self.postMessage({ type:"PROGRESS", done, total });
      }
    }

    self.postMessage({ type:"DONE", rows });

  }catch(e){
    self.postMessage({ type:"ERROR", error: String(e?.message || e) });
  }
};
