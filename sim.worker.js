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

// Targets (match your Python exports in ttk_results.json)
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
    limbs_mult: w.limbs_mult ?? 1.0,
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

self.onmessage = (ev) => {
  const msg = ev.data;
  if(msg.type !== "RUN_SIM") return;

  try{
    const { weapons, attachments, params } = msg;
    const { target, tiers, body, head, limbs, miss, trials, seed } = params;

    const tgt = TARGETS[target];
    if(!tgt) throw new Error(`Unknown target: ${target}`);

    const pHead = clamp01(head);
    const pLimbs = clamp01(limbs);
    const pBody = clamp01(body);
    const sum = pBody + pHead + pLimbs;
    const nBody = pBody / sum;
    const nHead = pHead / sum;
    const nLimbs = pLimbs / sum;

    const pMiss = clamp01(miss);

    const attByWeapon = groupAttachmentsByWeapon(attachments);

    // Build all configs
    const configs = [];
    for(const w of weapons){
      const base = buildWeaponBase(w);
      const tmap = attByWeapon.get(base.weapon) || new Map();
      const combos = combosForTypes(tmap); // includes "none" for each type

      for(const tier of tiers){
        const tiered = applyTierMods({ ...base }, tier);
        for(const combo of combos){
          const finalStats = applyAttachments(tiered, combo);
          configs.push({
            weapon: finalStats.weapon,
            tier,
            attachments: finalStats.attachments,
            stats: finalStats,
          });
        }
      }
    }

    const total = configs.length;
    const rows = [];
    let done = 0;

    for(let i=0;i<configs.length;i++){
      const cfg = configs[i];
      const rng = mulberry32((seed + i*1013904223) >>> 0);

      const ttks = new Array(trials);
      let shotsSum = 0;
      let reloadsSum = 0;

      for(let k=0;k<trials;k++){
        const shots = shotsToKillTrial(cfg.stats, tgt, nBody, nHead, nLimbs, pMiss, rng);
        const tr = ttkAndReloadsFromShots(shots, cfg.stats);
        ttks[k] = tr.ttk;
        shotsSum += shots;
        reloadsSum += tr.reloads;
      }

      ttks.sort((a,b)=>a-b);
      const ttk_p50 = percentile(ttks, 0.50);
      const ttk_p95 = percentile(ttks, 0.95);
      const ttk_mean = ttks.reduce((s,x)=>s+x,0) / ttks.length;

      rows.push({
        weapon: cfg.weapon,
        tier: cfg.tier,
        attachments: cfg.attachments,

        accuracy_profile: "CustomSim",
        acc_body: nBody, acc_head: nHead, acc_limbs: nLimbs,
        miss: pMiss,
        target,

        ttk_p50, ttk_p95, ttk_mean,
        shots_p50: null, // optional; keeping minimal
        shots_mean: shotsSum / trials,
        reloads_mean: reloadsSum / trials,

        damage_per_bullet: cfg.stats.damage_per_bullet,
        fire_rate_bps: cfg.stats.fire_rate_bps,
        mag_size: cfg.stats.mag_size,
        reload_time_s: cfg.stats.reload_time_s,
        reload_amount: cfg.stats.reload_amount,
        headshot_mult: cfg.stats.headshot_mult,
        limbs_mult: cfg.stats.limbs_mult,
      });

      done++;
      if(done % 10 === 0) self.postMessage({ type:"PROGRESS", done, total });
    }

    self.postMessage({ type:"DONE", rows });

  }catch(e){
    self.postMessage({ type:"ERROR", error: String(e?.message || e) });
  }
};
