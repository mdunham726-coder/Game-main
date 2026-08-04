/**
 * ContinuityProjector.js — v1.0.0
 *
 * Standalone continuity projection subsystem.
 *
 * Replaces the implicit selection performed by ContinuityBrain.assembleContinuityPacket()
 * with selection that is identified, explicit, reasoned, archived, and bounded. Every
 * managed continuity fact carries a disposition (live / memory / retired) and an archived
 * reason. Nothing here makes the engine better-informed about truth: no new evidence
 * source is added, and none may be designed here.
 *
 * Governing documents (repository root):
 *   CONTINUITY_PROJECTION_REQUIREMENTS.md        — the contract (R-n, F-n, V-n, INV-n, S-n)
 *   CONTINUITY_PROJECTION_IMPLEMENTATION_PLAN.md — the build (§n)
 * Where the two disagree, the requirements win.
 *
 * Authority (requirements §2): this file is authoritative for dispositions only. It is not
 * an authority for object existence, object state, player conditions, NPC identity, player
 * identity, player location, or action outcome, and does not become one by observing,
 * formatting, or archiving any of them.
 *
 * Interface (plan §3): four exports, no others.
 *   PROJECTOR_VERSION
 *   project(gameState, turnContext, options) -> { rendered, packet, failure }   // never throws
 *   renderPacket(packet, options) -> string                                     // pure
 *   compareToBaseline(packet, baselineString) -> report                         // pure and total
 *
 * ─── Departures from the plan as written, each RULED by the user ──────────────────────
 * Every item below is a user decision recorded during the G-10 follow-up review, not an
 * implementation liberty. None changes a category bound, the class of any element, what
 * replays on failure, or any player-visible policy.
 *
 * 1. TWO ADDITIVE ENTRY FIELDS (plan §4 schema). §6 requires two renders — 'live' and
 *    'compat' — over ONE packet, and §4's entry schema carries no mode information and no
 *    line grouping.
 *      entry.renderedCompat : boolean — inclusion in the 'compat' render, the mirror of the
 *                                       specified `rendered`, which is the 'live' render.
 *      entry.lineKey        : string  — which output line the fragment composes. Required
 *                                       because a dropped entry carries `category: null`
 *                                       (plan §4) and cannot otherwise be routed.
 *
 * 2. THE LIVE/COMPAT DELTA IS MEASURED, NOT ASSUMED. Plan §6 asserts that delta is "by
 *    construction" exactly the entries carrying an approved exclusion reason. That is
 *    FALSE: withholding entries can also delete a whole line, and can trigger the
 *    content-conditioned empty marker. The composition step therefore emits a LINE MANIFEST
 *    and the comparator classifies structural consequences from it — structure, never
 *    parsed prose. `compareToBaseline`'s report gains a `structural` field, and the gate
 *    FAILS CLOSED: anything unclassifiable or unapproved is not approved.
 *
 * 3. STRUCTURAL CONSEQUENCES, ruled approved, and only these:
 *      A  the `You:` line vanishes when every player attribute is unrecognized;
 *      B  an NPC line vanishes when its in-window attributes are all unrecognized and it
 *         carries no recognition suffix;
 *      C  the location line vanishes — see the live-only empty guard at _buildLocation;
 *      D  `(no promoted facts yet for this scene)` appears as a downstream consequence of
 *         A, B or C, and ONLY when each of those was itself approved.
 *    In every case the cause must be `unrecognized_bucket`. A capacity bound can never
 *    produce one: 10/12/8 trim a category, they never empty it. Anything else fails.
 *
 * 4. LIVE MODE MAY ONLY EVER WITHHOLD. Content present in live but absent from compat is an
 *    addition and is never approved, regardless of reason. This is what makes the approved
 *    difference set a set of ABSENCES, as R-27 property 3 describes it.
 *
 * 5. SHADOW DETERMINATION MAY PRECEDE THE BREADCRUMB RESET, contained so it cannot escape;
 *    on every non-shadow call the reset remains the first state mutation. See project().
 *
 * 6. A C-1 FACT WITH NULL `turn_set` TAKES `in_bound`, not `age_within_window` — it is
 *    exempt from the age test (F-6), so it was never measured against that window.
 * ──────────────────────────────────────────────────────────────────────────────────────
 *
 * Mirrored, not imported: _ENV_STRIP_PHRASES, _toCanonicalEnv and _getL0CellRecord are
 * module-private in ContinuityBrain.js. Requirements R-1 puts all selection logic in this
 * file and the plan §11 forbids touching ContinuityBrain.js before Phase 5, so exporting
 * them from there is not available. They are reproduced below verbatim and must be kept in
 * step until the old assembler is retired.
 */

const PROJECTOR_VERSION = '1.0.0';

// ── Preserved upstream constants ──────────────────────────────────────────────
// Mirrored from ContinuityBrain.js:37, :39, :43. These are EXISTING behavior and are not
// provisional — changing one changes current output.
const MOOD_WINDOW       = 5;    // C-6: mood snapshots used per packet
const STATE_ATTR_WINDOW = 5;    // C-1: state-bucket age window (F-6); null turn_set is exempt
const ENV_ATTR_WINDOW   = 20;   // C-4 per-NPC cap and C-5 location cap

// ── Framing literals ──────────────────────────────────────────────────────────
// Byte-identical to ContinuityBrain.js:1923-1924, :2038, :2041, :2044-2045, :2064,
// :2077, :2099-2100. Rule lines are built by repetition so no copy can silently
// change their length. R-17 requires exact reproduction.
const FR_TRUTH_HEADER   = 'CONTINUITY — TRUTH';
const FR_TRUTH_RULE     = '═'.repeat(43);
const FR_MOOD_HEADER    = 'CONTINUITY — MOOD';
const FR_MOOD_RULE      = '─'.repeat(45);
const FR_CONTEXT_HEADER = 'CONTEXT — RECENT LOCATION';
const FR_CONTEXT_RULE   = '─'.repeat(45);
const FR_SEPARATOR      = '';
const FR_NO_PROMOTED    = '(no promoted facts yet for this scene)';
const MK_NO_MOOD        = '(no mood data yet)';
const MK_NPC_ABSENT     = 'NPCs at this location: none visible in engine state.';
const LB_TRAJECTORY     = 'recent trajectory:';
const PLACEHOLDER       = '—';   // C-6 per-field fallback only (F-13); classified with C-6

// ── Category policy ───────────────────────────────────────────────────────────
// The approved matrix, requirements R-9.
//
// R-9, stated at the definition site as that requirement demands: EVERY NUMERIC BOUND
// BELOW IS A PROVISIONAL RELEASE-ONE CONSTANT TO BE VALIDATED BY SHADOW COMPARISON. None
// of `bound` on C-1, C-2 or C-3 is evidence-established. C-4's 20 and C-5's 20 are the
// EXISTING ENV_ATTR_WINDOW and are not new.
//
// R-31: each category declares whether its bound is projector-enforced or contract-
// dependent. All five bounds are projector-enforced. The NUMBER OF VISIBLE NPCs, over
// which C-4's per-NPC bound is applied, is contract-dependent (U-1) — no threshold is
// asserted; the count is recorded every turn as a diagnostic instead.
const CATEGORY_POLICY = {
  'C-1': { path: 'player',   bucket: 'state',       bound: 10, boundProvisional: true,  boundEnforcement: 'projector', ageWindow: STATE_ATTR_WINDOW, terminalHorizon: 20,   overflow: 'memory' },
  'C-2': { path: 'player',   bucket: 'physical',    bound: 12, boundProvisional: true,  boundEnforcement: 'projector', ageWindow: null,             terminalHorizon: null, overflow: 'memory' },
  'C-3': { path: 'player',   bucket: 'declared',    bound: 8,  boundProvisional: true,  boundEnforcement: 'projector', ageWindow: null,             terminalHorizon: null, overflow: 'memory' },
  'C-4': { path: 'npc',      bucket: null,          bound: ENV_ATTR_WINDOW, boundProvisional: false, boundEnforcement: 'projector', perSubject: true, subjectCount: 'contract-dependent', ageWindow: null, terminalHorizon: null, overflow: 'memory' },
  'C-5': { path: 'location', bucket: null,          bound: ENV_ATTR_WINDOW, boundProvisional: false, boundEnforcement: 'projector', dedupWithin: true, ageWindow: null, terminalHorizon: null, overflow: 'memory' },
};

// Verified bucket vocabulary, PER PATH — not global (F-31, plan §4). `declared` is verified
// for the player and NOT for an NPC; an NPC attribute in that bucket takes the general rule.
const VOCABULARY = {
  player:   ['physical', 'state', 'declared'],
  npc:      ['physical', 'state'],
  location: ['environment'],
};

// Paths on which the existing assembler already filters bucket 'object'
// (ContinuityBrain.js:1933 player, :1970 NPC). The LOCATION path has no bucket filter at
// all (:1997, F-12) — X-10 protects the filters that exist, and there is none there.
const OBJECT_FILTERED_PATHS = ['player', 'npc'];

// ── Reasons ───────────────────────────────────────────────────────────────────
// Closed set, plan §4. A reason outside it is a defect, not a free-text field.
const REASON = {
  IN_BOUND:            'in_bound',
  AGE_WITHIN_WINDOW:   'age_within_window',
  OVERFLOW_CAPACITY:   'overflow_capacity',
  DUPLICATE_SUPPRESSED:'duplicate_suppressed',
  AGE_BEYOND_WINDOW:   'age_beyond_window',
  AGE_BEYOND_HORIZON:  'age_beyond_horizon',
  CARRIED_AUXILIARY:   'carried_auxiliary',
  CARRIED_PASSTHROUGH: 'carried_passthrough',
  BUCKET_EXCLUDED:     'bucket_excluded_by_policy',
  UNRECOGNIZED_BUCKET: 'unrecognized_bucket',
};

// Reason -> { class, disposition }. Plan §4's table, encoded so no site invents a pairing.
const REASON_TABLE = {
  [REASON.IN_BOUND]:             { cls: 'managed',     disposition: 'live'    },
  [REASON.AGE_WITHIN_WINDOW]:    { cls: 'managed',     disposition: 'live'    },
  [REASON.OVERFLOW_CAPACITY]:    { cls: 'managed',     disposition: 'memory'  },
  [REASON.DUPLICATE_SUPPRESSED]: { cls: 'managed',     disposition: 'memory'  },
  [REASON.AGE_BEYOND_WINDOW]:    { cls: 'managed',     disposition: 'memory'  },
  [REASON.AGE_BEYOND_HORIZON]:   { cls: 'managed',     disposition: 'retired' },
  [REASON.CARRIED_AUXILIARY]:    { cls: 'auxiliary',   disposition: null      },
  [REASON.CARRIED_PASSTHROUGH]:  { cls: 'passthrough', disposition: null      },
  [REASON.BUCKET_EXCLUDED]:      { cls: 'dropped',     disposition: null      },
  [REASON.UNRECOGNIZED_BUCKET]:  { cls: 'dropped',     disposition: null      },
};

// Which reasons the 'compat' render includes. Compat reproduces the OLD selection rules:
// no C-1/C-2/C-3 count bounds, unrecognized buckets included on every path, everything
// else identical (plan §6). Used for the player line, whose compat rule is fully
// reason-determined; the NPC and location lines additionally carry a positional cap and
// are resolved at build time (see _capWindow).
const COMPAT_INCLUDED_REASONS = new Set([
  REASON.IN_BOUND,
  REASON.AGE_WITHIN_WINDOW,
  REASON.OVERFLOW_CAPACITY,     // C-1/C-2/C-3 only — the new bounds do not exist in compat
  REASON.UNRECOGNIZED_BUCKET,   // rendered today on every path (F-31)
]);

// ── Mirrored helpers ──────────────────────────────────────────────────────────
// Verbatim from ContinuityBrain.js:1053-1083 and :1215-1221. See the file header for why
// these are copied rather than imported.

const _ENV_STRIP_PHRASES = [
  /\bacross the way\b/g,
  /\bof main street\b/g,
  /\bof the street\b/g,
  /\bof the road\b/g,
  /\balong the street\b/g,
  /\bagainst the facade\b/g,
  /\bagainst the wall\b/g,
  /\bagainst facade\b/g,
  /\bagainst wall\b/g,
  /\bfrom this angle\b/g,
  /\bbetween buildings\b/g,
  /\bon the corner\b/g,
  /\bof the building\b/g,
  /\bof the area\b/g,
  /\bof the block\b/g,
  /\bjutting from the facade\b/g,
  /\bjutting from facade\b/g,
  /\bon the far side\b/g,
  /\bon the near side\b/g,
  /\bon the other side\b/g,
];

function _toCanonicalEnv(str) {
  let s = str.toLowerCase().replace(/\s+/g, ' ').trim();
  // strip leading articles
  s = s.replace(/^(?:a |an |the )/, '');
  // strip allowlisted trailing location phrases
  for (const rx of _ENV_STRIP_PHRASES) s = s.replace(rx, '');
  return s.trim();
}

function _getL0CellRecord(gameState) {
  const w   = gameState.world || {};
  const pos = w.position;
  if (!pos) return null;
  const key = `LOC:${pos.mx},${pos.my}:${pos.lx},${pos.ly}`;
  return w.cells?.[key] || null;
}

// ── Value coercion ────────────────────────────────────────────────────────────
// The three render paths coerce differently in current source and the difference is
// observable, so it is preserved rather than unified.
//   player   — interpolated `${a.value}` (:1945): null renders as "null"
//   NPC      — Array.prototype.join (:1973-1974): null renders as ""
//   location — explicit coercion (:2009): null renders as ""
function _coerceInterpolated(v) { return `${v}`; }
function _coerceJoined(v) { return (v === null || v === undefined) ? '' : String(v); }
function _coerceLocation(v) { return (typeof v === 'string') ? v : String(v ?? ''); }

// ── Lifecycle evidence boundary ───────────────────────────────────────────────
// R-30 / INV-14: the SINGLE boundary through which lifecycle evidence enters. Release one
// reads `turn_set` and nothing else, and adds no invalidation producer. A future evidence
// source is added HERE and in CATEGORY_POLICY — nowhere else. No construction, archiving,
// or rendering site below reads `turn_set` directly.
//
// Note for the boundary review (R-30): C-5's duplicate_suppressed disposition also consumes
// the attribute VALUE and its canonical form, which is value-derived lifecycle input and is
// accounted for at _dedupWithin rather than here.
function _lifecycleEvidence(attr) {
  const raw = attr ? attr.turn_set : undefined;
  return { turnSet: (raw === null || raw === undefined) ? null : raw };
}

// ── Deterministic order ───────────────────────────────────────────────────────
// R-6: primary `turn_set` descending; ties broken by storage order of the backing
// attribute object; null or absent `turn_set` ranks last. The tiebreak is explicit rather
// than relying on sort stability, so R-5 holds regardless of engine.
//
// Equivalence to current source: ContinuityBrain.js:1971 and :1998 sort with
// `(y.turn_set || 0) - (x.turn_set || 0)` under a stable sort. For every turn_set the
// engine actually stamps (a turn number >= 1, F-8/F-30) that is the same total order —
// nulls collapse to 0 and rank last, ties keep storage order. The orders can only diverge
// for a stored turn_set of exactly 0 or a negative number, which no writer produces.
function _rankByLifecycle(candidates) {
  return candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const ta = _lifecycleEvidence(a.c.attr).turnSet;
      const tb = _lifecycleEvidence(b.c.attr).turnSet;
      const aNull = (ta === null);
      const bNull = (tb === null);
      if (aNull && bNull) return a.i - b.i;
      if (aNull) return 1;
      if (bNull) return -1;
      if (tb !== ta) return tb - ta;
      return a.i - b.i;
    })
    .map(x => x.c);
}

// ── Entry construction ────────────────────────────────────────────────────────
// One record per classified element (plan §4). `class` and `disposition` are derived from
// the reason so a mismatched pairing cannot be written by hand.
function _entry(fields) {
  const t = REASON_TABLE[fields.reason];
  if (!t) throw new Error(`projector_defect: reason outside closed set: ${fields.reason}`);
  const cls = t.cls;
  // Plan §4: `category: null` is REQUIRED for a dropped entry — R-10 states that an
  // out-of-vocabulary attribute belongs to no category, and the object bucket is a
  // non-candidate recorded before any category existed. Asserting one would falsify
  // the archive.
  const category = (cls === 'dropped') ? null : (fields.category ?? null);
  const rendered = (cls === 'dropped') ? false : (fields.rendered === true);
  return {
    class:          cls,
    category:       category,
    subjectKey:     fields.subjectKey ?? null,
    key:            fields.key ?? null,
    value:          fields.value,
    bucket:         fields.bucket ?? null,
    turnSet:        fields.turnSet ?? null,
    disposition:    (cls === 'managed') ? t.disposition : null,
    rendered:       rendered,
    reason:         fields.reason,
    // additive render-support fields — see the file header
    renderedCompat: fields.renderedCompat === true,
    lineKey:        fields.lineKey,
  };
}

function _framing(text, position) {
  return { text, position };
}

// ── Vocabulary classification ─────────────────────────────────────────────────
// One general rule, one exception (plan §4).
//   Exception — player or NPC bucket 'object' -> bucket_excluded_by_policy. Excluded from
//     BOTH renders, producing no shadow difference, because the current assembler already
//     excludes it there (:1933, :1970).
//   General   — any attribute outside its path's verified vocabulary -> unrecognized_bucket.
//     Compat INCLUDES it, live excludes and records it. This is an approved shadow
//     difference (R-10, R-27), and it holds because the existing filters are exclusions,
//     not allowlists: an attribute in an unheard-of bucket renders today on every path.
//     It applies to a LOCATION attribute in bucket 'object' too — the location path has no
//     bucket filter to preserve, so dropping it there in compat would omit what the
//     baseline emits and break byte equality.
function _classifyBucket(path, bucket) {
  if (OBJECT_FILTERED_PATHS.includes(path) && bucket === 'object') return 'excluded_by_policy';
  return VOCABULARY[path].includes(bucket) ? 'in_vocabulary' : 'unrecognized';
}

// Positional cap shared by C-4 and C-5. The window is taken over the SAME candidate list
// the current assembler ranks — that is, in-vocabulary and unrecognized alike, with only
// the pre-existing object filter applied first. Compat then renders the whole window and
// live renders the window minus its unrecognized members.
//
// Why the cap is positional rather than applied after the vocabulary filter: filtering
// unrecognized attributes out first would let a recognized attribute at candidate position
// 21 be promoted into live and rendered when the baseline never rendered it. That is an
// ADDITION to projector output, and ruled item 4 in the header forbids one absolutely —
// R-27's approved set consists of absences. C-4's and C-5's bounds are unchanged, so the
// window must be the baseline's window.
//
// (An earlier revision justified this by citing plan §6's "by construction" claim about the
// live/compat delta. That claim is false in general — see header item 2 — so the rule now
// rests on the withhold-only invariant, which the comparator independently enforces.)
function _capWindow(ranked, bound) {
  return { window: ranked.slice(0, bound), tail: ranked.slice(bound) };
}

// ── C-1 / C-2 / C-3 — player attributes ───────────────────────────────────────
// Current behavior reproduced: one line, non-object buckets, C-1's age filter with the
// null-turn_set exemption, joined `bucket:value` in STORAGE order (F-5, F-6, R-18).
// New behavior: per-category count bounds, and unrecognized buckets excluded from live.
function _buildPlayer(gameState, curTurn, ctx) {
  const player = gameState.player;
  const attrs = player?.attributes ? Object.values(player.attributes) : [];
  const keys  = player?.attributes ? Object.keys(player.attributes)  : [];

  const staged = [];   // storage order, one per attribute
  const byCategory = { 'C-1': [], 'C-2': [], 'C-3': [] };

  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const bucket = attr ? attr.bucket : undefined;
    const verdict = _classifyBucket('player', bucket);
    const rec = {
      attr,
      key: keys[i],
      bucket: bucket ?? null,
      value: _coerceInterpolated(attr ? attr.value : undefined),
      turnSet: _lifecycleEvidence(attr).turnSet,
      storageIndex: i,
      reason: null,
      category: null,
    };

    if (verdict === 'excluded_by_policy') {
      rec.reason = REASON.BUCKET_EXCLUDED;          // excluded from both renders
    } else if (verdict === 'unrecognized') {
      rec.reason = REASON.UNRECOGNIZED_BUCKET;      // compat includes, live excludes
    } else {
      rec.category = (bucket === 'state') ? 'C-1' : (bucket === 'physical') ? 'C-2' : 'C-3';
      byCategory[rec.category].push(rec);
    }
    staged.push(rec);
  }

  // C-1 age rule. F-6: `turn_set == null` is EXEMPT from suppression and stays live —
  // U-9 forbids changing that. Ages 6-20 are memory (age_beyond_window, charter revision
  // 10); past the terminal horizon they are retired.
  const p1 = CATEGORY_POLICY['C-1'];
  const ageSurvivors = [];
  let stateAttrsSuppressed = 0;
  for (const rec of byCategory['C-1']) {
    if (rec.turnSet === null) { ageSurvivors.push(rec); continue; }
    const age = curTurn - rec.turnSet;
    if (age <= p1.ageWindow) { ageSurvivors.push(rec); continue; }
    // R-20 / V-26: this counter reflects AGE-RULE exclusions and nothing else. Bound
    // exclusions below are accounted separately in diagnostics.boundExclusions. Folding
    // them in here would silently change a documented diagnostic.
    stateAttrsSuppressed++;
    rec.reason = (age > p1.terminalHorizon) ? REASON.AGE_BEYOND_HORIZON : REASON.AGE_BEYOND_WINDOW;
  }

  // Count bounds.
  //
  // Live reason, ruled: `age_within_window` applies to a C-1 fact that was actually TESTED
  // against the age window and passed. A fact with a null or absent `turn_set` is EXEMPT
  // from that test (F-6) — it was never measured against the window, so calling it "within"
  // the window states something that was never evaluated. Such a fact takes `in_bound`:
  // it survived the bound that actually applied to it. C-2 and C-3 have no age gate and
  // take `in_bound` throughout.
  const boundExclusions = { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0 };
  const applyBound = (list, cat, liveReasonFor, counterKey) => {
    const ranked = _rankByLifecycle(list.map(r => ({ attr: r.attr, rec: r })));
    const bound = CATEGORY_POLICY[cat].bound;
    for (let i = 0; i < ranked.length; i++) {
      const rec = ranked[i].rec;
      if (i < bound) {
        rec.reason = liveReasonFor(rec);
      } else {
        rec.reason = REASON.OVERFLOW_CAPACITY;
        boundExclusions[counterKey]++;
      }
    }
  };
  applyBound(ageSurvivors,      'C-1', rec => (rec.turnSet === null ? REASON.IN_BOUND : REASON.AGE_WITHIN_WINDOW), 'c1');
  applyBound(byCategory['C-2'], 'C-2', () => REASON.IN_BOUND, 'c2');
  applyBound(byCategory['C-3'], 'C-3', () => REASON.IN_BOUND, 'c3');

  // Emit in STORAGE order — R-18: the `You:` line renders survivors in storage order
  // across all three categories, which interleaves buckets exactly as today.
  const entries = staged.map(rec => _entry({
    category:       rec.category,
    subjectKey:     null,
    key:            rec.key,
    value:          rec.value,
    bucket:         rec.bucket,
    turnSet:        rec.turnSet,
    rendered:       (rec.reason === REASON.IN_BOUND || rec.reason === REASON.AGE_WITHIN_WINDOW),
    renderedCompat: COMPAT_INCLUDED_REASONS.has(rec.reason),
    reason:         rec.reason,
    lineKey:        'you',
  }));

  if (ctx) ctx.stateAttrsSuppressed = stateAttrsSuppressed;
  return { entries, stateAttrsSuppressed, boundExclusions };
}

// ── C-7 — player identity (current-state authority passthrough) ───────────────
// Carried, not managed (R-14). Four-field guard, fallback order, part order and labels
// preserved exactly (F-14, U-6). The Arbiter owns these fields; this only formats them.
function _buildIdentity(gameState) {
  const pid = gameState.player?.identity;
  if (!pid || !(pid.canonical_name || pid.title_or_role || pid.current_form || pid.last_known_form)) {
    return { entry: null, line: null };
  }
  const parts = [];
  if (pid.canonical_name) parts.push(`canonical name: ${pid.canonical_name}`);
  if (pid.title_or_role)  parts.push(`title: ${pid.title_or_role}`);
  const activeForm = pid.current_form || pid.last_known_form;   // F-14 fallback
  if (activeForm)         parts.push(`current form: ${activeForm}`);
  const line = `Player: ${parts.join(' | ')}`;
  return {
    line,
    entry: _entry({
      category: 'identity', subjectKey: null, key: null, value: line,
      bucket: null, turnSet: null, rendered: true, renderedCompat: true,
      reason: REASON.CARRIED_PASSTHROUGH, lineKey: 'identity',
    }),
  };
}

// ── C-4 — NPC attributes ──────────────────────────────────────────────────────
// Per-NPC top-20 by turn_set desc, unchanged (F-9, U-3). The label and the recognition
// suffix are authority passthrough rendering inside the same line (R-15, F-15, F-19).
function _buildNpcs(visible) {
  const entries = [];
  let boundExclusions = 0;

  for (const npc of visible) {
    const id = npc.id;
    const lineKey = `npc:${id}`;

    // F-19 label rule, preserved verbatim (:1968): npc_name only once is_learned.
    // The label entry is pushed AFTER the attribute pass, because its rendered flags must
    // record whether a line was actually emitted — see the emission computation below.
    const label = (npc.is_learned && npc.npc_name)
      ? `${npc.npc_name} (${npc.id})`
      : `${npc.job_category || 'person'} (${npc.id})`;
    const labelEntryIndex = entries.length;
    entries.push(null);   // placeholder, filled in below once emission is known

    const attrs = npc.attributes ? Object.values(npc.attributes) : [];
    const keys  = npc.attributes ? Object.keys(npc.attributes)  : [];

    const candidates = [];
    for (let i = 0; i < attrs.length; i++) {
      const attr = attrs[i];
      const bucket = attr ? attr.bucket : undefined;
      const verdict = _classifyBucket('npc', bucket);
      const rec = {
        attr, key: keys[i], bucket: bucket ?? null,
        value: _coerceJoined(attr ? attr.value : undefined),
        turnSet: _lifecycleEvidence(attr).turnSet,
        verdict,
      };
      if (verdict === 'excluded_by_policy') {
        // Never a candidate — the current assembler filters it before sorting (:1970).
        entries.push(_entry({
          category: null, subjectKey: id, key: rec.key, value: rec.value,
          bucket: rec.bucket, turnSet: rec.turnSet, rendered: false, renderedCompat: false,
          reason: REASON.BUCKET_EXCLUDED, lineKey,
        }));
        continue;
      }
      candidates.push(rec);
    }

    const ranked = _rankByLifecycle(candidates.map(r => ({ attr: r.attr, rec: r })));
    const { window, tail } = _capWindow(ranked, CATEGORY_POLICY['C-4'].bound);

    for (const r of window) {
      const rec = r.rec;
      const unrecognized = (rec.verdict === 'unrecognized');
      entries.push(_entry({
        category:       unrecognized ? null : 'C-4',
        subjectKey:     id, key: rec.key, value: rec.value,
        bucket:         rec.bucket, turnSet: rec.turnSet,
        rendered:       !unrecognized,
        renderedCompat: true,                    // inside the baseline's window either way
        reason:         unrecognized ? REASON.UNRECOGNIZED_BUCKET : REASON.IN_BOUND,
        lineKey,
      }));
    }
    for (const r of tail) {
      const rec = r.rec;
      const unrecognized = (rec.verdict === 'unrecognized');
      if (!unrecognized) boundExclusions++;
      entries.push(_entry({
        category:       unrecognized ? null : 'C-4',
        subjectKey:     id, key: rec.key, value: rec.value,
        bucket:         rec.bucket, turnSet: rec.turnSet,
        rendered:       false,
        renderedCompat: false,                   // outside the baseline's window
        reason:         unrecognized ? REASON.UNRECOGNIZED_BUCKET : REASON.OVERFLOW_CAPACITY,
        lineKey,
      }));
    }

    // F-15 recognition suffix, including its leading ' | '. The `.slice(3)` form used when
    // the NPC has no attributes is applied at render, not here, so the stored value stays
    // one thing.
    const rec = npc.player_recognition;
    const hasRecognition = !!(rec?.recognizes_player && rec.known_identity);
    if (hasRecognition) {
      entries.push(_entry({
        category: 'recognition', subjectKey: id, key: null,
        value: ` | recognizes-player: ${rec.known_identity} (since T-${rec.learned_turn})`,
        bucket: null, turnSet: null, rendered: true, renderedCompat: true,
        reason: REASON.CARRIED_PASSTHROUGH, lineKey,
      }));
    }

    // Line emission, per mode. Reproduces :1980 — an NPC with neither attributes nor
    // recognition emits no line — and the test is on the JOINED string, so a single
    // attribute whose value coerces to empty also skips.
    //
    // The label's rendered flags record ACTUAL EMISSION rather than being set true on
    // sight. A label marked rendered for an NPC that produced no line makes the archive
    // assert output that does not exist, which R-24/V-32 accounting cannot tolerate. The
    // renderer keys off these flags, so flag and output agree by construction rather than
    // by two copies of the same rule staying in step.
    const joinFor = (flag) => window
      .map(r => r.rec)
      .filter(r => (flag === 'compat') ? true : r.verdict !== 'unrecognized')
      .map(r => r.value)
      .join(' | ');
    entries[labelEntryIndex] = _entry({
      category: 'label', subjectKey: id, key: null, value: label,
      bucket: null, turnSet: null,
      rendered:       !!(joinFor('live')   || hasRecognition),
      renderedCompat: !!(joinFor('compat') || hasRecognition),
      reason: REASON.CARRIED_PASSTHROUGH, lineKey,
    });
  }

  return { entries, boundExclusions };
}

// ── C-5 — location / environment attributes ───────────────────────────────────
// Rank top-20, dedup WITHIN those 20 by canonical key, NO backfill (F-11, U-4).
//
// V-23 / V-31, the single most likely defect in this file: render order is FIRST-APPEARANCE
// ORDER OF CANONICAL KEYS, not turn_set descending over the surviving values. When the
// substring-replacement branch fires, the older richer value replaces the newer one IN THE
// SLOT THE NEWER FACT OCCUPIED, without repositioning. It looks like a bug. It is not.
// Sorting survivors "correctly" produces a different string than current code.
// The entry recorded as collapsed is the PREVIOUSLY-KEPT NEWER value, not the surviving
// older one (R-9, V-31).
function _dedupWithin(window) {
  const seen = new Map();   // canonical key -> slot index
  const slots = [];         // { rec, value } in first-appearance order
  const collapsed = [];     // records displaced by dedup, in the order they were displaced
  let collapsedCount = 0;

  for (const r of window) {
    const rec = r.rec;
    const val = rec.value;                       // already coerced per :2009
    const ckey = _toCanonicalEnv(val);
    if (!seen.has(ckey)) {
      seen.set(ckey, slots.length);
      slots.push({ rec, value: val });
    } else {
      const keptIdx = seen.get(ckey);
      const slot = slots[keptIdx];
      if (val.length > slot.value.length && val.includes(slot.value)) {
        // Older richer fact wins. The slot keeps its position; its occupant becomes the
        // incoming record, and the record displaced is the one previously kept.
        collapsed.push(slot.rec);
        slot.rec = rec;
        slot.value = val;
      } else {
        collapsed.push(rec);
      }
      collapsedCount++;
    }
  }
  return { slots, collapsed, collapsedCount };
}

function _buildLocation(locRecord, locLabel, locationKey) {
  // Guard reproduced from :1996 — the line is emitted whenever the guard passes.
  if (!locRecord || !locRecord.attributes || !Object.keys(locRecord.attributes).length) {
    return { entries: [], collapsedCount: 0, windowSize: 0, survivorCount: 0, boundExclusions: 0, present: false };
  }

  const lineKey = 'location';
  const entries = [];
  const attrs = Object.values(locRecord.attributes);
  const keys  = Object.keys(locRecord.attributes);

  // F-12: the C-5 path applies NO bucket filter. Every attribute is a candidate, including
  // bucket 'object'.
  const candidates = attrs.map((attr, i) => ({
    attr, key: keys[i], bucket: (attr ? attr.bucket : undefined) ?? null,
    value: _coerceLocation(attr ? attr.value : undefined),
    turnSet: _lifecycleEvidence(attr).turnSet,
    verdict: _classifyBucket('location', attr ? attr.bucket : undefined),
  }));

  const ranked = _rankByLifecycle(candidates.map(r => ({ attr: r.attr, rec: r })));
  const { window, tail } = _capWindow(ranked, CATEGORY_POLICY['C-5'].bound);
  const { slots, collapsed, collapsedCount } = _dedupWithin(window);

  // Location label — current-state authority passthrough (R-8, F-19).
  //
  // LIVE-ONLY EMPTY GUARD, ruled. The old assembler has no empty-guard here (unlike the NPC
  // path at :1980) and never needed one: it excluded nothing by vocabulary, so a location
  // holding any attribute always had something to print and an empty line was unreachable.
  // The projector introduces a state the old code cannot reach — attributes stored, none of
  // them in the live set — and mechanically preserving a rule into a state its author never
  // contemplated would emit a label with no fact after it. In live mode the line is
  // therefore omitted when no live attribute contributes, matching the NPC convention that
  // no content means no prefixed line.
  //
  // The guard keys on the LIVE CONTRIBUTOR COUNT, deliberately not on the joined string
  // being empty. A location attribute whose value coerces to '' (:2009) yields an empty
  // join today and the old assembler prints `[label]: ` for it — that state IS reachable in
  // current code, so it is existing behavior and must be preserved untouched. Only the
  // never-reachable zero-contributor case is guarded.
  //
  // Compat is unaffected and stays byte-identical to the baseline.
  const liveContributors = slots.filter(s => s.rec.verdict !== 'unrecognized').length;
  entries.push(_entry({
    category: 'label', subjectKey: locationKey, key: null, value: locLabel,
    bucket: null, turnSet: null,
    rendered:       liveContributors > 0,
    renderedCompat: true,
    reason: REASON.CARRIED_PASSTHROUGH, lineKey,
  }));

  // Survivors FIRST, in slot order — this is the render order (F-11).
  for (const slot of slots) {
    const rec = slot.rec;
    const unrecognized = (rec.verdict === 'unrecognized');
    entries.push(_entry({
      category:       unrecognized ? null : 'C-5',
      subjectKey:     locationKey, key: rec.key,
      value:          slot.value,               // the slot's surviving value
      bucket:         rec.bucket, turnSet: rec.turnSet,
      rendered:       !unrecognized,
      renderedCompat: true,
      reason:         unrecognized ? REASON.UNRECOGNIZED_BUCKET : REASON.IN_BOUND,
      lineKey,
    }));
  }

  // Then the elements that reach no output: collapsed, then beyond the window.
  for (const rec of collapsed) {
    const unrecognized = (rec.verdict === 'unrecognized');
    entries.push(_entry({
      category:       unrecognized ? null : 'C-5',
      subjectKey:     locationKey, key: rec.key, value: rec.value,
      bucket:         rec.bucket, turnSet: rec.turnSet,
      rendered:       false, renderedCompat: false,
      reason:         unrecognized ? REASON.UNRECOGNIZED_BUCKET : REASON.DUPLICATE_SUPPRESSED,
      lineKey,
    }));
  }
  let boundExclusions = 0;
  for (const r of tail) {
    const rec = r.rec;
    const unrecognized = (rec.verdict === 'unrecognized');
    if (!unrecognized) boundExclusions++;
    entries.push(_entry({
      category:       unrecognized ? null : 'C-5',
      subjectKey:     locationKey, key: rec.key, value: rec.value,
      bucket:         rec.bucket, turnSet: rec.turnSet,
      rendered:       false, renderedCompat: false,
      reason:         unrecognized ? REASON.UNRECOGNIZED_BUCKET : REASON.OVERFLOW_CAPACITY,
      lineKey,
    }));
  }

  return {
    entries, collapsedCount,
    windowSize: window.length,
    survivorCount: slots.length,
    boundExclusions,
    present: true,
  };
}

// ── C-6 — mood (auxiliary seam content) ───────────────────────────────────────
// Location-filtered including the `undefined`-key legacy exception, last 5, latest
// expanded to five labelled lines, prior entries reversed (F-13, U-5). The '—' field
// placeholders appear only inside those five lines and are classified WITH C-6 (R-8) —
// they cannot outlive the line they occupy.
function _buildMood(w, moodLocKey) {
  const moodHistory = w.mood_history || [];
  const filtered = moodHistory.filter(m => m.location_key === undefined || m.location_key === moodLocKey);
  const recent = filtered.slice(-MOOD_WINDOW);

  if (!recent.length) {
    return _entry({
      category: 'mood-absence', subjectKey: null, key: null, value: MK_NO_MOOD,
      bucket: null, turnSet: null, rendered: true, renderedCompat: true,
      reason: REASON.CARRIED_AUXILIARY, lineKey: 'mood',
    });
  }

  const body = [];
  const latest = recent[recent.length - 1];
  body.push(`tone: ${latest.tone || PLACEHOLDER}`);
  body.push(`tension: ${latest.tension_level || PLACEHOLDER} (${latest.tension_direction || PLACEHOLDER})`);
  body.push(`conversation: ${latest.conversational_state || PLACEHOLDER}`);
  body.push(`focus: ${latest.scene_focus || PLACEHOLDER}`);
  body.push(`shift: ${latest.delta_note || PLACEHOLDER}`);
  if (recent.length > 1) {
    body.push(FR_SEPARATOR);
    body.push(LB_TRAJECTORY);
    for (const snap of recent.slice(0, -1).reverse()) {
      body.push(`  T-${snap.turn}: ${snap.tone} / ${snap.tension_level} ${snap.tension_direction} / ${snap.delta_note}`);
    }
  }
  return _entry({
    category: 'C-6', subjectKey: null, key: null, value: body.join('\n'),
    bucket: null, turnSet: null, rendered: true, renderedCompat: true,
    reason: REASON.CARRIED_AUXILIARY, lineKey: 'mood',
  });
}

// ── C-8 — recent location (auxiliary, single-use) ─────────────────────────────
// L0 only, suppressed on cell-move and on any non-L0 layer (F-16, U-7). The clear is
// performed by project(), not here — see R-21 and the write table in §9 of the plan.
function _buildContext(w) {
  const ctxLoc = w._lastPhaseBLoc;
  const pos = w.position;
  const currentCellRef = pos ? `cell(${pos.mx},${pos.my}:${pos.lx},${pos.ly})` : null;
  const ctxIsMoved = ctxLoc && currentCellRef && ctxLoc.locationRef !== currentCellRef;
  const ctxAtL0 = !w.active_local_space && !w.active_site;
  if (!(ctxLoc && !ctxIsMoved && ctxAtL0 && Array.isArray(ctxLoc.features) && ctxLoc.features.length > 0)) {
    return null;
  }
  return _entry({
    category: 'C-8', subjectKey: null, key: null,
    value: `[${ctxLoc.locationRef} — prior position]: ${ctxLoc.features.join(' | ')}`,
    bucket: null, turnSet: null, rendered: true, renderedCompat: true,
    reason: REASON.CARRIED_AUXILIARY, lineKey: 'context',
  });
}

// ── Packet construction ───────────────────────────────────────────────────────
function _buildPacket(gameState, turnContext, opts) {
  const shadow = opts.shadow === true;
  const w = gameState.world || {};
  const loc = w.active_local_space || w.active_site;
  // L0 fallback: env features are promoted to the cell record, not active_site/local_space.
  const locRecord = loc || _getL0CellRecord(gameState);
  const locLabel = locRecord
    ? (locRecord.name || (w.position ? `cell(${w.position.mx},${w.position.my}:${w.position.lx},${w.position.ly})` : 'location'))
    : 'location';

  // R-32 / V-42: the `w._visible_npcs` fallback is the route by which a founding-prompt NPC
  // created at L0 on turn 1 reaches the TRUTH block. It must not be simplified out.
  const visible = (loc && loc._visible_npcs) || w._visible_npcs || [];

  // R-7: the current turn comes from turn_history.length + 1 and from no substitute source.
  const curTurn = (gameState.turn_history?.length || 0) + 1;

  const moodLocKey = w.active_local_space?.local_space_id
    || w.active_site?.site_id
    || (w.position ? `LOC:${w.position.mx},${w.position.my}:${w.position.lx},${w.position.ly}` : null);

  const entries = [];

  // WRITE 1 of 4 (plan §9): turnContext.stateAttrsSuppressed, during build, suppressed in
  // shadow. Age-rule exclusions only.
  const playerPart = _buildPlayer(gameState, curTurn, shadow ? null : turnContext);
  entries.push(...playerPart.entries);

  const identityPart = _buildIdentity(gameState);
  if (identityPart.entry) entries.push(identityPart.entry);

  const npcPart = _buildNpcs(visible);
  entries.push(...npcPart.entries);

  // F-18: this marker ASSERTS A WORLD FACT derived from engine state, so it is
  // current-state authority passthrough, not framing (R-8), and is omitted on failure.
  if (visible.length === 0) {
    entries.push(_entry({
      category: 'npc-absence', subjectKey: null, key: null, value: MK_NPC_ABSENT,
      bucket: null, turnSet: null, rendered: true, renderedCompat: true,
      reason: REASON.CARRIED_PASSTHROUGH, lineKey: 'npc-absence',
    }));
  }

  const locPart = _buildLocation(locRecord, locLabel, moodLocKey);
  entries.push(...locPart.entries);

  entries.push(_buildMood(w, moodLocKey));

  const contextEntry = _buildContext(w);
  if (contextEntry) entries.push(contextEntry);

  // WRITE 4 of 4 (plan §9): the [CB-DEDUP] console line, format unchanged (R-25, F-20).
  // Suppressed in shadow.
  if (!shadow && locPart.collapsedCount > 0) {
    console.log(`[CB-DEDUP] env_dedup_collapsed location="${locLabel}" turn=${turnContext?.turn ?? '?'} original=${locPart.windowSize} kept=${locPart.survivorCount} collapsed=${locPart.collapsedCount}`);
  }

  // Framing (R-8, F-17). Emitted unconditionally and drawn from nothing — except the
  // CONTEXT trio, which delimits C-8 and cannot exist without it, and the empty-scene
  // marker, whose emission is content-conditioned and therefore decided at render.
  const framing = [
    _framing(FR_TRUTH_HEADER, 'truth_header'),
    _framing(FR_TRUTH_RULE,   'truth_rule'),
    _framing(FR_NO_PROMOTED,  'truth_empty_marker'),
    _framing(FR_SEPARATOR,    'section_separator'),
    _framing(FR_MOOD_HEADER,  'mood_header'),
    _framing(FR_MOOD_RULE,    'mood_rule'),
  ];
  if (contextEntry) {
    framing.push(_framing(FR_SEPARATOR,     'context_separator'));
    framing.push(_framing(FR_CONTEXT_HEADER,'context_header'));
    framing.push(_framing(FR_CONTEXT_RULE,  'context_rule'));
  }

  const boundExclusions = {
    c1: playerPart.boundExclusions.c1,
    c2: playerPart.boundExclusions.c2,
    c3: playerPart.boundExclusions.c3,
    c4: npcPart.boundExclusions,
    c5: locPart.boundExclusions,
  };

  const visibleNpcIds = [];
  for (const npc of visible) {
    if (npc && npc.id !== undefined && npc.id !== null) visibleNpcIds.push(String(npc.id));
  }
  visibleNpcIds.sort();

  return {
    version: PROJECTOR_VERSION,
    turn: curTurn,
    scene: {
      locationKey: moodLocKey,
      visibleNpcIds,
    },
    entries,
    framing,
    diagnostics: {
      stateAttrsSuppressed: playerPart.stateAttrsSuppressed,
      boundExclusions,
      dedupCollapsed: locPart.collapsedCount,
      // R-31 / INV-17: the visible-NPC count is contract-dependent (U-1). It is RECORDED
      // every turn rather than checked against an asserted threshold.
      visibleNpcCount: visible.length,
      droppedCount: entries.reduce((n, e) => n + (e.class === 'dropped' ? 1 : 0), 0),
    },
    identityLine: identityPart.line,
  };
}

// ── Composition ───────────────────────────────────────────────────────────────
// PURE: same packet and mode in, same lines and manifest out; no reads of gameState, no
// writes anywhere.
//
// Produces BOTH the rendered lines and a structured LINE MANIFEST describing what was
// emitted and which entries contributed. The manifest exists because plan §6 asserts the
// live/compat delta is "by construction" exactly the entries carrying an approved exclusion
// reason, and that assertion is FALSE: withholding an entry can also change whether a whole
// line exists, and can trigger the content-conditioned empty marker. Those consequences are
// invisible to an entry-level comparison and equally invisible to the compat-vs-baseline
// byte check, which never looks at the live render at all.
//
// The manifest is derived from the composition the renderer already performs, so the gate
// can reason about structure WITHOUT PARSING RENDERED PROSE — the thing plan §6 rules out,
// because C-4 and C-5 render bare values and `You:` values may contain '|' or ':'.
//
// Composition performs NO SORTING. `entries` is already in render order and all ordering
// decisions were made during build under R-6 and R-18 (V-23).
function _compose(packet, mode) {
  const flag = (mode === 'compat') ? 'renderedCompat' : 'rendered';
  const entries = (packet && Array.isArray(packet.entries)) ? packet.entries : [];

  const fr = {};
  if (packet && Array.isArray(packet.framing)) {
    for (const f of packet.framing) if (f) fr[f.position] = f.text;
  }
  const F = (position, fallback) => (fr[position] !== undefined ? fr[position] : fallback);

  const manifest = [];
  const record = (lineKey, kind, emitted, contributors, structural) => {
    manifest.push({ lineKey, kind, emitted, contributors: contributors || [], structural: structural === true });
  };

  // ── group the entries; a single ordered walk, no reordering ──
  const you = [];
  const youIdx = [];
  let identityLine = null;
  const identityIdx = [];
  const npcOrder = [];
  const npcGroups = new Map();     // lineKey -> { label, attrs: [], suffix: '', idx: [] }
  let npcAbsence = null;
  const npcAbsenceIdx = [];
  let locationPresent = false;
  let locationLabel = null;
  const locationVals = [];
  const locationIdx = [];
  let moodBody = null;
  const moodIdx = [];
  let contextBody = null;
  const contextIdx = [];

  const npcGroup = (lineKey) => {
    let g = npcGroups.get(lineKey);
    if (!g) { g = { label: null, attrs: [], suffix: '', idx: [] }; npcGroups.set(lineKey, g); npcOrder.push(lineKey); }
    return g;
  };

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    const on = (e[flag] === true);
    const lineKey = e.lineKey;

    if (lineKey === 'you') {
      if (on) { you.push(`${e.bucket}:${e.value}`); youIdx.push(i); }
    } else if (lineKey === 'identity') {
      if (on) { identityLine = e.value; identityIdx.push(i); }
    } else if (typeof lineKey === 'string' && lineKey.startsWith('npc:')) {
      const g = npcGroup(lineKey);
      if (e.category === 'label') { if (on) { g.label = e.value; g.idx.push(i); } }
      else if (e.category === 'recognition') { if (on) { g.suffix = e.value; g.idx.push(i); } }
      else if (on) { g.attrs.push(e.value); g.idx.push(i); }
    } else if (lineKey === 'npc-absence') {
      if (on) { npcAbsence = e.value; npcAbsenceIdx.push(i); }
    } else if (lineKey === 'location') {
      if (e.category === 'label') { if (on) { locationPresent = true; locationLabel = e.value; locationIdx.push(i); } }
      else if (on) { locationVals.push(e.value); locationIdx.push(i); }
    } else if (lineKey === 'mood') {
      if (on) { moodBody = e.value; moodIdx.push(i); }
    } else if (lineKey === 'context') {
      if (on) { contextBody = e.value; contextIdx.push(i); }
    }
  }

  // ── assemble, in the section order current source emits ──
  const lines = [];
  lines.push(F('truth_header', FR_TRUTH_HEADER));
  record('truth_header', 'framing', true);
  lines.push(F('truth_rule',   FR_TRUTH_RULE));
  record('truth_rule', 'framing', true);

  let truthLines = 0;

  if (you.length > 0) {
    lines.push(`You: ${you.join(' | ')}`);
    truthLines++;
  }
  record('you', 'content', you.length > 0, youIdx);

  if (identityLine !== null) {
    lines.push(identityLine);
    truthLines++;
  }
  record('identity', 'content', identityLine !== null, identityIdx);

  for (const lineKey of npcOrder) {
    const g = npcGroups.get(lineKey);
    const attrs = g.attrs.join(' | ');
    // :1980 — an NPC with neither attributes nor recognition emits no line. Build already
    // applied this rule when setting the label's rendered flags, so the label's presence in
    // this mode IS the emission decision; keying off it keeps flag and output in agreement
    // by construction rather than by two copies of the same rule.
    const emitted = (g.label !== null);
    if (emitted) {
      const truth = attrs ? `${attrs}${g.suffix}` : g.suffix.slice(3);   // :1981 leading ' | ' stripped
      lines.push(`${g.label}: ${truth}`);
      truthLines++;
    }
    record(lineKey, 'content', emitted, g.idx);
  }

  if (npcAbsence !== null) {
    lines.push(npcAbsence);
    truthLines++;
  }
  record('npc-absence', 'content', npcAbsence !== null, npcAbsenceIdx);

  if (locationPresent) {
    lines.push(`[${locationLabel}]: ${locationVals.join(' | ')}`);
    truthLines++;
  }
  record('location', 'content', locationPresent, locationIdx);

  // Content-conditioned framing: emission depends on how much truth content rendered, so it
  // is decided here rather than fixed at build. Marked `structural` so the gate can tell a
  // consequence apart from a primary difference.
  const emptyMarker = (truthLines === 0);
  if (emptyMarker) {
    lines.push(F('truth_empty_marker', FR_NO_PROMOTED));
  }
  record('truth_empty_marker', 'framing', emptyMarker, [], true);

  lines.push(F('section_separator', FR_SEPARATOR));
  record('section_separator', 'framing', true);
  lines.push(F('mood_header', FR_MOOD_HEADER));
  record('mood_header', 'framing', true);
  lines.push(F('mood_rule',   FR_MOOD_RULE));
  record('mood_rule', 'framing', true);
  if (moodBody !== null) lines.push(moodBody);
  record('mood', 'content', moodBody !== null, moodIdx);

  if (contextBody !== null) {
    lines.push(F('context_separator', FR_SEPARATOR));
    lines.push(F('context_header',    FR_CONTEXT_HEADER));
    lines.push(F('context_rule',      FR_CONTEXT_RULE));
    lines.push(contextBody);
  }
  record('context_separator', 'framing', contextBody !== null);
  record('context_header',    'framing', contextBody !== null);
  record('context_rule',      'framing', contextBody !== null);
  record('context', 'content', contextBody !== null, contextIdx);

  return { lines, manifest };
}

// ── Render ────────────────────────────────────────────────────────────────────
// PURE (plan §3.2, S-P2): same packet and options in, same string out; no reads of
// gameState, no writes anywhere. Three callers depend on this property — the live path,
// shadow comparison, and last-good replay. Thin wrapper over _compose so that the string
// the narrator receives and the manifest the gate inspects can never disagree: they are
// two products of one composition, not two computations of the same thing.
function renderPacket(packet, options) {
  const mode = (options && options.mode === 'compat') ? 'compat' : 'live';
  return _compose(packet, mode).lines.join('\n');
}

// ── Failure path ──────────────────────────────────────────────────────────────
// R-19 and plan §8. Last-good comes from the ARCHIVE — turn_history's continuity_packet
// envelopes — not from a cache or a new gameState field, either of which would be a fifth
// write and therefore S-8. This is a READ, not a write.
//
// Failure replay is not a category policy: it selects nothing, disposes nothing, and
// derives no verdict. It reproduces a prior verdict wholesale, so F-5's "no history as
// input" sink rule is untouched.
function _findLastGood(gameState) {
  const history = gameState && Array.isArray(gameState.turn_history) ? gameState.turn_history : [];
  for (let i = history.length - 1; i >= 0; i--) {
    const rec = history[i];
    const env = rec && rec.continuity_packet;
    // ok === true only. A failed or framing-only record must not be replayed as good.
    if (env && env.ok === true && env.packet && Array.isArray(env.packet.entries)) {
      return { packet: env.packet, turn: env.packet.turn ?? (rec.turn_number ?? null) };
    }
  }
  return null;
}

function _buildFailurePacket(gameState, stage) {
  const lastGood = _findLastGood(gameState);
  const replayCategories = ['C-1', 'C-2', 'C-3'];
  const entries = [];
  const categoriesReplayed = [];

  if (lastGood) {
    for (const e of lastGood.packet.entries) {
      // Only managed C-1/C-2/C-3. C-4 and C-5 are bound to the currently visible NPCs and
      // the current location and their subject labels are authority-owned, so they are
      // discarded along with all auxiliary and all passthrough content.
      if (!e || e.class !== 'managed') continue;
      if (!replayCategories.includes(e.category)) continue;
      entries.push({
        class: 'managed', category: e.category, subjectKey: null, key: e.key ?? null,
        value: e.value, bucket: e.bucket ?? null, turnSet: e.turnSet ?? null,
        disposition: e.disposition ?? null,
        rendered: e.rendered === true,
        reason: e.reason,
        renderedCompat: e.rendered === true,
        lineKey: 'you',
      });
      if (e.rendered === true && !categoriesReplayed.includes(e.category)) categoriesReplayed.push(e.category);
    }
  }

  // Framing is emitted normally on failure (R-8). Auxiliary and passthrough are not, so
  // there is no CONTEXT trio and no mood body — the MOOD section is its header and rule.
  const framing = [
    _framing(FR_TRUTH_HEADER, 'truth_header'),
    _framing(FR_TRUTH_RULE,   'truth_rule'),
    _framing(FR_NO_PROMOTED,  'truth_empty_marker'),
    _framing(FR_SEPARATOR,    'section_separator'),
    _framing(FR_MOOD_HEADER,  'mood_header'),
    _framing(FR_MOOD_RULE,    'mood_rule'),
  ];

  categoriesReplayed.sort();
  return {
    packet: {
      version: PROJECTOR_VERSION,
      turn: (gameState?.turn_history?.length || 0) + 1,
      scene: { locationKey: null, visibleNpcIds: [] },
      entries,
      framing,
      diagnostics: {
        stateAttrsSuppressed: 0,
        boundExclusions: { c1: 0, c2: 0, c3: 0, c4: 0, c5: 0 },
        dedupCollapsed: 0,
        visibleNpcCount: 0,
        droppedCount: 0,
      },
      identityLine: null,
    },
    replayedFrom: lastGood ? lastGood.turn : null,
    categoriesReplayed,
    stage,
  };
}

function _errMessage(err) {
  const raw = (err && err.message) ? String(err.message) : String(err);
  return raw.slice(0, 200);
}

// ── project() ─────────────────────────────────────────────────────────────────
// The single entry point (R-4, INV-11). IT NEVER THROWS: any error inside packet
// construction or render is caught, converted into a failure projection per R-19, and
// returned. That is what satisfies "the failure does not abort the turn" (F-29) without
// index.js acquiring failure-policy logic, which INV-13 forbids.
//
// options.shadow === true SUPPRESSES ALL FOUR WRITES — no diagnostic passback, no identity
// breadcrumb, no single-use clear, no console dedup line. Required by plan §6: the
// read-only-first ordering is the whole shadow mechanism.
function project(gameState, turnContext, options) {
  // SHADOW DETERMINATION, CONTAINED — ruled. Two requirements conflict at the hostile-input
  // edge: §9 suppresses the breadcrumb write in shadow mode, so the flag must be read before
  // the write can be decided; and V-29 wants the reset before anything that can throw.
  // Reading a property off an arbitrary object can theoretically throw, so the two cannot
  // both hold literally. The ruling: shadow determination may precede the reset provided it
  // CANNOT ESCAPE, and on every non-shadow call the reset remains the first state mutation
  // and precedes construction. A read that throws degrades to shadow = false, which fails
  // toward performing the reset — the safe direction, since the hazard being guarded against
  // is a STALE value surviving, not an extra null.
  let shadow = false;
  try { shadow = (options != null && options.shadow === true); } catch (_) { shadow = false; }

  // WRITE 2 of 4 (plan §9): the identity breadcrumb reset — the first state mutation.
  // F-21 records the live defect it fixes: in current source the reset sits below the
  // player-attribute block, so a throw above it leaves the previous turn's value in
  // gameState, which index.js:8731 then emits in the HTTP response. R-22 puts the contract
  // on the STORED FIELD, not merely on what is emitted.
  if (!shadow && gameState) {
    try { gameState._lastIdentityTruthLine = null; } catch (_) { /* non-extensible state */ }
  }

  let packet = null;
  let stage = 'build';
  try {
    packet = _buildPacket(gameState, turnContext, { shadow });

    // WRITE 3 of 4 (plan §9): the single-use clear, AFTER SUCCESSFUL PACKET CONSTRUCTION —
    // and deliberately BEFORE render. R-21 and INV-16 place the boundary at construction,
    // not at render: the failure model distinguishes a build failure from a render failure
    // precisely because they are different events, and a render-stage failure must not
    // leave the content uncleared as though construction had failed. Still cleared when the
    // content was suppressed — suppression is a successful projection in which the content
    // was deliberately not rendered (F-16). Not cleared on construction failure: that path
    // never reaches this line.
    if (!shadow) {
      const w = gameState && gameState.world;
      if (w) w._lastPhaseBLoc = null;
    }

    stage = 'render';
    const rendered = renderPacket(packet, { mode: 'live' });

    // WRITE 2 of 4, second half: set to the rendered Player: line, byte-identical (R-33).
    // Kept after render so the stored value is only ever a line that actually rendered; on
    // a render failure the field stays null from the reset above, satisfying R-22.
    if (!shadow && gameState && packet.identityLine !== null) {
      gameState._lastIdentityTruthLine = packet.identityLine;
    }

    return { rendered, packet, failure: null };
  } catch (err) {
    // R-19: replay last-good for C-1/C-2/C-3; omit C-4, C-5, auxiliary and passthrough;
    // emit framing. The turn continues.
    let rendered = '';
    let failure;
    try {
      const fb = _buildFailurePacket(gameState, stage);
      rendered = renderPacket(fb.packet, { mode: 'live' });
      failure = {
        stage: fb.stage,
        message: _errMessage(err),
        replayedFrom: fb.replayedFrom,
        categoriesReplayed: fb.categoriesReplayed,
      };
    } catch (inner) {
      // The failure path itself failed. R-17 / F-23 still require a non-null string —
      // diagnostics.js treats null as "no data" and would silently disable
      // /diagnostics/continuity.
      rendered = [FR_TRUTH_HEADER, FR_TRUTH_RULE, FR_NO_PROMOTED, FR_SEPARATOR, FR_MOOD_HEADER, FR_MOOD_RULE].join('\n');
      failure = {
        stage,
        message: `${_errMessage(err)} | replay_failed: ${_errMessage(inner)}`.slice(0, 200),
        replayedFrom: null,
        categoriesReplayed: [],
      };
    }

    // The failure record has two parts with different jobs (R-19). This is the VISIBLE
    // half — immediate visibility, not storage. The persisted half is written by the
    // caller into turnObject.continuity_packet.failure and inherits the turn's existing
    // asynchronous, swallowed-failure persistence (amended INV-8). Suppressed in shadow so
    // a shadow run cannot emit operator noise for a turn that still succeeded.
    if (!shadow) {
      console.log(`[CP-FAIL] stage=${failure.stage} turn=${(gameState?.turn_history?.length || 0) + 1} replayed_from=${failure.replayedFrom ?? 'none'} categories=${failure.categoriesReplayed.join(',') || 'none'} message="${failure.message}"`);
    }

    return { rendered, packet, failure };
  }
}

// ── compareToBaseline() ───────────────────────────────────────────────────────
// The shadow comparator (plan §3.3, §6). It lives here rather than in index.js because
// deciding whether a difference is approved is classification logic, which R-1 confines to
// this file.
//
// TWO CONTRACTS, BOTH REQUIRED:
//   PURE  — no reads of gameState, no writes anywhere.
//   TOTAL — it never throws, for any input. It must accept packet: null, which project()
//           returns after an early construction failure, and must contain any error raised
//           by the compat render. A comparator that threw would reach index.js:8736, emit
//           narrator_error and abort the turn — a diagnostic must never be able to take
//           down narration.
//
// METHOD, TWO HALVES:
//
//   1. BYTE EQUALITY, compat vs baseline. The baseline string is NEVER PARSED. C-4 and C-5
//      render bare values with no bucket and no key, and `You:` values are freeform
//      narration that may contain '|' or ':', so any algorithm that extracts facts from the
//      baseline inherits that unsoundness. The packet is rendered a second time in 'compat'
//      mode and compared BYTE FOR BYTE. This proves the projector reads the same inputs and
//      selects, orders and formats them identically to the assembler it replaces.
//
//   2. STRUCTURAL CLASSIFICATION, compat vs live. Byte equality says nothing about the live
//      render, and plan §6's claim that the live/compat delta is "by construction" exactly
//      the withheld entries is FALSE: withholding entries can also delete a whole line or
//      trigger the content-conditioned empty marker. Those consequences are compared here
//      through the two LINE MANIFESTS — structure, not text — so the prohibition on parsing
//      rendered prose is preserved.
//
// The two halves answer different questions and neither substitutes for the other. A run is
// clean only when byte equality holds AND every structural consequence is approved.
function _classifyStructure(packet) {
  const entryAt = (i) => {
    const es = Array.isArray(packet.entries) ? packet.entries : [];
    return es[i] || null;
  };

  const compat = _compose(packet, 'compat').manifest;
  const live   = _compose(packet, 'live').manifest;
  const byKey = (m) => { const map = new Map(); for (const r of m) map.set(r.lineKey, r); return map; };
  const C = byKey(compat), L = byKey(live);

  const keys = [];
  for (const r of compat) if (!keys.includes(r.lineKey)) keys.push(r.lineKey);
  for (const r of live)   if (!keys.includes(r.lineKey)) keys.push(r.lineKey);

  const differences = [];
  const counts = { c1: 0, c2: 0, c3: 0, unrecognizedBucket: 0 };
  let lineLossApproved = true;

  for (const key of keys) {
    const c = C.get(key), l = L.get(key);
    const cIdx = c ? c.contributors : [];
    const lIdx = l ? l.contributors : [];
    const missing = cIdx.filter(i => !lIdx.includes(i));   // contributed to compat, not live
    const added   = lIdx.filter(i => !cIdx.includes(i));   // contributed to live, not compat
    const kind    = (c ? c.kind : l.kind);
    const cEmit   = !!(c && c.emitted), lEmit = !!(l && l.emitted);

    // Exclusion counts are computed from entries that GENUINELY contributed to compat and
    // not to live. Counting every entry carrying an approved reason over-reports: an
    // unrecognized C-4/C-5 attribute beyond the unchanged top-20 window renders in neither
    // mode and constitutes no difference at all.
    for (const i of missing) {
      const e = entryAt(i);
      if (!e) continue;
      if (e.reason === REASON.UNRECOGNIZED_BUCKET) counts.unrecognizedBucket++;
      else if (e.reason === REASON.OVERFLOW_CAPACITY) {
        if (e.category === 'C-1') counts.c1++;
        else if (e.category === 'C-2') counts.c2++;
        else if (e.category === 'C-3') counts.c3++;
      }
    }

    if (added.length > 0) {
      // Live may only ever withhold. Anything appearing in live that compat lacks is an
      // ADDITION, which no approved-difference rule permits.
      differences.push({ lineKey: key, kind, type: 'contributor_added', approved: false, reasons: [] });
      lineLossApproved = false;
      continue;
    }

    if (cEmit === lEmit) {
      if (missing.length === 0) continue;
      // Same line, fewer contributors. Approved when every missing contributor carries an
      // approved exclusion reason — vocabulary on any path, or a NEW bound on C-1/C-2/C-3.
      // overflow_capacity on C-4/C-5 is NOT approved: those bounds are unchanged, so an
      // entry displaced by them cannot differ between modes.
      const reasons = missing.map(i => (entryAt(i) || {}).reason);
      const approved = missing.every(i => {
        const e = entryAt(i); if (!e) return false;
        if (e.reason === REASON.UNRECOGNIZED_BUCKET) return true;
        return e.reason === REASON.OVERFLOW_CAPACITY && ['C-1', 'C-2', 'C-3'].includes(e.category);
      });
      if (!approved) lineLossApproved = false;
      differences.push({ lineKey: key, kind, type: 'contributors_withheld', approved, reasons });
      continue;
    }

    if (cEmit && !lEmit) {
      // A WHOLE LINE DISAPPEARED from live. Ruled approved (cases A, B and C) only when
      // every contributor whose loss CAUSED the removal was removed as
      // `unrecognized_bucket`. Bounds cannot produce this: 10/12/8 trim a category, they
      // never empty one.
      //
      // Passthrough contributors — the NPC or location label — are excluded from the causal
      // test. A label does not cause its line to vanish; it vanishes BECAUSE the line did.
      // The label's rendered flag IS the emission decision, so it always disappears
      // alongside the line, and counting its `carried_passthrough` reason as an unapproved
      // cause would reject every case A/B/C the user ruled approved.
      const reasons = missing.map(i => (entryAt(i) || {}).reason);
      const causal = missing.filter(i => {
        const e = entryAt(i);
        return !!e && e.reason !== REASON.CARRIED_PASSTHROUGH && e.reason !== REASON.CARRIED_AUXILIARY;
      });
      const approved = causal.length > 0 && causal.every(i => {
        const e = entryAt(i);
        return !!e && e.reason === REASON.UNRECOGNIZED_BUCKET;
      });
      if (!approved) lineLossApproved = false;
      differences.push({ lineKey: key, kind, type: 'line_removed', approved, reasons });
      continue;
    }

    // A line APPEARED in live. The only approved instance is the content-conditioned empty
    // marker (case D), and only as a downstream consequence of line losses that were
    // themselves approved. Its approval is resolved after the loop, once every other
    // difference has been judged, because that is exactly the causal chain it depends on.
    differences.push({
      lineKey: key, kind,
      type: (c && c.structural) || (l && l.structural) ? 'structural_marker_added' : 'line_added',
      approved: null, reasons: [],
    });
  }

  for (const d of differences) {
    if (d.approved !== null) continue;
    d.approved = (d.type === 'structural_marker_added' && d.lineKey === 'truth_empty_marker' && lineLossApproved);
  }

  return {
    approved: differences.every(d => d.approved === true),
    differences,
    exclusions: counts,
  };
}

function compareToBaseline(packet, baselineString) {
  const emptyExclusions = { c1: 0, c2: 0, c3: 0, unrecognizedBucket: 0 };
  const noStructure = { approved: false, differences: [] };
  let turn = null;
  try {
    if (packet && typeof packet.turn === 'number') turn = packet.turn;

    if (!packet) {
      return { turn, compatEqual: false, firstDiff: null, exclusions: emptyExclusions,
               structural: noStructure, error: 'no_packet' };
    }

    // Fails CLOSED: if structure cannot be classified, it is not approved.
    let structural = noStructure;
    let exclusions = emptyExclusions;
    try {
      const s = _classifyStructure(packet);
      structural = { approved: s.approved, differences: s.differences };
      exclusions = s.exclusions;
    } catch (_) { structural = noStructure; exclusions = emptyExclusions; }

    let compat;
    try {
      compat = renderPacket(packet, { mode: 'compat' });
    } catch (err) {
      return { turn, compatEqual: false, firstDiff: null, exclusions, structural, error: _errMessage(err) };
    }

    if (typeof baselineString !== 'string') {
      return { turn, compatEqual: false, firstDiff: null, exclusions, structural, error: 'no_baseline' };
    }

    if (compat === baselineString) {
      return { turn, compatEqual: true, firstDiff: null, exclusions, structural, error: null };
    }

    // Any inequality fails the gate. The report locates a defect for human diagnosis; it
    // does not adjudicate one.
    const bLines = baselineString.split('\n');
    const cLines = compat.split('\n');
    const n = Math.max(bLines.length, cLines.length);
    let firstDiff = null;
    for (let i = 0; i < n; i++) {
      if (bLines[i] !== cLines[i]) {
        firstDiff = {
          lineIndex: i,
          baseline: bLines[i] === undefined ? null : bLines[i],
          compat:   cLines[i] === undefined ? null : cLines[i],
        };
        break;
      }
    }
    return { turn, compatEqual: false, firstDiff, exclusions, structural, error: null };
  } catch (err) {
    // Final backstop. Totality is a contract, not an aspiration.
    return { turn, compatEqual: false, firstDiff: null, exclusions: emptyExclusions,
             structural: noStructure, error: _errMessage(err) };
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
// Four, and no others (plan §3.4). No per-category selector, no policy object, no
// disposition helper: exporting them would let a future caller assemble a packet outside
// project(), which is how INV-11's fixed projection point erodes. compareToBaseline is not
// such a hole — it CONSUMES a finished packet and cannot produce one.
module.exports = {
  PROJECTOR_VERSION,
  project,
  renderPacket,
  compareToBaseline,
};
