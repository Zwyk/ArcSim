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

  // Monte-Carlo shot loop, with bullets-per-shot and per-bullet zone/miss rolls.
  // Supports either a single target object, or an array of targets for sequential multi-target sims.
  function shotsToKillTrial(stats, target, pBody, pHead, pLimbs, pMiss, rng){
    const targets = Array.isArray(target) ? target : [target];
    if (!targets.length) return Infinity;

    let idx = 0;
    let hp = targets[0].hp;
    let sh = targets[0].shield;
    let dr = targets[0].dr;

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
      hp = t.hp;
      sh = t.shield;
      dr = t.dr;
      return true;
    }

    // Loop until all targets are dead
    while (idx < targets.length){
      // If current target already dead (edge cases), advance
      if (ceilN(hp) < 1.0){
        if (!advanceTarget()) break;
        continue;
      }

      shots++;

      // Safety guard for extreme miss rates or invalid inputs
      if (shots > 200000) return Infinity;

      // Each bullet in the shot gets its own miss + hit-zone roll
      for (let b = 0; b < bulletsPerShot && idx < targets.length; b++){
        // If current target died between bullets (possible if we advanced), ensure we're on a live target
        while (idx < targets.length && ceilN(hp) < 1.0){
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
        const dmg = stats.damage_per_bullet * mult;

        if (sh > 0){
          sh = Math.max(0, sh - dmg);
          hp -= dmg * (1 - dr);
        } else {
          hp -= dmg;
        }

        // If we killed the current target with this bullet:
        if (ceilN(hp) < 1.0){
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
    let hp = targets[0].hp;
    let sh = targets[0].shield;
    let dr = targets[0].dr;

    const bulletsPerShot = stats.bullets_per_shot || 1;

    let shots = 0;

    // Index (0-based) of the bullet within the last shot that landed the FINAL killing blow.
    let killBullet = 0;
    let i = 0;

    function advanceTarget(){
      idx++;
      if (idx >= targets.length) return false;
      const t = targets[idx];
      hp = t.hp;
      sh = t.shield;
      dr = t.dr;
      return true;
    }

    while (idx < targets.length){
      if (ceilN(hp) < 1.0){
        if (!advanceTarget()) break;
        continue;
      }

      shots++;

      for (let b = 0; b < bulletsPerShot && idx < targets.length; b++){
        while (idx < targets.length && ceilN(hp) < 1.0){
          if (!advanceTarget()) break;
        }
        if (idx >= targets.length) break;

        const zone = hitSeq[i++] || "body";
        let mult = 1.0;
        if (zone === "head")      mult = stats.headshot_mult;
        else if (zone === "limbs") mult = stats.limbs_mult;

        const baseDmg = stats.damage_per_bullet;
        const dmg = baseDmg * mult;

        if (sh > 0){
          sh = Math.max(0, sh - baseDmg);
          hp -= dmg * (1 - dr);
        } else {
          hp -= dmg;
        }

        if (ceilN(hp) < 1.0){
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

  // Public API
  return {
    clamp01,
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
    shotsToKillTrial,
    shotsToKillWithSeq,
    ttkAndReloadsFromShots,
    mean,
    stddev,
    percentile,
    zForCL,
    quantileCI
  };
});
