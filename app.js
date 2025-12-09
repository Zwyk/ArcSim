const $ = (id) => document.getElementById(id);

const PATH_PRESETS = "data/presets/";
const FILE_WEAPONS = "data/weapons.json";
const FILE_ATTACH = "data/attachments.json";

const RARITY = {
  Legendary: ["Jupiter","Equalizer","Anvil Splitter","Aphelion"],
  Epic: ["Bobcat","Tempest","Vulcano","Bettina"],
  Rare: ["Torrente","Venator","Renegade","Osprey"],
  Uncommon: ["Il Toro","Burletta","Arpeggio","Anvil"],
  Common: ["Stitcher","Kettle","Hairpin","Ferro","Rattler"],
};
function rarityOf(weapon){
  for(const [rar, arr] of Object.entries(RARITY)){
    if(arr.includes(weapon)) return rar;
  }
  return "Common";
}
function rarityClass(rar){
  if(rar==="Legendary") return "badge-legendary";
  if(rar==="Epic") return "badge-epic";
  if(rar==="Rare") return "badge-rare";
  if(rar==="Uncommon") return "badge-uncommon";
  return "badge-common";
}

// Resolve CSS color for a rarity class (cached)
const __rarityColorCache = new Map();
function rarityColor(rar){
  const cls = rarityClass(rar);
  if (__rarityColorCache.has(cls)) return __rarityColorCache.get(cls);
  const el = document.createElement("span");
  el.className = cls;
  el.style.position = "absolute";
  el.style.left = "-9999px";
  el.textContent = "■";
  document.body.appendChild(el);
  const col = getComputedStyle(el).color || "#e9eef5";
  document.body.removeChild(el);
  __rarityColorCache.set(cls, col);
  return col;
}

async function fetchJSON(url){
  const r = await fetch(url, { cache: "no-store" });
  if(!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return await r.json();
}

function setSelectOptions(selectEl, values, preferredValue) {
  const cur = preferredValue ?? selectEl.value;
  // Pretty label mapping for target select
  const labelMap = new Map([
    ["NoShield", "No Shield"],
    ["Light", "Light"],
    ["Medium", "Medium"],
    ["Heavy", "Heavy"],
  ]);
  const isTargetSelect = (selectEl && selectEl.id === "targetSelect");
  selectEl.innerHTML = values.map(v => {
    const label = isTargetSelect ? (labelMap.get(v) || v) : v;
    return `<option value="${v}">${label}</option>`;
  }).join("");
  if (values.includes(cur)) selectEl.value = cur;
  else if (values.length) selectEl.value = values[0];
}

function ensureTargetTierOptions(rows){
  const DEFAULT_TARGETS = ["NoShield","Light","Medium","Heavy"];
  const DEFAULT_TIERS = [1,2,3,4];
  const rawTargets = (rows && rows.length) ? Array.from(new Set(rows.map(r=> r.target))) : DEFAULT_TARGETS;
  const orderIdx = new Map(DEFAULT_TARGETS.map((t,i)=>[t,i]));
  const targets = rawTargets.slice().sort((a,b)=> (orderIdx.get(a) ?? 999) - (orderIdx.get(b) ?? 999));
  const tiers = (rows && rows.length) ? Array.from(new Set(rows.map(r=> +r.tier))).sort((a,b)=>a-b) : DEFAULT_TIERS;
  // Default preferred target: saved target if present, else "Light" (if available)
  let preferred = savedTarget ?? $("targetSelect").value ?? "Light";
  if (!targets.includes(preferred)) preferred = targets.includes("Light") ? "Light" : (targets[0] || null);
  setSelectOptions($("targetSelect"), targets, preferred);
  ensureTierCheckboxes(tiers);
}

function getSelectedTiers(){
  const boxes = document.querySelectorAll("#tierChecks input[type=checkbox]");
  const selected = [];
  boxes.forEach(b => { if (b.checked) selected.push(+b.value); });
  return selected;
}

function setSelectedTiers(selected){
  const set = new Set((selected || []).map(Number));
  document.querySelectorAll("#tierChecks input[type=checkbox]").forEach(b => {
    b.checked = set.has(+b.value);
  });
}

function defaultTierSelectionFrom(tiers){
  // Default: all tiers checked
  return tiers.slice();
}

function ensureTierCheckboxes(tiers){
  const wrap = $("tierChecks");

  const existing = new Set(
    [...wrap.querySelectorAll("input[type=checkbox]")].map(b => +b.value)
  );

  for(const t of tiers){
    if(existing.has(t)) continue;
    const label = document.createElement("label");
    label.className = "tierPill";
    label.innerHTML = `<input type="checkbox" value="${t}"> Tier ${t}`;
    const cb = label.querySelector("input");
    cb.addEventListener("change", () => { scheduleSave(); render(); });
    wrap.appendChild(label);
  }

  if (Array.isArray(savedTierSelection) && savedTierSelection.length){
    setSelectedTiers(savedTierSelection);
  } else {
    setSelectedTiers(defaultTierSelectionFrom(tiers));
  }
}

function syncTargetTierFromRows(rows){
  const DEFAULT_TARGETS = ["NoShield","Light","Medium","Heavy"];
  const orderIdx = new Map(DEFAULT_TARGETS.map((t,i)=>[t,i]));
  const targets = [...new Set(rows.map(r => r.target))].sort((a,b)=> (orderIdx.get(a) ?? 999) - (orderIdx.get(b) ?? 999));
  const tiers = [...new Set(rows.map(r => +r.tier))].sort((a,b)=>a-b);
  // Choose preferred: override > saved > current > "Light" fallback
  const currentVal = $("targetSelect").value;
  let preferred = preferredTargetOverride ?? savedTarget ?? currentVal ?? "Light";
  if (!targets.includes(preferred)) preferred = targets.includes("Light") ? "Light" : (targets[0] || null);
  setSelectOptions($("targetSelect"), targets, preferred);
  preferredTargetOverride = null;
  savedTarget = $("targetSelect").value;
  
    ensureTierCheckboxes(tiers);
}

async function loadPresetById(presetId){
  const p = window._presetById?.get(presetId);
  if(!p) return;
  try{
    if(p.kind === "custom"){
      currentRows = window.lastCustomRows || [];
      const presetName = p.name;
      const meta = presetMetaFromRows(currentRows);
      $("heading").textContent = meta ? `Best TTK — ${presetName} · ${meta}` : `Best TTK — ${presetName}`;
      document.title = meta ? `ARC Raiders — ${presetName} · ${meta}` : `ARC Raiders — ${presetName}`;
      ensureTargetTierOptions(currentRows);
      setStatus("");
      render();
      if(!isRestoring) saveUIState(collectUIState());
      return;
    }

    // precomputed
    currentRows = await fetchJSON(PATH_PRESETS + p.file);
    const presetName = p.name;
    const meta = presetMetaFromRows(currentRows);
    $("heading").textContent = meta ? `Best TTK — ${presetName} · ${meta}` : `Best TTK — ${presetName}`;
    document.title = meta ? `ARC Raiders — ${presetName} · ${meta}` : `ARC Raiders — ${presetName}`;
    syncTargetTierFromRows(currentRows);
    setStatus("");
    render();
    if(!isRestoring) saveUIState(collectUIState());
  }catch(e){
    setStatus(`❌ Failed to load ${p.file}: ${e?.message || e}`);
  }
}

function setStatus(msg){ $("status").textContent = msg || ""; }

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
// Build a readable title for custom sim
function customTitleParts(p){
  const body = Math.round((p.body ?? 0) * 100);
  const head = Math.round((p.head ?? 0) * 100);
  const limbs = Math.round((p.limbs ?? 0) * 100);
  const miss = Math.round((p.miss ?? 0) * 100);

  const name = `Custom ${body}/${head}/${limbs}/${miss} (simulated)`;
  // Replace tier list in header meta with miss %
  const missLabel = `miss ${miss}%`;
  const trials = p.trials ? `${p.trials} trials` : null;
  const cl = (p.confidence != null) ? `${Math.round(p.confidence * 100)}% CI` : null;

  const usingOverride = !!getWeaponsOverride();
  const overrideNote = usingOverride ? "weapons override" : null;
  const meta = [missLabel, trials, cl, overrideNote].filter(Boolean).join(" · ");
  return { name, meta };
}

function setCustomTitle(p){
  const { name, meta } = customTitleParts(p || {});
  $("heading").textContent = meta ? `Best TTK — ${name} · ${meta}` : `Best TTK — ${name}`;
  document.title = meta ? `ARC Raiders — ${name} · ${meta}` : `ARC Raiders — ${name}`;
}
function presetMetaFromRows(rows){
  const r = rows?.[0];
  if (!r) return "";

  const parts = [];

  if (Number.isFinite(r.miss) && r.miss > 0){
    parts.push(`miss ${Math.round(r.miss * 100)}%`);
  }
  if (Number.isFinite(r.n_trials)) parts.push(`${r.n_trials} trials`);
  if (Number.isFinite(r.ci_level)) parts.push(`${Math.round(r.ci_level * 100)}% CI`);

  return parts.join(" · ");
}

function pctLabel(){
  const head = +$("headPct").value;
  const limbs = +$("limbsPct").value;
  const body = Math.max(0, 100 - head - limbs);
  $("bodyLabel").textContent = `Body: ${body}%, Head: ${head}%, Limbs: ${limbs}%`;
  const miss = +$("missPct").value;
  $("missLabel").textContent = `Miss: ${miss}%`;
}
$("headPct").addEventListener("input", pctLabel);
$("limbsPct").addEventListener("input", pctLabel);
$("missPct").addEventListener("input", pctLabel);
pctLabel();

let presetManifest = [];
let currentRows = [];
let worker = null;
let sortKey = "ttk";
let sortDir = "asc"; // "asc" or "desc"
let lastCustomParams = null;
const UI_STATE_KEY = "arc_ui_state_v2"; // bump version so old bad state doesn't fight you
let isRestoring = true;
let savedTierSelection = null;  // array of tier numbers
let savedTarget = null;
let preferredTargetOverride = null;
// Global UI state container for compare chart controls
window.uiState = window.uiState || {};
const uiState = window.uiState;
// ---- Custom sim session cache (avoid localStorage quota) ----
const SIM_CACHE = window.__arcSimCache || (window.__arcSimCache = new Map());
let pendingSimCacheKey = null;

function simCacheGet(key){
  return SIM_CACHE.get(key) || null;
}
function simCacheSet(key, rows){
  if (SIM_CACHE.has(key)) SIM_CACHE.delete(key);
  SIM_CACHE.set(key, rows);
  while (SIM_CACHE.size > 3){
    const firstKey = SIM_CACHE.keys().next().value;
    SIM_CACHE.delete(firstKey);
  }
}

// Custom weapons override (session only)
const WEAPONS_OVERRIDE_KEY = "arc_sim_weapons_override_v1";
function getWeaponsOverride(){
  try{
    const raw = sessionStorage.getItem(WEAPONS_OVERRIDE_KEY);
    if(!raw) return null;
    return JSON.parse(raw);
  }catch{
    return null;
  }
}
function setWeaponsOverride(obj){
  sessionStorage.setItem(WEAPONS_OVERRIDE_KEY, JSON.stringify(obj));
}
function clearWeaponsOverride(){
  sessionStorage.removeItem(WEAPONS_OVERRIDE_KEY);
}
function validateWeaponsJson(arr){
  if(!Array.isArray(arr)) return "Root must be an array of weapons";
  for (let i=0;i<arr.length;i++){
    const w = arr[i];
    if(!w || typeof w !== "object") return `Weapon[${i}] must be an object`;
    if(typeof w.name !== "string" || !w.name.trim()) return `Weapon[${i}].name missing`;
    for (const k of ["damage","fire_rate","mag_size","reload_time_s"]){
      if(!(k in w)) return `Weapon[${i}] missing '${k}'`;
      if(!Number.isFinite(Number(w[k]))) return `Weapon[${i}].${k} must be a number`;
    }
    if("reload_amount" in w && !Number.isFinite(Number(w.reload_amount))) return `Weapon[${i}].reload_amount must be a number`;
    if("headshot_mult" in w && !Number.isFinite(Number(w.headshot_mult))) return `Weapon[${i}].headshot_mult must be a number`;
    if("limbs_mult" in w && !Number.isFinite(Number(w.limbs_mult))) return `Weapon[${i}].limbs_mult must be a number`;
    if(w.tier_mods && typeof w.tier_mods !== "object") return `Weapon[${i}].tier_mods must be an object`;
  }
  return null;
}

// Default weapons cache to avoid repeated fetches
let __defaultWeaponsPromise = null;
function getDefaultWeaponsCached(){
  if (!__defaultWeaponsPromise){
    __defaultWeaponsPromise = fetchJSON(FILE_WEAPONS).catch(e => { __defaultWeaponsPromise = null; throw e; });
  }
  return __defaultWeaponsPromise;
}

function normalizeObject(obj){
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(normalizeObject);
  const out = {};
  Object.keys(obj).sort().forEach(k => { out[k] = normalizeObject(obj[k]); });
  return out;
}
function canonicalizeWeapons(arr){
  if (!Array.isArray(arr)) return [];
  const mapped = arr.map(w => normalizeObject(w));
  mapped.sort((a,b)=> String(a?.name || "").toLowerCase().localeCompare(String(b?.name || "").toLowerCase()));
  return mapped;
}
async function overrideIsDifferentFromDefault(){
  const ov = getWeaponsOverride();
  if (!ov) return false;
  try{
    const def = await getDefaultWeaponsCached();
    const a = JSON.stringify(canonicalizeWeapons(ov));
    const b = JSON.stringify(canonicalizeWeapons(def));
    return a !== b;
  }catch{
    // On fetch failure, be conservative: show active if override exists
    return true;
  }
}
async function updateWeaponsOverrideCue(){
  const cue = $("weaponsOverrideCue");
  if (!cue) return;
  const active = await overrideIsDifferentFromDefault();
  cue.style.display = active ? "" : "none";
  cue.title = active ? "Custom weapons override differs from default" : "";
}

function loadUIState(){
  try { return JSON.parse(localStorage.getItem(UI_STATE_KEY) || "{}"); }
  catch { return {}; }
}

function saveUIState(patch = {}){
  if (isRestoring) return;
  const prev = loadUIState();
  const next = { ...prev, ...patch };
  localStorage.setItem(UI_STATE_KEY, JSON.stringify(next));
}

function collectUIState(){
  return {
    presetFile: $("presetSelect")?.value ?? null,
    target: $("targetSelect")?.value ?? null,
    tiersSelected: getSelectedTiers(),
    baseOnly: $("baseOnly")?.checked ?? false,
    stackEq: $("stackEq")?.checked ?? true,
    stackTol: $("stackTol")?.value ?? "0.000001",
    tableCenter: $("tableCenter")?.value ?? "mean",
    sortKey,
    sortDir,
  };
}

function scheduleSave(){
  if (isRestoring) return;
  clearTimeout(scheduleSave._t);
  scheduleSave._t = setTimeout(() => saveUIState(collectUIState()), 80);
}

function metricTTK(row){
  // precomputed uses ttk_s, simulated uses ttk_p50
  if(Number.isFinite(row.ttk_p50)) return row.ttk_p50;
  return row.ttk_s;
}

// ---- Table center helpers (mean vs median) ----
function tableCenterMode(){
  const v = $("tableCenter")?.value;
  return v === "median" ? "median" : "mean";
}

function tableTTK(r){
  const mode = tableCenterMode();
  if (mode === "mean"){
    if (Number.isFinite(r.ttk_mean)) return r.ttk_mean;
    if (Number.isFinite(r.ttk_s)) return r.ttk_s;
    if (Number.isFinite(r.ttk_p50)) return r.ttk_p50;
  } else {
    if (Number.isFinite(r.ttk_p50)) return r.ttk_p50;
    if (Number.isFinite(r.ttk_s)) return r.ttk_s;
    if (Number.isFinite(r.ttk_mean)) return r.ttk_mean;
  }
  return NaN;
}

function tableShots(r){
  const mode = tableCenterMode();
  if (mode === "mean"){
    if (Number.isFinite(r.shots_mean)) return r.shots_mean;
    if (Number.isFinite(r.bullets_to_kill_mean)) return r.bullets_to_kill_mean;
    if (Number.isFinite(r.bullets_to_kill)) return r.bullets_to_kill;
    if (Number.isFinite(r.shots_p50)) return r.shots_p50;
  } else {
    if (Number.isFinite(r.shots_p50)) return r.shots_p50;
    if (Number.isFinite(r.bullets_to_kill)) return r.bullets_to_kill;
    if (Number.isFinite(r.shots_mean)) return r.shots_mean;
    if (Number.isFinite(r.bullets_to_kill_mean)) return r.bullets_to_kill_mean;
  }
  return NaN;
}

function tableReloads(r){
  const mode = tableCenterMode();
  if (mode === "median"){
    const v = Number(r.reloads_p50);
    if (Number.isFinite(v)) return v;
  }
  const m = Number(r.reloads_mean);
  if (Number.isFinite(m)) return m;
  const det = Number(r.reloads);
  if (Number.isFinite(det)) return det;
  return NaN;
}

function tableReloadTimeSpent(r){
  if (tableCenterMode() === "median"){
    const v = Number(r.reload_time_p50);
    if (Number.isFinite(v)) return v;
  }
  const rel = tableReloads(r);
  const rt  = Number(r.reload_time_s);
  if (!Number.isFinite(rel) || !Number.isFinite(rt)) return NaN;
  return Math.max(0, rel * rt);
}

function tableFireTimeSpent(r){
  if (tableCenterMode() === "median"){
    const v = Number(r.fire_time_p50);
    if (Number.isFinite(v)) return v;
  }
  const ttk = tableTTK(r);
  const rld = tableReloadTimeSpent(r);
  if (!Number.isFinite(ttk) || !Number.isFinite(rld)) return NaN;
  return Math.max(0, ttk - rld);
}

function getCiHalfForTable(row, prefix){
  if (tableCenterMode() === "median"){
    const lo = Number(row[`${prefix}_p50_ci_low`]);
    const hi = Number(row[`${prefix}_p50_ci_high`]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) return (hi - lo) / 2;
  }
  return getCiHalf(row, prefix);
}
function metricShots(r){
  if (Number.isFinite(r.shots_mean)) return r.shots_mean;
  if (Number.isFinite(r.bullets_to_kill_mean)) return r.bullets_to_kill_mean;
  if (Number.isFinite(r.shots_p50)) return r.shots_p50;
  if (Number.isFinite(r.bullets_to_kill)) return r.bullets_to_kill;
  return NaN;
}

function metricReloads(r){
  if (Number.isFinite(r.reloads_mean)) return r.reloads_mean;
  if (Number.isFinite(r.reloads)) return r.reloads;
  return NaN;
}

function fmtNum(x, decimals=2){
  if (!Number.isFinite(x)) return "";
  const p = 10 ** decimals;
  return (Math.round(x * p) / p).toFixed(decimals);
}

// removed unused fmtIntOr2 and fmtShotsMain

function bestPerWeapon(rows){
  const best = new Map();
  for (const r of rows){
    const w = r.weapon;
    const t = metricTTK(r);
    if (!Number.isFinite(t)) continue;
    const cur = best.get(w);
    if (!cur || t < metricTTK(cur)) best.set(w, r);
  }
  return [...best.values()];
}

function getThemeColor(varName, fallback){
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName);
  return (v && v.trim()) ? v.trim() : fallback;
}

function fmtAttachShort(r){
  const a = r.attachments || "none";
  return a;
}

function tierRoman(n){
  const map = {1:"I",2:"II",3:"III",4:"IV",5:"V"};
  return map[n] || String(n);
}

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
function getCiHalf(row, prefix){
  const lo = Number(row[`${prefix}_ci_low`]);
  const hi = Number(row[`${prefix}_ci_high`]);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) return (hi - lo) / 2;
  const sd = Number(row[`${prefix}_std`]);
  return ciHalfFallback(sd, row.n_trials, row.ci_level);
}

function pct(x, base){
  if (!Number.isFinite(x) || !Number.isFinite(base) || base === 0) return NaN;
  return (x / base) * 100;
}
function fmtN(x, d=3){
  if (!Number.isFinite(x)) return "";
  const p = 10**d;
  return (Math.round(x*p)/p).toFixed(d);
}
function renderStatCell(main, unit, sd, ciHalf){
  const mainTxt = Number.isFinite(main) ? `${fmtN(main, 3)}${unit}` : "";
  const sdPart = Number.isFinite(sd) ? `σ ±${fmtN(sd, 3)}${unit}` : "";
  const ciPart = Number.isFinite(ciHalf)
    ? `CI ±${fmtN(ciHalf, 3)}${unit} (${fmtN(pct(ciHalf, main), 1)}%)`
    : "";
  const combo = (sdPart && ciPart)
    ? `${sdPart} - ${ciPart}`
    : (sdPart || ciPart);
  const sub = combo ? `<div class="sub">${combo}</div>` : "";
  return `<div>${mainTxt}</div>${sub}`;
}

function attachmentRank(attName){
  if(!attName || attName==="none") return 0;
  let r = 1000;

  if(attName.includes("Extended") && attName.includes("Mag I")) r = Math.min(r, 10);
  if(attName.includes("Extended") && attName.includes("Mag II")) r = Math.min(r, 20);
  if(attName.includes("Extended") && attName.includes("Mag III")) r = Math.min(r, 30);
  if(attName.includes("Kinetic Converter")) r = Math.min(r, 40);

  // fallback for unknown attachments: stable-ish
  if(r === 1000) r = 500 + attName.length;
  return r;
}

function stackEquivalent(rows, tol){
  // group by weapon/tier/target + ttk within tolerance bucket
  const groups = new Map();

  for(const r of rows){
    const ttk = metricTTK(r);
    const bucket = Math.round(ttk / tol) * tol;
    const key = `${r.weapon}|${r.tier}|${r.target}|${bucket.toFixed(9)}`;

    if(!groups.has(key)){
      groups.set(key, { rep: r, variants: [r] });
    }else{
      const g = groups.get(key);
      g.variants.push(r);

      // Choose representative by lowest actual TTK; break ties by cheaper attachments
      const cur = g.rep;
      const curT = metricTTK(cur);
      const candT = metricTTK(r);
      if (Number.isFinite(candT) && Number.isFinite(curT)){
        if (candT < curT - 1e-12){
          g.rep = r;
        } else if (Math.abs(candT - curT) <= 1e-12){
          if (attachmentRank(r.attachments) < attachmentRank(cur.attachments)){
            g.rep = r;
          }
        }
      }
    }
  }

  const out = [];
  for(const g of groups.values()){
    const rep = { ...g.rep };
    if(g.variants.length > 1){
      rep._variants = g.variants.map(v => v.attachments);
      rep.attachments = `${rep.attachments} (+${g.variants.length - 1} variants)`;
    }
    out.push(rep);
  }
  return out;
}

function getCellValue(r, key){
  switch(key){
    case "weapon": return r.weapon ?? "";
    case "tier": return +r.tier;
    case "attachments": return r.attachments ?? "";
    case "ttk": return tableTTK(r) ?? Infinity;
    case "shots": return tableShots(r) ?? Infinity;
    case "reloads": return tableReloads(r) ?? Infinity;
    case "dmg": return +r.damage_per_bullet ?? 0;
    case "bps": return +r.fire_rate_bps ?? 0;
    case "mag": return +r.mag_size ?? 0;
    case "rld": return +r.reload_time_s ?? 0;
    case "ra": return +r.reload_amount ?? 0;
    case "dps_body": return dpsBody(r) ?? -Infinity;
    case "dps_head": return dpsHead(r) ?? -Infinity;
    case "fire_time": return tableFireTimeSpent(r) ?? Infinity;
    case "reload_time": return tableReloadTimeSpent(r) ?? Infinity;
    case "ci_half": return ciHalfSeconds(r) ?? Infinity;
    default: return metricTTK(r) ?? Infinity;
  }
}

function compare(a, b, dir){
  if (typeof a === "string" || typeof b === "string"){
    const aa = String(a).toLowerCase();
    const bb = String(b).toLowerCase();
    const c = aa.localeCompare(bb);
    return dir === "asc" ? c : -c;
  }
  const aa = Number(a);
  const bb = Number(b);
  const c = (aa < bb) ? -1 : (aa > bb) ? 1 : 0;
  return dir === "asc" ? c : -c;
}

function dpsBody(r){
  const dmg = Number(r.damage_per_bullet);
  const bps = Number(r.fire_rate_bps);
  if (!Number.isFinite(dmg) || !Number.isFinite(bps)) return NaN;
  return dmg * bps;
}

function dpsHead(r){
  const dmg = Number(r.damage_per_bullet);
  const bps = Number(r.fire_rate_bps);
  const hs = Number(r.headshot_mult);
  if (!Number.isFinite(dmg) || !Number.isFinite(bps) || !Number.isFinite(hs)) return NaN;
  return dmg * hs * bps;
}

function shotsForTiming(r){
  if (Number.isFinite(r.shots_mean)) return r.shots_mean;
  if (Number.isFinite(r.shots_p50)) return r.shots_p50;
  if (Number.isFinite(r.bullets_to_kill)) return r.bullets_to_kill;
  return NaN;
}

function fireTimeApprox(r){
  const shots = shotsForTiming(r);
  const bps = Number(r.fire_rate_bps);
  if (!Number.isFinite(shots) || !Number.isFinite(bps) || bps <= 0) return NaN;
  if (shots <= 1) return 0;
  return (shots - 1) / bps;
}

function reloadTimeSpent(r){
  const rel = Number(r.reloads_mean ?? r.reloads);
  const rt  = Number(r.reload_time_s);
  if (!Number.isFinite(rel) || !Number.isFinite(rt)) return NaN;
  return Math.max(0, rel * rt);
}

function fireTimeSpent(r){
  const ttk = metricTTK(r);
  const rld = reloadTimeSpent(r);
  if (!Number.isFinite(ttk) || !Number.isFinite(rld)) return NaN;
  return Math.max(0, ttk - rld);
}

function ciHalfSeconds(r){
  const lo = Number(r.ttk_p50_ci_low);
  const hi = Number(r.ttk_p50_ci_high);
  if (Number.isFinite(lo) && Number.isFinite(hi) && hi >= lo) return (hi - lo) / 2;
  const lo2 = Number(r.ttk_mean_ci_low);
  const hi2 = Number(r.ttk_mean_ci_high);
  if (Number.isFinite(lo2) && Number.isFinite(hi2) && hi2 >= lo2) return (hi2 - lo2) / 2;
  return NaN;
}
function updateSortIndicators(){
  document.querySelectorAll("th.sortable").forEach(th => {
    const k = th.dataset.sort;
    if (!th.dataset.label) th.dataset.label = th.textContent.trim();
    const base = th.dataset.label;
    th.textContent = base;
    if (k === sortKey){
      th.innerHTML = `${base}<span class="sortArrow">${sortDir === "asc" ? "▲" : "▼"}</span>`;
    }
  });
}

function render(){
  updateSortIndicators();
  const target = $("targetSelect").value;
  const selectedTiers = getSelectedTiers();
  const baseOnly = $("baseOnly").checked;
  // Start from target-only rows
  let rows = currentRows.filter(r => r.target === target);

  // NEW: compare chart should ignore global Tier/BaseOnly filters
  const rowsCompare = rows.slice();

  // Apply global filters only for table + top chart
  if (selectedTiers && selectedTiers.length){
    const set = new Set(selectedTiers);
    rows = rows.filter(r => set.has(+r.tier));
  }
  if (baseOnly){
    rows = rows.filter(r => (r.attachments === "none" || !r.attachments));
  }

  const rowsFiltered = rows.slice();

  // Keep global metric select in sync
  const gm = document.getElementById("graphMetric");
  if (gm && gm.value !== uiState.graphMetric) gm.value = uiState.graphMetric;

  // Top chart: best per weapon by TTK, but plot selected metric
  drawBestPerWeaponChart(rowsFiltered);
  // --- Compare chart (built from rowsCompare: target-only, ignores tier/baseOnly)
  initCompareControls();

  const compareCard = document.getElementById("compareCard");
  const wSel = document.getElementById("compareWeapon");
  const mSel = document.getElementById("compareMode");
  const tCtl = document.getElementById("compareTierCtl");
  const tSel = document.getElementById("compareTier");

  if (compareCard) compareCard.style.display = "";

  // available weapons from target-only rows (rowsCompare)
  const weaponsAvail = [...new Set(rowsCompare.map(r => r.weapon))].sort((a,b)=>a.localeCompare(b));
  if (!uiState.compareWeapon || !weaponsAvail.includes(uiState.compareWeapon)){
    uiState.compareWeapon = weaponsAvail[0] || "";
  }

  fillSelectOptions(wSel, weaponsAvail.map(w => ({value:w, label:w})), uiState.compareWeapon);
  mSel.value = uiState.compareMode;

  // tiers from data (rowsCompare)
  const tiersAvailAll = [...new Set(rowsCompare.map(r => Number(r.tier)))]
    .filter(Number.isFinite)
    .sort((a,b)=>a-b);
  const tiersAvailWeapon = [...new Set(
    rowsCompare.filter(r => r.weapon === uiState.compareWeapon).map(r => Number(r.tier))
  )].filter(Number.isFinite).sort((a,b)=>a-b);

  // tier selector for attachments mode (from data)
  const tierOptions = tiersAvailWeapon.map(t => ({ value: t, label: `Tier ${t}` }));
  const defaultTier = tiersAvailWeapon.length ? Math.max(...tiersAvailWeapon) : 1;
  if (!tiersAvailWeapon.includes(uiState.compareTier)) uiState.compareTier = defaultTier;
  fillSelectOptions(tSel, tierOptions, uiState.compareTier);

  const mode = uiState.compareMode;
  tCtl.style.display = (mode === "attachments") ? "" : "none";

  const W = uiState.compareWeapon;

  let items = [];
  if (mode === "tier"){
    // For each available tier of the weapon, pick the BEST (min mean TTK) setup for that tier
    for (const t of tiersAvailWeapon){
      const cand = rowsCompare.filter(r => r.weapon === W && Number(r.tier) === t);
      if (!cand.length) continue;
      let best = cand[0];
      for (const r of cand){
        const rt = Number(r.ttk_mean ?? metricTTK(r));
        const bt = Number(best.ttk_mean ?? metricTTK(best));
        if (rt < bt) best = r;
      }
      const M = getMetricDef(uiState.graphMetric || "ttk");
      items.push({
        label: `Tier ${t}`,
        mean: M.mean(best),
        p50: M.p50(best),
        sd:   M.sd(best),
        detail: (best.attachments || "none") + " · (best setup)"
      });
    }
    items.sort((a,b)=>Number(a.label.split(" ")[1]) - Number(b.label.split(" ")[1]));
    const M = getMetricDef(uiState.graphMetric || "ttk");
    drawHBarChart("compareChart", "compareTooltip", "compareMeta", items, {
      titleRight: `${W} · by tier · showing ${M.label}`,
      unit: M.unit,
      tickDec: M.tickDec,
      valDec: M.valDec,
      left: 150,
      labelMax: 18
    });
  } else {
    // mode === "attachments": compare attachment setups within chosen tier (top 12 fastest)
    const t = uiState.compareTier;
    const cand = rowsCompare.filter(r => r.weapon === W && Number(r.tier) === t);
    cand.sort((a,b)=> (a.ttk_mean ?? metricTTK(a)) - (b.ttk_mean ?? metricTTK(b)));
    const top = cand.slice(0, 12);

    const M = getMetricDef(uiState.graphMetric || "ttk");
    items = top.map(r => ({
      label: r.attachments || "none",
      mean: M.mean(r),
      p50: M.p50(r),
      sd:   M.sd(r),
      detail: `Tier ${t}`
    }));

    drawHBarChart("compareChart", "compareTooltip", "compareMeta", items, {
      titleRight: `${W} · Tier ${t} · by attachments · showing ${M.label}`,
      unit: M.unit,
      tickDec: M.tickDec,
      valDec: M.valDec,
      left: 240,
      labelMax: 34
    });
  }
  const stackOn = $("stackEq").checked;
  const tol = Math.max(0.0000001, +$("stackTol").value || 0.000001);

  if(stackOn) rows = stackEquivalent(rows, tol);

  rows.sort((a,b)=> compare(getCellValue(a, sortKey), getCellValue(b, sortKey), sortDir));
  const shown = rows;

  $("rowsCount").textContent = `${rows.length}`;
  $("weaponsCount").textContent = `${new Set(rows.map(r=>r.weapon)).size}`;

  $("subheading").textContent = `Target: ${target} · Showing ${shown.length}`;

  const tbody = $("tbody");
  tbody.innerHTML = "";

  for(const r of shown){
    const rar = rarityOf(r.weapon);
    const wClass = rarityClass(rar);

    const ttk = tableTTK(r);
    const ttkSd = Number(r.ttk_std);
    const ttkCi = getCiHalfForTable(r, "ttk");
    const ttkExtra = renderStatCell(ttk, "s", ttkSd, ttkCi);

    const variants = r._variants && r._variants.length ? r._variants : null;
    const attCell = variants
      ? `<span class="variantLink" data-variants="${encodeURIComponent(JSON.stringify(variants))}">${escapeHtml(r.attachments)}</span>`
      : escapeHtml(r.attachments);

    const tr = document.createElement("tr");
    const shotsMain = tableShots(r);
    const fireMain  = tableFireTimeSpent(r);
    const relMain   = tableReloads(r);
    const rldMain   = tableReloadTimeSpent(r);
    // dps and CI columns removed per request

    function romanTier(n){
      const map = {1:"I",2:"II",3:"III",4:"IV"};
      return map[n] || String(n);
    }
    const weaponText = `${String(r.weapon || "")} ${romanTier(+r.tier)}`;
    const wikiUrl = `https://arcraiders.wiki/wiki/${encodeURIComponent(String(r.weapon || ""))}`;

    tr.innerHTML = `
      <td class="${wClass}"><a class="weaponLink" href="${wikiUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(weaponText)}</a></td>
      <td class="num">${r.tier}</td>
      <td>${attCell}</td>
      <td class="num">${ttkExtra}</td>
      <td class="num">${renderStatCell(shotsMain, "", Number(r.shots_std), getCiHalfForTable(r, "shots"))}</td>
      <td class="num">${renderStatCell(fireMain, "s", Number(r.fire_time_std), getCiHalfForTable(r, "fire_time"))}</td>
      <td class="num">${renderStatCell(relMain, "", Number(r.reloads_std), getCiHalfForTable(r, "reloads"))}</td>
      <td class="num">${renderStatCell(rldMain, "s", Number(r.reload_time_std), getCiHalfForTable(r, "reload_time"))}</td>
      
    `;
    tbody.appendChild(tr);
  }

  // modal for variants
  tbody.querySelectorAll(".variantLink").forEach(el => {
    el.addEventListener("click", () => {
      const v = JSON.parse(decodeURIComponent(el.dataset.variants));
      openModal(v.join("\n"));
    });
  });

  $("downloadBtn").disabled = !(currentRows && currentRows.length);
}

// removed unused fmt()
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function openModal(text){
  $("modalBody").textContent = text;
  $("modal").classList.remove("hidden");
}
$("modalClose").addEventListener("click", ()=> $("modal").classList.add("hidden"));
$("modal").addEventListener("click", (e)=>{ if(e.target.id==="modal") $("modal").classList.add("hidden"); });

function downloadCurrent(){
  const blob = new Blob([JSON.stringify(currentRows, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "preset_custom.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(()=> URL.revokeObjectURL(a.href), 2000);
}
$("downloadBtn").addEventListener("click", downloadCurrent);

async function init(){
  // Load preset manifest and populate preset selector
  presetManifest = await fetchJSON(PATH_PRESETS + "presets.json");
  const presetSelect = $("presetSelect");
  presetSelect.innerHTML = "";
  const presetById = new Map(presetManifest.map(p => [p.id, p]));
  window._presetById = presetById;
  for (const p of presetManifest){
    const opt = document.createElement("option");
    opt.value = p.id; // use id, not file
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }

  // Add custom option only if custom data exists
  ensureCustomPresetOption();

    // title helper moved to global scope: setCustomTitle

  // Filters
  $("targetSelect").addEventListener("change", () => {
    savedTarget = $("targetSelect").value;
    scheduleSave();
    render();
  });
  $("baseOnly").addEventListener("change", render);
  $("stackEq").addEventListener("change", render);
  $("stackTol").addEventListener("input", render);
  $("confidence").addEventListener("change", ()=>{
    render();
    if(currentMode === "custom"){
      runCustomSim();
    }
  });

  // Sorting
  document.querySelectorAll("th.sortable").forEach(th => {
    th.addEventListener("click", ()=>{
      const key = th.dataset.sort;
      if (!key) return;
      if (sortKey === key){
        sortDir = (sortDir === "asc") ? "desc" : "asc";
      } else {
        sortKey = key;
        sortDir = "asc";
      }
      render();
      scheduleSave();
    });
  });

  // Global metric select wiring
  const gm = document.getElementById("graphMetric");
  if (gm){
    gm.value = uiState.graphMetric || "ttk";
    gm.addEventListener("change", () => {
      uiState.graphMetric = gm.value;
      render();
    });
  }

  // Default preset: Body only (explicit), else first precomputed
  const bodyOnly = presetManifest.find(p => p.id === "preset_body_only")?.id;
  const firstPrecomputed = presetManifest.find(p => p.kind === "precomputed")?.id;
  if (bodyOnly) presetSelect.value = bodyOnly;
  else if (firstPrecomputed) presetSelect.value = firstPrecomputed;

  // Restore UI state and then load preset
  const st = loadUIState();
  savedTierSelection = Array.isArray(st.tiersSelected) ? st.tiersSelected : null;
  savedTarget = st.target ?? null;

  if (st.stackTol != null) $("stackTol").value = st.stackTol;
  if (st.baseOnly != null) $("baseOnly").checked = !!st.baseOnly;
  else $("baseOnly").checked = true; // default: Base only on
  if (st.stackEq != null) $("stackEq").checked = !!st.stackEq;
  if (st.tableCenter && $("tableCenter")) $("tableCenter").value = st.tableCenter;
  if (st.sortKey) sortKey = st.sortKey;
  if (st.sortDir) sortDir = st.sortDir;

  if (st.presetFile) {
    const ok = [...$("presetSelect").options].some(o => o.value === st.presetFile);
    if (ok) $("presetSelect").value = st.presetFile;
  }

  await loadPresetById($("presetSelect").value);

  // Wire saving after restore
  [
    "presetSelect","targetSelect","stackEq","stackTol","baseOnly"
  ].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", scheduleSave);
    el.addEventListener("input", scheduleSave);
  });

  // Preset change handler: capture current target, kind-aware load and save
  presetSelect.addEventListener("change", async () => {
    const v = presetSelect.value;
    preferredTargetOverride = $("targetSelect")?.value ?? null;
    if (v !== "__custom__"){
      await loadPresetById(v);
    } else {
      // Switch back to last custom results if available
      if (Array.isArray(window.lastCustomRows) && window.lastCustomRows.length){
        currentRows = window.lastCustomRows.slice();
        setCustomTitle(lastCustomParams || {});
        syncTargetTierFromRows(currentRows);
        $("downloadBtn").disabled = false;
      } else {
        // No custom data: hide option and fallback to first precomputed
        removeCustomPresetOption();
        const firstPre = presetManifest.find(p => p.kind === "precomputed")?.id;
        if (firstPre){
          presetSelect.value = firstPre;
          await loadPresetById(firstPre);
        }
      }
      render();
    }
    scheduleSave();
  });

  // Save on changes
  [
    "presetSelect","targetSelect","stackEq","stackTol","baseOnly","tableCenter"
  ].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", scheduleSave);
    el.addEventListener("input", scheduleSave);
  });

  // Worker for custom simulation
  worker = new Worker("sim.worker.js");
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if(msg.type === "PROGRESS"){
      setStatus(`Simulating… ${msg.done}/${msg.total}`);
      return;
    }
    if(msg.type === "DONE"){
      currentRows = msg.rows;
      window.lastCustomRows = msg.rows;
      ensureCustomPresetOption();
      if (pendingSimCacheKey){
        simCacheSet(pendingSimCacheKey, msg.rows);
        pendingSimCacheKey = null;
      }
      setCustomTitle(lastCustomParams || {});
      $("presetSelect").value = "__custom__";
      syncTargetTierFromRows(currentRows);
      setStatus(`Done. Rows: ${currentRows.length}`);
      $("downloadBtn").disabled = false;
      $("runBtn").disabled = false;
      render();
      saveUIState(collectUIState());
      return;
    }
    if(msg.type === "ERROR"){
      setStatus(`Error: ${msg.error}`);
      $("runBtn").disabled = false;
      pendingSimCacheKey = null;
    }
  };

  // Custom simulation is always available; no gating checkbox
  $("runBtn").addEventListener("click", runCustomSim);

  // Table center toggle
  $("tableCenter")?.addEventListener("change", () => { scheduleSave(); render(); });

  // init compare chart controls once DOM is ready
  initCompareControls();

  // done restoring; now we allow saving
  isRestoring = false;
  saveUIState(collectUIState());

  // init weapons editor modal
  initWeaponsEditor();
  updateWeaponsOverrideCue();

  // Info modal wiring
  const infoBtn = $("infoBtn");
  const infoModal = $("infoModal");
  const closeInfo = $("closeInfoModal");
  function openInfo(){ if(infoModal){ infoModal.style.display = "flex"; infoModal.classList.remove("hidden"); } }
  function closeInfoModal(){ if(infoModal){ infoModal.style.display = "none"; infoModal.classList.add("hidden"); } }
  infoBtn?.addEventListener("click", openInfo);
  closeInfo?.addEventListener("click", closeInfoModal);
  infoModal?.addEventListener("click", (e) => { if(e.target === infoModal) closeInfoModal(); });
}

function cacheKey(params){
  return "arc_sim:" + JSON.stringify(params);
}

async function runCustomSim(){
  try{
    setStatus("");
    $("runBtn").disabled = true;

    const target = $("targetSelect").value;
    const tiers = getSelectedTiers();

    const head = clamp01((+$("headPct").value)/100);
    const limbs = clamp01((+$("limbsPct").value)/100);
    const body = clamp01(1 - head - limbs);
    const miss = clamp01((+$("missPct").value)/100);

    const trials = Math.max(100, +$("trials").value || 1000);
    const seed = (+$("seed").value || 1337) >>> 0;
    const confidence = parseFloat($("confidence").value || "0.95");

    const params = { target, tiers, body:+body.toFixed(4), head:+head.toFixed(4), limbs:+limbs.toFixed(4), miss:+miss.toFixed(4), trials, seed, confidence };
    lastCustomParams = { body:+body.toFixed(4), head:+head.toFixed(4), limbs:+limbs.toFixed(4), miss:+miss.toFixed(4), tiers, trials, confidence };

    const key = cacheKey(params);
    const cached = simCacheGet(key);
    if (cached){
      currentRows = cached;
      window.lastCustomRows = currentRows;
      setCustomTitle(lastCustomParams || {});
      $("presetSelect").value = "__custom__";
      setStatus("Loaded from session cache.");
      $("downloadBtn").disabled = false;
      $("runBtn").disabled = false;
      syncTargetTierFromRows(currentRows);
      render();
      return;
    }

    setStatus("Loading weapon data…");
    const [weaponsDefault, attachments] = await Promise.all([fetchJSON(FILE_WEAPONS), fetchJSON(FILE_ATTACH)]);
    const weapons = getWeaponsOverride() || weaponsDefault;

    setStatus("Simulating…");
    pendingSimCacheKey = key;
    worker.postMessage({ type:"RUN_SIM", weapons, attachments, params });

  }catch(e){
    setStatus(String(e?.message || e));
    $("runBtn").disabled = false;
  }
}

init();

function initWeaponsEditor(){
  const modal = $("weaponsModal");
  const openBtn = $("editWeaponsBtn");
  const closeBtn = $("closeWeaponsModal");
  const editor = $("weaponsEditor");
  const status = $("weaponsModalStatus");

  if(!modal || !openBtn || openBtn._bound) return;
  openBtn._bound = true;

  function showStatus(t){ if(status) status.textContent = t || ""; }
  function open(){ modal.style.display = "flex"; modal.classList.remove("hidden"); }
  function close(){ modal.style.display = "none"; modal.classList.add("hidden"); }

  openBtn.addEventListener("click", async () => {
    open();
    const ov = getWeaponsOverride();
    if(ov){
      editor.value = JSON.stringify(ov, null, 2);
      showStatus("Loaded override from session.");
    }else{
      const def = await fetchJSON(FILE_WEAPONS);
      editor.value = JSON.stringify(def, null, 2);
      showStatus("Loaded data/weapons.json.");
    }
  });

  if (closeBtn) closeBtn.addEventListener("click", close);
  if (modal) modal.addEventListener("click", (e) => { if(e.target === modal) close(); });

  $("loadWeaponsDefault")?.addEventListener("click", async () => {
    const def = await fetchJSON(FILE_WEAPONS);
    editor.value = JSON.stringify(def, null, 2);
    showStatus("Loaded data/weapons.json.");
  });

  $("resetWeaponsOverride")?.addEventListener("click", () => {
    clearWeaponsOverride();
    showStatus("Override cleared (will use default weapons.json).");
    updateWeaponsOverrideCue();
  });

  $("validateWeaponsBtn")?.addEventListener("click", () => {
    try{
      const parsed = JSON.parse(editor.value);
      const err = validateWeaponsJson(parsed);
      if(err) { showStatus("Invalid: " + err); return; }
      showStatus("Valid ✔");
    }catch(e){
      showStatus("Invalid JSON: " + e.message);
    }
  });

  $("saveWeaponsBtn")?.addEventListener("click", () => {
    try{
      const parsed = JSON.parse(editor.value);
      const err = validateWeaponsJson(parsed);
      if(err) { showStatus("Invalid: " + err); return; }
      setWeaponsOverride(parsed);
      showStatus("Saved override ✔ (applies to custom simulations).");
      updateWeaponsOverrideCue();
    }catch(e){
      showStatus("Invalid JSON: " + e.message);
    }
  });

  $("downloadWeaponsOverride")?.addEventListener("click", () => {
    try{
      const parsed = JSON.parse(editor.value);
      const blob = new Blob([JSON.stringify(parsed, null, 2)], { type:"application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "weapons.override.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(()=>URL.revokeObjectURL(a.href), 500);
      showStatus("Downloaded.");
    }catch(e){
      showStatus("Invalid JSON: " + e.message);
    }
  });

  $("importWeaponsBtn")?.addEventListener("click", () => $("importWeaponsOverride").click());
  $("importWeaponsOverride")?.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if(!file) return;
    const txt = await file.text();
    editor.value = txt;
    showStatus("Imported into editor (not saved yet).");
    e.target.value = "";
  });
}

// Helper: manage presence of Custom (simulated) option
function ensureCustomPresetOption(){
  const sel = document.getElementById("presetSelect");
  if (!sel) return;
  const hasRows = Array.isArray(window.lastCustomRows) && window.lastCustomRows.length > 0;
  const hasOpt = [...sel.options].some(o => o.value === "__custom__");
  if (hasRows && !hasOpt){
    const opt = document.createElement("option");
    opt.value = "__custom__";
    opt.textContent = "Custom (simulated)";
    sel.appendChild(opt);
  }
}
function removeCustomPresetOption(){
  const sel = document.getElementById("presetSelect");
  if (!sel) return;
  const idx = [...sel.options].findIndex(o => o.value === "__custom__");
  if (idx >= 0){ sel.remove(idx); }
}

// ---- Chart logic ----
let chartState = { items: [], hitIndex: -1 };
uiState.compareWeapon = uiState.compareWeapon || "";
uiState.compareMode = uiState.compareMode || "tier"; // 'tier' | 'attachments'
uiState.compareTier = uiState.compareTier || 4;       // used when mode='attachments'
uiState.graphMetric = uiState.graphMetric || "ttk";

// Metric definitions for charts
const METRIC_DEF = {
  ttk:        { label: "TTK",         unit: "s", tickDec: 2, valDec: 3,
                mean: r => Number.isFinite(r.ttk_mean) ? r.ttk_mean : (Number.isFinite(r.ttk_s) ? r.ttk_s : metricTTK(r)),
                sd:   r => Number(r.ttk_std),
                p50:  r => Number(r.ttk_p50) },

  shots:      { label: "Shots",       unit: "",  tickDec: 1, valDec: 2,
                mean: r => Number.isFinite(r.shots_mean) ? r.shots_mean : (Number.isFinite(r.bullets_to_kill) ? r.bullets_to_kill : NaN),
                sd:   r => Number(r.shots_std),
                p50:  r => NaN },

  fire_time:  { label: "Fire time",   unit: "s", tickDec: 2, valDec: 3,
                mean: r => Number.isFinite(r.fire_time_mean) ? r.fire_time_mean : fireTimeSpent(r),
                sd:   r => Number(r.fire_time_std),
                p50:  r => NaN },

  reloads:    { label: "Reloads",     unit: "",  tickDec: 2, valDec: 2,
                mean: r => Number.isFinite(r.reloads_mean) ? r.reloads_mean : (Number.isFinite(r.reloads) ? r.reloads : NaN),
                sd:   r => Number(r.reloads_std),
                p50:  r => NaN },

  reload_time:{ label: "Reload time", unit: "s", tickDec: 2, valDec: 3,
                mean: r => Number.isFinite(r.reload_time_mean) ? r.reload_time_mean : reloadTimeSpent(r),
                sd:   r => Number(r.reload_time_std),
                p50:  r => NaN },
};

function getMetricDef(key){
  return METRIC_DEF[key] || METRIC_DEF.ttk;
}

// Compare chart controls binding
function initCompareControls(){
  const wSel = document.getElementById("compareWeapon");
  const mSel = document.getElementById("compareMode");
  const tSel = document.getElementById("compareTier");
  if (!wSel || wSel._bound) return;
  wSel._bound = true;

  wSel.addEventListener("change", () => { uiState.compareWeapon = wSel.value; render(); });
  if (mSel) mSel.addEventListener("change", () => { uiState.compareMode = mSel.value; render(); });
  if (tSel) tSel.addEventListener("change", () => { uiState.compareTier = parseInt(tSel.value, 10); render(); });
}

function fillSelectOptions(selectEl, values, current){
  if (!selectEl) return;
  selectEl.innerHTML = "";
  for (const v of values){
    const opt = document.createElement("option");
    opt.value = String(v.value ?? v);
    opt.textContent = String(v.label ?? v);
    selectEl.appendChild(opt);
  }
  if (current != null){
    selectEl.value = String(current);
  }
}

function initChartEvents(){
  const canvas = document.getElementById("ttkChart");
  const tip = document.getElementById("chartTooltip");
  if (!canvas || canvas._hasEvents) return;
  canvas._hasEvents = true;

  canvas.addEventListener("mousemove", (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const idx = hitTestChart(canvas, x, y);
    if (idx < 0){
      tip.style.display = "none";
      chartState.hitIndex = -1;
      drawTTKChart(chartState._lastRows || []);
      return;
    }
    chartState.hitIndex = idx;
    const it = chartState.items[idx];
    tip.style.display = "block";
    tip.style.left = `${Math.min(rect.width - 10, x + 14)}px`;
    tip.style.top  = `${Math.max(10, y - 10)}px`;
    const sdTxt = Number.isFinite(it.sd) ? ` · σ ${it.sd.toFixed(3)}s` : "";
    const meanTxt = `${it.mean.toFixed(3)}s`;
    const medTxt  = Number.isFinite(it.p50) ? ` · p50 ${it.p50.toFixed(3)}s` : "";
    tip.innerHTML =
      `<div style="font-weight:600; margin-bottom:2px;">${it.weapon}</div>` +
      `<div>Mean: <b>${meanTxt}</b>${medTxt}${sdTxt} · Tier ${it.tier} · Reloads ${(Number(it.reloads_mean ?? it.reloads ?? 0)).toFixed(2)}</div>` +
      `<div style="opacity:.85;">${fmtAttachShort(it.row)}</div>`;
    drawTTKChart(chartState._lastRows || []);
  });

  canvas.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    chartState.hitIndex = -1;
    drawTTKChart(chartState._lastRows || []);
  });
}

function layoutChart(items, width, height){
  const pad = 14;
  const headerH = 26;          // space for tick labels
  const top = pad + headerH;   // increased top to include header band
  const bottom = 14;
  const left = 140;
  const right = 16;
  const innerW = Math.max(10, width - left - right);
  const barH = 18;
  const gap = 8;
  const neededH = top + bottom + items.length * (barH + gap) - gap;
  const finalH = Math.max(220, Math.min(900, neededH));
  return { pad, headerH, top, bottom, left, right, innerW, barH, gap, finalH };
}

function drawTTKChart(rows){
  const canvas = document.getElementById("ttkChart");
  const meta = document.getElementById("chartMeta");
  if (!canvas) return;
  initChartEvents();

  const bestRows = bestPerWeapon(rows).sort((a,b) => (Number(a.ttk_mean ?? metricTTK(a)) - Number(b.ttk_mean ?? metricTTK(b))));
  const items = bestRows.map(r => ({
    weapon: r.weapon,
    tier: r.tier,
    mean: Number(r.ttk_mean ?? metricTTK(r)),
    p50: Number(r.ttk_p50),
    sd: Number(r.ttk_std),
    reloads_mean: r.reloads_mean,
    row: r
  }));
  chartState.items = items;
  chartState._lastRows = rows;
  if (meta) meta.textContent = `${items.length} weapons`;

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || (canvas.parentElement ? canvas.parentElement.clientWidth : 600);
  const { top, headerH, left, right, innerW, barH, gap, finalH } = layoutChart(items, cssW, 0);
  canvas.style.height = `${finalH}px`;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(finalH * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0,0, cssW, finalH);
  if (!items.length) return;

  const maxHigh = Math.max(...items.map(it => {
    const mu = Number(it.mean);
    const sd = Number(it.sd);
    const hi = Number.isFinite(sd) ? (mu + sd) : mu;
    return hi;
  }));
  const maxScale = (Number.isFinite(maxHigh) ? maxHigh : 0) * 1.02; // add small headroom so max bar doesn't touch edge
  const barColor = getThemeColor("--accent", "#ff5a5f");
  const textColor = getThemeColor("--text", "#e9eef5");
  const subColor  = "rgba(255,255,255,0.6)";
  const gridColor = "rgba(255,255,255,0.08)";

  // grid + scale ticks inside header band
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillStyle = subColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const ticks = 4;
  const tickY = (top - headerH) + headerH / 2;   // center of header band
  for (let i=0;i<=ticks;i++){
    const p = i / ticks;
    const x = left + p * innerW;
    // vertical grid line
    ctx.strokeStyle = gridColor;
    ctx.beginPath();
    ctx.moveTo(x, top - 6);
    ctx.lineTo(x, finalH - 12);
    ctx.stroke();
    // tick label
    const v = p * maxScale; // 0..maxScale
    const xText = (i === ticks) ? (x - 0) : x; // tiny right padding to avoid edge overlap
    ctx.fillText(`${v.toFixed(2)}s`, xText, tickY);
  }

  ctx.textAlign = "left";
  ctx.fillStyle = textColor;
  for (let i=0;i<items.length;i++){
    const it = items[i];
    const y = top + i * (barH + gap);
    ctx.fillStyle = textColor;
    ctx.fillText(`${it.weapon} ${tierRoman(it.tier)}`, 10, y + barH/2);
    const pBar = (maxScale === 0) ? 0 : (it.mean / maxScale);
    const w = Math.max(2, pBar * innerW);
    ctx.fillStyle = barColor;
    ctx.globalAlpha = (i === chartState.hitIndex) ? 0.95 : 0.75;
    ctx.fillRect(left, y, w, barH);
    ctx.globalAlpha = 1;
    // error bar: ±1σ on TTK (clamped to [0, maxScale])
    if (Number.isFinite(it.sd) && it.sd > 0) {
      const lo = Math.max(0, it.mean - it.sd);
      const hi = Math.max(0, it.mean + it.sd);

      const x1 = left + (lo / maxScale) * innerW;
      const x2 = left + (hi / maxScale) * innerW;
      const cy = y + barH / 2;

      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 1;

      // horizontal line
      ctx.beginPath();
      ctx.moveTo(x1, cy);
      ctx.lineTo(x2, cy);
      ctx.stroke();

      // end caps
      ctx.beginPath();
      ctx.moveTo(x1, cy - 5);
      ctx.lineTo(x1, cy + 5);
      ctx.moveTo(x2, cy - 5);
      ctx.lineTo(x2, cy + 5);
      ctx.stroke();
    }

    // median dot
    if (Number.isFinite(it.p50)) {
      const x = left + (Math.max(0, it.p50) / maxScale) * innerW;
      const cy = y + barH / 2;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.arc(x, cy, 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    ctx.fillText(`${it.mean.toFixed(3)}s`, left + innerW, y + barH/2);
    ctx.textAlign = "left";
  }
  canvas._chartLayout = { top, left, innerW, barH, gap, finalH, cssW };
}

// New: Best-per-weapon (by TTK) but plot selected metric
function drawBestPerWeaponChart(rowsFiltered){
  const metricKey = uiState.graphMetric || "ttk";
  const M = getMetricDef(metricKey);

  const bestByWeapon = new Map();
  for (const r of rowsFiltered){
    const w = r.weapon;
    const t = Number.isFinite(r.ttk_mean) ? r.ttk_mean : metricTTK(r);
    if (!Number.isFinite(t)) continue;
    const cur = bestByWeapon.get(w);
    const curT = cur ? (Number.isFinite(cur.ttk_mean) ? cur.ttk_mean : metricTTK(cur)) : Infinity;
    if (!cur || t < curT) bestByWeapon.set(w, r);
  }

  const bestRows = [...bestByWeapon.values()]
    .sort((a,b)=> (Number.isFinite(a.ttk_mean)?a.ttk_mean:metricTTK(a)) - (Number.isFinite(b.ttk_mean)?b.ttk_mean:metricTTK(b)));

  const items = bestRows.map(r => ({
    label: `${r.weapon} ${tierRoman(r.tier)}`,
    mean: M.mean(r),
    sd:   M.sd(r),
    p50:  M.p50(r),
    labelColor: rarityColor(rarityOf(r.weapon)),
    detail: `Tier ${r.tier} · ${(r.attachments || "none")}`,
  })).filter(it => Number.isFinite(it.mean));

  drawHBarChart("ttkChart", "chartTooltip", "chartMeta", items, {
    titleRight: `${items.length} weapons · showing ${M.label}`,
    unit: M.unit,
    tickDec: M.tickDec,
    valDec: M.valDec,
    left: 160,
    labelMax: 28
  });
}

function hitTestChart(canvas, x, y){
  const L = canvas._chartLayout;
  if (!L) return -1;
  const { top, barH, gap } = L;
  const i = Math.floor((y - top) / (barH + gap));
  if (i < 0 || i >= chartState.items.length) return -1;
  const y0 = top + i * (barH + gap);
  if (y < y0 || y > y0 + barH) return -1;
  return i;
}

function shortenLabel(s, max=34){
  s = String(s ?? "");
  if (s.length <= max) return s;
  return s.slice(0, max-1) + "…";
}

function drawHBarChart(canvasId, tooltipId, metaId, items, opts = {}){
  const canvas = document.getElementById(canvasId);
  const tip = document.getElementById(tooltipId);
  const meta = document.getElementById(metaId);
  if (!canvas) return;

  const titleRight = opts.titleRight || "";
  if (meta) meta.textContent = titleRight;

  // dynamic height
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth;
  const right = 16;
  const headerH = 26;
  const top = 14 + headerH;
  const bottom = 14;
  const barH = 18;
  const gap = 8;

  const neededH = top + bottom + items.length * (barH + gap) - gap;
  const finalH = Math.max(220, Math.min(900, neededH));

  canvas.style.height = `${finalH}px`;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(finalH * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0,0, cssW, finalH);

  if (!items.length){
    if (tip) tip.style.display = "none";
    return;
  }

  const barColor = getThemeColor("--accent", "#ff5a5f");
  const textColor = getThemeColor("--text", "#e9eef5");
  const subColor  = "rgba(255,255,255,0.65)";
  const gridColor = "rgba(255,255,255,0.08)";

  const maxHigh = Math.max(...items.map(it => {
    const mu = Number(it.mean);
    const sd = Number(it.sd);
    const hi = Number.isFinite(sd) ? (mu + sd) : mu;
    return hi;
  }));
  const maxScale = (Number.isFinite(maxHigh) ? maxHigh : 0) * 1.02;

  // Compute dynamic left padding based on label widths so bars don't overlap labels
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const labelMax = opts.labelMax ?? 28;
  let maxLabelW = 0;
  for (const it of items){
    const s = shortenLabel(it.label, labelMax);
    const w = ctx.measureText(s).width;
    if (w > maxLabelW) maxLabelW = w;
  }
  const left = Math.max(opts.left ?? 140, 10 + maxLabelW + 10);
  const innerW = Math.max(10, cssW - left - right);

  // grid + ticks (0..maxScale)
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.fillStyle = subColor;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const ticks = 4;
  const tickY = 14 + headerH/2;

  for (let i=0;i<=ticks;i++){
    const p = i / ticks;
    const x = left + p * innerW;

    ctx.strokeStyle = gridColor;
    ctx.beginPath();
    ctx.moveTo(x, top - 6);
    ctx.lineTo(x, finalH - 12);
    ctx.stroke();

    const v = p * maxScale;
    const xText = (i === ticks) ? (x - 6) : x; // tiny right padding to avoid edge overlap
    ctx.fillText(`${v.toFixed(opts.tickDec ?? 2)}${opts.unit ?? "s"}`, xText, tickY);
  }

  // bars + markers
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  // store layout for hit testing
  canvas._hbarLayout = { left, top, innerW, barH, gap, finalH, items };

  for (let i=0;i<items.length;i++){
    const it = items[i];
    const y = top + i * (barH + gap);

    // label
    ctx.fillStyle = it.labelColor || textColor;
    ctx.globalAlpha = 1;
    ctx.fillText(shortenLabel(it.label, opts.labelMax ?? 28), 10, y + barH/2);

    // bar (mean)
    const pBar = (maxScale === 0) ? 0 : (it.mean / maxScale);
    const w = Math.max(2, pBar * innerW);

    ctx.fillStyle = barColor;
    ctx.globalAlpha = 0.75;
    ctx.fillRect(left, y, w, barH);
    ctx.globalAlpha = 1;

    // ±1σ whisker around mean
    if (Number.isFinite(it.sd) && it.sd > 0){
      const lo = Math.max(0, it.mean - it.sd);
      const hi = Math.max(0, it.mean + it.sd);
      const x1 = left + (lo / maxScale) * innerW;
      const x2 = left + (hi / maxScale) * innerW;
      const cy = y + barH/2;

      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x1, cy);
      ctx.lineTo(x2, cy);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(x1, cy - 5); ctx.lineTo(x1, cy + 5);
      ctx.moveTo(x2, cy - 5); ctx.lineTo(x2, cy + 5);
      ctx.stroke();
    }

    // median dot (p50)
    if (Number.isFinite(it.p50)){
      const x = left + (Math.max(0, it.p50) / maxScale) * innerW;
      const cy = y + barH/2;

      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.beginPath();
      ctx.arc(x, cy, 3.2, 0, Math.PI*2);
      ctx.fill();

      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // right value
    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    ctx.fillText(`${it.mean.toFixed(opts.valDec ?? 3)}${opts.unit ?? "s"}`, left + innerW, y + barH/2);
    ctx.textAlign = "left";
  }

  // tooltip
  if (tip){
    canvas.onmousemove = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const idx = hitTestHBar(canvas, x, y);
      if (idx < 0){ tip.style.display = "none"; return; }

      const it = items[idx];
      const unit = opts.unit ?? "s";
      const sdTxt = Number.isFinite(it.sd) ? ` · σ ${it.sd.toFixed(opts.valDec ?? 3)}${unit}` : "";
      const p50Txt = Number.isFinite(it.p50) ? ` · p50 ${it.p50.toFixed(opts.valDec ?? 3)}${unit}` : "";

      tip.style.display = "block";
      tip.style.left = `${Math.min(rect.width - 10, x + 14)}px`;
      tip.style.top  = `${Math.max(10, y - 10)}px`;
      tip.innerHTML =
        `<div style="font-weight:600; margin-bottom:2px;">${it.label}</div>` +
        `<div>Mean: <b>${it.mean.toFixed(opts.valDec ?? 3)}${unit}</b>${p50Txt}${sdTxt}</div>` +
        (it.detail ? `<div style="opacity:.85;">${it.detail}</div>` : "");
    };
    canvas.onmouseleave = () => { tip.style.display = "none"; };
  }
}

function hitTestHBar(canvas, x, y){
  const L = canvas._hbarLayout;
  if (!L) return -1;
  const { top, barH, gap, items } = L;
  const i = Math.floor((y - top) / (barH + gap));
  if (i < 0 || i >= items.length) return -1;
  const y0 = top + i * (barH + gap);
  if (y < y0 || y > y0 + barH) return -1;
  return i;
}
