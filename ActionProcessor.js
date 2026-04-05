// ActionProcessor.js — extracted from v103-1/v118 (no refactors; same behavior)
const crypto = require('crypto');

// Keep defaults for consistency (not used heavily here but stable)
const DEFAULTS = {
  STREAM: { R: 2, P: 1 },
};

function sha256Hex(s) { return crypto.createHash('sha256').update(String(s),'utf8').digest('hex'); }
function parseISO(ts) { const d=new Date(ts); if (Number.isNaN(d.getTime())) throw new Error("INVALID_ISO_TIMESTAMP"); return d; }
function toISO(d) { return new Date(d).toISOString(); }

// Levenshtein distance (duplicated from NPCs.js for module independence)
function levenshtein(a,b){
  a = String(a||'').toLowerCase(); b = String(b||'').toLowerCase();
  const n = a.length, m = b.length;
  const dp = new Array(m+1);
  for (let j=0;j<=m;j++) dp[j] = j;
  for (let i=1;i<=n;i++){
    let prev = dp[0];
    dp[0] = i;
    for (let j=1;j<=m;j++){
      const tmp = dp[j];
      const cost = (a[i-1]===b[j-1]) ? 0 : 1;
      dp[j] = Math.min(dp[j]+1, dp[j-1]+1, prev+cost);
      prev = tmp;
    }
  }
  return dp[m];
}

function aliasScore(query, name, aliases, ctxBonus=0){
  const q = String(query||'').trim().toLowerCase();
  let score = 0;
  if (q === String(name||'').trim().toLowerCase()) score += 10;
  if (Array.isArray(aliases) && aliases.some(al => q === String(al||'').trim().toLowerCase())) score += 6;
  const dists = [levenshtein(q, String(name||''))];
  if (Array.isArray(aliases)) for (const al of aliases) dists.push(levenshtein(q, String(al||'')));
  const dist = Math.min(...dists);
  if (dist > 2) score -= 2;
  score += Math.max(0, Math.min(ctxBonus, 4));
  return score;
}
function resolveItemByName(state, query){
  const inv = (((state||{}).player||{}).inventory)||[];
  const cands = [];
  for (const it of inv){
    const sc = aliasScore(query, it?.name||'', it?.aliases||[], 2);
    cands.push([sc, 'inventory', it]);
  }
  if (!cands.length) return null;
  cands.sort((a,b)=>b[0]-a[0]);
  const best = cands[0];
  const second = cands[1] || [-9999,'',{}];
  if (best[0] >= 20 && (best[0] - (typeof second[0]==='number'?second[0]:-9999)) >= 10){
    return [best[1], best[2]];
  }
  return null;
}

// ============================================================================
// INTENT PARSING — DEPRECATED (LEGACY FALLBACK)
// ============================================================================
// DEPRECATED: Use SemanticParser.normalizeUserIntent() instead
// This regex-based parser is a fallback for when the LLM parser fails.
// It provides basic handling of look/take/drop but cannot handle complex commands.
// Keep for backward compatibility and crash prevention only.
function parseIntent(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^(look|look around|observe|scan)$/.test(t)) return { action:'look' };
  let m;
  m = t.match(/^\b(grab|take|pick up)\b\s+(.*)$/); if (m){
    let target = (m[2]||'').trim().replace(/^(the|a|an)\s+/, '');
    if (!target) return { action:'noop' };
    return { action:'take', target };
  }
  m = t.match(/^\b(drop)\b\s+(.*)$/); if (m){
    let target = (m[2]||'').trim().replace(/^(the|a|an)\s+/, '');
    if (!target) return { action:'noop' };
    return { action:'drop', target };
  }
  // movement parsing moved to WorldGen.parseAndApplyMovement
}

// ============================================================================
// MERCHANT INVENTORY REGENERATION — STUB
// ============================================================================
// TODO: Implement actual merchant inventory regeneration logic
// This should:
//   1. Check if merchant NPC has been encountered
//   2. On each turn: add 10-20% new items to inventory based on profession
//   3. Remove sold items from inventory
//   4. Respect merchant specialty (different NPCs sell different things)
// Current status: Stub only - returns state unchanged to prevent crashes
function merchantRegenOnTurn(state, turnCount) {
  console.log(`[MERCHANT-REGEN] Stub called - turn ${turnCount}, merchants: ${state?.world?.npcs?.filter(n => n.type === 'merchant')?.length || 0}`);
  return state; // Return state unchanged for now
}

// PLAYER ACTION EXECUTION — TAKE ACTION
// ============================================================================
function applyPlayerActions(state, actions, deltas, flags, logger){
  const act = actions?.action;
  
  // ========== MOVEMENT ==========
  if (act === 'move') {
    // [POINT-D] Log when movement branch is entered
    console.log('[POINT-D-EXECUTE] Movement branch entered. action=', act, 'dir=', actions?.dir);
    const dir = String(actions?.dir || '').toLowerCase();
    const pos = state?.world?.position;
    console.log('[POINT-D-EXECUTE] pos exists?', !!pos, 'pos:', pos);
    if (!pos) {
      console.log('[POINT-D-EXECUTE] NO POSITION - returning early');
      return; // No position to move from
    }
    
    const l1w = state?.world?.l1_default?.w || 12;
    const l1h = state?.world?.l1_default?.h || 12;
    
    // Map direction to coordinate delta
    const dirMap = { north: {dx:0, dy:-1}, south: {dx:0, dy:1}, east: {dx:1, dy:0}, west: {dx:-1, dy:0} };
    const delta = dirMap[dir];
    console.log('[POINT-D-EXECUTE] dir:', dir, 'delta:', delta);
    if (!delta) {
      console.log('[POINT-D-EXECUTE] INVALID DIRECTION - returning early');
      return; // Invalid direction
    }

    // L1 site movement — depth≥2 uses site-local player.position, not world.position
    if (state.world.current_depth >= 2 && state.world.active_site) {
      const _site = state.world.active_site;
      const _siteW = _site.width || 7;
      const _siteH = _site.height || 7;
      const _sp = state.player?.position || { x: Math.floor(_siteW / 2), y: Math.floor(_siteH / 2) };
      const _nx = _sp.x + delta.dx;
      const _ny = _sp.y + delta.dy;
      if (_nx < 0 || _nx >= _siteW || _ny < 0 || _ny >= _siteH) {
        // Edge — exit to L0
        state.world.active_site = null;
        state.world.current_depth = 1;
        if (!state.player) state.player = {};
        state.player.depth = 1;
        console.log(`[ACTIONS] L1 edge exit: exited ${_site.name || 'site'} back to L0`);
      } else {
        state.player.position = { x: _nx, y: _ny };
        console.log(`[ACTIONS] L1 move ${dir}: site pos (${_nx},${_ny})`);
      }
      return;
    }

    // Calculate new position
    let newLx = pos.lx + delta.dx;
    let newLy = pos.ly + delta.dy;
    let newMx = pos.mx;
    let newMy = pos.my;
    
    // Handle L1 grid wrapping (move to adjacent L0 macro cell if at boundary)
    if (newLx < 0) { newMx -= 1; newLx = l1w - 1; }
    if (newLx >= l1w) { newMx += 1; newLx = 0; }
    if (newLy < 0) { newMy -= 1; newLy = l1h - 1; }
    if (newLy >= l1h) { newMy += 1; newLy = 0; }

    // Apply L0 toroidal wrap so macro coordinates stay within the 8×8 grid.
    // streamL1Cells applies identical arithmetic — position and cell keys must agree.
    const l0w = state?.world?.l0_size?.w || 8;
    const l0h = state?.world?.l0_size?.h || 8;
    newMx = ((newMx % l0w) + l0w) % l0w;
    newMy = ((newMy % l0h) + l0h) % l0h;

    // Log movement attempt with full context
    if (logger) {
      logger.player_move_attempted(
        dir,
        { mx: pos.mx, my: pos.my, lx: pos.lx, ly: pos.ly },
        { mx: newMx, my: newMy, lx: newLx, ly: newLy }
      );
    }
    
    // Update position in state
    state.world.position = { mx: newMx, my: newMy, lx: newLx, ly: newLy };
    console.log('[POINT-D-EXECUTE] POSITION MUTATED:', state.world.position);
    deltas.push({ op:'set', path:'/world/position', value: state.world.position });
    console.log('[POINT-D-EXECUTE] delta pushed for position change');
    
    // Log movement resolution (success)
    if (logger) {
      logger.player_move_resolved(
        true,
        'success',
        { mx: newMx, my: newMy, lx: newLx, ly: newLy }
      );
      logger.action_resolved('move', true, `moved ${dir}`);
    }
    
    console.log(`[ACTIONS] Move ${dir}: M${newMx},${newMy} L${newLx},${newLy}`);
    return;
  }
  
  if (act === 'take'){
    // TODO: Implement take action logic
    // This should:
    //   1. Parse target item from player intent
    //   2. Check if item exists in current cell or NPC inventory
    //   3. Validate player carrying capacity
    //   4. Mutate game state to move item to player inventory
    //   5. Return success/failure status for narrative
    console.log('[ACTIONS] Take action stub - needs implementation');
    if (logger) {
      logger.action_resolved('take', false, 'not implemented');
    }
    return; 
  }
  if (act === 'drop'){
    const target = actions?.target||'';
    const res = resolveItemByName(state, target);
    let dropSucceeded = false;
    if (res && res[0] === 'inventory'){
      const item = res[1];
      const inv = state.player.inventory;
      const idx = inv.findIndex(it => (it?.id) === item?.id);
      if (idx >= 0){
        inv.splice(idx,1);
        deltas.push({ op:'set', path:'/player/inventory', value: inv });
        flags.inventory_rev = true;
        dropSucceeded = true;
      }
    }
    if (logger) {
      logger.action_resolved('drop', dropSucceeded, dropSucceeded ? `dropped ${target}` : `could not drop ${target}`);
    }
    return;
  }
  if (act === 'look'){ 
    if (logger) {
      logger.action_resolved('look', true, 'observed surroundings');
    }
    return; 
  }
  
  // === PHASE 3C: Quest action execution ===
  if (['accept_quest', 'complete_quest'].includes(act)){
    const questSucceeded = updateNPCQuestState(actions, state, deltas, flags);
    if (logger) {
      logger.action_resolved(act, questSucceeded, questSucceeded ? `${act} completed` : `${act} failed`);
    }
    return;
  }
}

function computeInventoryDigestHex(state){
  const inv = (((state||{}).player||{}).inventory)||[];
  const rows = inv.map(it => {
    const slot = ((it||{}).props||{}).slot || '';
    const rarity = ((it||{}).props||{}).rarity || '';
    const line = `${it?.id||''}|${it?.name||''}|${slot}|${rarity}|${it?.property_revision||0}`;
    return line;
  }).sort().join('\n');
  return sha256Hex(rows);
}

// === PHASE 3C: Settlement NPC lookup (persistent NPCs, not current cell) ===
function getNPCInSettlement(state, settlementId, npcId){
  const settlement = (state?.world?.sites || {})[settlementId];
  if (!settlement || !Array.isArray(settlement.npcs)) return null;
  return settlement.npcs.find(n => n?.id === npcId) || null;
}

// === PHASE 3C: Quest action validation (no state mutation) ===
function validateQuestAction(action, targetNPC, state){
  const act = String(action?.action||'').toLowerCase();
  const npcId = action?.target; // NPC ID from normalized intent
  const questId = action?.questId; // Optional quest ID for complete_quest
  
  if (!npcId){
    return { valid: false, error: 'NO_NPC_TARGET', newState: null };
  }

  // Extract settlementId from NPC ID pattern: npc_${settlementId}_${index}
  const match = String(npcId).match(/^npc_([^_]+)_\d+$/);
  if (!match){
    return { valid: false, error: 'INVALID_NPC_ID_FORMAT', newState: null };
  }
  const settlementId = match[1];
  
  const npc = getNPCInSettlement(state, settlementId, npcId);
  if (!npc){
    return { valid: false, error: 'NPC_NOT_FOUND', newState: null };
  }

  // Check if NPC is a quest-giver
  if (typeof npc.quest_giver_rank !== 'number' || npc.quest_giver_rank <= 0){
    return { valid: false, error: 'NPC_NOT_QUEST_GIVER', newState: null };
  }

  const questState = (state?.quests) || { allQuestsSeeded: {}, active: [], completed: [], config: {} };
  
  if (act === 'accept_quest'){
    // Check: Quest available for this NPC
    const available = (questState.allQuestsSeeded[settlementId] || []).find(q => q.giver_npc_id === npcId);
    if (!available){
      return { valid: false, error: 'NO_QUEST_AVAILABLE', newState: null };
    }
    
    // Check: Not already active
    const alreadyActive = questState.active.some(q => q.id === available.id);
    if (alreadyActive){
      return { valid: false, error: 'QUEST_ALREADY_ACTIVE', newState: null };
    }
    
    // Check: Not already completed
    const alreadyCompleted = questState.completed.some(q => q.id === available.id);
    if (alreadyCompleted){
      return { valid: false, error: 'QUEST_ALREADY_COMPLETED', newState: null };
    }
    
    // Check: Max active quests limit
    const maxActive = questState.config?.maxActiveQuests || 10;
    if (questState.active.length >= maxActive){
      return { valid: false, error: 'MAX_ACTIVE_QUESTS_REACHED', newState: null };
    }
    
    return { valid: true, error: null, newState: { settlementId, questId: available.id, npc } };
  }
  
  if (act === 'complete_quest'){
    if (!questId){
      return { valid: false, error: 'NO_QUEST_ID', newState: null };
    }
    
    // Check: Quest is active
    const activeQuest = questState.active.find(q => q.id === questId);
    if (!activeQuest){
      return { valid: false, error: 'QUEST_NOT_ACTIVE', newState: null };
    }
    
    // Check: Quest is assigned to this NPC
    if (activeQuest.giver_npc_id !== npcId){
      return { valid: false, error: 'WRONG_QUEST_GIVER', newState: null };
    }
    
    // Check: Quest objectives completed (stub - assumes complete for now)
    // TODO: Implement objective validation when quest objective system is built
    //   This should check if player has met the quest's completion conditions
    //   before allowing quest completion
    
    return { valid: true, error: null, newState: { settlementId, questId, npc, activeQuest } };
  }
  
  if (act === 'ask_about_quest'){
    // Always valid if NPC is a quest-giver (no state constraints)
    return { valid: true, error: null, newState: { settlementId, npc } };
  }
  
  return { valid: false, error: 'UNKNOWN_QUEST_ACTION', newState: null };
}

// === PHASE 3C: NPC quest state persistence ===
function updateNPCQuestState(action, state, deltas, flags){
  const act = String(action?.action||'').toLowerCase();
  const validation = validateQuestAction(action, null, state);
  
  if (!validation.valid){
    console.log(`[QUEST] updateNPCQuestState failed: ${validation.error}`);
    return;
  }
  
  const { settlementId, questId, npc, activeQuest } = validation.newState;
  const settlement = (state.world.sites || state.world.settlements || {})[settlementId];
  
  if (!settlement){
    console.log(`[QUEST] Settlement ${settlementId} not found`);
    return;
  }
  
  if (act === 'accept_quest'){
    // Add quest to active list
    const questState = state.quests || { allQuestsSeeded: {}, active: [], completed: [], config: {} };
    const questToAccept = (questState.allQuestsSeeded[settlementId] || []).find(q => q.id === questId);
    
    if (questToAccept){
      questState.active.push({
        ...questToAccept,
        accepted_at: new Date().toISOString(),
        status: 'active'
      });
      
      deltas.push({
        op: 'set',
        path: '/quests/active',
        value: questState.active
      });
      
      console.log(`[QUEST] Accepted quest ${questId} from NPC ${npc.id}`);
      flags.quest_accepted = true;
    }
  }
  
  if (act === 'complete_quest'){
    // Move quest from active to completed
    const questState = state.quests;
    const activeIdx = questState.active.findIndex(q => q.id === questId);
    
    if (activeIdx >= 0){
      const completedQuest = {
        ...questState.active[activeIdx],
        completed_at: new Date().toISOString(),
        status: 'completed'
      };
      
      questState.active.splice(activeIdx, 1);
      questState.completed.push(completedQuest);
      
      deltas.push({
        op: 'set',
        path: '/quests/active',
        value: questState.active
      });
      
      deltas.push({
        op: 'set',
        path: '/quests/completed',
        value: questState.completed
      });
      
      // Decrement NPC quest_giver_rank
      const npcIdx = settlement.npcs.findIndex(n => n.id === npc.id);
      if (npcIdx >= 0 && settlement.npcs[npcIdx].quest_giver_rank > 0){
        settlement.npcs[npcIdx].quest_giver_rank -= 1;
        
        deltas.push({
          op: 'set',
          path: `/world/sites/${settlementId}/npcs`,
          value: settlement.npcs
        });
        
        console.log(`[QUEST] Completed quest ${questId}, NPC ${npc.id} rank: ${settlement.npcs[npcIdx].quest_giver_rank}`);
        flags.quest_completed = true;
      }
    }
  }
}

// === Phase 3: Validation for pre-normalized intents (no state mutation) ===
const DIR_ALIASES = { n:'north', s:'south', e:'east', w:'west', u:'up', d:'down' };
const VALID_DIRS = new Set(['north','south','east','west','up','down']);

function isValidDir(dir){
  if (!dir) return { ok:false, canonical:null };
  const d = String(dir).trim().toLowerCase();
  const canon = DIR_ALIASES[d] || d;
  return { ok: VALID_DIRS.has(canon), canonical: VALID_DIRS.has(canon) ? canon : null };
}

function getCellEntities(state){
  const cell = (((state||{}).world||{}).current_cell)||{};
  const items = Array.isArray(cell.items) ? cell.items : [];
  // If your schema nests npcs per cell, prefer that. Otherwise fallback to world.npcs array.
  const npcs = Array.isArray((((state||{}).world)||{}).npcs) ? state.world.npcs : (Array.isArray(cell.npcs)?cell.npcs:[]);
  return { items, npcs };
}

function findByNameCaseInsensitive(list, prop, query){
  const q = String(query||'').trim().toLowerCase();
  for (const it of (list||[])){
    const name = String(it?.[prop]||'').toLowerCase();
    if (name === q) return it;
  }
  return null;
}

function resolveCellItemByName(state, query){
  const { items } = getCellEntities(state);
  // Prefer aliasScore if available (matching inventory resolver style)
  let best = null;
  let bestScore = -1e9;
  for (const it of items){
    const score = (typeof aliasScore === 'function')
      ? aliasScore(query, it?.name||'', it?.aliases||[], 2)
      : (String(it?.name||'').toLowerCase() === String(query||'').trim().toLowerCase() ? 10 : 0);
    if (score > bestScore){ bestScore = score; best = it; }
  }
  return bestScore >= 6 ? best : null; // threshold similar to inventory resolver
}

function hasInventoryItem(state, name){
  const inv = (((state||{}).player||{}).inventory)||[];
  return !!findByNameCaseInsensitive(inv, 'name', name);
}

function isNPCPresent(state, name){
  const { npcs } = getCellEntities(state);
  return !!findByNameCaseInsensitive(npcs, 'name', name);
}
/**
 * validateAndQueueIntent(gameState, normalizedIntent)
 * Returns: { valid, queue, reason?, stateValidation? }
 */
function validateAndQueueIntent(state, normalizedIntent){
  const sv = { hasPlayer: !!((state||{}).player), notes: [] };

  if (!normalizedIntent || typeof normalizedIntent !== 'object'){
    return { valid:false, queue:[], reason:"NO_INTENT", stateValidation:sv };
  }
  const primary = normalizedIntent.primaryAction || null;
  if (!primary || typeof primary.action !== 'string' || !primary.action.trim()){
    return { valid:false, queue:[], reason:"NO_PRIMARY_ACTION", stateValidation:sv };
  }
  const secondaries = Array.isArray(normalizedIntent.secondaryActions) ? normalizedIntent.secondaryActions : [];
  const queue = normalizedIntent.compound ? [primary, ...secondaries] : [primary];

  // Validate each queued action without mutating state
  for (const act of queue){
    const action = String(act?.action||'').toLowerCase();
    if (!action){ return { valid:false, queue:[], reason:"EMPTY_ACTION", stateValidation:sv }; }

    if (action === 'move'){
      const { ok, canonical } = isValidDir(act?.dir);
      sv.validDir = ok;
      if (!ok) return { valid:false, queue:[], reason:"INVALID_DIRECTION", stateValidation:sv };
      act.dir = canonical; // canonicalize
      continue;
    }

    if (action === 'take'){
      const target = act?.target||'';
      const found = resolveCellItemByName(state, target);
      sv.targetInCell = !!found;
      if (!found) return { valid:false, queue:[], reason:"TARGET_NOT_FOUND_IN_CELL", stateValidation:sv };
      continue;
    }

    if (action === 'drop'){
      const target = act?.target||'';
      const inInv = hasInventoryItem(state, target);
      sv.targetInInventory = inInv;
      if (!inInv) return { valid:false, queue:[], reason:"TARGET_NOT_IN_INVENTORY", stateValidation:sv };
      continue;
    }

    if (action === 'examine'){
      const t = act?.target||'';
      const inCell = !!resolveCellItemByName(state, t);
      const inInv = hasInventoryItem(state, t);
      const npc   = isNPCPresent(state, t);
      sv.visible = !!(inCell || inInv || npc);
      if (!sv.visible) return { valid:false, queue:[], reason:"TARGET_NOT_VISIBLE", stateValidation:sv };
      continue;
    }

    if (action === 'talk'){
      const t = act?.target||'';
      const present = isNPCPresent(state, t);
      sv.targetIsNPC = present;
      if (!present) return { valid:false, queue:[], reason:"NPC_NOT_PRESENT", stateValidation:sv };
      continue;
    }

    // === PHASE 3C: Quest action validation ===
    if (['accept_quest', 'complete_quest', 'ask_about_quest'].includes(action)){
      const questValidation = validateQuestAction(act, null, state);
      sv.questValidation = questValidation;
      if (!questValidation.valid){
        return { valid:false, queue:[], reason:questValidation.error, stateValidation:sv };
      }
      continue;
    }

    // Lightweight checks / always-allow group
    if (['sit','stand','wait','listen','look','inventory','help'].includes(action)){
      continue;
    }

    // Actions that may need deeper model checks; allow if not modeled here
    if (['cast','attack','sneak'].includes(action)){
      sv.notes.push(`allowed_${action}_shallow`);
      continue;
    }

    // Unknown action: pass through but mark as shallow-validated
    sv.notes.push(`unknown_action:${action}`);
  }

  console.log('[ACTIONS] valid queue=%d primary=%s', queue.length, queue[0]?.action);
  return { valid:true, queue, stateValidation:sv };
}

module.exports = {
  validateAndQueueIntent,
  parseIntent,
  applyPlayerActions,
  computeInventoryDigestHex,
  resolveItemByName,
  isValidDir,
  getCellEntities,
  findByNameCaseInsensitive,
  resolveCellItemByName,
  hasInventoryItem,
  isNPCPresent,
  // New exports to prevent crashes and improve utility access
  merchantRegenOnTurn,
  aliasScore,
  levenshtein,
  parseISO,
  toISO,
  sha256Hex,
  // === PHASE 3C: Quest system exports ===
  getNPCInSettlement,
  validateQuestAction,
  updateNPCQuestState
};
