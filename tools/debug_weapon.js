// Debug script: deterministic headshots-only for any weapon, log HP/Shield after each shot
// Usage: node tools/debug_weapon.js <WeaponName> [TargetId] [Tier]
// Example: node tools/debug_weapon.js Anvil Heavy 4
// TargetId: id from data/shields.json (default: Light)
// Tier: 1-4 (default: 1)

const path = require('path');
const fs = require('fs');
const SimCore = require('../sim_core.js');

function readJSON(p){
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function normalizeShields(json){
  if (Array.isArray(json)){
    const map = {};
    for (const s of json){
      const id = s?.id || s?.name;
      if (!id) continue;
      map[id] = {
        name: id,
        label: s.label || id,
        hp: +s.hp,
        shield: +s.shield,
        dr: +s.dr,
      };
    }
    return map;
  }
  return json || {};
}

function main(){
  const weaponName = process.argv[2];
  const tier = parseInt(process.argv[3] || '1', 10);
  const targetId = process.argv[4] || 'Light';

  if (!weaponName){
    console.error('Usage: node tools\\debug_weapon.js <WeaponName> [TargetId] [Tier]');
    process.exit(1);
  }

  const shieldsPath = path.join(__dirname, '..', 'data', 'shields.json');
  const weaponsPath = path.join(__dirname, '..', 'data', 'weapons.json');

  const shieldsRaw = readJSON(shieldsPath);
  const SHIELDS = normalizeShields(shieldsRaw);
  const target = SHIELDS[targetId] || SimCore.TARGETS[targetId] || SimCore.TARGETS.Light;
  const weapons = readJSON(weaponsPath);
  const weapon = weapons.find(w => w.name.toLowerCase() === weaponName.toLowerCase());
  if (!weapon){
    console.error(`Weapon "${weaponName}" not found in weapons.json`);
    process.exit(1);
  }

  const base = SimCore.buildWeaponBase(weapon);
  const stats = SimCore.applyTierMods(base, tier);

  // Deterministic headshots-only sequence
  const maxBullets = 2000; // safety upper bound
  const hitSeq = new Array(maxBullets).fill('head');

  // Sim state
  let hp = target.hp;
  let sh = target.shield;
  const dr = target.dr;
  const bulletsPerShot = stats.bullets_per_shot || 1;

  let shots = 0;
  let killBullet = 0;
  let i = 0;

  function applyBullet(mult){
    const baseDmg = stats.damage_per_bullet;
    const dmg = baseDmg * mult;
    if (sh > 0){
      sh = Math.max(0, sh - baseDmg);
      hp -= dmg * (1 - dr);
    } else {
      hp -= dmg;
    }
  }

  console.log(`Target=${targetId} (hp=${target.hp}, shield=${target.shield}, dr=${target.dr}) | Tier=${tier}`);
  console.log(`Weapon=${weapon.name} | damage_per_bullet=${stats.damage_per_bullet} | headshot_mult=${stats.headshot_mult} | limbs_mult=${stats.limbs_mult} | bullets_per_shot=${bulletsPerShot}`);

  while (hp >= 1.0 && shots < 200000){
    shots++;
    for (let b = 0; b < bulletsPerShot && hp >= 1.0; b++){
      const zone = hitSeq[i++] || 'head';
      let mult = 1.0;
      if (zone === 'head') mult = stats.headshot_mult;
      else if (zone === 'limbs') mult = stats.limbs_mult;
      else mult = 1.0;

      applyBullet(mult);

      if (hp < 1.0){
        killBullet = b;
        break;
      }
    }
    console.log(`After shot ${shots}: hp=${hp.toFixed(3)} shield=${sh.toFixed(3)}`);
  }

  const bps = stats.bullets_per_shot || 1;
  const isBurst = (stats.burst_delay_s || 0) > 0 && bps > 1;
  const bulletsToKill = isBurst ? ((shots - 1) * bps + (killBullet + 1)) : shots;

  const { ttk, reloads } = SimCore.ttkAndReloadsFromShots({ shots, kill_bullet: killBullet, bullets_to_kill: bulletsToKill }, stats);

  console.log(`\nResult: shots=${shots}, bullets_to_kill=${bulletsToKill}, kill_bullet=${killBullet}, ttk=${ttk.toFixed(4)}s, reloads=${reloads}`);
}

main();
