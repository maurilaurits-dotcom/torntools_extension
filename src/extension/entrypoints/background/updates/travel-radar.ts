import { ttStorage } from "@common/utils/context";
import { api, settings, travelRadar, userdata } from "@common/utils/data/database";
import { hasAPIData } from "@common/utils/functions/api";
import { formatTime } from "@common/utils/functions/formatting";
import { logger } from "@common/utils/functions/logger";
import { LINKS } from "@common/utils/functions/torn";
import { TO_MILLIS } from "@common/utils/functions/utilities";
import { CHECK_SECONDS, COUNTRY_NAMES, NEVER, radarStateOf, tick, toTravelMethod } from "@features/travel-radar/radar-core";
import type { RadarPing, RadarState, RadarUser } from "@features/travel-radar/radar-core";
import { fetchTravelData } from "@features/travel-table/travel-data-fetcher";
import { dispatchNotification, newNotification } from "../notifications";

/** The data alarm fires every 30 s; a check is due once CHECK_SECONDS have nearly passed. */
const DUE_TOLERANCE = 15;
/** Heads-up before the leave-by time. */
const LEAD_SECONDS = 180;
/** Pings that assume "you can fly now" trust the Torn status only this long. */
const STATUS_MAX_AGE = (CHECK_SECONDS + 60) * TO_MILLIS.SECONDS;

export async function updateTravelRadar(): Promise<{ updated: boolean; alerts: number }> {
	if (!settings.pages.travel.radar) return { updated: false, alerts: 0 };

	const now = Math.floor(Date.now() / TO_MILLIS.SECONDS);
	const stored = radarStateOf(travelRadar);
	// A last check in the future means the clock was corrected: check now rather than wait for it.
	if (stored.lastCheck <= now && now - stored.lastCheck < CHECK_SECONDS - DUE_TOLERANCE) return { updated: false, alerts: 0 };

	let pings: RadarPing[];
	try {
		pings = await check(stored, now);
	} catch (error) {
		// Wait for the next check rather than retrying every 30 s while something is broken.
		await ttStorage.set({ travelRadar: { ...stored, lastCheck: now } });
		throw error;
	}

	let alerts = 0;
	for (const ping of pings) {
		try {
			await dispatchNotification(toNotification(ping));
			alerts++;
		} catch (error) {
			logger.error("Failed to send a travel radar notification.", error);
		}
	}

	return { updated: true, alerts };
}

/** Reads the feed, learns from it and stores the result; returns the pings that are due. */
async function check(stored: RadarState, now: number): Promise<RadarPing[]> {
	const { stocks } = await fetchTravelData();
	if (!stocks) {
		await ttStorage.set({ travelRadar: { ...stored, lastCheck: now } });
		return [];
	}

	const notify = settings.notifications.types.global && settings.notifications.types.travelRadar;
	const result = tick({
		state: stored,
		snapshot: stocks,
		now,
		watched: notify ? settings.pages.travel.radarWatched : [],
		user: radarUser(),
		leadSeconds: LEAD_SECONDS,
	});
	// Stored before sending, so a ping is never sent twice even if a notification fails.
	await ttStorage.set({ travelRadar: result.state });
	return result.pings;
}

function radarUser(): RadarUser | null {
	if (!api.torn.key || !hasAPIData()) return null;

	const isFresh = Date.now() - userdata.date <= STATUS_MAX_AGE;
	return {
		canFly: isFresh && userdata.profile?.status?.state === "Okay",
		method: toTravelMethod(settings.apiUsage.user.travel ? userdata.travel?.method : null),
	};
}

function clock(seconds: number) {
	return formatTime({ seconds }, { hideSeconds: true });
}

function toNotification(ping: RadarPing) {
	const country = COUNTRY_NAMES[ping.country];

	if (ping.type === "leaveNow" && ping.leaveBy !== undefined && ping.restock) {
		return newNotification(
			`Fly to ${country} by ${clock(ping.leaveBy)}`,
			`${ping.name} restocks ~${clock(ping.restock.center)} (be there ${clock(ping.restock.start)}), you'd land ${clock(ping.landAt)}.`,
			LINKS.travelagency,
		);
	}

	const lasts = ping.runOutAt === NEVER || ping.runOutAt === undefined ? "is barely selling" : `should last until ~${clock(ping.runOutAt)}`;
	return newNotification(`${ping.name} restocked in ${country}`, `It ${lasts}, you'd land ${clock(ping.landAt)}.`, LINKS.travelagency);
}
