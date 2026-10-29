import { describe, expect, it } from "bun:test";
import {
	CHECK_SECONDS,
	emptyStat,
	emptyTracker,
	flightSeconds,
	ingest,
	initialRadarState,
	isPredictable,
	MAX_GAP_SECONDS,
	onEvent,
	plan,
	radarStateOf,
	runOutAt,
	sanitizeSnapshot,
	SEED_STATS,
	splitKey,
	STALE_SECONDS,
	statsWithSeeds,
	tick,
	toTravelMethod,
	windowAfter,
} from "@features/travel-radar/radar-core";
import type { FeedSnapshot, ItemStat, RadarPing, RadarState, StockEvent, TickInput } from "@features/travel-radar/radar-core";

const T0 = 1_790_000_000;
const DAHLIA = 260;

function mexico(update: number, quantity: number, cost = 300): FeedSnapshot {
	return { mex: { update, stocks: [{ id: DAHLIA, name: "Dahlia", quantity, cost }] } };
}

/** Readings one check apart, starting at T0, returning every event they confirmed. */
function replay(quantities: number[], costs: number[] = []) {
	let tracker = emptyTracker();
	const events: StockEvent[] = [];
	quantities.forEach((quantity, i) => {
		const result = ingest(tracker, mexico(T0 + i * CHECK_SECONDS, quantity, costs[i] ?? 300));
		tracker = result.tracker;
		events.push(...result.events);
	});
	return { tracker, events };
}

function statWithGaps(gapsMin: number[]): ItemStat {
	return { ...emptyStat(), gapsMin, refills: [9000], inStockMin: [30], lastPhaseRate: 300 };
}

describe("travel radar", () => {
	describe("tracking stock", () => {
		it("needs two readings in a row before it believes a change", () => {
			const { events } = replay([500, 500, 0, 0]);

			expect(events).toHaveLength(1);
			expect(events[0]).toMatchObject({ key: "mex:260", type: "soldOut", at: T0 + CHECK_SECONDS + CHECK_SECONDS / 2 });
		});

		it("does not report a transition on first sight", () => {
			const { events, tracker } = replay([0, 0]);

			expect(events).toHaveLength(0);
			expect(tracker.entries["mex:260"].inStock).toBe(false);
		});

		it("turns a one-off phantom upload into a glimpse, never a restock", () => {
			const { events } = replay([0, 0, 3604, 0, 0]);

			expect(events.map((event) => event.type)).toEqual(["glimpsed"]);
		});

		it("ignores the feeds' ±1 flapping", () => {
			const { events } = replay([0, 0, 1, 0, 2, 0]);

			expect(events).toHaveLength(0);
		});

		it("drops a reading whose price is divided by 1000, and accepts a real price change that repeats", () => {
			const glitch = replay([500, 500, 0, 500], [300, 300, 0.3, 300]);
			const change = replay([500, 500, 500], [300, 900, 900]);

			expect(glitch.events).toHaveLength(0);
			expect(glitch.tracker.entries["mex:260"].cost).toBe(300);
			expect(change.tracker.entries["mex:260"].cost).toBe(900);
		});

		it("forgets the state of a country that went silent for too long", () => {
			const first = ingest(emptyTracker(), mexico(T0, 500));
			const second = ingest(first.tracker, mexico(T0 + CHECK_SECONDS, 500));

			const afterGap = ingest(second.tracker, mexico(T0 + CHECK_SECONDS + MAX_GAP_SECONDS + 1, 0));

			expect(afterGap.gapCountries).toEqual(["mex"]);
			expect(afterGap.tracker.entries["mex:260"].inStock).toBeNull();
		});

		it("skips a country whose update did not move", () => {
			const first = ingest(emptyTracker(), mexico(T0, 500));

			const again = ingest(first.tracker, mexico(T0, 0));

			expect(again.tracker.entries["mex:260"].quantity).toBe(500);
		});
	});

	describe("learning", () => {
		it("learns the empty time between a sell-out and the next restock", () => {
			let stat = emptyStat();

			stat = onEvent(stat, { key: "mex:260", name: "Dahlia", type: "soldOut", at: T0, quantity: 0 });
			stat = onEvent(stat, { key: "mex:260", name: "Dahlia", type: "restocked", at: T0 + 57 * 60, quantity: 9999 });

			expect(stat.gapsMin).toEqual([57]);
			expect(stat.refills).toEqual([9999]);
			expect(stat.restockedAt).toBe(T0 + 57 * 60);
		});

		it("predicts the restock window from the learned gaps", () => {
			const stat = statWithGaps([55, 56, 57, 58, 59, 60, 61]);

			const window = windowAfter(stat, T0);

			expect(window).toEqual({ start: T0 + 55.6 * 60, center: T0 + 58 * 60, end: T0 + 60.4 * 60, depth: 1 });
		});

		it("refuses to predict an item whose gaps are erratic", () => {
			const stat = statWithGaps([5, 60, 15, 120, 30]);

			expect(isPredictable(stat)).toBe(false);
			expect(windowAfter(stat, T0)).toBeNull();
		});

		it("ships seeds that are predictable from the first check", () => {
			for (const [key, stat] of Object.entries(SEED_STATS)) {
				expect(isPredictable(stat), key).toBe(true);
			}
		});
	});

	describe("planning a trip", () => {
		it("says go now when the stock outlasts the flight", () => {
			const stat = { ...statWithGaps([57, 58, 59]), refills: [9000], restockedAt: T0 - 600 };

			const result = plan(T0, stat, true, 8000, flightSeconds("mex", "standard"));

			expect(result).toEqual({ type: "goNow", landAt: T0 + 24 * 60 });
		});

		it("times the departure so the flight lands at the early edge of the restock window", () => {
			const stat = { ...statWithGaps([57, 58, 59]), soldOutAt: T0 };
			const flight = flightSeconds("mex", "standard");

			const result = plan(T0, stat, false, 0, flight);

			expect(result.type).toBe("leaveBy");
			if (result.type !== "leaveBy") return;
			expect(result.landAt).toBe(result.restock.start);
			expect(result.leaveBy).toBe(result.restock.start - flight);
		});

		it("chains restock cycles ahead for a flight longer than one empty phase", () => {
			const stat = { ...SEED_STATS["chi:274"], soldOutAt: T0 };
			const flight = flightSeconds("chi", "standard");

			const result = plan(T0, stat, false, 0, flight);

			expect(result.type).toBe("leaveBy");
			if (result.type !== "leaveBy") return;
			expect(result.restock.depth).toBeGreaterThan(1);
			expect(result.leaveBy).toBeGreaterThanOrEqual(T0);
		});

		it("keeps learning while the stock state is unknown", () => {
			expect(plan(T0, SEED_STATS["mex:260"], null, 0, 1440)).toEqual({ type: "learning" });
		});
	});

	describe("pings", () => {
		const user = { canFly: true, method: "standard" as const };
		const LEAD = 180;

		/** A Dahlia with three ~58 min gaps learned that sells out at T0 + 450, seen at every check since. */
		function emptyDahlia(): RadarState {
			let state: RadarState = { ...initialRadarState(), stats: { "mex:260": statWithGaps([57, 58, 59]) } };
			[500, 500, 0, 0].forEach((quantity, i) => {
				const now = T0 + i * CHECK_SECONDS;
				state = tick({ state, snapshot: mexico(now, quantity), now, watched: [], user: null, leadSeconds: LEAD }).state;
			});
			return state;
		}

		/** One check per CHECK_SECONDS, each seeing a fresh upload, collecting every ping with its time. */
		function checks(state: RadarState, from: number, until: number, quantity: (now: number) => number, options: Partial<TickInput> = {}) {
			const pings: { at: number; ping: RadarPing }[] = [];
			for (let now = from; now <= until; now += CHECK_SECONDS) {
				const result = tick({ state, snapshot: mexico(now, quantity(now)), now, watched: ["mex:260"], user, leadSeconds: LEAD, ...options });
				state = result.state;
				pings.push(...result.pings.map((ping) => ({ at: now, ping })));
			}
			return { state, pings };
		}

		// p10 of [57, 58, 59] is 57.2 min: the window opens 3432 s after the sell-out; a standard flight takes 1440 s.
		const SOLD_OUT_AT = T0 + 450;
		const LEAVE_BY = SOLD_OUT_AT + 3432 - 1440;

		it("tells a watched item's leave-by time once, on the last check before the heads-up", () => {
			const { pings, state } = checks(emptyDahlia(), T0 + 1200, LEAVE_BY + 600, () => 0);

			expect(state.stats["mex:260"].soldOutAt).toBe(SOLD_OUT_AT);
			expect(pings).toHaveLength(1);
			expect(pings[0].at).toBe(T0 + 2100);
			expect(pings[0].ping).toMatchObject({ type: "leaveNow", key: "mex:260", name: "Dahlia", leaveBy: LEAVE_BY, landAt: SOLD_OUT_AT + 3432 });
			expect(state.sent["leave:mex:260"]).toBe(T0 + 2100);
		});

		it("stays quiet for items nobody watches, without a key, or while the player can't fly", () => {
			const run = (options: Partial<TickInput>) => checks(emptyDahlia(), T0 + 1200, LEAVE_BY + 600, () => 0, options).pings;

			expect(run({ watched: [] })).toHaveLength(0);
			expect(run({ user: null })).toHaveLength(0);
			expect(run({ user: { ...user, canFly: false } })).toHaveLength(0);
		});

		it("never pings from a stale upload", () => {
			const { state } = checks(emptyDahlia(), T0 + 1200, T0 + 1800, () => 0);
			const now = T0 + 2100;

			const result = tick({ state, snapshot: mexico(T0 + 1800, 0), now: now + STALE_SECONDS, watched: ["mex:260"], user, leadSeconds: LEAD });

			expect(result.pings).toHaveLength(0);
		});

		it("says restocked when a watched item comes back and should last until you land", () => {
			const restockAt = T0 + 1500;

			const { pings } = checks(emptyDahlia(), T0 + 1200, T0 + 2400, (now) => (now < restockAt ? 0 : 9999 - (now - restockAt) / 10));

			expect(pings).toHaveLength(1);
			expect(pings[0].at).toBe(restockAt + CHECK_SECONDS);
			expect(pings[0].ping).toMatchObject({ type: "restocked", key: "mex:260", landAt: restockAt + CHECK_SECONDS + 1440 });
		});

		it("holds back a second restocked ping for the same item within its cooldown", () => {
			// Empty two checks, back two checks: the feed flaps a full cycle every 20 minutes.
			let state = emptyDahlia();
			let restockEvents = 0;
			const restockPings: number[] = [];
			for (let now = T0 + 1200; now <= T0 + 1200 + 8 * CHECK_SECONDS; now += CHECK_SECONDS) {
				const quantity = Math.floor((now - T0) / (2 * CHECK_SECONDS)) % 2 ? 9999 : 0;
				const result = tick({ state, snapshot: mexico(now, quantity), now, watched: ["mex:260"], user, leadSeconds: LEAD });
				state = result.state;
				restockEvents += result.events.filter((event) => event.type === "restocked").length;
				restockPings.push(...result.pings.filter((ping) => ping.type === "restocked").map(() => now));
			}

			expect(restockEvents).toBe(2);
			expect(restockPings).toHaveLength(1);
		});

		it("sends at most three pings per check", () => {
			const watched: string[] = [];
			const stats: Record<string, ItemStat> = {};
			for (let id = 1; id <= 6; id++) {
				watched.push(`mex:${id}`);
				stats[`mex:${id}`] = { ...statWithGaps([57, 58, 59]), refills: [9000], restockedAt: T0 - 600 };
			}
			let state: RadarState = { ...initialRadarState(), stats };
			const feed = (now: number, quantity: number) => ({
				mex: { update: now, stocks: watched.map((key) => ({ id: Number(key.split(":")[1]), name: key, quantity, cost: 300 })) },
			});
			let pings: RadarPing[] = [];
			[0, 0, 9000, 8990].forEach((quantity, i) => {
				const now = T0 + i * CHECK_SECONDS;
				const result = tick({ state, snapshot: feed(now, quantity), now, watched, user, leadSeconds: LEAD });
				state = result.state;
				pings = result.pings;
			});

			expect(pings).toHaveLength(3);
		});

		it("drops a feed stamped far in the future instead of letting it block later updates", () => {
			const result = tick({ state: initialRadarState(), snapshot: mexico(T0 + 3600, 500), now: T0, watched: [], user: null, leadSeconds: LEAD });

			expect(result.state.tracker.countrySeenAt.mex).toBeUndefined();
			expect(result.state.lastCheck).toBe(T0);
		});
	});

	describe("an untrusted feed", () => {
		it("survives malformed blocks and readings instead of throwing", () => {
			const raw = { mex: null, cay: { update: T0 }, can: { update: T0, stocks: { a: 1 } }, haw: { update: T0, stocks: [null, 5, "x"] } };

			expect(() => tick({ state: initialRadarState(), snapshot: raw, now: T0, watched: [], user: null, leadSeconds: 180 })).not.toThrow();
			expect(sanitizeSnapshot(raw, T0)).toEqual({ haw: { update: T0, stocks: [] } });
		});

		it("drops readings with numbers sent as strings, impossible ids or a missing name", () => {
			const raw = {
				mex: {
					update: T0,
					stocks: [
						{ id: 260, name: "Dahlia", quantity: "7000", cost: 300 },
						{ id: 0, name: "Zero", quantity: 1, cost: 1 },
						{ id: 1_000_000, name: "Huge", quantity: 1, cost: 1 },
						{ id: 261, name: null, quantity: 1, cost: 1 },
						{ id: 262, name: "Ok", quantity: 5, cost: 1 },
					],
				},
			};

			expect(sanitizeSnapshot(raw, T0).mex.stocks.map((reading) => reading.id)).toEqual([262]);
		});

		it("rejects a country whose update is not a whole number or lies in the future", () => {
			expect(sanitizeSnapshot({ mex: { update: "1790000000", stocks: [] } }, T0)).toEqual({});
			expect(sanitizeSnapshot({ mex: { update: T0 + 3600, stocks: [] } }, T0)).toEqual({});
		});

		it("cleans item names of control characters and caps their length", () => {
			const raw = { mex: { update: T0, stocks: [{ id: 260, name: `Dahlia\nFAKE: log in again${"x".repeat(5000)}`, quantity: 5, cost: 1 }] } };

			const [reading] = sanitizeSnapshot(raw, T0).mex.stocks;

			expect(reading.name).not.toContain("\n");
			expect(reading.name.length).toBeLessThanOrEqual(48);
		});

		it("caps the readings kept per country", () => {
			const stocks = Array.from({ length: 5000 }, (_, i) => ({ id: i + 1, name: "n", quantity: 5, cost: 1 }));

			expect(sanitizeSnapshot({ mex: { update: T0, stocks } }, T0).mex.stocks.length).toBeLessThanOrEqual(64);
		});

		it("keeps the stored state bounded when the feed keeps inventing items", () => {
			let state = initialRadarState();
			for (let i = 0; i < 30; i++) {
				const now = T0 + i * CHECK_SECONDS;
				const stocks = Array.from({ length: 64 }, (_, j) => ({ id: i * 64 + j + 1, name: "n", quantity: 5, cost: 1 }));
				const snapshot = Object.fromEntries(
					["mex", "cay", "can", "haw", "uni", "arg", "swi", "jap", "chi", "uae", "sou"].map((c) => [c, { update: now, stocks }]),
				);
				state = tick({ state, snapshot, now, watched: [], user: null, leadSeconds: 180 }).state;
			}

			expect(Object.keys(state.tracker.entries).length).toBeLessThanOrEqual(800);
			expect(JSON.stringify(state).length).toBeLessThan(1_000_000);
		});

		it("forgets items the feed stopped listing a day ago, but keeps the seeds", () => {
			const first = tick({ state: initialRadarState(), snapshot: mexico(T0, 500), now: T0, watched: [], user: null, leadSeconds: 180 }).state;
			const dayLater = T0 + 25 * 3600;

			const later = tick({
				state: first,
				snapshot: { cay: { update: dayLater, stocks: [] } },
				now: dayLater,
				watched: [],
				user: null,
				leadSeconds: 180,
			}).state;

			expect(later.tracker.entries["mex:260"]).toBeUndefined();
			expect(statsWithSeeds(later)["mex:260"]).toBe(SEED_STATS["mex:260"]);
		});

		it("accepts only plain decimal item ids in keys", () => {
			expect(splitKey("mex:260")).toEqual({ country: "mex", itemId: 260 });
			for (const key of ["mex:0x104", "mex:260abc", "mex:1e3", "mex:-5", "mex:260:9", "mex:0", "xyz:260"]) {
				expect(splitKey(key), key).toBeNull();
			}
		});
	});

	describe("stored state", () => {
		it("starts fresh from an upgrade's empty object or anything malformed", () => {
			for (const raw of [{}, null, undefined, { tracker: 5 }, { tracker: { entries: {} } }, "x"]) {
				const state = radarStateOf(raw);

				expect(state).toEqual(initialRadarState());
				expect(() => tick({ state, snapshot: mexico(T0, 500), now: T0, watched: [], user: null, leadSeconds: 180 })).not.toThrow();
			}
		});

		it("keeps a valid stored state as it is", () => {
			const stored = tick({ state: initialRadarState(), snapshot: mexico(T0, 500), now: T0, watched: [], user: null, leadSeconds: 180 }).state;

			expect(radarStateOf(stored)).toBe(stored);
		});

		it("stores only what it learned, so a later seed update still reaches existing users", () => {
			const state = tick({ state: initialRadarState(), snapshot: mexico(T0, 500), now: T0, watched: [], user: null, leadSeconds: 180 }).state;

			expect(Object.keys(state.stats)).toEqual([]);
			expect(statsWithSeeds(state)["mex:260"]).toBe(SEED_STATS["mex:260"]);
		});

		it("forgets a sent ping dated in the future after a clock correction", () => {
			const state = { ...initialRadarState(), sent: { "leave:mex:260": T0 + 86_400 } };

			const next = tick({ state, snapshot: mexico(T0, 500), now: T0, watched: [], user: null, leadSeconds: 180 }).state;

			expect(next.sent).toEqual({});
		});
	});

	describe("ticket and sell rate", () => {
		it("reads Torn's travel method, defaulting to standard for anything unknown", () => {
			expect(toTravelMethod("Airstrip")).toBe("airstrip");
			expect(toTravelMethod("Business")).toBe("business");
			for (const odd of [null, undefined, "", "constructor", "__proto__", "Business Class"]) {
				expect(toTravelMethod(odd), String(odd)).toBe("standard");
			}
		});

		it("expects stock to run out at the faster of this refill's pace and the last one", () => {
			const stat = { ...emptyStat(), refills: [9000], restockedAt: T0, lastPhaseRate: 100 };

			// 3000 sold in 10 minutes = 300 a minute, faster than the last phase: 6000 left last 20 minutes.
			expect(runOutAt(stat, T0 + 600, 6000)).toBe(T0 + 600 + 20 * 60);
			expect(runOutAt(stat, T0 + 600, 0)).toBe(T0 + 600);
		});
	});
});
