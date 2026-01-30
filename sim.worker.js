// WebWorker: generates a custom preset by simulating all weapon/tier/attachment combos
// using weapons.json + attachments.json.
importScripts("sim_core.js");

const {
  clamp01,
  normalizeZoneWeights,
  computeEffectiveTrials,
  buildTargetListFromParams,
  mulberry32,
  buildConfigs,
  resolveTargetSpec,
  simulateRowStats,
} = self.SimCore;

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg?.type !== "RUN_SIM") return;

  try{
    const { weapons, attachments, shields, patch, params } = msg;
    const {
      target,
      targets,
      tiers,
      body,
      head,
      limbs,
      miss,
      trials,
      seed,
      confidence,
      fullSweep,
    } = params || {};

    const doFullSweep = (fullSweep !== false);

    // Normalize accuracy inputs and miss rate
    const { nBody, nHead, nLimbs } = normalizeZoneWeights(body, head, limbs);
    const pMiss = clamp01(Number(miss ?? 0));
    const { effTrials } = computeEffectiveTrials(trials, pMiss, nBody, nHead, nLimbs);

    const tierList = doFullSweep
      ? [1,2,3,4]
      : (Array.isArray(tiers) && tiers.length ? tiers.map(Number) : [1,2,3,4]);

    const { configs } = buildConfigs(weapons || [], attachments || [], patch || [], tierList);

    const targetsMap = shields || {};
    const { targetList, targetLookup } = buildTargetListFromParams(
      targetsMap,
      { target, targets, multiTarget: params?.multiTarget },
      doFullSweep,
      ["Medium", "Light", "Light"]
    );

    const baseSeed = (Number(seed ?? 1337) >>> 0);
    const cl = confidence ?? 0.95;

    const total = configs.length * targetList.length;
    const rows = [];
    const prepatchRows = [];
    let done = 0;

    for (let i = 0; i < configs.length; i++){
      const cfg = configs[i];
      for (let ti = 0; ti < targetList.length; ti++){
        const targetName = targetList[ti];
        const tgt = resolveTargetSpec(targetsMap, targetName, targetLookup);

        // deterministic RNG stream per (config, target)
        const rng = mulberry32((baseSeed + i*1013904223 + ti*374761393) >>> 0);
        const post = simulateRowStats(cfg.stats, tgt, nBody, nHead, nLimbs, pMiss, effTrials, rng, cl);

        // prepatch run (independent deterministic RNG stream) when available
        let pre = null;
        if (cfg.stats_pre){
          const rngPre = mulberry32((baseSeed + 0x9e3779b9 + i*1013904223 + ti*374761393) >>> 0);
          pre = simulateRowStats(cfg.stats_pre, tgt, nBody, nHead, nLimbs, pMiss, effTrials, rngPre, cl);
        }

        rows.push({
          weapon: cfg.weapon,
          tier: cfg.tier,
          attachments: cfg.attachments,

          accuracy_profile: "CustomSim",
          acc_body: nBody,
          acc_head: nHead,
          acc_limbs: nLimbs,
          miss: pMiss,

          target: targetName,
          ci_level: cl,
          n_trials: effTrials,

          ...post,

          damage_per_bullet: cfg.stats.damage_per_bullet,
          fire_rate_bps: cfg.stats.fire_rate_bps,
          mag_size: cfg.stats.mag_size,
          reload_time_s: cfg.stats.reload_time_s,
          reload_amount: cfg.stats.reload_amount,
          headshot_mult: cfg.stats.headshot_mult,
          limbs_mult: cfg.stats.limbs_mult,
        });

        if (pre){
          prepatchRows.push({
            weapon: cfg.weapon,
            tier: cfg.tier,
            attachments: cfg.attachments,

            accuracy_profile: "CustomSim",
            acc_body: nBody,
            acc_head: nHead,
            acc_limbs: nLimbs,
            miss: pMiss,

            target: targetName,
            ci_level: cl,
            n_trials: effTrials,

            ...pre,

            damage_per_bullet: cfg.stats_pre.damage_per_bullet,
            fire_rate_bps: cfg.stats_pre.fire_rate_bps,
            mag_size: cfg.stats_pre.mag_size,
            reload_time_s: cfg.stats_pre.reload_time_s,
            reload_amount: cfg.stats_pre.reload_amount,
            headshot_mult: cfg.stats_pre.headshot_mult,
            limbs_mult: cfg.stats_pre.limbs_mult,
          });
        }

        done++;
        if (done % 10 === 0) self.postMessage({ type: "PROGRESS", done, total });
      }
    }

    self.postMessage({ type: "DONE", rows, prepatchRows });

  }catch(e){
    self.postMessage({ type: "ERROR", error: String(e?.message || e) });
  }
};
