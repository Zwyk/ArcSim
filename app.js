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

function syncTargetTierFromRows(rows) {
  const targets = [...new Set(rows.map(r => r.target))].sort();
  const tiers = [...new Set(rows.map(r => +r.tier))].sort((a,b)=>a-b);

  setSelectOptions($("targetSelect"), targets, $("targetSelect").value);
  setSelectOptions($("tierSelect"), tiers.map(String), $("tierSelect").value);
}

async function loadPresetFile(file) {
  setStatus(`Loading ${file}…`);
  try {
    const rows = await fetchJSON(PATH_PRESETS + file);
    currentRows = rows;
    $("heading").textContent = `Fastest setups — ${$("presetSelect").selectedOptions[0].textContent}`;
    syncTargetTierFromRows(currentRows);
    setStatus("");
    // append preset metadata (trials/CI) when present
    const meta = presetMetaFromRows(currentRows);
    const sub = $("subheading");
    sub.textContent = sub.textContent ? `${sub.textContent}${meta?` · ${meta}`:``}` : (meta || "");
    render();
  } catch (e) {
    setStatus(`❌ Failed to load ${file}: ${e?.message || e}`);
  }
}

function setStatus(msg){ $("status").textContent = msg || ""; }

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function presetMetaFromRows(rows){
  const r = rows && rows[0];
  if(!r) return "";
  if(Number.isFinite(r.n_trials) && Number.isFinite(r.ci_level)){
    return `${r.n_trials} trials · ${Math.round(r.ci_level*100)}% CI`;
  }
  return "";
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

function render(){
  const target = $("targetSelect").value;
  const tier = +$("tierSelect").value;
  const topN = Math.max(10, +$("topN").value || 200);

  let rows = currentRows.filter(r => r.target === target && +r.tier === tier);
  const stackOn = $("stackEq").checked;
  const tol = Math.max(0.0000001, +$("stackTol").value || 0.000001);

  if(stackOn) rows = stackEquivalent(rows, tol);

  rows.sort((a,b)=> metricTTK(a) - metricTTK(b));
  const shown = rows.slice(0, topN);

  $("rowsCount").textContent = `${rows.length}`;
  $("weaponsCount").textContent = `${new Set(rows.map(r=>r.weapon)).size}`;

  $("subheading").textContent = `Target: ${target} · Tier: ${tier} · Showing top ${shown.length}`;

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
  // Load preset manifest
  presetManifest = await fetchJSON(PATH_PRESETS + "presets.json");
  const presetSelect = $("presetSelect");
  presetSelect.innerHTML = "";
  for(const p of presetManifest){
    const opt = document.createElement("option");
    opt.value = p.file;
    opt.textContent = p.name;
    presetSelect.appendChild(opt);
  }

  // Target/tier dropdowns will be populated from loaded preset rows

  $("targetSelect").addEventListener("change", render);
  $("tierSelect").addEventListener("change", render);
  $("topN").addEventListener("change", render);
  $("stackEq").addEventListener("change", render);
  $("stackTol").addEventListener("change", render);

  // Load initial preset
  presetSelect.addEventListener("change", async () => {
    await loadPresetFile(presetSelect.value);
  });

  await loadPresetFile(presetSelect.value);

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
    const tiers = [+$("tierSelect").value];

    const head = clamp01((+$("headPct").value)/100);
    const limbs = clamp01((+$("limbsPct").value)/100);
    const body = clamp01(1 - head - limbs);
    const miss = clamp01((+$("missPct").value)/100);

    const trials = Math.max(100, +$("trials").value || 1000);
    const seed = (+$("seed").value || 1337) >>> 0;
    const confidence = parseFloat($("confidence").value || "0.95");

    const params = { target, tiers, body:+body.toFixed(4), head:+head.toFixed(4), limbs:+limbs.toFixed(4), miss:+miss.toFixed(4), trials, seed, confidence };

    const key = cacheKey(params);
    const cached = localStorage.getItem(key);
    if(cached){
      currentRows = JSON.parse(cached);
      setStatus("Loaded from cache.");
      $("downloadBtn").disabled = false;
      $("runBtn").disabled = false;
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
