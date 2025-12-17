// sim_core.js
// Shared simulation core used by both the web worker and Node presets.

// UMD wrapper: works in browser (SimCore global) and Node (module.exports)
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.SimCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {

  // ---- Targets (shields) ----
  const TARGETS = {
    NoShield: { name: "NoShield", hp: 100, shield: 0,  dr: 0.0    },
    Light:    { name: "Light",    hp: 100, shield: 40, dr: 0.25   },
    Medium:   { name: "Medium",   hp: 100, shield: 70, dr: 0.425  },
    Heavy:    { name: "Heavy",    hp: 100, shield: 100, dr: 0.525 }
  };

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
    const map = new Map(); // weapon -> (type -> list)
    for (const a of attachments){
      for (const w of (a.compatible || [])){
        if (!map.has(w)) map.set(w, new Map());
        const tmap = map.get(w);
        const type = a.type || "misc";
        if (!tmap.has(type)) tmap.set(type, []);
        tmap.get(type).push(a);
      }
    }
    return map;
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

  // Apply one combo of attachments
  function applyAttachments(stats, combo){
    const out = { ...stats };
    const names = [];

    for (const a of combo){
      if (a._none) continue;
      names.push(a.name);

      if (a.mag_add != null) out.mag_size += a.mag_add;
      if (a.fire_rate_mult != null) out.fire_rate_bps *= a.fire_rate_mult;
      // hooks for later:
      // if (a.reload_time_mult) out.reload_time_s *= a.reload_time_mult;
      // if (a.damage_mult)      out.damage_per_bullet *= a.damage_mult;
    }

    out.attachments = names.length ? names.join(" + ") : "none";
    return out;
  }

  // Core: apply ONE bullet to (hp, sh), taking DR into account.
  function applyBullet(targetState, dmg){
    let { hp, sh, dr } = targetState;
    if (sh > 0){
      sh = Math.max(0, sh - dmg);   // full damage to shield
      hp -= dmg * (1 - dr);        // mitigated damage to HP
    } else {
      hp -= dmg;                   // full to HP
    }
    targetState.hp = hp;
    targetState.shield = sh;
  }

  // Monte-Carlo shot loop, with bullets-per-shot and per-bullet zone/miss rolls.
  function shotsToKillTrial(stats, target, pBody, pHead, pLimbs, pMiss, rng){
    let hp = target.hp;
    let sh = target.shield;
    const dr = target.dr;

    const bulletsPerShot = stats.bullets_per_shot || 1;
    let shots = 0;

    // Index (0-based) of the bullet within the last shot that landed the killing blow.
    // Used for burst weapons with burst_delay_s.
    let killBullet = 0;

    while (hp >= 1.0){
      shots++;

      // Safety guard for extreme miss rates or invalid inputs
      if (shots > 200000) return Infinity;

      // Each bullet in the shot gets its own miss + hit-zone roll
      for (let b = 0; b < bulletsPerShot && hp >= 1.0; b++){
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

        // If we killed within this shot, record which bullet did it (for burst timing)
        if (hp < 1.0){
          killBullet = b;
          break;
        }

        if (shots > 200000) return Infinity;
      }
    }

    const bps2 = stats.bullets_per_shot || 1;
    const isBurst = (stats.burst_delay_s || 0) > 0 && bps2 > 1;
    const bulletsToKill = isBurst
      ? ((shots - 1) * bps2 + (killBullet + 1))
      : shots;
    return { shots, kill_bullet: killBullet, bullets_to_kill: bulletsToKill };
  }

  // Deterministic version with a fixed sequence of hit-zones for bullets
  function shotsToKillWithSeq(stats, target, hitSeq){
    let hp = target.hp;
    let sh = target.shield;
    const dr = target.dr;
    const bulletsPerShot = stats.bullets_per_shot || 1;

    let shots = 0;

    // Index (0-based) of the bullet within the last shot that landed the killing blow.
    // Used for burst weapons with burst_delay_s.
    let killBullet = 0;
    let i = 0;

    while (hp >= 1.0){
      shots++;

      // no misses in deterministic mode, only a fixed sequence of hit types
      for (let b = 0; b < bulletsPerShot && hp >= 1.0; b++){
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

        // If we killed within this shot, record which bullet did it (for burst timing)
        if (hp < 1.0){
          killBullet = b;
          break;
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
    TARGETS,
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
    quantileCI
  };
});
