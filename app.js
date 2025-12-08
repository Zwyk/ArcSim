const $ = (id) => document.getElementById(id);

const PATH_PRESETS = "data/presets/";
const FILE_WEAPONS = "data/weapons.json";
const FILE_ATTACH = "data/attachments.json";

// Rarity colors (edit freely to match your sheet)
const RARITY = {
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
  if(rar==="Epic") return "badge-epic";
  if(rar==="Rare") return "badge-rare";
  if(rar==="Uncommon") return "badge-uncommon";
  return "badge-common";
}

async function fetchJSON(url){
  const r = await fetch(url, { cache: "no-store" });
  if(!r.ok) throw new Error(`Failed to fetch ${url}: ${r.status}`);
  return await r.json();
}

function setSelectOptions(selectEl, values, preferredValue) {
  const cur = preferredValue ?? selectEl.value;
  selectEl.innerHTML = values.map(v => `<option value="${v}">${v}</option>`).join("");
  if (values.includes(cur)) selectEl.value = cur;
  else if (values.length) selectEl.value = values[0];
}

function getSelectedTiers(){
  const boxes = document.querySelectorAll("#tierChecks input[type=checkbox]");
  const selected = [];
  boxes.forEach(b => { if (b.checked) selected.push(+b.value); });
  return selected.length ? selected : null; // null => means "all"
}

function buildTierCheckboxes(tiers){
  const wrap = $("tierChecks");
  const prev = new Set(getSelectedTiers() || tiers);

  wrap.innerHTML = "";
  for(const t of tiers){
    const id = `tier_${t}`;
    const label = document.createElement("label");
    label.className = "tierPill";
    label.innerHTML = `<input type="checkbox" id="${id}" value="${t}"> Tier ${t}`;
    wrap.appendChild(label);

    const cb = label.querySelector("input");
    cb.checked = prev.has(t);
    cb.addEventListener("change", render);
  }
}

function syncTargetTierFromRows(rows) {
  // Collect targets
  const targets = Array.from(new Set(rows.map(r=> r.target))).sort();
  setSelectOptions($("targetSelect"), targets.map(t=> ({value: t, label: t})), $("targetSelect").value || targets[0]);

  // Collect tiers and build checkboxes
  const tiers = Array.from(new Set(rows.map(r=> +r.tier))).sort((a,b)=> a-b);
  const cont = $("tierChecks");
  cont.innerHTML = "";
  tiers.forEach(t => {
    const id = `tier-${t}`;
    const label = document.createElement("label");
    label.className = "tierPill";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = id;
    cb.value = String(t);
    cb.checked = true;
    cb.addEventListener("change", render);
    const span = document.createElement("span");
    span.textContent = `T${t}`;
    label.appendChild(cb);
    label.appendChild(span);
    cont.appendChild(label);
  });

  setSelectOptions($("targetSelect"), targets, $("targetSelect").value);
function getSelectedTiers(){
  return Array.from(document.querySelectorAll('#tierChecks input[type="checkbox"]:checked'))
    .map(cb => +cb.value);
}
  buildTierCheckboxes(tiers);
}

async function loadPresetFile(file) {
  setStatus(`Loading ${file}…`);
  try {
    currentRows = await fetchJSON(PATH_PRESETS + file);

    const presetName = $("presetSelect").selectedOptions[0].textContent;
    const meta = presetMetaFromRows(currentRows);

    $("heading").textContent = meta
      ? `Fastest setups — ${presetName} · ${meta}`
      : `Fastest setups — ${presetName}`;

    document.title = meta
      ? `ARC Raiders — ${presetName} · ${meta}`
      : `ARC Raiders — ${presetName}`;

    syncTargetTierFromRows(currentRows);
    setStatus(""
    );
    render();
  } catch (e) {
    setStatus(`❌ Failed to load ${file}: ${e?.message || e}`);
  }
}

function setStatus(msg){ $("status").textContent = msg || ""; }

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
// Build a readable title for custom sim
function customSimTitle(p){
  const body = Math.round((p.body ?? 0) * 100);
  const head = Math.round((p.head ?? 0) * 100);
  const limbs = Math.round((p.limbs ?? 0) * 100);
  const miss = Math.round((p.miss ?? 0) * 100);

  const tiers = (p.tiers && p.tiers.length)
    ? `T${p.tiers.join(',')}`
    : "T(all)";

  const trials = p.trials ? `${p.trials} trials` : null;
  const cl = (p.confidence != null) ? `${Math.round(p.confidence * 100)}% CI` : null;

  const parts = [
    `Custom ${body}/${head}/${limbs}`,
    `miss ${miss}%`,
    tiers,
    trials,
    cl
  ].filter(Boolean);

  return parts.join(" · ");
}

function setCustomTitle(p){
  const t = customSimTitle(p);
  $("heading").textContent = `Fastest setups — ${t}`;
  document.title = `ARC Raiders — ${t}`;
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

function metricTTK(row){
  // precomputed uses ttk_s, simulated uses ttk_p50
  if(Number.isFinite(row.ttk_p50)) return row.ttk_p50;
  return row.ttk_s;
}
function metricShots(row){
  if(Number.isFinite(row.shots_p50)) return row.shots_p50;
  return row.bullets_to_kill; // in old file, it's bullets_to_kill (no misses)
}

function attachmentRank(attName){
  // Your order: Mag1 < Mag2 < Mag3 < Kinetic Converter
  // We'll rank by "best cheap" (lower is cheaper)
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

      // keep cheapest representative by attachmentRank
      const cur = g.rep;
      if(attachmentRank(r.attachments) < attachmentRank(cur.attachments)){
        g.rep = r;
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
    case "ttk": return metricTTK(r) ?? Infinity;
    case "shots": return metricShots(r) ?? Infinity;
    case "reloads": return (r.reloads_mean ?? r.reloads) ?? Infinity;
    case "dmg": return +r.damage_per_bullet ?? 0;
    case "bps": return +r.fire_rate_bps ?? 0;
    case "mag": return +r.mag_size ?? 0;
    case "rld": return +r.reload_time_s ?? 0;
    case "ra": return +r.reload_amount ?? 0;
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

function updateSortIndicators(){
  document.querySelectorAll("th.sortable").forEach(th => {
    const k = th.dataset.sort;
    const base = th.textContent.replace(/[\s▲▼].*$/, "").trim();
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
  const topN = Math.max(10, +$("topN").value || 200);

  let rows = currentRows.filter(r => r.target === target);
  if (selectedTiers && selectedTiers.length){
    const set = new Set(selectedTiers);
    rows = rows.filter(r => set.has(+r.tier));
  }
  if (baseOnly){
    rows = rows.filter(r => (r.attachments === "none" || !r.attachments));
  }
  const stackOn = $("stackEq").checked;
  const tol = Math.max(0.0000001, +$("stackTol").value || 0.000001);

  if(stackOn) rows = stackEquivalent(rows, tol);

  rows.sort((a,b)=> compare(getCellValue(a, sortKey), getCellValue(b, sortKey), sortDir));
  const shown = rows.slice(0, topN);

  $("rowsCount").textContent = `${rows.length}`;
  $("weaponsCount").textContent = `${new Set(rows.map(r=>r.weapon)).size}`;

  $("subheading").textContent = `Target: ${target} · Showing top ${shown.length}`;

  const tbody = $("tbody");
  tbody.innerHTML = "";

  for(const r of shown){
    const rar = rarityOf(r.weapon);
    const wClass = rarityClass(rar);

    const ttk = metricTTK(r);
    const shots = metricShots(r);

    const clPct = r.ci_level ? Math.round(r.ci_level * 100) : null;
    let ttkExtra = "";
    if(Number.isFinite(r.ttk_p50_ci_low) && Number.isFinite(r.ttk_p50_ci_high) && clPct){
      const half = (r.ttk_p50_ci_high - r.ttk_p50_ci_low) / 2;
      const rel = (Number.isFinite(r.ttk_ci_rel) ? (r.ttk_ci_rel * 100) : null);
      ttkExtra = `<div class="sub">${clPct}% CI: ${fmt(r.ttk_p50_ci_low)}–${fmt(r.ttk_p50_ci_high)} (±${fmt(half)}s${rel!=null?`, ${rel.toFixed(1)}%`:``})</div>`;
    }

    const variants = r._variants && r._variants.length ? r._variants : null;
    const attCell = variants
      ? `<span class="variantLink" data-variants="${encodeURIComponent(JSON.stringify(variants))}">${escapeHtml(r.attachments)}</span>`
      : escapeHtml(r.attachments);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="${wClass}">${escapeHtml(r.weapon)}</td>
      <td class="num">${r.tier}</td>
      <td>${attCell}</td>
      <td class="num">${fmt(ttk)}s${ttkExtra}</td>
      <td class="num">${shots ?? ""}</td>
      <td class="num">${fmt(r.reloads_mean ?? r.reloads)}</td>
      <td class="num">${fmt(r.damage_per_bullet)}</td>
      <td class="num">${fmt(r.fire_rate_bps)}</td>
      <td class="num">${fmt(r.mag_size)}</td>
      <td class="num">${fmt(r.reload_time_s)}</td>
      <td class="num">${fmt(r.reload_amount)}</td>
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

function fmt(x){
  if(x === null || x === undefined) return "";
  const n = Number(x);
  if(!Number.isFinite(n)) return "";
  if(Math.abs(n) >= 100) return n.toFixed(0);
  if(Math.abs(n) >= 10) return n.toFixed(2);
  return n.toFixed(3);
}
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
  presetManifest.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.file;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  });

    // title helper moved to global scope: setCustomTitle

  // Filters
  $("targetSelect").addEventListener("change", render);
  $("baseOnly").addEventListener("change", render);
  $("topN").addEventListener("input", render);
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
    });
  });

  // Add fixed Custom option
  {
    const opt = document.createElement("option");
    opt.value = "__custom__";
    opt.textContent = "Custom (simulated)";
    presetSelect.insertBefore(opt, presetSelect.firstChild);
  }

  // Load initial preset and handle changes
  presetSelect.addEventListener("change", async () => {
    const v = presetSelect.value;
    if(v === "__custom__"){
      // Ignore; stays on current rows
      return;
    }
    await loadPresetFile(v);
  });
  if(presetSelect.value !== "__custom__"){
    await loadPresetFile(presetSelect.value);
  }

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
      setCustomTitle(lastCustomParams || {});
      $("presetSelect").value = "__custom__";
      syncTargetTierFromRows(currentRows);
      setStatus(`Done. Rows: ${currentRows.length}`);
      $("downloadBtn").disabled = false;
      render();
      return;
    }
    if(msg.type === "ERROR"){
      setStatus(`Error: ${msg.error}`);
    }
  };

  const useCustom = $("useCustom");
  useCustom.addEventListener("change", ()=>{
    $("runBtn").disabled = !useCustom.checked;
  });
  $("runBtn").addEventListener("click", runCustomSim);
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
    const cached = localStorage.getItem(key);
    if(cached){
      currentRows = JSON.parse(cached);
      setCustomTitle(lastCustomParams || {});
      $("presetSelect").value = "__custom__";
      setStatus("Loaded from cache.");
      $("downloadBtn").disabled = false;
      $("runBtn").disabled = false;
      syncTargetTierFromRows(currentRows);
      render();
      return;
    }

    setStatus("Loading weapon data…");
    const [weapons, attachments] = await Promise.all([fetchJSON(FILE_WEAPONS), fetchJSON(FILE_ATTACH)]);

    setStatus("Simulating…");
    worker.postMessage({ type:"RUN_SIM", weapons, attachments, params });

    // Store when DONE arrives
    const oldHandler = worker.onmessage;
    worker.onmessage = (ev) => {
      const msg = ev.data;
      if(msg.type === "DONE"){
        localStorage.setItem(key, JSON.stringify(msg.rows));
      }
      oldHandler(ev);
      if(msg.type === "DONE" || msg.type === "ERROR"){
        $("runBtn").disabled = false;
        worker.onmessage = oldHandler;
      }
    };

  }catch(e){
    setStatus(String(e?.message || e));
    $("runBtn").disabled = false;
  }
}

init();
