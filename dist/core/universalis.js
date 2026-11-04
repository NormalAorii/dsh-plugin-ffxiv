/** Universalis market data access with global throttling and Chinese server resolution. @module dsh-plugin-ffxiv/core/universalis */
import { CN_DATACENTERS, CN_WORLDS, canonicalChineseServer, INTERNATIONAL_DATACENTERS } from '../data/worlds.js';
import { ENDPOINTS } from './env.js';
import { requestJsonOrNull } from './http.js';
import { universalisLimiter } from './throttle.js';
function base() {
    return ENDPOINTS.universalisBase().replace(/\/+$/, '');
}
/** Resolve a Chinese/English server, data-center, or numeric world id. */
export function resolveServerInput(raw) {
    const input = raw.trim();
    const chinese = canonicalChineseServer(input);
    if (chinese) {
        const isDc = CN_DATACENTERS.some((dc) => dc.name === chinese);
        if (isDc)
            return { query: chinese, display: chinese, kind: 'dc' };
        // Numeric world ids are the most reliable Universalis path for CN worlds.
        const world = CN_WORLDS.find((entry) => entry.name === chinese);
        if (world)
            return { query: String(world.id), display: chinese, kind: 'world' };
        return { query: chinese, display: chinese, kind: 'world' };
    }
    if (/^\d+$/.test(input)) {
        const world = CN_WORLDS.find((entry) => entry.id === Number(input));
        return { query: input, display: world ? world.name : input, kind: 'id' };
    }
    const internationalDc = INTERNATIONAL_DATACENTERS.find((name) => name.toLowerCase() === input.toLowerCase());
    if (internationalDc)
        return { query: internationalDc, display: internationalDc, kind: 'dc' };
    return { query: input, display: input, kind: 'raw' };
}
/** True when the input looks like a Chinese data center (used for display hints). */
export function isDataCenterInput(raw) {
    const chinese = canonicalChineseServer(raw);
    if (chinese)
        return CN_DATACENTERS.some((dc) => dc.name === chinese);
    return INTERNATIONAL_DATACENTERS.some((name) => name.toLowerCase() === raw.trim().toLowerCase());
}
/** Fetch one market snapshot; `undefined` means the endpoint answered 404 (no data). */
export async function getMarket(serverQuery, itemId, options = {}) {
    const params = new URLSearchParams();
    if (options.listings !== undefined)
        params.set('listings', String(options.listings));
    if (options.entries !== undefined)
        params.set('entries', String(options.entries));
    const suffix = params.size > 0 ? `?${params.toString()}` : '';
    const url = `${base()}/${encodeURIComponent(serverQuery)}/${itemId}${suffix}`;
    const timeoutMs = options.timeoutMs ?? 9000;
    const fetchOnce = () => universalisLimiter.schedule(() => requestJsonOrNull(url, { timeoutMs, signal: options.signal }));
    let payload;
    try {
        payload = await fetchOnce();
    }
    catch (error) {
        if (options.signal?.aborted)
            throw error;
        await new Promise((resolve) => {
            setTimeout(resolve, 300);
        });
        payload = await fetchOnce();
    }
    if (!payload)
        return undefined;
    const listings = Array.isArray(payload.listings)
        ? payload.listings.map((row) => ({
            pricePerUnit: Number(row.pricePerUnit) || 0,
            quantity: Number(row.quantity) || 0,
            hq: row.hq === true,
            worldName: typeof row.worldName === 'string' ? row.worldName : undefined,
            retainerName: typeof row.retainerName === 'string' ? row.retainerName : undefined,
            lastReviewTime: typeof row.lastReviewTime === 'number' ? row.lastReviewTime : undefined,
        }))
        : [];
    const recentHistory = Array.isArray(payload.recentHistory)
        ? payload.recentHistory.map((row) => ({
            pricePerUnit: Number(row.pricePerUnit) || 0,
            quantity: Number(row.quantity) || 0,
            hq: row.hq === true,
            timestamp: Number(row.timestamp) || 0,
            buyerName: typeof row.buyerName === 'string' ? row.buyerName : undefined,
        }))
        : [];
    return {
        itemId: Number(payload.itemID) || itemId,
        worldName: typeof payload.worldName === 'string' ? payload.worldName : undefined,
        lastUploadTime: typeof payload.lastUploadTime === 'number' ? payload.lastUploadTime : undefined,
        listings,
        recentHistory,
        currentAveragePrice: typeof payload.currentAveragePrice === 'number' ? payload.currentAveragePrice : undefined,
    };
}
/** Pick the cheapest listing under an optional HQ filter. */
export function cheapestListing(listings, hqOnly) {
    let best;
    for (const listing of listings) {
        if (hqOnly && !listing.hq)
            continue;
        if (!best || listing.pricePerUnit < best.pricePerUnit)
            best = listing;
    }
    return best;
}
/** Sort listings by unit price ascending and keep the first `limit` rows. */
export function sortedListings(listings, hqOnly, limit) {
    return listings
        .filter((listing) => !hqOnly || listing.hq)
        .slice()
        .sort((a, b) => a.pricePerUnit - b.pricePerUnit)
        .slice(0, Math.max(1, limit));
}
/** The lowest unit price, ignoring listings with no stock. */
export function lowestUnitPrice(listings, hqOnly) {
    const best = cheapestListing(listings, hqOnly);
    return best ? { price: best.pricePerUnit, hq: best.hq } : undefined;
}
