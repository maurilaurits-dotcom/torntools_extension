// Projects/torntools_extension/src/common/features/travel-radar/radar-core.ts
var COUNTRY_CODES = ["mex", "cay", "can", "haw", "uni", "arg", "swi", "jap", "chi", "uae", "sou"];
var COUNTRY_NAMES = {
  mex: "Mexico",
  cay: "Cayman Islands",
  can: "Canada",
  haw: "Hawaii",
  uni: "United Kingdom",
  arg: "Argentina",
  swi: "Switzerland",
  jap: "Japan",
  chi: "China",
  uae: "UAE",
  sou: "South Africa"
};
var STANDARD_MINUTES = {
  mex: 24,
  cay: 33,
  can: 39,
  haw: 127,
  uni: 151,
  arg: 158,
  swi: 166,
  jap: 213,
  chi: 229,
  uae: 257,
  sou: 282
};
var METHOD_FACTOR = { standard: 1, airstrip: 0.7, private: 0.5, business: 0.3 };
function toTravelMethod(method) {
  const lower = method?.toLowerCase();
  return lower && Object.hasOwn(METHOD_FACTOR, lower) ? lower : "standard";
}
function flightSeconds(country, method) {
  return Math.round(STANDARD_MINUTES[country] * 60 * METHOD_FACTOR[method]);
}
function isCountryCode(code) {
  return COUNTRY_CODES.includes(code);
}
var CHECK_SECONDS = 300;
var MAX_GAP_SECONDS = 3 * CHECK_SECONDS;
var STALE_SECONDS = 300;
var LAND_MARGIN = 60;
var LATE_GRACE = 60;
var CHECK_SLACK = 60;
var MIN_LEAVE_COOLDOWN = 600;
var SENT_TTL = 2 * 24 * 3600;
var MAX_FUTURE_SECONDS = 600;
var CONFIRMATIONS = 2;
var MIN_GLIMPSE_QUANTITY = 10;
var MAX_ITEM_ID = 99999;
var MAX_READINGS_PER_COUNTRY = 64;
var MAX_NAME_LENGTH = 48;
var MAX_ENTRIES = 800;
var ENTRY_TTL = 24 * 3600;
var MAX_PINGS_PER_CHECK = 3;
var MIN_GAPS = 3;
var MAX_CHAIN = 12;
var MAX_MAD_SHARE = 0.35;
var NEVER = Number.POSITIVE_INFINITY;
var MAX_GAPS = 15;
var MAX_REFILLS = 5;
var MAX_GAP_MINUTES = 24 * 60;
var MIN_RATE_MINUTES = 2;
var MERGED_GAP = 1.8;
var MAX_SEEN = 10;
var MIN_READ_ONCE = 2;
function percentile(values, p) {
  if (!values.length)
    throw new Error("percentile of an empty list");
  const sorted = [...values].sort((a, b) => a - b);
  const k = (sorted.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.min(f + 1, sorted.length - 1);
  return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}
function median(values) {
  return percentile(values, 0.5);
}
function itemKey(country, itemId) {
  return `${country}:${itemId}`;
}
function splitKey(key) {
  const match = /^([a-z]{3}):([1-9]\d{0,4})$/.exec(key);
  if (!match || !isCountryCode(match[1]))
    return null;
  return { country: match[1], itemId: Number(match[2]) };
}
function isCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function sanitizeSnapshot(raw, now) {
  const snapshot = {};
  if (!raw || typeof raw !== "object")
    return snapshot;
  for (const country of COUNTRY_CODES) {
    const block = raw[country];
    if (!block || typeof block.update !== "number" || !Number.isSafeInteger(block.update) || block.update > now + MAX_FUTURE_SECONDS)
      continue;
    if (!Array.isArray(block.stocks))
      continue;
    const stocks = [];
    for (const reading of block.stocks.slice(0, MAX_READINGS_PER_COUNTRY)) {
      if (!reading || typeof reading !== "object")
        continue;
      const { id, name, quantity, cost } = reading;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > MAX_ITEM_ID)
        continue;
      if (typeof name !== "string" || !isCount(quantity) || !isCount(cost))
        continue;
      stocks.push({
        id,
        name: name.replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, MAX_NAME_LENGTH),
        quantity,
        cost
      });
    }
    snapshot[country] = { update: block.update, stocks };
  }
  return snapshot;
}
function emptyTracker() {
  return { entries: {}, countrySeenAt: {} };
}
function emptyStat() {
  return { gapsMin: [], refills: [], soldOutAt: null, restockedAt: null, lastPhaseRate: null, inStockMin: [], skipGap: false, longGaps: 0, onceSeen: [] };
}
function emptyEntry() {
  return {
    inStock: null,
    lastAgreeAt: 0,
    pendingInStock: null,
    pendingSince: 0,
    pendingQuantity: 0,
    pendingCount: 0,
    quantity: 0,
    cost: null,
    costCandidate: null,
    name: ""
  };
}
function clearPending(entry) {
  return { ...entry, pendingInStock: null, pendingSince: 0, pendingQuantity: 0, pendingCount: 0 };
}
function takeLast(values, n) {
  return values.slice(Math.max(0, values.length - n));
}
function farOff(value, reference) {
  return reference > 0 && Math.abs(value - reference) * 2 > reference;
}
function withCost(entry, cost) {
  const known = entry.cost;
  const candidate = entry.costCandidate;
  if (known === null || !farOff(cost, known))
    return { ...entry, cost, costCandidate: null };
  if (candidate !== null && !farOff(cost, candidate))
    return { ...entry, cost, costCandidate: null };
  return null;
}
function step(entry, reading, at) {
  const priced = withCost(entry, reading.cost);
  if (!priced)
    return [{ ...entry, costCandidate: reading.cost }, null];
  const target = reading.quantity > 0;
  const base = { ...priced, quantity: reading.quantity, name: reading.name };
  if (base.inStock === target) {
    const isGlimpse = !target && base.pendingCount > 0 && base.pendingInStock === true && base.pendingQuantity >= MIN_GLIMPSE_QUANTITY;
    const glimpse = isGlimpse ? { type: "glimpsed", at: Math.floor((base.pendingSince + at) / 2), quantity: base.pendingQuantity } : null;
    return [clearPending({ ...base, lastAgreeAt: at }), glimpse];
  }
  const continuing = base.pendingCount > 0 && base.pendingInStock === target;
  const since = continuing ? base.pendingSince : at;
  const quantity = continuing ? base.pendingQuantity : reading.quantity;
  const count = continuing ? base.pendingCount + 1 : 1;
  if (count < CONFIRMATIONS) {
    return [{ ...base, pendingInStock: target, pendingSince: since, pendingQuantity: quantity, pendingCount: count }, null];
  }
  const transition = base.inStock !== null ? { type: target ? "restocked" : "soldOut", at: Math.floor((base.lastAgreeAt + since) / 2), quantity } : null;
  return [clearPending({ ...base, inStock: target, lastAgreeAt: at }), transition];
}
function ingest(state, snapshot, maxGapSeconds = MAX_GAP_SECONDS) {
  const entries = { ...state.entries };
  const seen = { ...state.countrySeenAt };
  const events = [];
  const gapCountries = [];
  for (const country of COUNTRY_CODES) {
    const block = snapshot[country];
    if (!block)
      continue;
    const last = seen[country];
    if (last !== undefined && block.update <= last)
      continue;
    if (last !== undefined && block.update - last > maxGapSeconds) {
      gapCountries.push(country);
      for (const id of Object.keys(entries).filter((id) => id.startsWith(`${country}:`))) {
        entries[id] = clearPending({ ...entries[id], inStock: null });
      }
    }
    for (const reading of block.stocks) {
      const key = itemKey(country, reading.id);
      const [next, transition] = step(entries[key] ?? emptyEntry(), reading, block.update);
      entries[key] = next;
      if (transition)
        events.push({ key, name: reading.name, ...transition });
    }
    seen[country] = block.update;
  }
  return { tracker: { entries, countrySeenAt: seen }, events, gapCountries };
}
function refillSize(stat) {
  return stat.refills.length ? Math.trunc(median(stat.refills)) : null;
}
function inStockMinutes(stat) {
  if (stat.inStockMin.length)
    return median(stat.inStockMin);
  const refill = refillSize(stat);
  const rate = stat.lastPhaseRate;
  if (refill === null || rate === null || rate <= 0)
    return null;
  return refill / rate;
}
function minutesSince(start, at) {
  if (start === null)
    return null;
  const minutes = (at - start) / 60;
  return minutes > 0 && minutes <= MAX_GAP_MINUTES ? minutes : null;
}
function phaseRate(stat, soldOutAt) {
  const refill = stat.refills.at(-1);
  if (stat.restockedAt === null || refill === undefined)
    return null;
  const minutes = (soldOutAt - stat.restockedAt) / 60;
  return minutes > 0 ? refill / minutes : null;
}
function onEvent(stat, event) {
  switch (event.type) {
    case "soldOut": {
      const phase = minutesSince(stat.restockedAt, event.at);
      return {
        ...stat,
        soldOutAt: event.at,
        skipGap: false,
        restockedAt: null,
        lastPhaseRate: phaseRate(stat, event.at) ?? stat.lastPhaseRate,
        inStockMin: phase !== null ? takeLast([...stat.inStockMin, phase], MAX_GAPS) : stat.inStockMin
      };
    }
    case "restocked": {
      const gap = stat.skipGap ? null : minutesSince(stat.soldOutAt, event.at);
      const long = gap !== null && stat.gapsMin.length >= MIN_GAPS && gap > MERGED_GAP * median(stat.gapsMin);
      const merged = long && stat.longGaps < 2;
      return {
        ...stat,
        gapsMin: gap !== null && !merged ? takeLast([...stat.gapsMin, gap], MAX_GAPS) : stat.gapsMin,
        longGaps: long ? stat.longGaps + 1 : gap !== null ? 0 : stat.longGaps,
        refills: takeLast([...stat.refills, event.quantity], MAX_REFILLS),
        soldOutAt: null,
        restockedAt: event.at,
        skipGap: false,
        onceSeen: takeLast([...stat.onceSeen, false], MAX_SEEN)
      };
    }
    case "glimpsed": {
      const seen = takeLast([...stat.onceSeen, true], MAX_SEEN);
      let brief = null;
      if (seen.filter(Boolean).length >= MIN_READ_ONCE)
        brief = true;
      else if (stat.inStockMin.length)
        brief = percentile(stat.inStockMin, 0.1) * 60 < 2 * CHECK_SECONDS;
      if (brief === true)
        return { ...stat, soldOutAt: event.at, skipGap: true, onceSeen: seen };
      if (brief === false)
        return { ...stat, onceSeen: seen };
      return { ...stat, skipGap: stat.soldOutAt !== null, onceSeen: seen };
    }
  }
}
function forgetAnchors(stat) {
  return { ...stat, soldOutAt: null, restockedAt: null, skipGap: false };
}
function sellRate(stat, now, quantityNow) {
  const refill = stat.refills.at(-1);
  const minutes = stat.restockedAt === null ? null : (now - stat.restockedAt) / 60;
  const current = refill !== undefined && minutes !== null && minutes >= MIN_RATE_MINUTES ? Math.max(0, refill - quantityNow) / minutes : null;
  const rates = [current, stat.lastPhaseRate].filter((rate) => rate !== null);
  return rates.length ? Math.max(...rates) : null;
}
function isPredictable(stat) {
  const gaps = stat.gapsMin;
  if (gaps.length < MIN_GAPS)
    return false;
  const mid = median(gaps);
  return mid > 0 && median(gaps.map((gap) => Math.abs(gap - mid))) / mid <= MAX_MAD_SHARE;
}
function windowAfter(stat, soldOutAt) {
  if (!isPredictable(stat))
    return null;
  const at = (p) => soldOutAt + Math.round(percentile(stat.gapsMin, p) * 60);
  return { start: at(0.1), center: at(0.5), end: at(0.9), depth: 1 };
}
function runOutAt(stat, now, quantity) {
  if (quantity <= 0)
    return now;
  const rate = sellRate(stat, now, quantity);
  if (rate === null)
    return null;
  if (rate <= 0)
    return NEVER;
  return now + Math.round(quantity / rate * 60);
}
function nextRestock(stat, now, inStock, quantity) {
  if (inStock === false)
    return stat.soldOutAt === null ? null : windowAfter(stat, stat.soldOutAt);
  if (inStock === true) {
    const runOut = runOutAt(stat, now, quantity);
    return runOut === null || runOut === NEVER ? null : windowAfter(stat, runOut);
  }
  return null;
}
function following(stat, previous) {
  if (!isPredictable(stat))
    return null;
  const inStock = inStockMinutes(stat);
  if (inStock === null)
    return null;
  const gaps = stat.gapsMin;
  const mid = median(gaps);
  const depth = previous.depth + 1;
  const spread = Math.sqrt(depth);
  const center = previous.center + Math.round((inStock + mid) * 60);
  return {
    start: center - Math.round((mid - percentile(gaps, 0.1)) * 60 * spread),
    center,
    end: center + Math.round((percentile(gaps, 0.9) - mid) * 60 * spread),
    depth
  };
}
function plan(now, stat, inStock, quantity, flight) {
  if (inStock === true) {
    const runOut = runOutAt(stat, now, quantity);
    if (runOut !== null && runOut > now + flight + LAND_MARGIN)
      return { type: "goNow", landAt: now + flight };
  }
  if (inStock === null)
    return { type: "learning" };
  if (stat.gapsMin.length >= MIN_GAPS && !isPredictable(stat))
    return { type: "unpredictable" };
  let window = nextRestock(stat, now, inStock, quantity);
  let steps = 0;
  while (window && window.start - flight < now) {
    if (++steps > MAX_CHAIN)
      return { type: "learning" };
    window = following(stat, window);
  }
  if (!window)
    return { type: "learning" };
  return { type: "leaveBy", leaveBy: window.start - flight, landAt: window.start, restock: window };
}
function learn(stats, ingested) {
  const prefixes = ingested.gapCountries.map((country) => `${country}:`);
  const learned = Object.fromEntries(Object.entries(stats).map(([id, stat]) => [id, prefixes.some((p) => id.startsWith(p)) ? forgetAnchors(stat) : stat]));
  for (const event of ingested.events) {
    learned[event.key] = onEvent(learned[event.key] ?? emptyStat(), event);
  }
  return learned;
}
function prune(entries, stats, now) {
  const lastSeen = (entry) => Math.max(entry.lastAgreeAt, entry.pendingSince);
  const kept = Object.fromEntries(Object.entries(entries).filter(([, entry]) => now - lastSeen(entry) <= ENTRY_TTL).sort(([, a], [, b]) => lastSeen(b) - lastSeen(a)).slice(0, MAX_ENTRIES));
  const keptStats = Object.fromEntries(Object.entries(stats).filter(([key]) => (key in kept) || (key in SEED_STATS)));
  return { entries: kept, stats: keptStats };
}
function leaveCooldown(stat) {
  const gaps = stat?.gapsMin ?? [];
  return Math.max(MIN_LEAVE_COOLDOWN, gaps.length ? Math.floor(median(gaps) * 30) : 0);
}
function isStale(snapshot, country, now) {
  const block = snapshot[country];
  return !block || now - block.update > STALE_SECONDS;
}
function tick({ state, snapshot, now, watched, user, leadSeconds }) {
  const current = sanitizeSnapshot(snapshot, now);
  const tracker = {
    ...state.tracker,
    countrySeenAt: Object.fromEntries(Object.entries(state.tracker.countrySeenAt).filter(([, at]) => at <= now + MAX_FUTURE_SECONDS))
  };
  const ingested = ingest(tracker, current);
  const { entries, stats } = prune(ingested.tracker.entries, learn(statsWithSeeds(state), ingested), now);
  const pings = [];
  if (user?.canFly) {
    for (const key of watched) {
      const parts = splitKey(key);
      const entry = entries[key];
      if (!parts || !entry || isStale(current, parts.country, now))
        continue;
      const stat = stats[key] ?? emptyStat();
      const flight = flightSeconds(parts.country, user.method);
      const base = { key, country: parts.country, itemId: parts.itemId, name: entry.name };
      const restock = ingested.events.find((event) => event.key === key && event.type === "restocked");
      if (restock) {
        const runOut = runOutAt(stat, now, entry.quantity);
        const dedup = `restock:${key}`;
        const last = state.sent[dedup];
        if (runOut !== null && runOut > now + flight + LAND_MARGIN && (last === undefined || now - last >= leaveCooldown(stat))) {
          pings.push({ ...base, type: "restocked", dedup, landAt: now + flight, runOutAt: runOut });
          continue;
        }
      }
      const itemPlan = plan(now, stat, entry.inStock, entry.quantity, flight);
      if (itemPlan.type !== "leaveBy")
        continue;
      if (now <= itemPlan.leaveBy - leadSeconds - CHECK_SECONDS - CHECK_SLACK || now > itemPlan.leaveBy + LATE_GRACE)
        continue;
      const dedup = `leave:${key}`;
      const last = state.sent[dedup];
      if (last !== undefined && now - last < leaveCooldown(stat))
        continue;
      pings.push({ ...base, type: "leaveNow", dedup, landAt: itemPlan.landAt, leaveBy: itemPlan.leaveBy, restock: itemPlan.restock });
    }
  }
  const due = pings.slice(0, MAX_PINGS_PER_CHECK);
  const newlySent = Object.fromEntries(due.map((ping) => [ping.dedup, now]));
  const sent = Object.fromEntries(Object.entries({ ...state.sent, ...newlySent }).filter(([, at]) => at <= now && now - at <= SENT_TTL));
  const learned = Object.fromEntries(Object.entries(stats).filter(([key, stat]) => stat !== SEED_STATS[key]));
  return { state: { tracker: { ...ingested.tracker, entries }, stats: learned, sent, lastCheck: now }, events: ingested.events, pings: due };
}
var SEED_STATS = {
  "chi:274": {
    ...emptyStat(),
    gapsMin: [14.6, 16.5, 17, 14.1, 16.6, 15.4, 15.5, 14.2, 13.8, 16.4, 14.6, 15.2, 14.1, 15.5, 14.4],
    refills: [2482, 2428, 2247, 2136, 2454],
    lastPhaseRate: 173.19,
    inStockMin: [2.1, 6.8, 4.3, 4.3, 3.1, 8, 13.5, 6.2, 9.1, 5.5, 13.4, 17.3, 21.7, 16.8, 12.3]
  },
  "uae:384": {
    ...emptyStat(),
    gapsMin: [14.1, 16.3, 16.8, 14.9, 12.8, 16.2, 16.3, 16.6, 14.6, 13.9, 13.9, 15.2, 14.4, 15.8, 15.8],
    refills: [2398, 2287, 2281, 2308, 2250],
    lastPhaseRate: 118.56,
    inStockMin: [5.4, 5.8, 4.9, 2.1, 6.8, 9.2, 11.5, 6.9, 4.5, 8.1, 11.9, 18.8, 12.6, 18.5, 19.5]
  },
  "mex:260": {
    ...emptyStat(),
    gapsMin: [65.3, 59.5, 56.2, 57.7, 56.4, 55.6, 63.4, 61.3, 63.6, 55.9, 65.1, 56, 60.1, 66.6, 56.9],
    refills: [9440, 9999, 8995, 9166, 9904],
    lastPhaseRate: 166.71,
    inStockMin: [33.4, 16.8, 12.6, 11.9, 28.3, 40.1, 37.7, 38.4, 43.4, 45, 58.8, 37.2, 30.8, 42.7, 55]
  },
  "cay:617": {
    ...emptyStat(),
    gapsMin: [60.9, 56.9, 56.4, 55.3, 54.2, 64.7, 66.1, 56.1, 56.9, 64.5, 56.7, 55.3, 53.1, 58.9, 61],
    refills: [9999, 9666, 9826, 9778, 9951],
    lastPhaseRate: 131.4,
    inStockMin: [23.4, 19.3, 15.6, 20, 23.2, 33.4, 37.2, 48.4, 56.3, 53.9, 48.9, 39.8, 42.1, 54.3, 74.4]
  },
  "uni:206": {
    ...emptyStat(),
    gapsMin: [131.6, 120.1, 128.3, 119.9, 126.9, 116.6, 124.2, 110.5],
    refills: [2500, 2442, 2500, 2499, 2500],
    lastPhaseRate: 8.99,
    inStockMin: [203, 327.2, 204.7, 119.9, 156.8, 312.5, 278.1]
  },
  "jap:206": {
    ...emptyStat(),
    gapsMin: [117, 109.8, 116.8, 125.7, 112.9, 120.4, 114.5, 114, 112.2, 125.3, 118.5],
    refills: [1853, 2253, 1590, 1423, 1851],
    lastPhaseRate: 154.04,
    inStockMin: [3.1, 7.5, 4.1, 6.8, 2.1, 5.2, 2.2, 2.1, 2.1, 3.1, 7.3, 4.3, 3.1, 4.5, 12]
  }
};
function initialRadarState() {
  return { tracker: emptyTracker(), stats: {}, sent: {}, lastCheck: 0 };
}
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function radarStateOf(raw) {
  if (!isRecord(raw) || !isRecord(raw.tracker) || !isRecord(raw.stats) || !isRecord(raw.sent) || typeof raw.lastCheck !== "number")
    return initialRadarState();
  if (!isRecord(raw.tracker.entries) || !isRecord(raw.tracker.countrySeenAt))
    return initialRadarState();
  return raw;
}
function statsWithSeeds(state) {
  return { ...SEED_STATS, ...state.stats };
}
export {
  CHECK_SECONDS,
  COUNTRY_NAMES,
  MAX_GAP_SECONDS,
  NEVER,
  SEED_STATS,
  STALE_SECONDS,
  emptyStat,
  emptyTracker,
  flightSeconds,
  forgetAnchors,
  ingest,
  initialRadarState,
  isPredictable,
  onEvent,
  plan,
  radarStateOf,
  runOutAt,
  sanitizeSnapshot,
  splitKey,
  statsWithSeeds,
  tick,
  toTravelMethod,
  windowAfter
};
