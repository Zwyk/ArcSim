const $ = (id) => document.getElementById(id);

const PATH_PRESETS = "data/presets/";
const PATH_PREPATCH_PRESETS = PATH_PRESETS + "prepatch/";
let prepatchRows = null;
let prepatchMap = null;

const FILE_WEAPONS = "data/weapons.json";
const FILE_ATTACH = "data/attachments.json";
const FILE_SHIELDS = "data/shields.json";
const FILE_PATCH = "data/patch.json";

// Shields normalization and globals
let SHIELDS = null;          // map id -> {name,hp,shield,dr,label}
let SHIELD_ORDER = [];       // ordered ids

function normalizeShields(json){
  if (Array.isArray(json)){
    const map = {};
    const order = [];
    for (const s of json){
      const id = s?.id || s?.name;
      if (!id) continue;
      order.push(id);
      map[id] = {
        name: id,
        label: s.label || id,
        hp: +s.hp,
        shield: +s.shield,
        dr: +s.dr,
      };
    }
    return { map, order };
  }
  // object format fallback
  const map = {};
  const order = Object.keys(json || {});
  for (const id of order){
    const s = json[id];
    map[id] = { name:id, label: s?.label || s?.name || id, hp:+s?.hp, shield:+s?.shield, dr:+s?.dr };
  }
  return { map, order };
}

function shieldLabel(id){
  return (SHIELDS && SHIELDS[id] && SHIELDS[id].label) ? SHIELDS[id].label : id;
}


function targetLabel(id){
  const s = String(id || "");
  if (s.includes("+")){
    const parts = s.split("+").map(p => p.trim()).filter(Boolean);
    if (parts.length > 1){
      // Multi-target: show count and shield labels
      return `(${parts.length}) ${parts.map(p => shieldLabel(p)).join("+")}`;
    }
  }
  // Single target: show shield label only
  return shieldLabel(s);
}


function isMultiTargetId(id){
  return String(id || "").includes("+");
}

// For chart autoscaling we want a stable scale across single-target presets,
// but multi-target scenarios should not influence that scale unless a multi-target
// is currently selected (and vice-versa).
function getScalePoolRows(rows, selectedTargetId){
  const sel = String(selectedTargetId ?? "").trim();
  const wantMulti = isMultiTargetId(sel);
  return (rows || []).filter(r => isMultiTargetId(r && r.target) === wantMulti);
}


const RARITY = {
  Legendary: ["Jupiter","Equalizer","Anvil Splitter","Aphelion"],
  Epic: ["Bobcat","Tempest","Vulcano","Bettina"],
  Rare: ["Torrente","Venator","Renegade","Osprey"],
  Uncommon: ["Il Toro","Burletta","Arpeggio","Anvil"],
  Common: ["Stitcher","Kettle","Hairpin","Ferro","Rattler"],
};

function rarityOf(weapon){
  const w = String(weapon || "").toLowerCase();

  let best = null; // { rar, nameLen }

  for (const [rar, arr] of Object.entries(RARITY)){
    for (const name of arr){
      const n = String(name).toLowerCase();
      if (!n) continue;

      if (w === n || w.includes(n)){
        const len = n.length;
        if (!best || len > best.nameLen){
          best = { rar, nameLen: len };
        }
      }
    }
  }

  return best ? best.rar : "Common";
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

// --- Attachment rarity (for compare-by-attachments colors) ---
const ATTACHMENT_RARITY = {
  "Extended Mags I": "Common",
  "Extended Mags II": "Uncommon",
  "Extended Mags III": "Rare",
  "Kinetic Converter": "Legendary",
};

const RARITY_RANK = { Common: 1, Uncommon: 2, Rare: 3, Epic: 4, Legendary: 5 };

// Strip counts/variant suffixes and extra spaces
function cleanAttachmentName(s){
  return String(s || "")
    // remove "(+3 variants)" / "(+1 variant)"
    .replace(/\(\+\d+\s*variants?\)/gi, "")
    // remove plain "(+5)" style suffixes
    .replace(/\(\+\d+\)/gi, "")
    .trim();
}

// Decide rarity from the *pattern* in the attachment name
function attachmentRarityOfName(name){
  const n = cleanAttachmentName(name);

  // Accept both spellings: Converter / Convertor
  if (/kinetic convert(?:er|or)/i.test(n)) return "Legendary";
  if (/extended.*mag iii/i.test(n))  return "Rare";
  if (/extended.*mag ii/i.test(n))   return "Uncommon";
  if (/extended.*mag i\b/i.test(n))  return "Common";

  return "Common";
}
// Highest rarity among all attachments in the combo
function attachmentsRarity(attachmentsStr){
  const s = String(attachmentsStr || "").trim();
  if (!s || s === "none") return "Common";

  // split only on " + " between attachments, not on "(+5)"
  const parts = s
    .split(/\s+\+\s+/)
    .map(cleanAttachmentName)
    .filter(Boolean);

  let best = "Common";
  for (const p of parts){
    const r = attachmentRarityOfName(p);
    if ((RARITY_RANK[r] || 0) > (RARITY_RANK[best] || 0)) {
      best = r;
    }
  }
  return best;
}

function assetBaseURL(){
  const u = new URL(document.baseURI);

  // If baseURI ends with a filename (e.g. /index.html), use its directory
  const last = u.pathname.split("/").pop() || "";
  if (last.includes(".")) return new URL(".", u);

  // If baseURI looks like a directory without trailing slash (/REPO), add it
  if (!u.pathname.endsWith("/")) u.pathname += "/";

  return u;
}

async function fetchJSON(relPath){
  const abs = new URL(relPath, assetBaseURL()).toString();
  const r = await fetch(abs, { cache: "no-store" });
  if(!r.ok){
    const t = await r.text().catch(()=> "");
    throw new Error(`Failed to fetch ${abs}: ${r.status} ${r.statusText}${t ? ` — ${t.slice(0,80)}` : ""}`);
  }
  return await r.json();
}

async function fetchJSONMaybe(relPath){
  try{ return await fetchJSON(relPath); }
  catch{ return null; }
}

function attKeyForRow(r){
  const a = (r && (r._attKey ?? r.attachments)) ?? "none";
  const s = String(a || "none").trim();
  return s || "none";
}

function prepatchKey(r){
  return `${r.weapon}|${Number(r.tier)||0}|${r.target}|${attKeyForRow(r)}`;
}

function buildPrepatchMap(rows){
  const m = new Map();
  for (const r of (rows || [])){
    if (!r || !r.weapon) continue;
    m.set(prepatchKey(r), r);
  }
  return m;
}

function getPrepatchRow(r){
  if (!prepatchMap || !r) return null;
  return prepatchMap.get(prepatchKey(r)) || null;
}

// delta helpers (lower is always better)
function deltaTolerance(metricKey){
  const tolTier = Number.isFinite(uiState?.tierTtkTol) ? Number(uiState.tierTtkTol) : 0;
  const tolStack = Number($("stackTol")?.value || 0);
  const timeTol = Math.max(0, tolTier, tolStack);
  if (metricKey === "ttk" || metricKey === "fire_time" || metricKey === "reload_time") return timeTol;
  // counts (shots/reloads) are typically near-integers; avoid noise
  return 0.01;
}

function makeDeltaInfo(post, pre, metricKey){
  if (!Number.isFinite(post) || !Number.isFinite(pre)) return null;
  const tol = deltaTolerance(metricKey);
  const diff = post - pre; // negative = improved after patch
  if (Math.abs(diff) <= tol) return null;
  const dir = (diff < 0) ? "up" : "down";
  const pct = (pre !== 0) ? (diff / pre) * 100 : NaN;
  return { dir, diff, pct, pre, post };
}

function fmtSigned(x, d=3){
  if (!Number.isFinite(x)) return "";
  const s = fmtN(Math.abs(x), d);
  return (x > 0 ? `+${s}` : x < 0 ? `-${s}` : `0`);
}

function deltaTooltipText(d, unit){
  const u = unit || "";
  const abs = `${fmtSigned(d.diff, 3)}${u}`;
  const pctTxt = Number.isFinite(d.pct) ? ` (${fmtSigned(d.pct, 1)}%)` : "";
  return `pre-patch ${fmtN(d.pre,3)}${u} · Δ ${abs}${pctTxt}`;
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
    const label = isTargetSelect ? targetLabel(v) : v;
    return `<option value="${v}">${label}</option>`;
  }).join("");
  if (values.includes(cur)) selectEl.value = cur;
  else if (values.length) selectEl.value = values[0];
}

function ensureTargetTierOptions(rows){
  const DEFAULT_TARGETS = (SHIELD_ORDER && SHIELD_ORDER.length)
    ? SHIELD_ORDER
    : ["NoShield","Light","Medium","Heavy"];
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

  // Remember current selection to preserve across preset changes
  const currentSelected = getSelectedTiers();

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

  // On initial restore, apply saved selection or default; otherwise preserve user's current selection
  if (isRestoring){
    if (Array.isArray(savedTierSelection) && savedTierSelection.length){
      setSelectedTiers(savedTierSelection);
    } else {
      setSelectedTiers(defaultTierSelectionFrom(tiers));
    }
  } else {
    // Preserve what the user had selected; new tiers remain unchecked
    setSelectedTiers(currentSelected.filter(t => tiers.includes(t)));
  }
}

function syncTargetTierFromRows(rows){
  const DEFAULT_TARGETS = (SHIELD_ORDER && SHIELD_ORDER.length)
    ? SHIELD_ORDER
    : ["NoShield","Light","Medium","Heavy"];
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
    currentRows = p.kind === "custom" ? window.lastCustomRows : await fetchJSON(PATH_PRESETS + p.file);

    // Optional: load matching pre-patch preset (same filename, in presets/prepatch/)
    prepatchRows = null;
    prepatchMap = null;
    if (p.kind !== "custom" && p.file){
      const pre = await fetchJSONMaybe(PATH_PREPATCH_PRESETS + p.file);
      if (pre && Array.isArray(pre) && pre.length){
        prepatchRows = pre;
        prepatchMap = buildPrepatchMap(prepatchRows);
      }
    }

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

  const usingOverrides = [
    getWeaponsOverride() ? 'weapons' : null,
    getOverride(SHIELDS_OVERRIDE_KEY) ? 'shields' : null,
    getOverride(ATTACH_OVERRIDE_KEY) ? 'attachments' : null,
  ].filter(Boolean);
  const overrideNote = usingOverrides.length ? `overrides: ${usingOverrides.join('/')}` : null;
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
let lastCustomTargetPreference = null;
let lastCustomMultiTargetId = null;
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
function simCacheSet(key, value){
  if (SIM_CACHE.has(key)) SIM_CACHE.delete(key);
  SIM_CACHE.set(key, value);
  while (SIM_CACHE.size > 3){
    const firstKey = SIM_CACHE.keys().next().value;
    SIM_CACHE.delete(firstKey);
  }
}

// Session overrides for values used in custom simulation
const WEAPONS_OVERRIDE_KEY = "arc_sim_weapons_override_v1";
const SHIELDS_OVERRIDE_KEY = "arc_sim_shields_override_v1";
const ATTACH_OVERRIDE_KEY  = "arc_sim_attachments_override_v1";

// User-editable multi-target default profile (custom simulations only)
const MULTI_TARGET_PROFILE_KEY = "arc_sim_multi_target_profile_v1";
const DEFAULT_MULTI_TARGET_PROFILE = ["Medium","Light","Light"];

// Resolve user-entered shield tokens to canonical shield ids.
// Accepts ids or labels, and ignores whitespace inside the token (e.g. "No Shield" => "NoShield").
function resolveShieldIdLoose(token){
  const raw = String(token || "").trim();
  if (!raw) return "";

  // Collapse all whitespace inside the token.
  const collapsed = raw.replace(/\s+/g, "");

  // If shields aren't loaded yet, best-effort normalize by removing spaces.
  if (!SHIELDS) return collapsed;

  // Fast paths.
  if (SHIELDS[raw]) return raw;
  if (SHIELDS[collapsed]) return collapsed;

  const want = collapsed.toLowerCase();
  for (const [id, s] of Object.entries(SHIELDS || {})){
    if (String(id).replace(/\s+/g, "").toLowerCase() === want) return id;
    if (String(s?.label || "").replace(/\s+/g, "").toLowerCase() === want) return id;
  }

  // Unknown: return the collapsed token so validation can surface it.
  return collapsed;
}

function normalizeMultiTargetProfile(arr){
  const parts = (Array.isArray(arr) ? arr : [])
    .map(x => resolveShieldIdLoose(x))
    .filter(Boolean);
  // Must contain >=2 targets
  if (parts.length <= 1) return null;
  // If shields are loaded, validate ids
  if (SHIELDS){
    const ok = parts.every(p => !!SHIELDS[p]);
    if (!ok) return null;
  }
  return parts;
}

function getMultiTargetProfile(){
  try{
    const raw = localStorage.getItem(MULTI_TARGET_PROFILE_KEY);
    if (raw){
      const parsed = JSON.parse(raw);
      const norm = normalizeMultiTargetProfile(parsed);
      if (norm) return norm;
    }
  }catch{}
  // Default (and validate once shields are available)
  return normalizeMultiTargetProfile(DEFAULT_MULTI_TARGET_PROFILE) || DEFAULT_MULTI_TARGET_PROFILE.slice();
}

function setMultiTargetProfile(profileArr){
  const norm = normalizeMultiTargetProfile(profileArr);
  if (!norm) throw new Error("Invalid multi-target profile");
  localStorage.setItem(MULTI_TARGET_PROFILE_KEY, JSON.stringify(norm));
}

function multiTargetIdFromProfile(profileArr){
  const parts = normalizeMultiTargetProfile(profileArr) || DEFAULT_MULTI_TARGET_PROFILE;
  return parts.join("+");
}

function updateMultiTargetsHint(){
  const hint = $("multiTargetsHint");
  if (!hint) return;
  const id = multiTargetIdFromProfile(getMultiTargetProfile());
  hint.textContent = `Current: ${targetLabel(id)}`;
}

function getOverride(key){
  try{
    const raw = sessionStorage.getItem(key);
    if(!raw) return null;
    return JSON.parse(raw);
  }catch{
    return null;
  }
}
function setOverride(key, obj){
  sessionStorage.setItem(key, JSON.stringify(obj));
}
function clearOverride(key){
  sessionStorage.removeItem(key);
}
// Back-compat helpers
function getWeaponsOverride(){ return getOverride(WEAPONS_OVERRIDE_KEY); }
function setWeaponsOverride(obj){ setOverride(WEAPONS_OVERRIDE_KEY, obj); }
function clearWeaponsOverride(){ clearOverride(WEAPONS_OVERRIDE_KEY); }
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

// Default shields/attachments cache
let __defaultShieldsPromise = null;
function getDefaultShieldsCached(){
  if (!__defaultShieldsPromise){
    __defaultShieldsPromise = fetchJSON(FILE_SHIELDS).catch(e => { __defaultShieldsPromise = null; throw e; });
  }
  return __defaultShieldsPromise;
}

let __defaultAttachmentsPromise = null;
function getDefaultAttachmentsCached(){
  if (!__defaultAttachmentsPromise){
    __defaultAttachmentsPromise = fetchJSON(FILE_ATTACH).catch(e => { __defaultAttachmentsPromise = null; throw e; });
  }
  return __defaultAttachmentsPromise;
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
function canonicalizeShieldsRaw(raw){
  try{
    // Accept either array or object shape. Normalize to sorted array of entries.
    let map;
    if (Array.isArray(raw)){
      map = {};
      for (const s of raw){
        const id = s?.id || s?.name;
        if (!id) continue;
        map[id] = { label: s.label || id, hp: +s.hp, shield: +s.shield, dr: +s.dr };
      }
    } else {
      map = {};
      for (const [id, s] of Object.entries(raw || {})){
        map[id] = { label: s?.label || s?.name || id, hp: +s?.hp, shield: +s?.shield, dr: +s?.dr };
      }
    }
    const ids = Object.keys(map).sort();
    return ids.map(id => ({ id, ...map[id] }));
  }catch{
    return [];
  }
}
function canonicalizeAttachmentsRaw(arr){
  if (!Array.isArray(arr)) return [];
  const mapped = arr.map(a => normalizeObject(a));
  mapped.sort((a,b)=> String(a?.name || "").toLowerCase().localeCompare(String(b?.name || "").toLowerCase()));
  return mapped;
}

async function overrideShieldsDifferentFromDefault(){
  const ov = getOverride(SHIELDS_OVERRIDE_KEY);
  if (!ov) return false;
  try{
    const def = await getDefaultShieldsCached();
    const a = JSON.stringify(canonicalizeShieldsRaw(ov));
    const b = JSON.stringify(canonicalizeShieldsRaw(def));
    return a !== b;
  }catch{
    return true;
  }
}

async function overrideAttachmentsDifferentFromDefault(){
  const ov = getOverride(ATTACH_OVERRIDE_KEY);
  if (!ov) return false;
  try{
    const def = await getDefaultAttachmentsCached();
    const a = JSON.stringify(canonicalizeAttachmentsRaw(ov));
    const b = JSON.stringify(canonicalizeAttachmentsRaw(def));
    return a !== b;
  }catch{
    return true;
  }
}

async function updateOverrideCue(){
  const cue = $("weaponsOverrideCue");
  if (!cue) return;
  const [w, s, a] = await Promise.all([
    overrideIsDifferentFromDefault(),
    overrideShieldsDifferentFromDefault(),
    overrideAttachmentsDifferentFromDefault(),
  ]);
  const active = !!(w || s || a);
  cue.style.display = active ? "" : "none";
  cue.textContent = active ? "Overrides active" : "";
  const parts = [];
  if (w) parts.push("weapons");
  if (s) parts.push("shields");
  if (a) parts.push("attachments");
  cue.title = active ? ("Custom overrides differ from defaults: " + parts.join(", ")) : "";
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
	    attachmentsMode: $("attachmentsMode")?.value ?? "base",
    stackEq: $("stackEq")?.checked ?? true,
    stackTol: $("stackTol")?.value ?? "0.001",
    tableCenter: $("tableCenter")?.value ?? "mean",
    graphMetric: uiState.graphMetric || "ttk",
    graphOrderBy: uiState.graphOrderBy || "ttk",
    ttkScaleMax: uiState.ttkScaleMax,
    compareScaleMax: uiState.compareScaleMax,
    tierTtkTol: uiState.tierTtkTol,
    ttkIncludesReload: uiState.ttkIncludesReload,
    compareTierValues: uiState.compareTierValues || "best",
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
  let t = Number.isFinite(row.ttk_p50) ? row.ttk_p50 : row.ttk_s;
  if (!Number.isFinite(t)) return t;

  // When unchecked, remove reload time component
  if (uiState.ttkIncludesReload === false){
    const rel = Number.isFinite(row.reload_time_p50)
      ? Number(row.reload_time_p50)
      : reloadTimeSpent(row);
    if (Number.isFinite(rel)) t = Math.max(0, t - rel);
  }
  return t;
}

// Always-return TTK including reload (ignores toggle)
function metricTTKIncludingReload(row){
  // precomputed uses ttk_s, simulated uses ttk_p50
  const t = Number.isFinite(row.ttk_p50) ? row.ttk_p50 : row.ttk_s;
  return t;
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

  const shotsMean = Number(r.shots_mean);
  const shotsP50  = Number(r.shots_p50);

  const btkMean   = Number(r.bullets_to_kill_mean);
  const btk       = Number(r.bullets_to_kill);

  const detShots  = Number(r.shots); // deterministic fallback

  if (mode === "mean"){
    if (Number.isFinite(shotsMean)) return shotsMean;
    if (Number.isFinite(btkMean))   return btkMean;
    if (Number.isFinite(btk))       return btk;
    if (Number.isFinite(shotsP50))  return shotsP50;
    if (Number.isFinite(detShots))  return detShots;
  } else {
    if (Number.isFinite(shotsP50))  return shotsP50;
    if (Number.isFinite(btk))       return btk;
    if (Number.isFinite(shotsMean)) return shotsMean;
    if (Number.isFinite(btkMean))   return btkMean;
    if (Number.isFinite(detShots))  return detShots;
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
function renderStatCell(main, unit, sd, ciHalf, delta){
  const mainTxt = Number.isFinite(main) ? `${fmtN(main, 3)}${unit}` : "";
  const sdPart = Number.isFinite(sd) ? `σ ±${fmtN(sd, 3)}${unit}` : "";
  const ciPart = Number.isFinite(ciHalf)
    ? `CI ±${fmtN(ciHalf, 3)}${unit} (${fmtN(pct(ciHalf, main), 1)}%)`
    : "";
  const combo = (sdPart && ciPart)
    ? `${sdPart} - ${ciPart}`
    : (sdPart || ciPart);
  const sub = combo ? `<div class="sub">${combo}</div>` : "";

  const arrow = (delta && delta.dir)
    ? `<span class="deltaArrow ${delta.dir === "up" ? "deltaUp" : "deltaDown"}" data-tip="${escapeHtml(deltaTooltipText(delta, unit))}" aria-label="${escapeHtml(deltaTooltipText(delta, unit))}" tabindex="0">${delta.dir === "up" ? "▲" : "▼"}</span>`
    : `<span class="deltaArrow deltaNone" aria-hidden="true">▲</span>`;

  return `<div class="cellMain">${arrow}<span>${mainTxt}</span></div>${sub}`;
}


function attachmentRank(attName){
  if(!attName || attName==="none") return 0;
  let r = 1000;

  if(attName.includes("Extended") && attName.includes("Mag I")) r = Math.min(r, 10);
  if(attName.includes("Extended") && attName.includes("Mag II")) r = Math.min(r, 20);
  if(attName.includes("Extended") && attName.includes("Mag III")) r = Math.min(r, 30);
  if(/Kinetic Convert(?:er|or)/i.test(attName)) r = Math.min(r, 40);

  // fallback for unknown attachments: stable-ish
  if(r === 1000) r = 500 + attName.length;
  return r;
}

function isBaseAttachments(a){
  return (a === "none" || !a);
}

function hasKinetic(a){
  return /kinetic convert(?:er|or)/i.test(String(a || ""));
}

function filterRowsByAttachmentMode(rows, mode){
  const m = mode || "base";
  if (m === "base"){
    return rows.filter(r => isBaseAttachments(r.attachments));
  }
  if (m === "best_no_kinetic"){
    return rows.filter(r => !hasKinetic(r.attachments));
  }
  return rows;
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
    rep._attKey = (g.rep.attachments || "none");
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
  const attachmentsMode = $("attachmentsMode")?.value || "base";
  // Start from target-only rows
  let rows = currentRows.filter(r => r.target === target);

  // NEW: compare chart should ignore global Tier/BaseOnly filters
  const rowsCompare = rows.slice();

  // Apply global filters only for table + top chart
  if (selectedTiers && selectedTiers.length){
    const set = new Set(selectedTiers);
    rows = rows.filter(r => set.has(+r.tier));
  }
  rows = filterRowsByAttachmentMode(rows, attachmentsMode);

  // Always include Tier 1-only weapons, even if Tier 1 isn't selected
  try{
    const tiersByWeapon = new Map();
    for (const r of rowsCompare){
      const w = r.weapon;
      if (!tiersByWeapon.has(w)) tiersByWeapon.set(w, new Set());
      tiersByWeapon.get(w).add(Number(r.tier));
    }
    const tier1OnlyWeapons = new Set(
      [...tiersByWeapon.entries()]
        .filter(([_, s]) => s.size === 1 && s.has(1))
        .map(([w,_]) => w)
    );

    if (tier1OnlyWeapons.size){
      const haveTier1Selected = !selectedTiers || selectedTiers.includes(1);
      if (!haveTier1Selected){
        const haveWeaponInRows = new Set(rows.map(r => r.weapon));
        for (const w of tier1OnlyWeapons){
          if (haveWeaponInRows.has(w)) continue;
          let add = rowsCompare.filter(r => r.weapon === w && Number(r.tier) === 1);
          add = filterRowsByAttachmentMode(add, attachmentsMode);
          if (add.length) rows.push(...add);
        }
      }
    }
  }catch{}

  const rowsFiltered = rows.slice();

  // Keep global metric select in sync
  const gm = document.getElementById("graphMetric");
  if (gm && gm.value !== uiState.graphMetric) gm.value = uiState.graphMetric;
  const go = document.getElementById("graphOrderBy");
  if (go && go.value !== uiState.graphOrderBy) go.value = uiState.graphOrderBy;

  // Top chart: best per weapon by TTK, but plot selected metric
  drawBestPerWeaponChart(rowsFiltered);
  // --- Compare chart (built from rowsCompare: target-only, ignores tier/baseOnly)
  initCompareControls();

  const compareCard = document.getElementById("compareCard");
  const wSel = document.getElementById("compareWeapon");
  const mSel = document.getElementById("compareMode");
  const tCtl = document.getElementById("compareTierCtl");
  const tSel = document.getElementById("compareTier");
  const vCtl = document.getElementById("compareTierValuesCtl");
  const vSel = document.getElementById("compareTierValues");

  if (compareCard) compareCard.style.display = "";

  // available weapons from target-only rows (rowsCompare)
  const weaponsAvail = [...new Set(rowsCompare.map(r => r.weapon))].sort((a,b)=>a.localeCompare(b));
  if (!uiState.compareWeapon || !weaponsAvail.includes(uiState.compareWeapon)){
    uiState.compareWeapon = weaponsAvail[0] || "";
  }

  fillSelectOptions(wSel, weaponsAvail.map(w => ({value:w, label:w})), uiState.compareWeapon);
  mSel.value = uiState.compareMode;
  if (vSel) vSel.value = uiState.compareTierValues || "best";

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
  if (vCtl) vCtl.style.display = (mode === "tier") ? "" : "none";

  const W = uiState.compareWeapon;

  let items = [];
  if (mode === "tier"){
    // For each available tier of the weapon, pick the BEST (min mean TTK) setup for that tier
    for (const t of tiersAvailWeapon){
      let cand = rowsCompare.filter(r => r.weapon === W && Number(r.tier) === t);
	      const cv = (uiState.compareTierValues || "best");
	      if (cv === "base"){
	        cand = cand.filter(r => isBaseAttachments(r.attachments));
	      } else if (cv === "best_no_kinetic"){
	        cand = cand.filter(r => !hasKinetic(r.attachments));
	      }
      if (!cand.length) continue;
      let best = cand[0];
      for (const r of cand){
        const rt = Number(r.ttk_mean ?? metricTTK(r));
        const bt = Number(best.ttk_mean ?? metricTTK(best));
        if (rt < bt) best = r;
      }
      const M = getMetricDef(uiState.graphMetric || "ttk");
      const orderKey = uiState.graphOrderBy || "ttk";
      const O = getMetricDef(orderKey);
      const stats = extractMetricStats(best, uiState.graphMetric || "ttk");
      if (!stats) continue;
      const { mean, median, sd } = stats;
      const pr2 = getPrepatchRow(best);
      const preMean2 = pr2 ? Number(extractMetricStats(pr2, uiState.graphMetric || "ttk")?.mean) : NaN;
      const delta = makeDeltaInfo(mean, preMean2, uiState.graphMetric || "ttk");
      items.push({
        label: `Tier ${t}`,
        mean,
        delta,
        p50: median,
        sd,
	        detail: (cv === "base")
	                  ? (best.attachments || "none") + " · (base)"
	                  : (cv === "best_no_kinetic")
	                      ? (best.attachments || "none") + " · (best w/o kinetic)"
	                      : (best.attachments || "none") + " · (best setup)",
        barColor: rarityColor(rarityOf(W)),
        labelColor: rarityColor(rarityOf(W)),
        _order: Number(extractMetricStats(best, orderKey)?.mean)
      });
    }
    // Order bars by selected ordering metric (ascending)
    items.sort((a,b)=> (Number.isFinite(a._order) ? a._order : Infinity) - (Number.isFinite(b._order) ? b._order : Infinity));
    const M = getMetricDef(uiState.graphMetric || "ttk");
    const scaleRows = getScalePoolRows(currentRows, $("targetSelect")?.value ?? savedTarget).filter(r => r.weapon === W);
    const autoMaxHigh = maxWhiskerFromRows(scaleRows, M);
    drawHBarChart("compareChart", "compareTooltip", "compareMeta", items, {
      titleRight: `${W} · by tier · ${((uiState.compareTierValues||"best")==="base")?"base only":"best attachments"} · showing ${M.label}`,
      unit: M.unit,
      tickDec: M.tickDec,
      valDec: M.valDec,
      left: 150,
      labelMax: 18,
      maxScale: uiState.compareScaleMax,
      autoMaxHigh
    });
  } else {
    // mode === "attachments": compare attachment setups within chosen tier (top 12 fastest)
    const t = uiState.compareTier;
    const cand = rowsCompare.filter(r => r.weapon === W && Number(r.tier) === t);
    cand.sort((a,b)=> (a.ttk_mean ?? metricTTK(a)) - (b.ttk_mean ?? metricTTK(b)));
    const top = cand.slice(0, 12);

    const M = getMetricDef(uiState.graphMetric || "ttk");
    const orderKey = uiState.graphOrderBy || "ttk";
    const O = getMetricDef(orderKey);
    items = top.map(r => {
      const rar = attachmentsRarity(r.attachments || "none");
      const col = rarityColor(rar);
      const stats = extractMetricStats(r, uiState.graphMetric || "ttk");
      if (!stats) return null;
      const { mean, median, sd } = stats;

      const pr2 = getPrepatchRow(r);
      const preMean2 = pr2 ? Number(extractMetricStats(pr2, uiState.graphMetric || "ttk")?.mean) : NaN;
      const delta = makeDeltaInfo(mean, preMean2, uiState.graphMetric || "ttk");

      return {
        label: r.attachments || "none",
        mean,
        delta,
        p50: median,
        sd,
        detail: `Tier ${t}`,
        barColor: col,
        labelColor: col,
        _order: Number(extractMetricStats(r, orderKey)?.mean)
      };
    }).filter(Boolean);

    // Order bars by selected ordering metric (ascending)
    items.sort((a,b)=> (Number.isFinite(a._order) ? a._order : Infinity) - (Number.isFinite(b._order) ? b._order : Infinity));

    const scaleRows2 = getScalePoolRows(currentRows, $("targetSelect")?.value ?? savedTarget).filter(r => r.weapon === W);
    const autoMaxHigh2 = maxWhiskerFromRows(scaleRows2, M);
    drawHBarChart("compareChart", "compareTooltip", "compareMeta", items, {
      titleRight: `${W} · Tier ${t} · by attachments · showing ${M.label}`,
      unit: M.unit,
      tickDec: M.tickDec,
      valDec: M.valDec,
      left: 240,
      labelMax: 34,
      maxScale: uiState.compareScaleMax,
      autoMaxHigh: autoMaxHigh2
    });
  }
  const tolRaw = +($("stackTol").value || 0);
  const tol = Math.max(0, tolRaw);
  if (tol > 0) rows = stackEquivalent(rows, tol);

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

    // Pre-patch deltas (if available)
    const pr = getPrepatchRow(r);
    const dTtk = pr ? makeDeltaInfo(ttk, tableTTK(pr), "ttk") : null;

    const ttkExtra = renderStatCell(ttk, "s", ttkSd, ttkCi, dTtk);

    const variants = r._variants && r._variants.length ? r._variants : null;
    const attCell = variants
      ? `<span class="variantLink" data-variants="${encodeURIComponent(JSON.stringify(variants))}">${escapeHtml(r.attachments)}</span>`
      : escapeHtml(r.attachments);

    const tr = document.createElement("tr");
    const shotsMain = tableShots(r);
    const fireMain  = tableFireTimeSpent(r);
    const relMain   = tableReloads(r);
    const rldMain   = tableReloadTimeSpent(r);

    const dShots = pr ? makeDeltaInfo(shotsMain, tableShots(pr), "shots") : null;
    const dFire  = pr ? makeDeltaInfo(fireMain, tableFireTimeSpent(pr), "fire_time") : null;
    const dRel   = pr ? makeDeltaInfo(relMain, tableReloads(pr), "reloads") : null;
    const dRld   = pr ? makeDeltaInfo(rldMain, tableReloadTimeSpent(pr), "reload_time") : null;
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
      <td class="num">${renderStatCell(shotsMain, "", Number(r.shots_std), getCiHalfForTable(r, "shots"), dShots)}</td>
      <td class="num">${renderStatCell(fireMain, "s", Number(r.fire_time_std), getCiHalfForTable(r, "fire_time"), dFire)}</td>
      <td class="num">${renderStatCell(relMain, "", Number(r.reloads_std), getCiHalfForTable(r, "reloads"), dRel)}</td>
      <td class="num">${renderStatCell(rldMain, "s", Number(r.reload_time_std), getCiHalfForTable(r, "reload_time"), dRld)}</td>
      
    `;
    tbody.appendChild(tr);
  }

  // Tooltip for variants (mouseover like chart tooltips)
  let tip = document.getElementById("tableTooltip");
  if (!tip){
    tip = document.createElement("div");
    tip.id = "tableTooltip";
    tip.className = "chartTooltip";
    tip.style.display = "none";
    document.body.appendChild(tip);
  }
  tbody.querySelectorAll(".variantLink").forEach(el => {
    const variants = JSON.parse(decodeURIComponent(el.dataset.variants));
    function showTip(ev){
      tip.style.display = "block";
      tip.innerHTML = `<div style=\"font-weight:600; margin-bottom:2px;\">Variants</div>` +
                      variants.map(v => `<div>${escapeHtml(v || "none")}</div>`).join("");
      const x = ev.clientX + 14; // follow cursor like chart tooltips
      const y = ev.clientY - 10;
      const vw = document.documentElement.clientWidth;
      tip.style.left = `${Math.min(vw - 10, x)}px`;
      tip.style.top  = `${Math.max(10, y)}px`;
    }
    el.addEventListener("mouseenter", showTip);
    el.addEventListener("mousemove", showTip);
    el.addEventListener("mouseleave", () => { tip.style.display = "none"; });
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
// Custom tooltip for pre-patch delta arrows (table + any HTML labels)
function initDeltaArrowTooltips(){
  let tip = document.getElementById("deltaTooltip");
  if(!tip){
    tip = document.createElement("div");
    tip.id = "deltaTooltip";
    tip.className = "chartTooltip";
    tip.style.display = "none";
    document.body.appendChild(tip);
  }

  let activeEl = null;

  function clampPos(clientX, clientY){
    const pad = 12;
    // Put somewhere first so getBoundingClientRect is valid
    tip.style.left = "-9999px";
    tip.style.top = "-9999px";

    const rect = tip.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;

    let x = clientX + pad;
    let y = clientY + pad;

    if (x + rect.width + 8 > vw) x = Math.max(8, vw - rect.width - 8);
    if (y + rect.height + 8 > vh) y = Math.max(8, vh - rect.height - 8);

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  function show(el, clientX, clientY){
    const txt = el?.getAttribute?.("data-tip") || el?.getAttribute?.("title") || "";
    if(!txt) return;
    tip.textContent = txt;
    tip.style.display = "block";
    clampPos(clientX, clientY);
  }

  function hide(){
    tip.style.display = "none";
    activeEl = null;
  }

  // Pointer-based hover (works for mouse + pen)
  document.addEventListener("pointerover", (e)=>{
    const el = e.target?.closest?.(".deltaArrow");
    if(!el) return;
    activeEl = el;
    show(el, e.clientX, e.clientY);
  }, true);

  document.addEventListener("pointermove", (e)=>{
    if(!activeEl) return;
    show(activeEl, e.clientX, e.clientY);
  }, true);

  document.addEventListener("pointerout", (e)=>{
    const el = e.target?.closest?.(".deltaArrow");
    if(!el) return;
    if(activeEl === el) hide();
  }, true);

  // Touch/click: toggle tooltip
  document.addEventListener("click", (e)=>{
    const el = e.target?.closest?.(".deltaArrow");
    if(!el){
      if(activeEl) hide();
      return;
    }
    if(activeEl === el){
      hide();
      return;
    }
    activeEl = el;
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width/2, r.top);
  }, true);

  // Keyboard accessibility
  document.addEventListener("focusin", (e)=>{
    const el = e.target?.closest?.(".deltaArrow");
    if(!el) return;
    activeEl = el;
    const r = el.getBoundingClientRect();
    show(el, r.left + r.width/2, r.top);
  }, true);

  document.addEventListener("focusout", (e)=>{
    const el = e.target?.closest?.(".deltaArrow");
    if(!el) return;
    if(activeEl === el) hide();
  }, true);

  // Hide on scroll / escape
  document.addEventListener("scroll", ()=>{ if(activeEl) hide(); }, true);
  document.addEventListener("keydown", (e)=>{ if(e.key === "Escape") hide(); });
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
  // enable tooltips for patch delta arrows
  initDeltaArrowTooltips();
  // Load preset manifest and populate preset selector
  presetManifest = await fetchJSON(PATH_PRESETS + "presets.json");
  // Load shields for labels/order
  try{
    const { map, order } = normalizeShields(await fetchJSON(FILE_SHIELDS));
    SHIELDS = map;
    SHIELD_ORDER = order;
  }catch(e){
    SHIELDS = null;
    SHIELD_ORDER = ["NoShield","Light","Medium","Heavy"];
  }
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
	  $("attachmentsMode")?.addEventListener("change", render);
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

  // Global order-by select wiring
  const go = document.getElementById("graphOrderBy");
  if (go){
    go.value = uiState.graphOrderBy || "ttk";
    go.addEventListener("change", () => {
      uiState.graphOrderBy = go.value;
      render();
    });
  }

  // Chart max scale inputs
  function parseScaleInput(el){
    if (!el) return null;
    const raw = String(el.value || "").trim();
    if (!raw) return null;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) {
      el.value = ""; // back to auto
      return null;
    }
    return v;
  }
  const tIn = $("ttkScaleMax");
  if (tIn){
    tIn.addEventListener("input", () => {
      uiState.ttkScaleMax = parseScaleInput(tIn);
      scheduleSave();
      render();
    });
  }
  const cIn = $("compareScaleMax");
  if (cIn){
    cIn.addEventListener("input", () => {
      uiState.compareScaleMax = parseScaleInput(cIn);
      scheduleSave();
      render();
    });
  }

  // Tier tolerance input wiring
  const tolIn = $("tierTtkTol");
  if (tolIn){
    tolIn.addEventListener("input", () => {
      const raw = String(tolIn.value ?? "").trim();

      // Empty field => revert to default
      if (raw === ""){
        uiState.tierTtkTol = 0.001;
        scheduleSave();
        render();
        return;
      }

      const v = Number(raw);
      if (Number.isFinite(v) && v >= 0){
        uiState.tierTtkTol = v;
        scheduleSave();
        render();
      }
      // else: ignore invalid keystrokes (don’t overwrite state)
    });
  }

  // TTK includes reload toggle wiring
  const incRel = $("ttkIncludesReload");
  if (incRel){
    incRel.addEventListener("change", () => {
      uiState.ttkIncludesReload = !!incRel.checked;
      scheduleSave();
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

  if (st.graphMetric) uiState.graphMetric = st.graphMetric;
  if (st.graphOrderBy) uiState.graphOrderBy = st.graphOrderBy;
  if (st.compareTierValues) uiState.compareTierValues = st.compareTierValues;
  if ($("graphMetric")) $("graphMetric").value = uiState.graphMetric || "ttk";
  if ($("graphOrderBy")) $("graphOrderBy").value = uiState.graphOrderBy || "ttk";

	  if (st.stackTol != null) $("stackTol").value = st.stackTol;
	  // Attachments mode (migrate old baseOnly checkbox if present)
	  const attModeEl = $("attachmentsMode");
	  if (attModeEl){
	    let m = st.attachmentsMode ?? null;
	    if (!m && st.baseOnly != null) m = st.baseOnly ? "base" : "best";
	    if (!m) m = "base"; // default: Base only
	    const ok = [...attModeEl.options].some(o => o.value === m);
	    attModeEl.value = ok ? m : "base";
	  }
  // stackEq checkbox removed; merging controlled by stackTol > 0
  if (st.tableCenter && $("tableCenter")) $("tableCenter").value = st.tableCenter;
  if (st.sortKey) sortKey = st.sortKey;
  if (st.sortDir) sortDir = st.sortDir;

  if (st.ttkScaleMax !== undefined) uiState.ttkScaleMax = st.ttkScaleMax;
  if (st.compareScaleMax !== undefined) uiState.compareScaleMax = st.compareScaleMax;
  if (st.tierTtkTol !== undefined) uiState.tierTtkTol = Number(st.tierTtkTol);
  if (!Number.isFinite(uiState.tierTtkTol) || uiState.tierTtkTol < 0) uiState.tierTtkTol = 0.001;
  // default: checked
  uiState.ttkIncludesReload = (st.ttkIncludesReload !== undefined) ? !!st.ttkIncludesReload : true;
  const cb = $("ttkIncludesReload");
  if (cb) cb.checked = !!uiState.ttkIncludesReload;
  const tInRestore = $("ttkScaleMax");
  if (tInRestore) tInRestore.value = (Number.isFinite(uiState.ttkScaleMax) && uiState.ttkScaleMax > 0) ? String(uiState.ttkScaleMax) : "";
  const cInRestore = $("compareScaleMax");
  if (cInRestore) cInRestore.value = (Number.isFinite(uiState.compareScaleMax) && uiState.compareScaleMax > 0) ? String(uiState.compareScaleMax) : "";
  const tolInRestore = $("tierTtkTol");
  if (tolInRestore) tolInRestore.value = String(uiState.tierTtkTol);

  if (st.presetFile) {
    const ok = [...$("presetSelect").options].some(o => o.value === st.presetFile);
    if (ok) $("presetSelect").value = st.presetFile;
  }

  await loadPresetById($("presetSelect").value);

  // Wire saving after restore
	  [
	    "presetSelect","targetSelect","stackTol","attachmentsMode","graphMetric","graphOrderBy","ttkScaleMax","compareScaleMax","tierTtkTol","ttkIncludesReload"
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
	    "presetSelect","targetSelect","stackTol","attachmentsMode","tableCenter"
	  ].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("change", scheduleSave);
    el.addEventListener("input", scheduleSave);
  });

  // Worker for custom simulation
  worker = new Worker("sim.worker.js");

  // Sidebar toggle behavior (mobile drawer)
  const sidebarBtn = document.getElementById("sidebarToggleBtn");
  const sidebarBackdrop = document.getElementById("sidebarBackdrop");

  function setSidebarOpen(open){
    document.body.classList.toggle("sidebar-open", !!open);
    const btn = document.getElementById("sidebarToggleBtn");
    if (btn) btn.textContent = open ? "✕" : "☰";
  }

  // Show the toggle only when it has an effect (mobile widths)
  function updateSidebarToggleVisibility(){
    const btn = document.getElementById("sidebarToggleBtn");
    if (!btn) return;
    const isMobile = window.matchMedia('(max-width: 900px)').matches;
    btn.style.display = isMobile ? '' : 'none';
    btn.setAttribute('aria-hidden', isMobile ? 'false' : 'true');
    if (!isMobile){
      document.body.classList.remove('sidebar-open');
      btn.textContent = '☰';
    }
  }
  updateSidebarToggleVisibility();
  window.addEventListener('resize', updateSidebarToggleVisibility);

  sidebarBtn?.addEventListener("click", () => {
    setSidebarOpen(!document.body.classList.contains("sidebar-open"));
  });

  sidebarBackdrop?.addEventListener("click", () => setSidebarOpen(false));

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setSidebarOpen(false);
  });
  worker.onmessage = (ev) => {
    const msg = ev.data;
    if(msg.type === "PROGRESS"){
      setStatus(`Simulating… ${msg.done}/${msg.total}`);
      return;
    }
    if(msg.type === "DONE"){
      currentRows = msg.rows;
      window.lastCustomRows = msg.rows;
      prepatchRows = Array.isArray(msg.prepatchRows) ? msg.prepatchRows : null;
      prepatchMap = prepatchRows ? buildPrepatchMap(prepatchRows) : null;
      window.lastCustomPrepatchRows = prepatchRows;
      ensureCustomPresetOption();
      if (pendingSimCacheKey){
        simCacheSet(pendingSimCacheKey, { rows: msg.rows, prepatchRows: msg.prepatchRows || null });
        pendingSimCacheKey = null;
      }
      setCustomTitle(lastCustomParams || {});
      $("presetSelect").value = "__custom__";
      // Prefer the multi-target row for custom sims if the user previously had a multi-target selected
      if (lastCustomTargetPreference === "__multi__") preferredTargetOverride = lastCustomMultiTargetId;
      else if (lastCustomTargetPreference) preferredTargetOverride = lastCustomTargetPreference;
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
  updateOverrideCue();

  // init multi-target editor + hint
  initMultiTargetsEditor();
  updateMultiTargetsHint();

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

    const prevTarget = $("targetSelect").value;
    const multiTargetProfile = getMultiTargetProfile();
    const multiTargetId = multiTargetIdFromProfile(multiTargetProfile);
    lastCustomMultiTargetId = multiTargetId;
    lastCustomTargetPreference = isMultiTargetId(prevTarget) ? "__multi__" : prevTarget;
    const tiers = getSelectedTiers();

    const head = clamp01((+$("headPct").value)/100);
    const limbs = clamp01((+$("limbsPct").value)/100);
    const body = clamp01(1 - head - limbs);
    const miss = clamp01((+$("missPct").value)/100);

    const trials = Math.max(100, +$("trials").value || 1000);
    const seed = (+$("seed").value || 1337) >>> 0;
    const confidence = parseFloat($("confidence").value || "0.95");

    const params = { target: "ALL", tiers, body:+body.toFixed(4), head:+head.toFixed(4), limbs:+limbs.toFixed(4), miss:+miss.toFixed(4), trials, seed, confidence, fullSweep: true, multiTarget: multiTargetProfile };
    lastCustomParams = { body:+body.toFixed(4), head:+head.toFixed(4), limbs:+limbs.toFixed(4), miss:+miss.toFixed(4), tiers, trials, confidence };

    // Include current overrides signature in the cache key so changes bypass cache
    const weaponsOv = getWeaponsOverride() || null;
    const shieldsOv = getOverride(SHIELDS_OVERRIDE_KEY) || null;
    const attachOv  = getOverride(ATTACH_OVERRIDE_KEY) || null;
    const key = cacheKey({
      ...params,
      __ov_weapons__: weaponsOv,
      __ov_shields__: shieldsOv,
      __ov_attach__: attachOv,
    });
    const cached = simCacheGet(key);
    if (cached){
      // Back-compat: older cache stored only rows array
      const rows = Array.isArray(cached) ? cached : cached.rows;
      const pre  = (cached && !Array.isArray(cached)) ? cached.prepatchRows : null;

      currentRows = rows || [];
      window.lastCustomRows = currentRows;
      prepatchRows = Array.isArray(pre) ? pre : null;
      prepatchMap = prepatchRows ? buildPrepatchMap(prepatchRows) : null;
      window.lastCustomPrepatchRows = prepatchRows;
      setCustomTitle(lastCustomParams || {});
      $("presetSelect").value = "__custom__";
      setStatus("Loaded from session cache.");
      $("downloadBtn").disabled = false;
      $("runBtn").disabled = false;
      // Keep target selection stable across custom sims
      if (lastCustomTargetPreference === "__multi__") preferredTargetOverride = lastCustomMultiTargetId;
      else if (lastCustomTargetPreference) preferredTargetOverride = lastCustomTargetPreference;
      syncTargetTierFromRows(currentRows);
      render();
      return;
    }

    setStatus("Loading weapon data…");
    const [weaponsDefault, attachmentsDefault, shieldsRawDefault, patchDefault] = await Promise.all([
      fetchJSON(FILE_WEAPONS),
      fetchJSON(FILE_ATTACH),
      fetchJSON(FILE_SHIELDS),
      fetchJSON(FILE_PATCH),
    ]);
    const shieldsOverride = getOverride(SHIELDS_OVERRIDE_KEY);
    const attachmentsOverride = getOverride(ATTACH_OVERRIDE_KEY);
    const weapons = getWeaponsOverride() || weaponsDefault;
    const attachments = attachmentsOverride || attachmentsDefault;
    const shieldsRaw = shieldsOverride || shieldsRawDefault;
    const { map: shields } = normalizeShields(shieldsRaw);
    const patch = patchDefault;

    setStatus("Simulating…");
    // Avoid stale deltas while running custom sim
    prepatchRows = null;
    prepatchMap = null;
    window.lastCustomPrepatchRows = null;
    pendingSimCacheKey = key;
    worker.postMessage({ type:"RUN_SIM", weapons, attachments, shields, patch, params });

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
  const fileSelect = $("valuesFileSelect");

  if(!modal || !openBtn || openBtn._bound) return;
  openBtn._bound = true;

  function showStatus(t){ if(status) status.textContent = t || ""; }
  function open(){ modal.style.display = "flex"; modal.classList.remove("hidden"); }
  function close(){ modal.style.display = "none"; modal.classList.add("hidden"); }

  async function loadSelectedFile(){
    const sel = (fileSelect?.value || 'weapons');
    try{
      if (sel === 'weapons'){
        const ov = getWeaponsOverride();
        if (ov){
          editor.value = JSON.stringify(ov, null, 2);
          showStatus("Loaded weapons override from session.");
        } else {
          const def = await fetchJSON(FILE_WEAPONS);
          editor.value = JSON.stringify(def, null, 2);
          showStatus("Loaded data/weapons.json.");
        }
      } else if (sel === 'shields'){
        const ovRaw = getOverride(SHIELDS_OVERRIDE_KEY);
        if (ovRaw){
          editor.value = JSON.stringify(ovRaw, null, 2);
          showStatus("Loaded shields override from session.");
        } else {
          const def = await fetchJSON(FILE_SHIELDS);
          editor.value = JSON.stringify(def, null, 2);
          showStatus("Loaded data/shields.json.");
        }
      } else if (sel === 'attachments'){
        const ovAtt = getOverride(ATTACH_OVERRIDE_KEY);
        if (ovAtt){
          editor.value = JSON.stringify(ovAtt, null, 2);
          showStatus("Loaded attachments override from session.");
        } else {
          const def = await fetchJSON(FILE_ATTACH);
          editor.value = JSON.stringify(def, null, 2);
          showStatus("Loaded data/attachments.json.");
        }
      }
    }catch(e){
      editor.value = '';
      showStatus(String(e?.message || e));
    }
  }

  openBtn.addEventListener("click", async () => {
    open();
    await loadSelectedFile();
  });

  fileSelect?.addEventListener('change', loadSelectedFile);

  if (closeBtn) closeBtn.addEventListener("click", close);
  if (modal) modal.addEventListener("click", (e) => { if(e.target === modal) close(); });

  // Per-file handlers are set up below

  // Validate / Save / Reset / Download / Import handling per selected file
  const validateBtn = $("validateWeaponsBtn");
  const saveBtn = $("saveWeaponsBtn");
  const resetBtn = $("resetWeaponsOverride");
  const downloadBtn = $("downloadWeaponsOverride");
  const importInput = $("importWeaponsOverride");
  const importBtn = $("importWeaponsBtn");

  function currentOverrideKey(){
    const sel = (fileSelect?.value || 'weapons');
    if (sel === 'weapons') return WEAPONS_OVERRIDE_KEY;
    if (sel === 'shields') return SHIELDS_OVERRIDE_KEY;
    return ATTACH_OVERRIDE_KEY;
  }
  function currentDefaultPath(){
    const sel = (fileSelect?.value || 'weapons');
    if (sel === 'weapons') return FILE_WEAPONS;
    if (sel === 'shields') return FILE_SHIELDS;
    return FILE_ATTACH;
  }

  validateBtn?.addEventListener('click', () => {
    try{
      const parsed = JSON.parse(editor.value || '');
      // Minimal validation for weapons; others pass if JSON parses
      const sel = (fileSelect?.value || 'weapons');
      if (sel === 'weapons'){
        const err = validateWeaponsJson(parsed);
        if (err) throw new Error(err);
      }
      showStatus('Valid JSON.');
    }catch(e){
      showStatus('Invalid: ' + String(e?.message || e));
    }
  });

  saveBtn?.addEventListener('click', () => {
    try{
      const parsed = JSON.parse(editor.value || '');
      setOverride(currentOverrideKey(), parsed);
      showStatus('Saved override to session.');
      updateOverrideCue();
    }catch(e){
      showStatus('Save failed: ' + String(e?.message || e));
    }
  });

  resetBtn?.addEventListener('click', () => {
    clearOverride(currentOverrideKey());
    showStatus('Reset override.');
    updateOverrideCue();
    loadSelectedFile();
  });

  downloadBtn?.addEventListener('click', async () => {
    try{
      const blob = new Blob([editor.value || ''], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const sel = (fileSelect?.value || 'weapons');
      a.href = url;
      a.download = sel + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showStatus('Downloaded JSON.');
    }catch(e){
      showStatus('Download failed: ' + String(e?.message || e));
    }
  });

  importBtn?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try{
      const text = await file.text();
      const parsed = JSON.parse(text);
      editor.value = JSON.stringify(parsed, null, 2);
      showStatus('Loaded file into editor. Remember to Validate and Save override.');
    }catch(err){
      showStatus('Import failed: ' + String(err?.message || err));
    }
  });
}

function initMultiTargetsEditor(){
  const modal = $("multiTargetsModal");
  const openBtn = $("editMultiTargetsBtn");
  const closeBtn = $("closeMultiTargetsModal");
  const saveBtn = $("saveMultiTargetsBtn");
  const resetBtn = $("resetMultiTargetsBtn");
  const editor = $("multiTargetsEditor");
  const status = $("multiTargetsModalStatus");
  const avail = $("multiTargetsAvailable");

  if (!modal || !openBtn || openBtn._bound) return;
  openBtn._bound = true;

  function showStatus(t){ if(status) status.textContent = t || ""; }
  function open(){ modal.style.display = "flex"; modal.classList.remove("hidden"); }
  function close(){ modal.style.display = "none"; modal.classList.add("hidden"); }

  function parseProfile(text){
    const s = String(text || "").trim();
    if (!s) return [];
    // If the user used explicit separators (+, comma, newlines), don't treat spaces as separators.
    // That allows labels like "No Shield".
    const hasExplicitSep = /[+,\n\r\t]/.test(s);
    const rawParts = s.split(hasExplicitSep ? /[+,\n\r\t]+/g : /\s+/g);
    return rawParts.map(p => resolveShieldIdLoose(p)).filter(Boolean);
  }

  function validateParts(parts){
    if (!Array.isArray(parts) || parts.length <= 1) return "Please provide at least 2 shields.";
    if (SHIELDS){
      const unknown = parts.filter(p => !SHIELDS[p]);
      if (unknown.length) return `Unknown shield id(s): ${unknown.join(", ")}`;
    }
    return null;
  }

  function refreshAvail(){
    if (!avail) return;
    const ids = Array.isArray(SHIELD_ORDER) && SHIELD_ORDER.length ? SHIELD_ORDER : Object.keys(SHIELDS || {});
    avail.textContent = ids.join(", ");
  }

  function refreshPreview(){
    if (!editor) return;
    const parts = parseProfile(editor.value);
    const err = validateParts(parts);
    if (err){
      showStatus(err);
      return false;
    }
    const id = parts.join("+");
    showStatus(`Preview: ${targetLabel(id)}`);
    return true;
  }

  openBtn.addEventListener("click", () => {
    const prof = getMultiTargetProfile();
    if (editor) editor.value = prof.join("+");
    refreshAvail();
    refreshPreview();
    open();
  });

  closeBtn?.addEventListener("click", close);
  modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  editor?.addEventListener("input", refreshPreview);

  resetBtn?.addEventListener("click", () => {
    try{
      localStorage.removeItem(MULTI_TARGET_PROFILE_KEY);
      if (editor) editor.value = DEFAULT_MULTI_TARGET_PROFILE.join("+");
      refreshAvail();
      refreshPreview();
      updateMultiTargetsHint();
    }catch{}
  });

  saveBtn?.addEventListener("click", () => {
    try{
      const parts = parseProfile(editor?.value);
      const err = validateParts(parts);
      if (err){ showStatus(err); return; }
      setMultiTargetProfile(parts);
      updateMultiTargetsHint();
      showStatus("Saved. Run a new custom simulation to apply.");
      close();
    }catch(e){
      showStatus("Save failed: " + String(e?.message || e));
    }
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
uiState.compareTierValues = uiState.compareTierValues || "best"; // 'best' | 'base'
uiState.graphMetric = uiState.graphMetric || "ttk";
uiState.graphOrderBy = uiState.graphOrderBy || "ttk";
if (uiState.ttkScaleMax === undefined) uiState.ttkScaleMax = null;
if (uiState.compareScaleMax === undefined) uiState.compareScaleMax = null;
if (uiState.tierTtkTol === undefined) uiState.tierTtkTol = 0.001;

// Metric definitions for charts (mean + median support)
const METRIC_DEF = {
  ttk: {
    key: "ttk",
    label: "TTK",
    unit: "s",
    tickDec: 2,
    valDec: 3,
    meanField: "ttk_mean",
    p50Field: "ttk_p50",
    stdField: "ttk_std",
    ciLowField: "ttk_mean_ci_low",
    ciHighField: "ttk_mean_ci_high",
  },
  shots: {
    key: "shots",
    label: "Shots",
    unit: "",
    tickDec: 1,
    valDec: 2,
    meanField: "shots_mean",
    p50Field: "shots_p50",
    stdField: "shots_std",
    ciLowField: "shots_mean_ci_low",
    ciHighField: "shots_mean_ci_high",
  },
  fire_time: {
    key: "fire_time",
    label: "Fire time",
    unit: "s",
    tickDec: 2,
    valDec: 3,
    meanField: "fire_time_mean",
    p50Field: "fire_time_p50",
    stdField: "fire_time_std",
    ciLowField: "fire_time_mean_ci_low",
    ciHighField: "fire_time_mean_ci_high",
  },
  reloads: {
    key: "reloads",
    label: "Reloads",
    unit: "",
    tickDec: 2,
    valDec: 2,
    meanField: "reloads_mean",
    p50Field: "reloads_p50",
    stdField: "reloads_std",
    ciLowField: "reloads_mean_ci_low",
    ciHighField: "reloads_mean_ci_high",
  },
  reload_time: {
    key: "reload_time",
    label: "Reload time",
    unit: "s",
    tickDec: 2,
    valDec: 3,
    meanField: "reload_time_mean",
    p50Field: "reload_time_p50",
    stdField: "reload_time_std",
    ciLowField: "reload_time_mean_ci_low",
    ciHighField: "reload_time_mean_ci_high",
  },
};

// Compute the maximum "whisker" (mean + sd) across a set of rows for a given metric
function maxWhiskerFromRows(rows, M){
  let maxHi = 0;
  const key = (M && M.key) ? M.key : "ttk";

  for (const r of (rows || [])){
    let mu;
    let sd;

    // For axis autoscaling of TTK, always use the original (simulated) TTK
    // which includes reload time, even if the UI toggle is unchecked.
    if (key === "ttk"){
      mu = Number(r.ttk_mean);
      if (!Number.isFinite(mu)) mu = metricTTKIncludingReload(r);
      sd = Number(r.ttk_std);
    } else {
      const st = extractMetricStats(r, key);
      if (!st) continue;
      mu = Number(st.mean);
      if (!Number.isFinite(mu)) continue;
      sd = Number(st.sd);
    }

    const hi = Number.isFinite(sd) ? (mu + sd) : mu;
    if (hi > maxHi) maxHi = hi;
  }

  return maxHi;
}

// Choose a "nice" major tick step for a given range
function niceStep(range, targetMajors = 4){
  if (!Number.isFinite(range) || range <= 0) return 1;
  const raw = range / Math.max(1, targetMajors);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const err = raw / pow;

  let step;
  if (err <= 1) step = 1;
  else if (err <= 2) step = 2;
  else if (err <= 5) step = 5;
  else step = 10;

  return step * pow;
}

function getMetricDef(key){
  return METRIC_DEF[key] || METRIC_DEF.ttk;
}

function extractMetricStats(row, metricKey) {
  const def = METRIC_DEF[metricKey];
  if (!def) return null;

  let mean = Number(row[def.meanField]);
  if (!Number.isFinite(mean)) mean = null;
  if (mean == null) {
    // Fallbacks for deterministic-only fields
    if (metricKey === "ttk") mean = Number.isFinite(row.ttk_s) ? row.ttk_s : metricTTK(row);
    else if (metricKey === "shots"){
      const btk = Number(row.bullets_to_kill);
      const det = Number(row.shots);
      mean = Number.isFinite(btk) ? btk : (Number.isFinite(det) ? det : undefined);
    }
    else if (metricKey === "fire_time") mean = fireTimeSpent(row);
    else if (metricKey === "reload_time") mean = reloadTimeSpent(row);
    else if (metricKey === "reloads") mean = Number.isFinite(row.reloads) ? row.reloads : undefined;
  }
  if (mean == null) return null;

  let median = (def.p50Field && row[def.p50Field] != null)
    ? row[def.p50Field]
    : mean;

  let ciLow = (def.ciLowField && row[def.ciLowField] != null)
    ? row[def.ciLowField]
    : mean;

  let ciHigh = (def.ciHighField && row[def.ciHighField] != null)
    ? row[def.ciHighField]
    : mean;

  const sd = def.stdField ? row[def.stdField] : undefined;

  // When plotting TTK and the toggle is off, subtract reload time
  if (metricKey === "ttk" && uiState.ttkIncludesReload === false){
    const relMean = Number.isFinite(row.reload_time_mean)
      ? Number(row.reload_time_mean)
      : reloadTimeSpent(row);

    const relMed = Number.isFinite(row.reload_time_p50)
      ? Number(row.reload_time_p50)
      : relMean;

    if (Number.isFinite(relMean)){
      mean = Math.max(0, mean - relMean);
      if (Number.isFinite(ciLow))  ciLow  = Math.max(0, ciLow  - relMean);
      if (Number.isFinite(ciHigh)) ciHigh = Math.max(0, ciHigh - relMean);
    }
    if (Number.isFinite(relMed)){
      // median dot uses p50
      // if p50 not present, we used mean above; adjust that path too
      // Here we adjust median safely
      // eslint-disable-next-line no-self-assign
      median = Math.max(0, median - relMed);
    }
  }

  return { mean, median, ciLow, ciHigh, sd };
}

// Compare chart controls binding
function initCompareControls(){
  const wSel = document.getElementById("compareWeapon");
  const mSel = document.getElementById("compareMode");
  const tSel = document.getElementById("compareTier");
  const vSel = document.getElementById("compareTierValues");
  if (!wSel || wSel._bound) return;
  wSel._bound = true;

  wSel.addEventListener("change", () => { uiState.compareWeapon = wSel.value; render(); });
  if (mSel) mSel.addEventListener("change", () => { uiState.compareMode = mSel.value; render(); });
  if (tSel) tSel.addEventListener("change", () => { uiState.compareTier = parseInt(tSel.value, 10); render(); });
  if (vSel) vSel.addEventListener("change", () => { uiState.compareTierValues = vSel.value; render(); });
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
    row: r,
    barColor: rarityColor(rarityOf(r.weapon))
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
  const defaultBarColor = getThemeColor("--accent", "#ff5a5f");
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
    const fillCol = it.barColor || it.labelColor || defaultBarColor;
    ctx.fillStyle = fillCol;
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
  const TIER_TTK_TOL = Number.isFinite(uiState.tierTtkTol) ? uiState.tierTtkTol : 0.001; // seconds

  const byWeapon = new Map();
  for (const r of rowsFiltered){
    if (!r || !r.weapon) continue;
    let arr = byWeapon.get(r.weapon);
    if (!arr) byWeapon.set(r.weapon, (arr = []));
    arr.push(r);
  }

  // For each weapon: best row per tier -> pick lowest tier among near-equal best TTK tiers
  const bestRows = [];
  for (const [w, arr] of byWeapon){
    const bestByTier = new Map(); // tier -> row
    for (const r of arr){
      const tier = Number(r.tier) || 1;
      let t = Number.isFinite(r.ttk_mean) ? r.ttk_mean : metricTTK(r);
      if (Number.isFinite(t) && uiState.ttkIncludesReload === false){
        const rel = Number.isFinite(r.reload_time_mean) ? Number(r.reload_time_mean) : reloadTimeSpent(r);
        if (Number.isFinite(rel)) t = Math.max(0, t - rel);
      }
      if (!Number.isFinite(t)) continue;

      const cur = bestByTier.get(tier);
      let curT = cur ? (Number.isFinite(cur.ttk_mean) ? cur.ttk_mean : metricTTK(cur)) : Infinity;
      if (Number.isFinite(curT) && uiState.ttkIncludesReload === false){
        const relC = cur ? (Number.isFinite(cur.reload_time_mean) ? Number(cur.reload_time_mean) : reloadTimeSpent(cur)) : undefined;
        if (Number.isFinite(relC)) curT = Math.max(0, curT - relC);
      }
      if (!cur || t < curT) bestByTier.set(tier, r);
    }
    if (!bestByTier.size) continue;

    let bestTTK = Infinity;
    for (const r of bestByTier.values()){
      let t = Number.isFinite(r.ttk_mean) ? r.ttk_mean : metricTTK(r);
      if (Number.isFinite(t) && uiState.ttkIncludesReload === false){
        const rel = Number.isFinite(r.reload_time_mean) ? Number(r.reload_time_mean) : reloadTimeSpent(r);
        if (Number.isFinite(rel)) t = Math.max(0, t - rel);
      }
      if (t < bestTTK) bestTTK = t;
    }

    const closeTiers = [];
    for (const [tier, r] of bestByTier.entries()){
      let t = Number.isFinite(r.ttk_mean) ? r.ttk_mean : metricTTK(r);
      if (Number.isFinite(t) && uiState.ttkIncludesReload === false){
        const rel = Number.isFinite(r.reload_time_mean) ? Number(r.reload_time_mean) : reloadTimeSpent(r);
        if (Number.isFinite(rel)) t = Math.max(0, t - rel);
      }
      if (t <= bestTTK + TIER_TTK_TOL) closeTiers.push(tier);
    }

    closeTiers.sort((a,b)=>a-b);
    const chosenTier = closeTiers[0];
    const chosenRow = bestByTier.get(chosenTier);
    bestRows.push({ row: chosenRow, tierPlus: closeTiers.length > 1 });
  }
  // Order bars by selected ordering metric (ascending)
  const orderKey = uiState.graphOrderBy || "ttk";
  bestRows.sort((a,b)=>{
    const av = Number(extractMetricStats(a.row, orderKey)?.mean);
    const bv = Number(extractMetricStats(b.row, orderKey)?.mean);
    return (Number.isFinite(av) ? av : Infinity) - (Number.isFinite(bv) ? bv : Infinity);
  });

  const items = bestRows.map(({ row: r, tierPlus }) => {
    const stats = extractMetricStats(r, metricKey);
    if (!stats) return null;
    const { mean, median, sd } = stats;

    const pr = getPrepatchRow(r);
    const preMean = pr ? Number(extractMetricStats(pr, metricKey)?.mean) : NaN;
    const delta = makeDeltaInfo(mean, preMean, metricKey);

    return {
      label: `${r.weapon} ${tierRoman(r.tier)}${tierPlus ? "+" : ""}`,
      mean,
      delta,
      sd,
      p50: median,
      labelColor: rarityColor(rarityOf(r.weapon)),
      barColor: rarityColor(rarityOf(r.weapon)),
      detail: `Tier ${r.tier}${tierPlus ? "+" : ""} · ${(r.attachments || "none")}`,
    };
  }).filter(it => it && Number.isFinite(it.mean));
  const autoMaxHigh = maxWhiskerFromRows(getScalePoolRows(currentRows, $("targetSelect")?.value ?? savedTarget), M);
  drawHBarChart("ttkChart", "chartTooltip", "chartMeta", items, {
    titleRight: `${items.length} weapons · showing ${M.label}`,
    unit: M.unit,
    tickDec: M.tickDec,
    valDec: M.valDec,
    left: 160,
    labelMax: 28,
    maxScale: uiState.ttkScaleMax,
    autoMaxHigh
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

  const defaultBarColor = getThemeColor("--accent", "#ff5a5f");
  const textColor = getThemeColor("--text", "#e9eef5");
  const subColor  = "rgba(255,255,255,0.65)";
  const gridColor = "rgba(255,255,255,0.08)";
  const deltaUpColor = getThemeColor("--uncommon", "#33d17a");
  const deltaDownColor = getThemeColor("--accent", "#ff5a5f");
  const unit = opts.unit ?? "s";
  const valueDec = opts.valueDec ?? 3;
  const gapNameVal = 8;
  const gapValBar = 8;
  const arrowReserve = Number.isFinite(opts.arrowReserve) ? opts.arrowReserve : 14;

  const maxHigh = Math.max(...items.map(it => {
    const mu = Number(it.mean);
    const sd = Number(it.sd);
    const hi = Number.isFinite(sd) ? (mu + sd) : mu;
    return hi;
  }));
  const autoHigh = (Number.isFinite(opts.autoMaxHigh) && opts.autoMaxHigh > 0)
    ? opts.autoMaxHigh
    : (Number.isFinite(maxHigh) ? maxHigh : 0);
  let maxScale =
    (Number.isFinite(opts.maxScale) && opts.maxScale > 0)
      ? opts.maxScale
      : (autoHigh * 1.02);

  // Compute dynamic left padding based on label and value widths
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const labelMax = opts.labelMax ?? 28;
  let maxLabelW = 0;
  let maxValueW = 0;
  for (const it of items){
    const s = shortenLabel(it.label, labelMax);
    const w = ctx.measureText(s).width;
    if (w > maxLabelW) maxLabelW = w;

    const valText = `${Number(it.mean).toFixed(valueDec)}${unit}`;
    const vw = ctx.measureText(valText).width;
    if (vw > maxValueW) maxValueW = vw;
  }
  const minLeft = 10 + maxLabelW + gapNameVal + arrowReserve + maxValueW + gapValBar;
  const left = Math.max(opts.left ?? 140, minLeft);
  const innerW = Math.max(10, cssW - left - right);

  // grid + ticks (0..maxScale) with nice snapping and labels for majors + minors
  ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const manualMax = Number.isFinite(opts.maxScale) && opts.maxScale > 0;
  let majorStep = niceStep(maxScale, opts.majorTicks ?? 4);
  const minorPerMajor = opts.minorTicks ?? 3;

  // Snap auto scale to a nice multiple (manual max stays exact)
  if (!manualMax && Number.isFinite(maxScale) && maxScale > 0 && Number.isFinite(majorStep) && majorStep > 0){
    maxScale = Math.ceil(maxScale / majorStep) * majorStep;
  }

  const tickY = 14 + headerH/2;
  const tickDec = opts.tickDec ?? 2;
  const minorGridColor = "rgba(255,255,255,0.04)";

  // Build arrays of major and minor ticks
  const majors = [];
  const minors = [];
  const eps = 1e-9;
  const majorCount = Math.max(1, Math.round(maxScale / Math.max(majorStep, eps)));
  for (let i = 0; i <= majorCount; i++){
    const v = Math.min(maxScale, i * majorStep);
    if (v >= 0 - eps && v <= maxScale + eps) majors.push(v);
  }
  if (minorPerMajor > 0 && Number.isFinite(majorStep) && majorStep > 0){
    const mStep = majorStep / (minorPerMajor + 1);
    for (let m = 0; m < majors.length; m++){
      const v0 = majors[m];
      const v1 = (m + 1 < majors.length) ? majors[m+1] : maxScale;
      for (let j = 1; j <= minorPerMajor; j++){
        const vv = v0 + j * mStep;
        if (vv > v0 + eps && vv < v1 - eps && vv <= maxScale + eps){
          minors.push(vv);
        }
      }
    }
  }

  // Merge and draw
  const allTicks = [...majors, ...minors].sort((a,b)=>a-b);
  let lastLabelX = -Infinity;
  const minLabelSpacing = 36; // px

  allTicks.forEach((v) => {
    const x = left + (v / maxScale) * innerW;
    const isMajor = majors.includes(v);

    ctx.strokeStyle = isMajor ? gridColor : minorGridColor;
    ctx.lineWidth = isMajor ? 1.0 : 0.8;
    ctx.beginPath();
    ctx.moveTo(x, top - 6);
    ctx.lineTo(x, finalH - 12);
    ctx.stroke();

    if (x - lastLabelX >= minLabelSpacing){
      ctx.fillStyle = isMajor ? subColor : "rgba(255,255,255,0.55)";
      const label = `${v.toFixed(tickDec)}${unit}`;
      ctx.fillText(label, x, tickY);
      lastLabelX = x;
    }
  })

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

    const fillCol = it.barColor || it.labelColor || defaultBarColor;

    ctx.fillStyle = fillCol;
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

    // value label (mean) between name and bar, on the left side (+ optional delta arrow)
    ctx.textAlign = "right";
    const valText = `${Number(it.mean).toFixed(valueDec)}${unit}`;
    const valueX = left - gapValBar;
    const valW = ctx.measureText(valText).width;

    if (it.delta && it.delta.dir){
      const sym = (it.delta.dir === "up") ? "▲" : "▼";
      const ax = valueX - valW - Math.max(0, arrowReserve - 1); // a bit left of the value text
      ctx.textAlign = "left";
      ctx.fillStyle = (it.delta.dir === "up") ? deltaUpColor : deltaDownColor;
      ctx.fillText(sym, ax, y + barH/2);
      ctx.textAlign = "right";
    }

    ctx.fillStyle = subColor;
    ctx.fillText(valText, valueX, y + barH/2);
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
      const deltaTxt = (it.delta && Number.isFinite(it.delta.pre))
        ? (() => {
            const d = opts.valDec ?? 3;
            const pre = it.delta.pre.toFixed(d);
            const post = it.delta.post.toFixed(d);
            const diff = fmtSigned(it.delta.diff, d);
            const pct = Number.isFinite(it.delta.pct) ? ` (${fmtSigned(it.delta.pct, 1)}%)` : "";
            return `<div style="margin-top:2px; opacity:.9;">Pre-patch: <b>${pre}${unit}</b> · Δ <b>${diff}${unit}</b>${pct}</div>`;
          })()
        : "";

      tip.innerHTML =
        `<div style="font-weight:600; margin-bottom:2px;">${it.label}</div>` +
        `<div>Mean: <b>${it.mean.toFixed(opts.valDec ?? 3)}${unit}</b>${p50Txt}${sdTxt}</div>` +
        deltaTxt +
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
