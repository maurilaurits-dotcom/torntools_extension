// The report's live board: the extension branch's radar core, run in the browser against Prometheus.
import { CHECK_SECONDS, COUNTRY_NAMES, NEVER, SEED_STATS, flightSeconds, isPredictable, plan, runOutAt, splitKey, tick } from "./radar-core.js";

const FEED = "https://api.prombot.co.uk/api/travel";
const theme = new URLSearchParams(location.search).get("theme");
if (theme === "dark" || theme === "light") document.documentElement.dataset.theme = theme;
const CONFIRM_AFTER_MS = 60_000;
const rowsElement = document.getElementById("board-rows");
const statusElement = document.getElementById("board-status");
const ticketElement = document.getElementById("ticket");
const toastsElement = document.getElementById("toasts");

let state = null;
let lastRead = null;

const tct = (seconds) => new Date(seconds * 1000).toISOString().slice(11, 16);
const now = () => Math.floor(Date.now() / 1000);

function cell(text, className, sub) {
	const td = document.createElement("td");
	if (className) td.className = className;
	td.append(text);
	if (sub) {
		const span = document.createElement("span");
		span.className = "sub";
		span.textContent = sub;
		td.append(span);
	}
	return td;
}

function rows() {
	const method = ticketElement.value;
	const at = now();
	return Object.entries(state.tracker.entries)
		.map(([key, entry]) => ({ key, entry, parts: splitKey(key), stat: state.stats[key] }))
		.filter((row) => row.parts && row.stat && isPredictable(row.stat))
		.map((row) => ({ ...row, plan: plan(at, row.stat, row.entry.inStock, row.entry.quantity, flightSeconds(row.parts.country, method)) }))
		.sort((a, b) => order(a.plan) - order(b.plan) || a.entry.name.localeCompare(b.entry.name));
}

function order(itemPlan) {
	if (itemPlan.type === "goNow") return itemPlan.landAt - 1e10;
	if (itemPlan.type === "leaveBy") return itemPlan.leaveBy;
	return Number.MAX_SAFE_INTEGER;
}

function render() {
	const list = rows();
	rowsElement.replaceChildren(
		...list.map((row) => {
			const tr = document.createElement("tr");
			const shelf = row.entry.inStock ? `${row.entry.quantity.toLocaleString("en")} in stock` : row.entry.inStock === false ? "Empty" : "Checking";
			let planCell;
			if (row.plan.type === "goNow") planCell = cell("Go now", "go", `lands ${tct(row.plan.landAt)}`);
			else if (row.plan.type === "leaveBy") planCell = cell(`Leave ${tct(row.plan.leaveBy)}`, "", `restock ~${tct(row.plan.restock.center)}`);
			else planCell = cell("Watching", "wait", row.entry.inStock === null ? "confirming the shelf" : "waiting for a sell-out");
			tr.append(
				cell(COUNTRY_NAMES[row.parts.country]),
				cell(row.entry.name),
				cell(shelf, "num"),
				planCell,
				cell(`${row.stat.gapsMin.length} restocks`, "num col-learned"),
			);
			return tr;
		}),
	);
	if (!list.length) {
		const tr = document.createElement("tr");
		tr.className = "empty";
		const td = cell("No predictable item in the feed yet.");
		td.colSpan = 5;
		tr.append(td);
		rowsElement.replaceChildren(tr);
	}
	renderToasts(list);
}

/** The two notifications, worded as the extension's background updater words them. */
function renderToasts(list) {
	const leave = list.find((row) => row.plan.type === "leaveBy");
	const goNow = list.find((row) => row.plan.type === "goNow");
	const toasts = [];
	if (leave) {
		const { restock } = leave.plan;
		toasts.push([
			"",
			`TornTools - Fly to ${COUNTRY_NAMES[leave.parts.country]} by ${tct(leave.plan.leaveBy)}`,
			`${leave.entry.name} restocks ~${tct(restock.center)} (be there ${tct(restock.start)}), you'd land ${tct(leave.plan.landAt)}.`,
		]);
	}
	if (goNow) {
		const runOut = runOutAt(goNow.stat, now(), goNow.entry.quantity);
		const lasts = runOut === null || runOut === NEVER ? "is barely selling" : `should last until ~${tct(runOut)}`;
		toasts.push(["go", `TornTools - ${goNow.entry.name} restocked in ${COUNTRY_NAMES[goNow.parts.country]}`, `It ${lasts}, you'd land ${tct(goNow.plan.landAt)}.`]);
	}
	if (!toasts.length) return;
	toastsElement.replaceChildren(
		...toasts.map(([className, title, message]) => {
			const div = document.createElement("div");
			div.className = `toast ${className}`.trim();
			const strong = document.createElement("strong");
			strong.textContent = title;
			div.append(strong, message);
			return div;
		}),
	);
}

function setStatus(text, isLive) {
	statusElement.textContent = text;
	statusElement.classList.toggle("off", !isLive);
}

async function read() {
	try {
		const response = await fetch(FEED, { cache: "no-store" });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const feed = await response.json();
		if (!feed || typeof feed.stocks !== "object") throw new Error("unexpected response");
		state = tick({ state, snapshot: feed.stocks, now: now(), watched: [], user: null, leadSeconds: 180 }).state;
		lastRead = now();
		setStatus(`Live, read ${tct(lastRead)} TCT`, true);
	} catch (error) {
		setStatus(`Couldn't reach Prometheus (${error.message}); retrying`, false);
	}
	render();
}

async function start() {
	try {
		const warm = await (await fetch("warm-state.json")).json();
		state = { ...warm, stats: { ...SEED_STATS, ...warm.stats } };
	} catch {
		state = { tracker: { entries: {}, countrySeenAt: {} }, stats: SEED_STATS, sent: {}, lastCheck: 0 };
	}
	ticketElement.addEventListener("change", render);
	await read();
	// A second reading a minute later confirms the shelves; after that, the extension's own pace.
	setTimeout(() => {
		void read();
		setInterval(read, CHECK_SECONDS * 1000);
	}, CONFIRM_AFTER_MS);
	setInterval(() => lastRead && render(), 30_000);
}

void start();
