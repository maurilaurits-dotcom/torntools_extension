import "./travel-radar.css";
import { ttStorage } from "@common/utils/context";
import { settings, travelRadar, userdata } from "@common/utils/data/database";
import { hasAPIData } from "@common/utils/functions/api";
import { createContainer } from "@common/utils/functions/containers";
import { elementBuilder } from "@common/utils/functions/dom";
import { findElement } from "@common/utils/functions/find-elements";
import { formatNumber, formatTime } from "@common/utils/functions/formatting";
import { logger } from "@common/utils/functions/logger";
import { isAbroad, isCaptcha, isFlying } from "@common/utils/functions/torn";
import { TO_MILLIS } from "@common/utils/functions/utilities";
import { PHFillBell, PHFillBellSlash } from "@common/utils/icons/phosphor-icons";
import { Feature } from "@features/feature";
import { COUNTRY_NAMES, flightSeconds, isPredictable, plan, radarStateOf, splitKey, statsWithSeeds, toTravelMethod } from "@features/travel-radar/radar-core";
import type { CountryCode, ItemStat, Plan, RadarState, TrackEntry, TravelMethod } from "@features/travel-radar/radar-core";

const FLAGS: Record<CountryCode, string> = {
	mex: "mexico",
	cay: "cayman",
	can: "canada",
	haw: "hawaii",
	uni: "uk",
	arg: "argentina",
	swi: "switzerland",
	jap: "japan",
	chi: "china",
	uae: "uae",
	sou: "south_africa",
};
const REFRESH_MS = 30 * TO_MILLIS.SECONDS;

interface RadarRow {
	key: string;
	country: CountryCode;
	itemId: number;
	entry: TrackEntry;
	stat: ItemStat;
	plan: Plan;
	isWatched: boolean;
}

let refreshTimer: ReturnType<typeof setInterval> | undefined;
let content: HTMLElement | undefined;

function travelMethod(): TravelMethod {
	return toTravelMethod(hasAPIData() && settings.apiUsage.user.travel ? userdata.travel?.method : null);
}

function clock(seconds: number) {
	return formatTime({ seconds }, { hideSeconds: true });
}

/** Items worth showing: predictable ones, and every watched one so it can be unwatched. */
function buildRows(state: RadarState, now: number, method: TravelMethod, watched: string[]): RadarRow[] {
	const stats = statsWithSeeds(state);

	return Object.entries(state.tracker.entries)
		.flatMap(([key, entry]) => {
			const parts = splitKey(key);
			const stat = stats[key];
			const isWatched = watched.includes(key);
			if (!parts || !stat || (!isWatched && !isPredictable(stat))) return [];

			const itemPlan = plan(now, stat, entry.inStock, entry.quantity, flightSeconds(parts.country, method));
			return [{ key, entry, stat, country: parts.country, itemId: parts.itemId, plan: itemPlan, isWatched }];
		})
		.sort((a, b) => Number(b.isWatched) - Number(a.isWatched) || comparePlans(a.plan, b.plan) || a.entry.name.localeCompare(b.entry.name));
}

/** Go-now first (soonest landing first), then by departure time; items still learning last. */
function comparePlans(a: Plan, b: Plan) {
	const rank = (itemPlan: Plan) => ({ goNow: 0, leaveBy: 1, learning: 2, unpredictable: 2 })[itemPlan.type];
	const time = (itemPlan: Plan) => (itemPlan.type === "goNow" ? itemPlan.landAt : itemPlan.type === "leaveBy" ? itemPlan.leaveBy : 0);
	return rank(a) - rank(b) || time(a) - time(b);
}

function describePlan(itemPlan: Plan, stat: ItemStat) {
	switch (itemPlan.type) {
		case "goNow":
			return {
				text: "Go now",
				detail: `lands ${clock(itemPlan.landAt)}`,
				title: `In stock until after you'd land at ${clock(itemPlan.landAt)}.`,
				className: "go-now",
			};
		case "leaveBy": {
			const { restock } = itemPlan;
			return {
				text: `Leave by ${clock(itemPlan.leaveBy)}`,
				detail: `restocks ~${clock(restock.center)}`,
				title: `Restocks ~${clock(restock.center)} (between ${clock(restock.start)} and ${clock(restock.end)}), learned from ${stat.gapsMin.length} restocks.`,
				className: "leave-by",
			};
		}
		case "unpredictable":
			return { text: "Erratic", detail: "", title: "This item restocks too irregularly to predict.", className: "muted" };
		case "learning":
			return { text: "Learning…", detail: "", title: "Waiting to see the item sell out or restock.", className: "muted" };
	}
}

function toRow(row: RadarRow) {
	const status = row.entry.inStock ? `${formatNumber(row.entry.quantity)} in stock` : row.entry.inStock === false ? "Empty" : "Unknown";
	const planText = describePlan(row.plan, row.stat);

	return elementBuilder({
		type: "div",
		class: ["tt-radar-row", row.isWatched ? "watched" : ""],
		children: [
			elementBuilder({
				type: "div",
				class: "item",
				children: [
					elementBuilder({
						type: "img",
						class: "flag",
						attributes: {
							src: `/images/v2/travel_agency/flags/fl_${FLAGS[row.country]}.svg`,
							alt: COUNTRY_NAMES[row.country],
							title: COUNTRY_NAMES[row.country],
						},
					}),
					elementBuilder({ type: "img", class: "icon", attributes: { src: `/images/items/${row.itemId}/small.png`, alt: "" } }),
					elementBuilder({
						type: "div",
						class: "name",
						children: [
							elementBuilder({ type: "span", text: row.entry.name }),
							elementBuilder({ type: "span", class: "country", text: COUNTRY_NAMES[row.country] }),
						],
					}),
				],
			}),
			elementBuilder({ type: "div", class: "status", text: status }),
			elementBuilder({
				type: "div",
				class: ["plan", planText.className],
				attributes: { title: planText.title },
				children: [
					elementBuilder({ type: "span", text: planText.text }),
					planText.detail ? elementBuilder({ type: "span", class: "detail", text: planText.detail }) : null,
				],
			}),
			elementBuilder({
				type: "button",
				class: "watch",
				attributes: {
					"aria-label": `Notify me about ${row.entry.name} in ${COUNTRY_NAMES[row.country]}`,
					"aria-pressed": String(row.isWatched),
					"data-radar-key": row.key,
					title: row.isWatched ? "Stop notifying me" : "Notify me when to leave and when it restocks",
				},
				children: [row.isWatched ? PHFillBell() : PHFillBellSlash()],
				events: { click: () => toggleWatch(row.key) },
			}),
		],
	});
}

async function toggleWatch(key: string) {
	let next: string[] = [];
	await ttStorage.update("settings", (stored) => {
		const watched = stored.pages.travel.radarWatched;
		next = watched.includes(key) ? watched.filter((watchedKey) => watchedKey !== key) : [...watched, key];
		stored.pages.travel.radarWatched = next;
	});
	// The in-memory settings catch up through the storage listener; render from what was just stored.
	render(next);
}

function render(watched = settings.pages.travel.radarWatched) {
	if (!content) return;

	const state = radarStateOf(travelRadar);
	const now = Math.floor(Date.now() / TO_MILLIS.SECONDS);
	const rows = buildRows(state, now, travelMethod(), watched);
	const focusedKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.radarKey : undefined;

	const footer = state.lastCheck
		? `Last checked ${formatTime({ seconds: state.lastCheck }, { type: "ago" })}. Times assume a ${travelMethod()} ticket; the bell sends a notification when to leave and when the item restocks.`
		: "The radar reads the stock services every 5 minutes while your browser is open. Predictions appear after its first checks.";

	content.replaceChildren(
		elementBuilder({
			type: "div",
			id: "tt-travel-radar",
			children: [
				elementBuilder({
					type: "div",
					class: ["tt-radar-row", "header"],
					children: [
						elementBuilder({ type: "div", class: "item", text: "Item" }),
						elementBuilder({ type: "div", class: "status", text: "Now" }),
						elementBuilder({ type: "div", class: "plan", text: "Plan" }),
						elementBuilder({ type: "div", class: "watch", text: "Notify" }),
					],
				}),
				...rows.map(toRow),
				elementBuilder({ type: "p", class: "tt-radar-footer", text: footer }),
			],
		}),
	);

	// Keep keyboard focus on the bell that had it.
	if (focusedKey) findElement(`button.watch[data-radar-key="${CSS.escape(focusedKey)}"]`, content, true)?.focus();
}

export default class TravelRadarFeature extends Feature {
	constructor() {
		super("Travel Radar", "travel");
	}

	override precondition() {
		return !isAbroad() && !isFlying();
	}

	override isEnabled() {
		return settings.pages.travel.radar;
	}

	override execute() {
		// Built once and refreshed in place, so the panel keeps its spot on the page and focus survives a refresh.
		content = createContainer("Travel Radar", { defaultPosition: true, class: "mt10" }).content;
		render();
		refreshTimer ??= setInterval(() => {
			try {
				render();
			} catch (error) {
				logger.error("Failed to refresh the travel radar.", error);
			}
		}, REFRESH_MS);
	}

	override storageKeys() {
		return ["settings.pages.travel.radar", "settings.external.yata", "settings.external.prometheus", "settings.external.tornintel"];
	}

	override requirements() {
		if (!settings.external.yata && !settings.external.prometheus && !settings.external.tornintel) return "Prometheus, Torn Intel and YATA not enabled";
		else if (isCaptcha()) return "Captcha present.";

		return true;
	}
}
