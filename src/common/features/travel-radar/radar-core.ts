const COUNTRY_CODES = ["mex", "cay", "can", "haw", "uni", "arg", "swi", "jap", "chi", "uae", "sou"] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

export const COUNTRY_NAMES: Record<CountryCode, string> = {
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
	sou: "South Africa",
};

const STANDARD_MINUTES: Record<CountryCode, number> = {
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
	sou: 282,
};

export type TravelMethod = "standard" | "airstrip" | "private" | "business";

const METHOD_FACTOR: Record<TravelMethod, number> = { standard: 1, airstrip: 0.7, private: 0.5, business: 0.3 };

export function toTravelMethod(method: string | null | undefined): TravelMethod {
	const lower = method?.toLowerCase();
	return lower && Object.hasOwn(METHOD_FACTOR, lower) ? (lower as TravelMethod) : "standard";
}

export function flightSeconds(country: CountryCode, method: TravelMethod): number {
	return Math.round(STANDARD_MINUTES[country] * 60 * METHOD_FACTOR[method]);
}

function isCountryCode(code: string): code is CountryCode {
	return (COUNTRY_CODES as readonly string[]).includes(code);
}

export const CHECK_SECONDS = 300;
// A country silent for longer restarts as unknown: a whole cycle may have been missed.
export const MAX_GAP_SECONDS = 3 * CHECK_SECONDS;
export const STALE_SECONDS = 300;
const LAND_MARGIN = 60;
const LATE_GRACE = 60;
const CHECK_SLACK = 60;
const MIN_LEAVE_COOLDOWN = 600;
const SENT_TTL = 2 * 24 * 3600;
// Feed stamps beyond now + this are dropped: one bogus future stamp would block every real update.
const MAX_FUTURE_SECONDS = 600;
const CONFIRMATIONS = 2;
// The feeds flap by ±1 (1-3 units); a real restock shows hundreds.
const MIN_GLIMPSE_QUANTITY = 10;
const MAX_ITEM_ID = 99_999;
const MAX_READINGS_PER_COUNTRY = 64;
const MAX_NAME_LENGTH = 48;
const MAX_ENTRIES = 800;
const ENTRY_TTL = 24 * 3600;
const MAX_PINGS_PER_CHECK = 3;

const MIN_GAPS = 3;
const MAX_CHAIN = 12;
const MAX_MAD_SHARE = 0.35;
export const NEVER = Number.POSITIVE_INFINITY;

const MAX_GAPS = 15;
const MAX_REFILLS = 5;
const MAX_GAP_MINUTES = 24 * 60;
const MIN_RATE_MINUTES = 2;
// Real gaps stay within ~13% of their median (48 h replay); two cycles run together are ~2.3x.
const MERGED_GAP = 1.8;
const MAX_SEEN = 10;
// At 5-min checks ~2 in 3 plushie restocks are read once, Dahlia's about 1 in 150.
const MIN_READ_ONCE = 2;

interface CountryStock {
	update: number;
	stocks: { id: number; name: string; quantity: number; cost: number }[];
}
export type FeedSnapshot = Record<string, CountryStock>;

type StockEventType = "soldOut" | "restocked" | "glimpsed";

export interface StockEvent {
	key: string;
	name: string;
	type: StockEventType;
	at: number;
	quantity: number;
}

export interface TrackEntry {
	inStock: boolean | null;
	lastAgreeAt: number;
	pendingInStock: boolean | null;
	pendingSince: number;
	pendingQuantity: number;
	pendingCount: number;
	quantity: number;
	cost: number | null;
	costCandidate: number | null;
	name: string;
}

interface TrackerState {
	entries: Record<string, TrackEntry>;
	countrySeenAt: Record<string, number>;
}

export interface ItemStat {
	gapsMin: number[];
	refills: number[];
	soldOutAt: number | null;
	restockedAt: number | null;
	lastPhaseRate: number | null;
	inStockMin: number[];
	skipGap: boolean;
	longGaps: number;
	onceSeen: boolean[];
}

interface RestockWindow {
	start: number;
	center: number;
	end: number;
	depth: number;
}

export type Plan =
	| { type: "goNow"; landAt: number }
	| { type: "leaveBy"; leaveBy: number; landAt: number; restock: RestockWindow }
	| { type: "learning" }
	| { type: "unpredictable" };

export interface RadarState {
	tracker: TrackerState;
	stats: Record<string, ItemStat>;
	sent: Record<string, number>;
	lastCheck: number;
}

export interface RadarPing {
	type: "leaveNow" | "restocked";
	dedup: string;
	key: string;
	country: CountryCode;
	itemId: number;
	name: string;
	landAt: number;
	leaveBy?: number;
	restock?: RestockWindow;
	runOutAt?: number;
}

export interface RadarUser {
	canFly: boolean;
	method: TravelMethod;
}

function percentile(values: number[], p: number): number {
	if (!values.length) throw new Error("percentile of an empty list");
	const sorted = [...values].sort((a, b) => a - b);
	const k = (sorted.length - 1) * p;
	const f = Math.floor(k);
	const c = Math.min(f + 1, sorted.length - 1);
	return sorted[f] + (sorted[c] - sorted[f]) * (k - f);
}

function median(values: number[]): number {
	return percentile(values, 0.5);
}

function itemKey(country: string, itemId: number): string {
	return `${country}:${itemId}`;
}

export function splitKey(key: string): { country: CountryCode; itemId: number } | null {
	const match = /^([a-z]{3}):([1-9]\d{0,4})$/.exec(key);
	if (!match || !isCountryCode(match[1])) return null;
	return { country: match[1], itemId: Number(match[2]) };
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function sanitizeSnapshot(raw: unknown, now: number): FeedSnapshot {
	const snapshot: FeedSnapshot = {};
	if (!raw || typeof raw !== "object") return snapshot;

	for (const country of COUNTRY_CODES) {
		const block = (raw as Record<string, unknown>)[country] as { update?: unknown; stocks?: unknown } | null | undefined;
		if (!block || typeof block.update !== "number" || !Number.isSafeInteger(block.update) || block.update > now + MAX_FUTURE_SECONDS) continue;
		if (!Array.isArray(block.stocks)) continue;

		const stocks: CountryStock["stocks"] = [];
		for (const reading of block.stocks.slice(0, MAX_READINGS_PER_COUNTRY)) {
			if (!reading || typeof reading !== "object") continue;
			const { id, name, quantity, cost } = reading as Record<string, unknown>;
			if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1 || id > MAX_ITEM_ID) continue;
			if (typeof name !== "string" || !isCount(quantity) || !isCount(cost)) continue;
			stocks.push({
				id,
				name: name
					.replaceAll(/[\p{Cc}\p{Cf}]/gu, " ")
					.trim()
					.slice(0, MAX_NAME_LENGTH),
				quantity,
				cost,
			});
		}
		snapshot[country] = { update: block.update, stocks };
	}
	return snapshot;
}

export function emptyTracker(): TrackerState {
	return { entries: {}, countrySeenAt: {} };
}

export function emptyStat(): ItemStat {
	return { gapsMin: [], refills: [], soldOutAt: null, restockedAt: null, lastPhaseRate: null, inStockMin: [], skipGap: false, longGaps: 0, onceSeen: [] };
}

function emptyEntry(): TrackEntry {
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
		name: "",
	};
}

function clearPending(entry: TrackEntry): TrackEntry {
	return { ...entry, pendingInStock: null, pendingSince: 0, pendingQuantity: 0, pendingCount: 0 };
}

function takeLast<T>(values: T[], n: number): T[] {
	return values.slice(Math.max(0, values.length - n));
}

function farOff(value: number, reference: number): boolean {
	return reference > 0 && Math.abs(value - reference) * 2 > reference;
}

// A real price change repeats on the next reading; a ÷1000 upload doesn't.
function withCost(entry: TrackEntry, cost: number): TrackEntry | null {
	const known = entry.cost;
	const candidate = entry.costCandidate;
	if (known === null || !farOff(cost, known)) return { ...entry, cost, costCandidate: null };
	if (candidate !== null && !farOff(cost, candidate)) return { ...entry, cost, costCandidate: null };
	return null;
}

function step(entry: TrackEntry, reading: { name: string; quantity: number; cost: number }, at: number): [TrackEntry, Omit<StockEvent, "key" | "name"> | null] {
	const priced = withCost(entry, reading.cost);
	if (!priced) return [{ ...entry, costCandidate: reading.cost }, null];

	const target = reading.quantity > 0;
	const base: TrackEntry = { ...priced, quantity: reading.quantity, name: reading.name };
	if (base.inStock === target) {
		// One in-stock reading between empties: at one check per 5 min often all that's seen of a real restock.
		const isGlimpse = !target && base.pendingCount > 0 && base.pendingInStock === true && base.pendingQuantity >= MIN_GLIMPSE_QUANTITY;
		const glimpse = isGlimpse ? { type: "glimpsed" as const, at: Math.floor((base.pendingSince + at) / 2), quantity: base.pendingQuantity } : null;
		return [clearPending({ ...base, lastAgreeAt: at }), glimpse];
	}

	const continuing = base.pendingCount > 0 && base.pendingInStock === target;
	const since = continuing ? base.pendingSince : at;
	const quantity = continuing ? base.pendingQuantity : reading.quantity;
	const count = continuing ? base.pendingCount + 1 : 1;
	if (count < CONFIRMATIONS) {
		return [{ ...base, pendingInStock: target, pendingSince: since, pendingQuantity: quantity, pendingCount: count }, null];
	}

	const transition =
		base.inStock !== null
			? { type: target ? ("restocked" as const) : ("soldOut" as const), at: Math.floor((base.lastAgreeAt + since) / 2), quantity }
			: null;
	return [clearPending({ ...base, inStock: target, lastAgreeAt: at }), transition];
}

interface Ingested {
	tracker: TrackerState;
	events: StockEvent[];
	gapCountries: CountryCode[];
}

export function ingest(state: TrackerState, snapshot: FeedSnapshot, maxGapSeconds = MAX_GAP_SECONDS): Ingested {
	const entries = { ...state.entries };
	const seen = { ...state.countrySeenAt };
	const events: StockEvent[] = [];
	const gapCountries: CountryCode[] = [];

	for (const country of COUNTRY_CODES) {
		const block = snapshot[country];
		if (!block) continue;

		const last = seen[country];
		if (last !== undefined && block.update <= last) continue;
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
			if (transition) events.push({ key, name: reading.name, ...transition });
		}
		seen[country] = block.update;
	}

	return { tracker: { entries, countrySeenAt: seen }, events, gapCountries };
}

function refillSize(stat: ItemStat): number | null {
	return stat.refills.length ? Math.trunc(median(stat.refills)) : null;
}

function inStockMinutes(stat: ItemStat): number | null {
	if (stat.inStockMin.length) return median(stat.inStockMin);
	const refill = refillSize(stat);
	const rate = stat.lastPhaseRate;
	if (refill === null || rate === null || rate <= 0) return null;
	return refill / rate;
}

function minutesSince(start: number | null, at: number): number | null {
	if (start === null) return null;
	const minutes = (at - start) / 60;
	return minutes > 0 && minutes <= MAX_GAP_MINUTES ? minutes : null;
}

function phaseRate(stat: ItemStat, soldOutAt: number): number | null {
	const refill = stat.refills.at(-1);
	if (stat.restockedAt === null || refill === undefined) return null;
	const minutes = (soldOutAt - stat.restockedAt) / 60;
	return minutes > 0 ? refill / minutes : null;
}

export function onEvent(stat: ItemStat, event: StockEvent): ItemStat {
	switch (event.type) {
		case "soldOut": {
			const phase = minutesSince(stat.restockedAt, event.at);
			return {
				...stat,
				soldOutAt: event.at,
				skipGap: false,
				restockedAt: null,
				lastPhaseRate: phaseRate(stat, event.at) ?? stat.lastPhaseRate,
				inStockMin: phase !== null ? takeLast([...stat.inStockMin, phase], MAX_GAPS) : stat.inStockMin,
			};
		}
		case "restocked": {
			const gap = stat.skipGap ? null : minutesSince(stat.soldOutAt, event.at);
			// A restock missed entirely between checks leaves no glimpse: its "gap" is two cycles run together.
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
				onceSeen: takeLast([...stat.onceSeen, false], MAX_SEEN),
			};
		}
		case "glimpsed": {
			// A brief item's restocks are often read only once, so there one reading is a real restock; a long-stocked
			// item is always read twice, so there it is a glitch.
			const seen = takeLast([...stat.onceSeen, true], MAX_SEEN);
			let brief: boolean | null = null;
			if (seen.filter(Boolean).length >= MIN_READ_ONCE) brief = true;
			else if (stat.inStockMin.length) brief = percentile(stat.inStockMin, 0.1) * 60 < 2 * CHECK_SECONDS;

			if (brief === true) return { ...stat, soldOutAt: event.at, skipGap: true, onceSeen: seen };
			if (brief === false) return { ...stat, onceSeen: seen };
			return { ...stat, skipGap: stat.soldOutAt !== null, onceSeen: seen };
		}
	}
}

export function forgetAnchors(stat: ItemStat): ItemStat {
	return { ...stat, soldOutAt: null, restockedAt: null, skipGap: false };
}

function sellRate(stat: ItemStat, now: number, quantityNow: number): number | null {
	const refill = stat.refills.at(-1);
	const minutes = stat.restockedAt === null ? null : (now - stat.restockedAt) / 60;
	const current = refill !== undefined && minutes !== null && minutes >= MIN_RATE_MINUTES ? Math.max(0, refill - quantityNow) / minutes : null;
	const rates = [current, stat.lastPhaseRate].filter((rate): rate is number => rate !== null);
	return rates.length ? Math.max(...rates) : null;
}

export function isPredictable(stat: ItemStat): boolean {
	const gaps = stat.gapsMin;
	if (gaps.length < MIN_GAPS) return false;
	const mid = median(gaps);
	// MAD rather than IQR: when uploads are sparse, whole cycles merge into one long "gap", which only inflates the upper tail.
	return mid > 0 && median(gaps.map((gap) => Math.abs(gap - mid))) / mid <= MAX_MAD_SHARE;
}

export function windowAfter(stat: ItemStat, soldOutAt: number): RestockWindow | null {
	if (!isPredictable(stat)) return null;
	const at = (p: number) => soldOutAt + Math.round(percentile(stat.gapsMin, p) * 60);
	return { start: at(0.1), center: at(0.5), end: at(0.9), depth: 1 };
}

export function runOutAt(stat: ItemStat, now: number, quantity: number): number | null {
	if (quantity <= 0) return now;
	const rate = sellRate(stat, now, quantity);
	if (rate === null) return null;
	if (rate <= 0) return NEVER;
	return now + Math.round((quantity / rate) * 60);
}

function nextRestock(stat: ItemStat, now: number, inStock: boolean | null, quantity: number): RestockWindow | null {
	if (inStock === false) return stat.soldOutAt === null ? null : windowAfter(stat, stat.soldOutAt);
	if (inStock === true) {
		const runOut = runOutAt(stat, now, quantity);
		return runOut === null || runOut === NEVER ? null : windowAfter(stat, runOut);
	}
	return null;
}

function following(stat: ItemStat, previous: RestockWindow): RestockWindow | null {
	if (!isPredictable(stat)) return null;
	const inStock = inStockMinutes(stat);
	if (inStock === null) return null;
	const gaps = stat.gapsMin;
	const mid = median(gaps);
	const depth = previous.depth + 1;
	const spread = Math.sqrt(depth);
	const center = previous.center + Math.round((inStock + mid) * 60);
	return {
		start: center - Math.round((mid - percentile(gaps, 0.1)) * 60 * spread),
		center,
		end: center + Math.round((percentile(gaps, 0.9) - mid) * 60 * spread),
		depth,
	};
}

export function plan(now: number, stat: ItemStat, inStock: boolean | null, quantity: number, flight: number): Plan {
	if (inStock === true) {
		const runOut = runOutAt(stat, now, quantity);
		if (runOut !== null && runOut > now + flight + LAND_MARGIN) return { type: "goNow", landAt: now + flight };
	}
	if (inStock === null) return { type: "learning" };
	if (stat.gapsMin.length >= MIN_GAPS && !isPredictable(stat)) return { type: "unpredictable" };

	let window = nextRestock(stat, now, inStock, quantity);
	let steps = 0;
	while (window && window.start - flight < now) {
		if (++steps > MAX_CHAIN) return { type: "learning" };
		window = following(stat, window);
	}
	if (!window) return { type: "learning" };
	return { type: "leaveBy", leaveBy: window.start - flight, landAt: window.start, restock: window };
}

function learn(stats: Record<string, ItemStat>, ingested: Ingested): Record<string, ItemStat> {
	const prefixes = ingested.gapCountries.map((country) => `${country}:`);
	const learned = Object.fromEntries(Object.entries(stats).map(([id, stat]) => [id, prefixes.some((p) => id.startsWith(p)) ? forgetAnchors(stat) : stat]));
	for (const event of ingested.events) {
		learned[event.key] = onEvent(learned[event.key] ?? emptyStat(), event);
	}
	return learned;
}

function prune(entries: Record<string, TrackEntry>, stats: Record<string, ItemStat>, now: number) {
	const lastSeen = (entry: TrackEntry) => Math.max(entry.lastAgreeAt, entry.pendingSince);
	const kept = Object.fromEntries(
		Object.entries(entries)
			.filter(([, entry]) => now - lastSeen(entry) <= ENTRY_TTL)
			.sort(([, a], [, b]) => lastSeen(b) - lastSeen(a))
			.slice(0, MAX_ENTRIES),
	);
	const keptStats = Object.fromEntries(Object.entries(stats).filter(([key]) => key in kept || key in SEED_STATS));
	return { entries: kept, stats: keptStats };
}

// Deduped by time rather than by leave-by time: predictions shift as data arrives.
function leaveCooldown(stat: ItemStat | undefined): number {
	const gaps = stat?.gapsMin ?? [];
	return Math.max(MIN_LEAVE_COOLDOWN, gaps.length ? Math.floor(median(gaps) * 30) : 0);
}

function isStale(snapshot: FeedSnapshot, country: CountryCode, now: number): boolean {
	const block = snapshot[country];
	return !block || now - block.update > STALE_SECONDS;
}

export interface TickInput {
	state: RadarState;
	snapshot: unknown;
	now: number;
	watched: string[];
	user: RadarUser | null;
	leadSeconds: number;
}

interface TickResult {
	state: RadarState;
	events: StockEvent[];
	pings: RadarPing[];
}

export function tick({ state, snapshot, now, watched, user, leadSeconds }: TickInput): TickResult {
	const current = sanitizeSnapshot(snapshot, now);
	const tracker = {
		...state.tracker,
		countrySeenAt: Object.fromEntries(Object.entries(state.tracker.countrySeenAt).filter(([, at]) => at <= now + MAX_FUTURE_SECONDS)),
	};
	const ingested = ingest(tracker, current);
	const { entries, stats } = prune(ingested.tracker.entries, learn(statsWithSeeds(state), ingested), now);

	const pings: RadarPing[] = [];
	if (user?.canFly) {
		for (const key of watched) {
			const parts = splitKey(key);
			const entry = entries[key];
			if (!parts || !entry || isStale(current, parts.country, now)) continue;

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
			if (itemPlan.type !== "leaveBy") continue;
			// The last check before the lead time, since the next one would come too late.
			if (now <= itemPlan.leaveBy - leadSeconds - CHECK_SECONDS - CHECK_SLACK || now > itemPlan.leaveBy + LATE_GRACE) continue;
			const dedup = `leave:${key}`;
			const last = state.sent[dedup];
			if (last !== undefined && now - last < leaveCooldown(stat)) continue;
			pings.push({ ...base, type: "leaveNow", dedup, landAt: itemPlan.landAt, leaveBy: itemPlan.leaveBy, restock: itemPlan.restock });
		}
	}

	const due = pings.slice(0, MAX_PINGS_PER_CHECK);
	const newlySent = Object.fromEntries(due.map((ping) => [ping.dedup, now]));
	// A send dated in the future (the clock was corrected) would never expire.
	const sent = Object.fromEntries(Object.entries({ ...state.sent, ...newlySent }).filter(([, at]) => at <= now && now - at <= SENT_TTL));
	// Seeds nothing has changed stay out of storage, so a later seed update still reaches this player.
	const learned = Object.fromEntries(Object.entries(stats).filter(([key, stat]) => stat !== SEED_STATS[key]));

	return { state: { tracker: { ...ingested.tracker, entries }, stats: learned, sent, lastCheck: now }, events: ingested.events, pings: due };
}

// From YATA's 48 h histories of 2026-09-26 → 28. Katana and Swiss Army Knife are left out: their rhythm is erratic.
export const SEED_STATS: Record<string, ItemStat> = {
	"chi:274": {
		...emptyStat(), // Panda Plushie
		gapsMin: [14.6, 16.5, 17.0, 14.1, 16.6, 15.4, 15.5, 14.2, 13.8, 16.4, 14.6, 15.2, 14.1, 15.5, 14.4],
		refills: [2482, 2428, 2247, 2136, 2454],
		lastPhaseRate: 173.19,
		inStockMin: [2.1, 6.8, 4.3, 4.3, 3.1, 8.0, 13.5, 6.2, 9.1, 5.5, 13.4, 17.3, 21.7, 16.8, 12.3],
	},
	"uae:384": {
		...emptyStat(), // Camel Plushie
		gapsMin: [14.1, 16.3, 16.8, 14.9, 12.8, 16.2, 16.3, 16.6, 14.6, 13.9, 13.9, 15.2, 14.4, 15.8, 15.8],
		refills: [2398, 2287, 2281, 2308, 2250],
		lastPhaseRate: 118.56,
		inStockMin: [5.4, 5.8, 4.9, 2.1, 6.8, 9.2, 11.5, 6.9, 4.5, 8.1, 11.9, 18.8, 12.6, 18.5, 19.5],
	},
	"mex:260": {
		...emptyStat(), // Dahlia
		gapsMin: [65.3, 59.5, 56.2, 57.7, 56.4, 55.6, 63.4, 61.3, 63.6, 55.9, 65.1, 56.0, 60.1, 66.6, 56.9],
		refills: [9440, 9999, 8995, 9166, 9904],
		lastPhaseRate: 166.71,
		inStockMin: [33.4, 16.8, 12.6, 11.9, 28.3, 40.1, 37.7, 38.4, 43.4, 45.0, 58.8, 37.2, 30.8, 42.7, 55.0],
	},
	"cay:617": {
		...emptyStat(), // Banana Orchid
		gapsMin: [60.9, 56.9, 56.4, 55.3, 54.2, 64.7, 66.1, 56.1, 56.9, 64.5, 56.7, 55.3, 53.1, 58.9, 61.0],
		refills: [9999, 9666, 9826, 9778, 9951],
		lastPhaseRate: 131.4,
		inStockMin: [23.4, 19.3, 15.6, 20.0, 23.2, 33.4, 37.2, 48.4, 56.3, 53.9, 48.9, 39.8, 42.1, 54.3, 74.4],
	},
	"uni:206": {
		...emptyStat(), // Xanax (UK)
		gapsMin: [131.6, 120.1, 128.3, 119.9, 126.9, 116.6, 124.2, 110.5],
		refills: [2500, 2442, 2500, 2499, 2500],
		lastPhaseRate: 8.99,
		inStockMin: [203.0, 327.2, 204.7, 119.9, 156.8, 312.5, 278.1],
	},
	"jap:206": {
		...emptyStat(), // Xanax (Japan)
		gapsMin: [117.0, 109.8, 116.8, 125.7, 112.9, 120.4, 114.5, 114.0, 112.2, 125.3, 118.5],
		refills: [1853, 2253, 1590, 1423, 1851],
		lastPhaseRate: 154.04,
		inStockMin: [3.1, 7.5, 4.1, 6.8, 2.1, 5.2, 2.2, 2.1, 2.1, 3.1, 7.3, 4.3, 3.1, 4.5, 12.0],
	},
};

export function initialRadarState(): RadarState {
	return { tracker: emptyTracker(), stats: {}, sent: {}, lastCheck: 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

// An upgrading install's migration stores {} for a new object setting, not its default.
export function radarStateOf(raw: unknown): RadarState {
	if (!isRecord(raw) || !isRecord(raw.tracker) || !isRecord(raw.stats) || !isRecord(raw.sent) || typeof raw.lastCheck !== "number")
		return initialRadarState();
	if (!isRecord(raw.tracker.entries) || !isRecord(raw.tracker.countrySeenAt)) return initialRadarState();
	return raw as unknown as RadarState;
}

export function statsWithSeeds(state: RadarState): Record<string, ItemStat> {
	return { ...SEED_STATS, ...state.stats };
}
