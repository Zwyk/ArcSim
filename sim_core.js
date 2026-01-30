// sim_core.js
// Shared simulation core used by both the web worker and Node presets.

const CEIL_DIGITS = 8;

// UMD wrapper: works in browser (SimCore global) and Node (module.exports)
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  // ---- Helpers ----
  function clamp01(x){
    if (!Number.isFinite(x)) return 0;
    if (x < 0) return 0;
    if (x > 1) return 1;
    return x;
  }

  // Normalize hit-zone weights into probabilities.
  // Returns { nBody, nHead, nLimbs, total } where total is the pre-normalized sum.
  function normalizeZoneWeights(body, head, limbs){
    const b = Number(body ?? 0);
    const h = Number(head ?? 0);
    const l = Number(limbs ?? 0);
    const total = b + h + l;
    return {
      total,
      nBody: total > 0 ? (b / total) : 0,
      nHead: total > 0 ? (h / total) : 0,
      nLimbs: total > 0 ? (l / total) : 0,
    };
  }

  function isFullyDeterministicAccuracy(pMiss, nBody, nHead, nLimbs, eps){
    const e = (eps == null) ? 1e-9 : eps;
    return (pMiss <= e) && (
      (Math.abs(nBody - 1) <= e && Math.abs(nHead) <= e && Math.abs(nLimbs) <= e) ||
      (Math.abs(nHead - 1) <= e && Math.abs(nBody) <= e && Math.abs(nLimbs) <= e) ||
      (Math.abs(nLimbs - 1) <= e && Math.abs(nBody) <= e && Math.abs(nHead) <= e)
    );
  }

  // Trials: allow request for many trials, but short-circuit fully-deterministic scenarios.
  // Deterministic = 100% one zone (body/head/limbs) and 0% miss.
  function computeEffectiveTrials(trials, pMiss, nBody, nHead, nLimbs, eps){
    const reqTrials = Math.max(1, (Number(trials ?? 1) | 0));
    const isDeterministic = isFullyDeterministicAccuracy(pMiss, nBody, nHead, nLimbs, eps);
    const effTrials = isDeterministic ? 1 : reqTrials;
    return { reqTrials, effTrials, isDeterministic };
  }

  // Stable 32-bit hash (FNV-1a) for deterministic seeding.
  function hash32(str){
    let h = 0x811c9dc5;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++){
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // Deterministic hit sequences (simple fixed sequences)
  function makeZoneSequence(bodyW, headW, limbsW, length){
    const len = (length == null) ? 100 : length;
    const parts = [
      ["body", bodyW],
      ["head", headW],
      ["limbs", limbsW],
    ].filter(([, w]) => w > 0);
    if (!parts.length) return ["body"];
    const sum = parts.reduce((s, [, w]) => s + w, 0);
    const norm = parts.map(([z, w]) => [z, w / sum]);
    const counts = Object.fromEntries(norm.map(([z, w]) => [z, Math.round(w * len)]));
    const total = Object.values(counts).reduce((s, x) => s + x, 0);
    const mainZone = norm.slice().sort((a, b) => b[1] - a[1])[0][0];
    counts[mainZone] += (len - total);
    let bag = [];
    for (const [z] of norm.slice().sort((a, b) => b[1] - a[1])){
      bag = bag.concat(Array(Math.max(0, counts[z])).fill(z));
    }
    if (!bag.length) return ["body"];
    const out = new Array(bag.length).fill(null);
    const step = 7;
    let i = 0;
    for (const item of bag){
      while (out[i] !== null) i = (i + 1) % out.length;
      out[i] = item;
      i = (i + step) % out.length;
    }
    return out;
  }

  function combosCountForTypes(typeMap){
    if (!typeMap || !typeMap.keys) return 1;
    let n = 1;
    for (const t of typeMap.keys()){
      const list = typeMap.get(t);
      const k = Array.isArray(list) ? (1 + list.length) : 1;
      n *= k;
    }
    return n;
  }

  function maxTier(weapon){
    const tm = weapon?.tier_mods || {};
    let m = 0;
    for (const v of Object.values(tm)) if (Array.isArray(v)) m = Math.max(m, v.length);
    return Math.max(1, 1 + m);
  }

  // Build a consistent target list from UI-like params.
  // - Includes composite multi-target specs via +.
  // - Ensures the multi-target label is included for full sweeps or ALL.
  function buildTargetListFromParams(targetsMap, params, doFullSweep, defaultMultiParts){
    const p = params || {};
    const targetLookup = buildTargetLookup(targetsMap);

    // Composite multi-target scenario support (also included in sweeps)
    let multiParts = Array.isArray(defaultMultiParts) && defaultMultiParts.length
      ? defaultMultiParts.slice()
      : ["Medium", "Light", "Light"];

    if (Array.isArray(p.multiTarget)){
      const parts = p.multiTarget.map(x => String(x || "").trim()).filter(Boolean);
      if (parts.length > 1){
        try{
          // validates ids/labels (space-insensitive) via the shared resolver
          resolveTargetSpec(targetsMap, parts.join("+"), targetLookup);
          multiParts = parts;
        }catch(_e){ /* keep default */ }
      }
    }
    const DEFAULT_MULTI_TARGET_NAME = multiParts.join("+");

    let targetList;
    if (doFullSweep){
      targetList = Object.keys(targetsMap);
      if (!targetList.includes(DEFAULT_MULTI_TARGET_NAME)) targetList.push(DEFAULT_MULTI_TARGET_NAME);
    } else if (Array.isArray(p.targets)){
      targetList = p.targets;
    } else if (p.target === "ALL" || p.target == null){
      targetList = Object.keys(targetsMap);
      if (!targetList.includes(DEFAULT_MULTI_TARGET_NAME)) targetList.push(DEFAULT_MULTI_TARGET_NAME);
    } else {
      targetList = [p.target];
    }

    for (const tName of targetList){
      // validate (also validates composite specs)
      resolveTargetSpec(targetsMap, tName, targetLookup);
    }

    return { targetList, targetLookup, multiParts, DEFAULT_MULTI_TARGET_NAME };
  }

  // Build target scenarios (single targets + optional composite) with cached totals.
  function buildTargetScenarios(targetsMap, multiParts){
    const out = [];
    for (const id of Object.keys(targetsMap || {})){
      const t = targetsMap[id];
      const totals = targetTotals(t);
      out.push({ name: id, target: t, ...totals });
    }

    const parts = Array.isArray(multiParts) ? multiParts.slice() : [];
    if (parts.length > 1){
      try{
        const lookup = buildTargetLookup(targetsMap);
        const label = parts.join("+");
        const tgt = resolveTargetSpec(targetsMap, label, lookup);
        const totals = targetTotals(tgt);
        out.push({ name: label, target: tgt, ...totals });
      }catch(_e){ /* skip */ }
    }

    return out;
  }

  // simple deterministic PRNG
  function mulberry32(a) {
    return function () {
      let t = a += 0x6D2B79F5;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  // Build base stats from weapons.json entry
  function buildWeaponBase(w){
    return {
      weapon: w.name,
      damage_per_bullet: w.damage,
      fire_rate_bps: w.fire_rate,
      mag_size: w.mag_size,
      reload_time_s: w.reload_time_s,
      reload_amount: w.reload_amount ?? 0,
      headshot_mult: w.headshot_mult ?? 2.0,
      limbs_mult: w.limbs_mult ?? 0.75,
      tier_mods: w.tier_mods || {},
      // bullets fired per shot / trigger pull (shotguns, burst weapons, etc.)
      bullets_per_shot: (Number.isFinite(Number(w.nb_bullets)) && Number(w.nb_bullets) > 0)
        ? Number(w.nb_bullets)
        : 1,

      // Optional: delay between bullets within the same shot (burst cadence), in seconds.
      // If present (>0) AND bullets_per_shot>1, the shot behaves like a burst.
      burst_delay_s: (Number.isFinite(Number(w.burst_delay)) && Number(w.burst_delay) > 0)
        ? Number(w.burst_delay)
        : 0,

      // Ammo consumed per shot.
      // - If this shot is a burst (burst_delay_s>0): each shot consumes nb_bullets ammo.
      // - Otherwise (shotgun-style multi-projectile): still consumes 1 ammo per shot.
      ammo_per_shot: (
        (Number.isFinite(Number(w.burst_delay)) && Number(w.burst_delay) > 0) &&
        (Number.isFinite(Number(w.nb_bullets)) && Number(w.nb_bullets) > 1)
      ) ? Number(w.nb_bullets) : 1
    };
  }

  // Apply tier modifiers from weapon.tier_mods
  function applyTierMods(base, tier){
    const out = { ...base, tier };
    const tm = base.tier_mods || {};
    const idx = (tier|0) - 2; // Tier II->0, Tier III->1, Tier IV->2

    if (idx < 0) return out;  // Tier I: no tier mods

    // reload time reduction (percent) — clamp to avoid negatives
    if (Array.isArray(tm.reload_time_reduction_pct) && tm.reload_time_reduction_pct[idx] != null){
      const pct = Math.max(0, tm.reload_time_reduction_pct[idx]);
      out.reload_time_s *= (1 - pct / 100);
    }
    // mag add — clamp to avoid accidental downgrades
    if (Array.isArray(tm.mag_add) && tm.mag_add[idx] != null){
      const add = Math.max(0, tm.mag_add[idx]);
      out.mag_size += add;
    }
    // fire rate increase (percent)
    if (Array.isArray(tm.fire_rate_pct) && tm.fire_rate_pct[idx] != null){
      out.fire_rate_bps *= (1 + (tm.fire_rate_pct[idx] / 100));
    }
    // future-proof: could add more tier mods here

    return out;
  }

  // Group attachments by weapon + type
 function groupAttachmentsByWeapon(attachments){
    const map = new Map(); // weaponBase -> (type -> list)
    for (const a of attachments){
      for (const w of (a.compatible || [])){
        const key = String(w || "").trim();
        if (!key) continue;

        if (!map.has(key)) map.set(key, new Map());
        const tmap = map.get(key);

        const type = a.type || "misc";
        if (!tmap.has(type)) tmap.set(type, []);
        tmap.get(type).push(a);
      }
    }
    return map;
  }

  function getTypeMapForWeapon(attachMap, weaponName){
    const wn = String(weaponName || "").toLowerCase();

    let bestKey = null;
    let bestLen = -1;

    for (const key of attachMap.keys()){
      const k = String(key || "").toLowerCase();
      if (!k) continue;

      if (wn === k || wn.includes(k)){
        if (k.length > bestLen){
          bestLen = k.length;
          bestKey = key;
        }
      }
    }

    return bestKey ? attachMap.get(bestKey) : null;
  }

  // All combinations of "none or one per type"
  function combosForTypes(typeMap){
    const types = [...typeMap.keys()].sort();
    const lists = types.map(t => [{ name:"none", type:t, _none:true }, ...typeMap.get(t)]);
    const out = [];

    function rec(i, acc){
      if (i === lists.length){
        out.push(acc.slice());
        return;
      }
      for (const item of lists[i]){
        acc.push(item);
        rec(i+1, acc);
        acc.pop();
      }
    }
    rec(0, []);
    return out;
  }

// Apply a list of mod objects (attachments/patch-like) to weapon stats.
// By default, this does NOT change the "attachments" label unless setAttachmentsLabel=true.
function applyMods(stats, modsList, opts){
  const out = { ...stats };
  const o = opts || {};
  const setLabel = !!o.setAttachmentsLabel;

  const names = [];
  for (const m of (modsList || [])){
    if (!m || m._none) continue;
    if (m.name) names.push(m.name);

    // Alias support (typo-proofing)
    const magAdd = (m.mag_add != null) ? m.mag_add : (m.mad_add != null ? m.mad_add : null);

    if (magAdd != null)              out.mag_size += magAdd;

    if (m.fire_rate_mult != null)    out.fire_rate_bps *= m.fire_rate_mult;
    if (m.fire_rate_pct != null)     out.fire_rate_bps *= (1 + (m.fire_rate_pct / 100));
    if (m.fire_rate != null)         out.fire_rate_bps += m.fire_rate;

    if (m.reload_time_mult != null)  out.reload_time_s *= m.reload_time_mult;
    if (m.reload_time_pct != null)   out.reload_time_s *= (1 + (m.reload_time_pct / 100));
    if (m.reload_time != null)       out.reload_time_s += m.reload_time;

    if (m.damage_mult != null)       out.damage_per_bullet *= m.damage_mult;
    if (m.damage_add != null)        out.damage_per_bullet += m.damage_add;

    if (m.reload_amount_add != null) out.reload_amount += m.reload_amount_add;
    if (m.reload_amount != null)     out.reload_amount = m.reload_amount;

    if (m.headshot_mult != null)     out.headshot_mult *= m.headshot_mult;
    if (m.limbs_mult != null)        out.limbs_mult *= m.limbs_mult;
  }

  if (setLabel){
    out.attachments = names.length ? names.join(" + ") : "none";
  }
  return out;
}

// Reverse/unapply a list of mod objects (attachments/patch-like).
// NOTE: direct "set" ops (e.g. reload_amount) are not generally invertible; those are ignored here.
function unapplyMods(stats, modsList, opts){
  const out = { ...stats };
  const o = opts || {};
  const setLabel = !!o.setAttachmentsLabel;

  const names = [];
  for (const m of (modsList || [])){
    if (!m || m._none) continue;
    if (m.name) names.push(m.name);

    const magAdd = (m.mag_add != null) ? m.mag_add : (m.mad_add != null ? m.mad_add : null);

    if (magAdd != null)              out.mag_size -= magAdd;

    if (m.fire_rate_mult != null)    out.fire_rate_bps /= m.fire_rate_mult;
    if (m.fire_rate_pct != null)     out.fire_rate_bps /= (1 + (m.fire_rate_pct / 100));
    if (m.fire_rate != null)         out.fire_rate_bps -= m.fire_rate;

    if (m.reload_time_mult != null)  out.reload_time_s /= m.reload_time_mult;
    if (m.reload_time_pct != null)   out.reload_time_s /= (1 + (m.reload_time_pct / 100));
    if (m.reload_time != null)       out.reload_time_s -= m.reload_time;

    if (m.damage_mult != null)       out.damage_per_bullet /= m.damage_mult;
    if (m.damage_add != null)        out.damage_per_bullet -= m.damage_add;

    if (m.reload_amount_add != null) out.reload_amount -= m.reload_amount_add;

    if (m.headshot_mult != null)     out.headshot_mult /= m.headshot_mult;
    if (m.limbs_mult != null)        out.limbs_mult /= m.limbs_mult;
  }

  if (setLabel){
    out.attachments = names.length ? names.join(" + ") : "none";
  }
  return out;
}

// Apply one combo of attachments (also sets "attachments" label)
function applyAttachments(stats, combo){
  return applyMods(stats, combo, { setAttachmentsLabel: true });
}

// Apply one combo of attachments (inverse; also sets "attachments" label)
function unapplyAttachments(stats, combo){
  return unapplyMods(stats, combo, { setAttachmentsLabel: true });
}

  
  // Apply a single bullet's damage to a target state.
  // IMPORTANT GAME RULE:
  // - Shield is reduced by BASE bullet damage (before head/limb multiplier).
  // - HP damage uses the hit-zone multiplier; while shield is up, damage reduction applies.
  // state: { hp, sh, dr }
  function applyBulletToState(stats, state, mult){
    const baseDmg = stats.damage_per_bullet;
    const dmg = baseDmg * mult;

    if (state.sh > 0){
      state.sh = Math.max(0, state.sh - baseDmg);
      state.hp -= dmg * (1 - state.dr);
    } else {
      state.hp -= dmg;
    }
  }

// Monte-Carlo shot loop, with bullets-per-shot and per-bullet zone/miss rolls.
  // Supports either a single target object, or an array of targets for sequential multi-target sims.
  function shotsToKillTrial(stats, target, pBody, pHead, pLimbs, pMiss, rng){
    const targets = Array.isArray(target) ? target : [target];
    if (!targets.length) return Infinity;

    let idx = 0;
    const state = { hp: targets[0].hp, sh: targets[0].shield, dr: targets[0].dr };

    const bulletsPerShot = stats.bullets_per_shot || 1;
    let shots = 0;

    // Index (0-based) of the bullet within the last shot that landed the FINAL killing blow.
    // Used for burst weapons with burst_delay_s.
    let killBullet = 0;

    // Helper: move to next target when current dies, return true if we still have targets left
    function advanceTarget(){
      idx++;
      if (idx >= targets.length) return false;
      const t = targets[idx];
      state.hp = t.hp;
      state.sh = t.shield;
      state.dr = t.dr;
      return true;
    }

    // Loop until all targets are dead
    while (idx < targets.length){
      // If current target already dead (edge cases), advance
      if (ceilN(state.hp) < 1.0){
        if (!advanceTarget()) break;
        continue;
      }

      shots++;

      // Safety guard for extreme miss rates or invalid inputs
      if (shots > 200000) return Infinity;

      // Each bullet in the shot gets its own miss + hit-zone roll
      for (let b = 0; b < bulletsPerShot && idx < targets.length; b++){
        // If current target died between bullets (possible if we advanced), ensure we're on a live target
        while (idx < targets.length && ceilN(state.hp) < 1.0){
          if (!advanceTarget()) break;
        }
        if (idx >= targets.length) break;

        if (rng() < pMiss){
          continue;
        }

        const r = rng();
        let mult = 1.0;
        if (r < pBody){
          mult = 1.0;
        } else if (r < pBody + pHead){
          mult = stats.headshot_mult;
        } else {
          mult = stats.limbs_mult;
        }
        applyBulletToState(stats, state, mult);

        // If we killed the current target with this bullet:
        if (ceilN(state.hp) < 1.0){
          // If that was the last target, record kill bullet and finish this shot
          if (idx === targets.length - 1){
            killBullet = b;
            idx = targets.length; // mark done
            break;
          }
          // Otherwise, advance immediately and keep going within the same shot/burst
          advanceTarget();
        }
      }
    }

    const bps2 = stats.bullets_per_shot || 1;
    const isBurst = (stats.burst_delay_s || 0) > 0 && bps2 > 1;
    const bulletsToKill = isBurst
      ? ((shots - 1) * bps2 + (killBullet + 1))
      : shots;

    return { shots, kill_bullet: killBullet, bullets_to_kill: bulletsToKill };
  }

  // Deterministic version with a fixed sequence of hit-zones for bullets.
  // Supports either a single target object, or an array of targets for sequential multi-target sims.
  function shotsToKillWithSeq(stats, target, hitSeq){
    const targets = Array.isArray(target) ? target : [target];
    if (!targets.length) return Infinity;

    let idx = 0;
    const state = { hp: targets[0].hp, sh: targets[0].shield, dr: targets[0].dr };

    const bulletsPerShot = stats.bullets_per_shot || 1;

    let shots = 0;

    // Index (0-based) of the bullet within the last shot that landed the FINAL killing blow.
    let killBullet = 0;
    let i = 0;

    function advanceTarget(){
      idx++;
      if (idx >= targets.length) return false;
      const t = targets[idx];
      state.hp = t.hp;
      state.sh = t.shield;
      state.dr = t.dr;
      return true;
    }

    while (idx < targets.length){
      if (ceilN(state.hp) < 1.0){
        if (!advanceTarget()) break;
        continue;
      }

      shots++;

      for (let b = 0; b < bulletsPerShot && idx < targets.length; b++){
        while (idx < targets.length && ceilN(state.hp) < 1.0){
          if (!advanceTarget()) break;
        }
        if (idx >= targets.length) break;

        const zone = hitSeq[i++] || "body";
        let mult = 1.0;
        if (zone === "head")      mult = stats.headshot_mult;
        else if (zone === "limbs") mult = stats.limbs_mult;

        applyBulletToState(stats, state, mult);

        if (ceilN(state.hp) < 1.0){
          if (idx === targets.length - 1){
            killBullet = b;
            idx = targets.length;
            break;
          }
          advanceTarget();
        }

        if (shots > 200000) return Infinity;
      }
    }

    const bps3 = stats.bullets_per_shot || 1;
    const isBurst2 = (stats.burst_delay_s || 0) > 0 && bps3 > 1;
    const bulletsToKill = isBurst2
      ? ((shots - 1) * bps3 + (killBullet + 1))
      : shots;
    return { shots, kill_bullet: killBullet, bullets_to_kill: bulletsToKill };
  }


  // Turn shots needed into TTK + reloads.
  // Timing is shot-based (fire_rate is shots/sec).
  // Ammo is also shot-based: even if a weapon fires multiple bullets per shot
  // (nb_bullets / bullets_per_shot), it still consumes **one** ammo unit.
  function ttkAndReloadsFromShots(shotsInfo, stats) {
    // Backwards compatible: accept either a number of shots, or an object:
    // { shots: <number>, kill_bullet: <0-based index within last shot> }
    const info = (typeof shotsInfo === "number")
      ? { shots: shotsInfo, kill_bullet: 0 }
      : (shotsInfo || { shots: NaN, kill_bullet: 0 });

    const shotsNeeded = info.shots;

    if (!Number.isFinite(shotsNeeded)) {
      return { ttk: NaN, reloads: NaN };
    }

    const killBulletRaw = info.kill_bullet ?? 0;

    const magSize       = stats.mag_size;
    const fr            = stats.fire_rate_bps;
    const rt            = stats.reload_time_s;
    const ra            = stats.reload_amount;
    const ammoPerShot   = stats.ammo_per_shot || 1;

    const bulletsPerShot = stats.bullets_per_shot || 1;
    const bulletDelay    = stats.burst_delay_s || 0;

    const burstDuration = (bulletDelay > 0 && bulletsPerShot > 1)
      ? (bulletsPerShot - 1) * bulletDelay
      : 0;

    const baseInterval = fr > 0 ? 1 / fr : 0;
    // A new shot can't start before the previous burst is done.
    const shotInterval = Math.max(baseInterval, burstDuration);

    // Guard: impossible to fire a single shot if one shot costs more ammo than mag size
    if (ammoPerShot > magSize) {
      return { ttk: Infinity, reloads: Infinity };
    }

    // Clamp kill bullet index to a valid range
    const killBullet = Math.max(0, Math.min((bulletsPerShot - 1), killBulletRaw));

    let shotsDone  = 0;
    let ammoInMag  = magSize;
    let reloads    = 0; // number of reload *actions* (each costing reload_time_s)
    let time       = 0;

    while (shotsDone < shotsNeeded) {
      ammoInMag -= ammoPerShot;
      shotsDone++;

      if (shotsDone < shotsNeeded) {
        // Determine if a reload is required before the NEXT shot
        const needReload = (ammoInMag < ammoPerShot);

        // If we can't afford the next shot, reload in-between shots
        if (needReload) {
          if (ra && ra > 0 && ra < magSize) {
            const remainingShots = shotsNeeded - shotsDone;   // after firing this shot
            const neededAmmo     = remainingShots * ammoPerShot;
            const haveAmmo       = ammoInMag;

            const missingAmmo = Math.max(
              0,
              Math.min(
                magSize - haveAmmo,
                neededAmmo - haveAmmo
              )
            );

            const chunks = Math.max(1, Math.ceil(missingAmmo / ra));
            time += chunks * rt;

            ammoInMag += chunks * ra;
            if (ammoInMag > magSize) ammoInMag = magSize;
            reloads += chunks;
          } else {
            time += rt;
            ammoInMag = magSize;
            reloads += 1;
          }
        }

        // Fire time is only the cadence between shots within the same magazine.
        // If the next shot requires a reload, we do NOT wait shotInterval here.
        if (!needReload && shotInterval > 0) {
          time += shotInterval;
        }

      } else {
        // Last shot: if it's a burst weapon, the kill may occur mid-burst.
        if (bulletDelay > 0 && bulletsPerShot > 1) {
          time += killBullet * bulletDelay;
        }
      }
    }

    return { ttk: time, reloads };
  }

  function ceilN(x, digits = CEIL_DIGITS){
    const p = 10 ** digits;
    // tiny epsilon prevents floating point artifacts (e.g. 1.23000000002)
    return Math.ceil(x * p - 1e-9) / p;
  }

  // ---- Stats helpers (mean, stdev, CI, etc.) ----

  function mean(arr){
    if (!arr.length) return NaN;
    let s = 0;
    for (const x of arr) s += x;
    return s / arr.length;
  }

  function stddev(arr, mu){
    if (!arr.length) return NaN;
    const m = (mu != null) ? mu : mean(arr);
    let s2 = 0;
    for (const x of arr){
      const d = x - m;
      s2 += d * d;
    }
    return Math.sqrt(s2 / arr.length);
  }

  function percentile(sortedArr, p){
    if (!sortedArr.length) return NaN;
    if (p <= 0) return sortedArr[0];
    if (p >= 1) return sortedArr[sortedArr.length - 1];
    const idx = (sortedArr.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    const t = idx - lo;
    if (hi >= sortedArr.length) return sortedArr[sortedArr.length - 1];
    return sortedArr[lo] * (1 - t) + sortedArr[hi] * t;
  }

  // approximate z-score for a given confidence level
  function zForCL(conf){
    if (!Number.isFinite(conf) || conf <= 0.5 || conf >= 1) return 1.96;
    if (conf === 0.90) return 1.645;
    if (conf === 0.95) return 1.96;
    if (conf === 0.99) return 2.576;
    // crude fallback
    return 1.96;
  }

  function quantileCI(sortedArr, conf){
    if (!sortedArr.length) return { lo: NaN, hi: NaN };
    const n = sortedArr.length;
    const alpha = 1 - conf;
    const loP = alpha / 2;
    const hiP = 1 - alpha / 2;
    return {
      lo: percentile(sortedArr, loP),
      hi: percentile(sortedArr, hiP)
    };
  }


// ---------- Higher-level shared helpers (used by both Node preset generator and WebWorker) ----------

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

// Normal-approx order-stat CI for a quantile q (e.g. 0.5 median, 0.95 p95).
// Returns [low, high] values (from the sorted sample) that roughly bound the quantile with confidence cl.
function quantileCIForQ(sortedArr, q, cl){
  const n = sortedArr.length;
  if (n === 0) return [NaN, NaN];
  if (n === 1) return [sortedArr[0], sortedArr[0]];

  const z = zForCL(cl);
  const mu = n * q;
  const sigma = Math.sqrt(n * q * (1 - q));

  let kLow = Math.floor(mu - z * sigma);
  let kHigh = Math.ceil(mu + z * sigma);

  kLow = Math.max(0, Math.min(n - 1, kLow));
  kHigh = Math.max(0, Math.min(n - 1, kHigh));
  if (kHigh < kLow){ const t = kLow; kLow = kHigh; kHigh = t; }

  return [sortedArr[kLow], sortedArr[kHigh]];
}

// Build a compatibility map for patch.json like attachments map, so getTypeMapForWeapon() can be reused.
// Map<compatibleWeaponName, Map<"patch", patchItems[]>>
function groupPatchByWeapon(patchArr){
  const m = new Map();
  for (const it of (patchArr || [])){
    const compat = it && (it.compatible ?? it.weapons ?? it.weapon ?? it.weapon_name);
    const list = Array.isArray(compat) ? compat : (typeof compat === "string" ? [compat] : null);
    if (!list || !list.length) continue;

    for (const wName of list){
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

// Build (weapon,tier,attachments) configs, optionally including a pre-patch baseline for weapons affected by patch.json.
// Returns { configs, attachMap, patchMap } where configs is an array of { weapon, tier, attachments, stats, stats_pre }.
function buildConfigs(weapons, attachments, patch, tierList){
  const attachMap = groupAttachmentsByWeapon(attachments || []);
  const patchMap = groupPatchByWeapon(patch || []);
  const tiers = Array.isArray(tierList) && tierList.length ? tierList.map(Number) : [1,2,3,4];

  const configs = [];
  for (const w of (weapons || [])){
    for (const t of tiers){
      const basePost = applyTierMods(buildWeaponBase(w), t);

      // If weapon affected by patch.json, compute a pre-patch baseline by reversing patch mods (then apply tier + attachments)
      let basePre = null;
      const patchTypeMap = getTypeMapForWeapon(patchMap, w.name);
      const patchItems = patchTypeMap ? patchTypeMap.get("patch") : null;
      if (Array.isArray(patchItems) && patchItems.length){
        basePre = buildWeaponBase(w);
        basePre = unapplyMods(basePre, patchItems);
        basePre = applyTierMods(basePre, t);
      }

      const typeMap = getTypeMapForWeapon(attachMap, w.name);
      if (typeMap){
        const combos = combosForTypes(typeMap);
        for (const combo of combos){
          const stats = applyAttachments(basePost, combo);
          const stats_pre = basePre ? applyAttachments(basePre, combo) : null;
          configs.push({ weapon: w.name, tier: t, attachments: stats.attachments, stats, stats_pre });
        }
      } else {
        configs.push({ weapon: w.name, tier: t, attachments: "none", stats: basePost, stats_pre: basePre });
      }
    }
  }
  return { configs, attachMap, patchMap };
}

// Build a lookup that can resolve target ids OR labels/names (space-insensitive).
function buildTargetLookup(targetsMap){
  const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, "");
  const lookup = new Map();
  for (const id of Object.keys(targetsMap || {})){
    const t = targetsMap[id];
    lookup.set(norm(id), id);
    if (t?.label) lookup.set(norm(t.label), id);
    if (t?.name) lookup.set(norm(t.name), id);
  }
  return { lookup, norm };
}

// Resolves either a single target id/label, or a composite like "Medium+Light+Light" into:
// - a single target object, or
// - an array of target objects (multi-target / sequential)
function resolveTargetSpec(targetsMap, targetName, targetLookup){
  const s = String(targetName || "");
  const { lookup, norm } = targetLookup || buildTargetLookup(targetsMap);
  const resolveOne = (token) => {
    const key = lookup.get(norm(token)) || token;
    const t = (targetsMap || {})[key];
    if (!t) throw new Error(`Unknown target: ${token}`);
    return t;
  };

  if (s.includes("+")){
    const parts = s.split("+").map(x=>x.trim()).filter(Boolean);
    return parts.map(resolveOne);
  }
  return resolveOne(s.trim());
}

function targetTotals(tgt){
  if (Array.isArray(tgt)){
    const hp = tgt.reduce((s,t)=>s + (+t.hp || 0), 0);
    const shield = tgt.reduce((s,t)=>s + (+t.shield || 0), 0);
    const dr = tgt[0]?.dr ?? 0;
    return { hp, shield, dr };
  }
  return { hp: +tgt.hp || 0, shield: +tgt.shield || 0, dr: +tgt.dr || 0 };
}

// Shared Monte-Carlo per-row stats (same output shape for Node-generated presets and browser custom sims)
function simulateRowStats(stats, tgt, pBody, pHead, pLimbs, pMiss, trials, rng, cl){
  const n = Math.max(1, trials|0);

  const ttks = new Array(n);
  const shotsArr = new Array(n);
  const reloadsArr = new Array(n);
  const reloadTimeArr = new Array(n);
  const fireTimeArr = new Array(n);

  let shotsSum = 0;
  let reloadsSum = 0;

  for (let k = 0; k < n; k++){
    const shotsInfo = shotsToKillTrial(stats, tgt, pBody, pHead, pLimbs, pMiss, rng);
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
  const [ttk_p50_ci_low, ttk_p50_ci_high] = quantileCIForQ(ttks, 0.50, cl);
  const [ttk_p95_ci_low, ttk_p95_ci_high] = quantileCIForQ(ttks, 0.95, cl);

  const sShots_mean = shotsSum / n;
  const sShots_std = stddev(shotsArr, sShots_mean);
  const sShots_half = ciHalfFallback(sShots_std, n, cl);

  const sRel_mean = reloadsSum / n;
  const sRel_std = stddev(reloadsArr, sRel_mean);
  const sRel_half = ciHalfFallback(sRel_std, n, cl);

  const sRTime_mean = mean(reloadTimeArr);
  const sRTime_std = stddev(reloadTimeArr, sRTime_mean);
  const sRTime_half = ciHalfFallback(sRTime_std, n, cl);

  const sFire_mean = mean(fireTimeArr);
  const sFire_std = stddev(fireTimeArr, sFire_mean);
  const sFire_half = ciHalfFallback(sFire_std, n, cl);

  const shots_p50 = percentile(shotsArr, 0.50);
  const [shots_p50_ci_low, shots_p50_ci_high] = quantileCIForQ(shotsArr, 0.50, cl);

  const reloads_p50 = percentile(reloadsArr, 0.50);
  const [reloads_p50_ci_low, reloads_p50_ci_high] = quantileCIForQ(reloadsArr, 0.50, cl);

  const reload_time_p50 = percentile(reloadTimeArr, 0.50);
  const [reload_time_p50_ci_low, reload_time_p50_ci_high] = quantileCIForQ(reloadTimeArr, 0.50, cl);

  const fire_time_p50 = percentile(fireTimeArr, 0.50);
  const [fire_time_p50_ci_low, fire_time_p50_ci_high] = quantileCIForQ(fireTimeArr, 0.50, cl);

  return {
    ttk_mean, ttk_mean_ci_low, ttk_mean_ci_high,
    ttk_p50, ttk_p50_ci_low, ttk_p50_ci_high,
    ttk_p95, ttk_p95_ci_low, ttk_p95_ci_high,
    ttk_std: ttk_sd,
    ttk_std_pct: (ttk_mean > 0 ? (ttk_sd / ttk_mean) : null),

    shots_mean: sShots_mean,
    shots_std: sShots_std,
    shots_std_pct: (sShots_mean > 0 ? (sShots_std / sShots_mean) : null),
    shots_ci_half: sShots_half,
      shots_mean_ci_low: sShots_mean - sShots_half,
      shots_mean_ci_high: sShots_mean + sShots_half,
    reloads_mean: sRel_mean,
    reloads_std: sRel_std,
    reloads_std_pct: (sRel_mean > 0 ? (sRel_std / sRel_mean) : null),
    reloads_ci_half: sRel_half,
      reloads_mean_ci_low: sRel_mean - sRel_half,
      reloads_mean_ci_high: sRel_mean + sRel_half,
    reload_time_mean: sRTime_mean,
    reload_time_std: sRTime_std,
    reload_time_std_pct: (sRTime_mean > 0 ? (sRTime_std / sRTime_mean) : null),
    reload_time_ci_half: sRTime_half,
      reload_time_mean_ci_low: sRTime_mean - sRTime_half,
      reload_time_mean_ci_high: sRTime_mean + sRTime_half,
    fire_time_mean: sFire_mean,
    fire_time_std: sFire_std,
    fire_time_std_pct: (sFire_mean > 0 ? (sFire_std / sFire_mean) : null),
    fire_time_ci_half: sFire_half,
      fire_time_mean_ci_low: sFire_mean - sFire_half,
      fire_time_mean_ci_high: sFire_mean + sFire_half,

    shots_p50, shots_p50_ci_low, shots_p50_ci_high,
    reloads_p50, reloads_p50_ci_low, reloads_p50_ci_high,
    reload_time_p50, reload_time_p50_ci_low, reload_time_p50_ci_high,
    fire_time_p50, fire_time_p50_ci_low, fire_time_p50_ci_high,
  };
}


  // Public API
  return {
    clamp01,
    normalizeZoneWeights,
    isFullyDeterministicAccuracy,
    computeEffectiveTrials,
    hash32,
    makeZoneSequence,
    combosCountForTypes,
    maxTier,
    buildTargetListFromParams,
    buildTargetScenarios,
    mulberry32,
    buildWeaponBase,
    applyTierMods,
    groupAttachmentsByWeapon,
    getTypeMapForWeapon,
    combosForTypes,
    applyAttachments,
    unapplyAttachments,
    applyMods,
    unapplyMods,
    applyBulletToState,
    shotsToKillTrial,
    shotsToKillWithSeq,
    ttkAndReloadsFromShots,
    mean,
    stddev,
    percentile,
    zForCL,
    quantileCI,

    // shared helpers
    groupPatchByWeapon,
    hasPatchForWeapon,
    buildConfigs,
    buildTargetLookup,
    resolveTargetSpec,
    targetTotals,
    simulateRowStats
  };
});
