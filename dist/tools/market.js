/** Market and trading: price, history, cross-server comparison (B1–B3). @module dsh-plugin-ffxiv/tools/market */
import { guardTool, requireString } from '../core/define.js';
import { withDisclaimer } from '../core/env.js';
import { clampInt, formatGil, gil, relativeTime } from '../core/format.js';
import { text } from '../core/types.js';
import { cheapestListing, getMarket, resolveServerInput, sortedListings } from '../core/universalis.js';
import { resolveItem } from '../core/xivapi.js';
const listingSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        pricePerUnit: { type: 'integer' },
        quantity: { type: 'integer' },
        hq: { type: 'boolean' },
        worldName: { type: 'string' },
    },
    required: ['pricePerUnit', 'quantity', 'hq'],
};
const cheapestSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        price: { type: 'integer' },
        hq: { type: 'boolean' },
        quantity: { type: 'integer' },
        worldName: { type: 'string' },
    },
    required: ['price', 'hq', 'quantity'],
};
function uploadAgeMinutes(lastUploadTime) {
    if (!lastUploadTime)
        return undefined;
    const delta = Math.floor((Date.now() - lastUploadTime) / 60000);
    return Number.isFinite(delta) ? Math.max(0, delta) : undefined;
}
/** Build the market-domain tool definitions. */
export function createMarketTools(define) {
    const marketPrice = define({
        name: 'ffxiv_market_price',
        description: '当用户询问 FF14 某物品在指定服务器、大区或跨服大区（如“神意之地”“莫古力”“陆行鸟”）的板子当前最低售价、在售数量，或要求查价/看现价时调用此工具。可选只看 HQ。',
        parameters: {
            itemName: { type: 'string', required: true, description: '物品中文名称（支持部分名称）' },
            server: {
                type: 'string',
                required: true,
                description: '服务器名、大区名或 DC 名，例如“神意之地”“莫古力”“陆行鸟”',
            },
            hqOnly: { type: 'boolean', description: '只看 HQ 在售（默认 false）', default: false },
            limit: { type: 'integer', description: '最多返回多少条在售记录（默认 5，最大 20）', default: 5 },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    itemId: { type: 'integer' },
                    itemName: { type: 'string' },
                    server: { type: 'string' },
                    cheapest: cheapestSchema,
                    listings: { type: 'array', items: listingSchema },
                    lastUploadAgeMinutes: { type: 'integer' },
                    message: { type: 'string' },
                },
                required: ['itemId', 'itemName', 'server', 'listings'],
            },
            render(args, value) {
                if (value.message && value.listings.length === 0) {
                    return [text(withDisclaimer([`${value.server} · ${value.itemName}`, String(value.message)]))];
                }
                const lines = [];
                if (value.cheapest) {
                    lines.push(`${value.server} · ${value.itemName} · 最低价 ${gil(value.cheapest.price)}（${value.cheapest.hq ? 'HQ' : 'NQ'}）`);
                }
                else {
                    lines.push(`${value.server} · ${value.itemName}`);
                }
                if (value.lastUploadAgeMinutes !== undefined) {
                    const age = Number(value.lastUploadAgeMinutes);
                    const hint = age >= 60 ? '（数据可能滞后）' : '';
                    lines.push(`数据更新：${age < 1 ? '1 分钟内' : `${age} 分钟前`}${hint}`);
                }
                lines.push(`在售（前 ${value.listings.length} 条）：`);
                for (const listing of value.listings) {
                    const world = listing.worldName ? ` · ${listing.worldName}` : '';
                    lines.push(`- ${formatGil(listing.pricePerUnit)} G × ${listing.quantity}${listing.hq ? '（HQ）' : ''}${world}`);
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(withDisclaimer(lines))];
            },
        },
        execute: guardTool('ffxiv_market_price', async (args, ctx) => {
            const itemName = requireString(args, 'itemName', '物品名称');
            const serverInput = requireString(args, 'server', '服务器');
            const hqOnly = args.hqOnly === true;
            const limit = clampInt(args.limit, 5, 1, 20);
            const resolved = resolveServerInput(serverInput);
            const item = await resolveItem(itemName, ctx.signal);
            if (!item) {
                return {
                    itemId: 0,
                    itemName,
                    server: resolved.display,
                    listings: [],
                    message: `未找到与“${itemName}”匹配的物品，请先用 ffxiv_search_item 确认名称。`,
                };
            }
            const snapshot = await getMarket(resolved.query, item.id, { listings: limit, signal: ctx.signal });
            if (!snapshot) {
                return {
                    itemId: item.id,
                    itemName: item.name,
                    server: resolved.display,
                    listings: [],
                    message: '该范围当前无在售记录。',
                };
            }
            const listings = sortedListings(snapshot.listings, hqOnly, limit);
            if (listings.length === 0) {
                return {
                    itemId: item.id,
                    itemName: item.name,
                    server: resolved.display,
                    listings: [],
                    ...(snapshot.lastUploadTime ? { lastUploadAgeMinutes: uploadAgeMinutes(snapshot.lastUploadTime) } : {}),
                    message: hqOnly ? '该范围当前无 HQ 在售记录。' : '该范围当前无在售记录。',
                };
            }
            const best = cheapestListing(snapshot.listings, hqOnly);
            const age = uploadAgeMinutes(snapshot.lastUploadTime);
            return {
                itemId: item.id,
                itemName: item.name,
                server: resolved.display,
                ...(best
                    ? {
                        cheapest: {
                            price: best.pricePerUnit,
                            hq: best.hq,
                            quantity: best.quantity,
                            ...(best.worldName ? { worldName: best.worldName } : {}),
                        },
                    }
                    : {}),
                listings: listings.map((listing) => ({
                    pricePerUnit: listing.pricePerUnit,
                    quantity: listing.quantity,
                    hq: listing.hq,
                    ...(listing.worldName ? { worldName: listing.worldName } : {}),
                })),
                ...(age !== undefined ? { lastUploadAgeMinutes: age } : {}),
            };
        }),
    });
    const marketHistory = define({
        name: 'ffxiv_market_history',
        description: '当用户询问 FF14 某物品近期的成交记录、成交价走势，或想判断某物品最近卖多少、卖得快不快时调用此工具。返回指定服务器/大区的最近成交记录（按时间倒序）。',
        parameters: {
            itemName: { type: 'string', required: true, description: '物品中文名称（支持部分名称）' },
            server: { type: 'string', required: true, description: '服务器名、大区名或 DC 名' },
            entries: { type: 'integer', description: '返回最近多少笔成交（默认 10，最大 20）', default: 10 },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    itemId: { type: 'integer' },
                    itemName: { type: 'string' },
                    server: { type: 'string' },
                    entries: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                pricePerUnit: { type: 'integer' },
                                quantity: { type: 'integer' },
                                hq: { type: 'boolean' },
                                timestamp: { type: 'integer' },
                            },
                            required: ['pricePerUnit', 'quantity', 'hq', 'timestamp'],
                        },
                    },
                    message: { type: 'string' },
                },
                required: ['itemId', 'itemName', 'server', 'entries'],
            },
            render(args, value) {
                if (value.entries.length === 0) {
                    return [text(String(value.message ?? '暂无成交记录。'))];
                }
                const lines = [`${value.server} · ${value.itemName} · 最近 ${value.entries.length} 笔成交：`];
                for (const entry of value.entries) {
                    lines.push(`- ${relativeTime(entry.timestamp)}：${formatGil(entry.pricePerUnit)} G × ${entry.quantity}${entry.hq ? '（HQ）' : ''}`);
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(withDisclaimer(lines))];
            },
        },
        execute: guardTool('ffxiv_market_history', async (args, ctx) => {
            const itemName = requireString(args, 'itemName', '物品名称');
            const serverInput = requireString(args, 'server', '服务器');
            const entries = clampInt(args.entries, 10, 1, 20);
            const resolved = resolveServerInput(serverInput);
            const item = await resolveItem(itemName, ctx.signal);
            if (!item) {
                return {
                    itemId: 0,
                    itemName,
                    server: resolved.display,
                    entries: [],
                    message: `未找到与“${itemName}”匹配的物品，请先用 ffxiv_search_item 确认名称。`,
                };
            }
            const snapshot = await getMarket(resolved.query, item.id, { entries, signal: ctx.signal });
            if (!snapshot) {
                return { itemId: item.id, itemName: item.name, server: resolved.display, entries: [], message: '暂无成交记录。' };
            }
            const history = snapshot.recentHistory
                .slice()
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, entries)
                .map((entry) => ({
                pricePerUnit: entry.pricePerUnit,
                quantity: entry.quantity,
                hq: entry.hq,
                timestamp: entry.timestamp,
            }));
            if (history.length === 0) {
                return { itemId: item.id, itemName: item.name, server: resolved.display, entries: [], message: '暂无成交记录。' };
            }
            return { itemId: item.id, itemName: item.name, server: resolved.display, entries: history };
        }),
    });
    const marketCompare = define({
        name: 'ffxiv_market_compare',
        description: '当用户想比较 FF14 同一物品在多个服务器/大区的最低售价，判断去哪里买更便宜、跨服比价时调用此工具。一次性传入逗号分隔的服务器列表（最多 6 个），返回按价格升序的对比表。',
        parameters: {
            itemName: { type: 'string', required: true, description: '物品中文名称（支持部分名称）' },
            servers: {
                type: 'string',
                required: true,
                description: '逗号分隔的服务器/大区列表，例如“神意之地,红玉海,莫古力”，最多 6 个',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    itemId: { type: 'integer' },
                    itemName: { type: 'string' },
                    results: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                server: { type: 'string' },
                                cheapest: cheapestSchema,
                                message: { type: 'string' },
                            },
                            required: ['server'],
                        },
                    },
                    message: { type: 'string' },
                },
                required: ['itemId', 'itemName', 'results'],
            },
            render(args, value) {
                if (value.results.length === 0)
                    return [text(String(value.message ?? '没有可比较的服务器。'))];
                const lines = [`跨服比价：${value.itemName}`, '服务器 | 最低价 | 数量 | HQ'];
                for (const row of value.results) {
                    if (row.cheapest) {
                        lines.push(`${row.server} | ${formatGil(row.cheapest.price)} G | ${row.cheapest.quantity} | ${row.cheapest.hq ? 'HQ' : 'NQ'}`);
                    }
                    else {
                        lines.push(`${row.server} | 无在售 | - | -`);
                    }
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(withDisclaimer(lines))];
            },
        },
        timeoutMs: 45_000,
        execute: guardTool('ffxiv_market_compare', async (args, ctx) => {
            const itemName = requireString(args, 'itemName', '物品名称');
            const rawServers = requireString(args, 'servers', '服务器列表');
            const allServers = rawServers
                .split(/[,，、;；\s]+/)
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0);
            const servers = [...new Set(allServers)].slice(0, 6);
            const notes = [];
            if (allServers.length > 6)
                notes.push('最多比较 6 个服务器，已忽略多余项。');
            if (servers.length === 0)
                throw new Error('服务器列表不能为空');
            const item = await resolveItem(itemName, ctx.signal);
            if (!item) {
                return {
                    itemId: 0,
                    itemName,
                    results: [],
                    message: `未找到与“${itemName}”匹配的物品，请先用 ffxiv_search_item 确认名称。`,
                };
            }
            const results = [];
            const failed = [];
            for (const rawServer of servers) {
                const resolved = resolveServerInput(rawServer);
                try {
                    const snapshot = await getMarket(resolved.query, item.id, {
                        listings: 1,
                        signal: ctx.signal,
                        timeoutMs: 8000,
                    });
                    if (!snapshot || snapshot.listings.length === 0) {
                        results.push({ server: resolved.display, message: '无在售记录' });
                        continue;
                    }
                    const best = cheapestListing(snapshot.listings, false);
                    results.push({
                        server: resolved.display,
                        ...(best
                            ? {
                                cheapest: {
                                    price: best.pricePerUnit,
                                    hq: best.hq,
                                    quantity: best.quantity,
                                    ...(best.worldName ? { worldName: best.worldName } : {}),
                                },
                            }
                            : {}),
                    });
                }
                catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    failed.push(`${resolved.display}（${reason}）`);
                    results.push({ server: resolved.display, message: `查询失败：${reason}` });
                }
            }
            if (failed.length > 0)
                notes.push(`以下服务器查询失败，未计入比价：${failed.join('；')}。`);
            results.sort((a, b) => {
                if (a.cheapest && b.cheapest)
                    return a.cheapest.price - b.cheapest.price;
                if (a.cheapest)
                    return -1;
                if (b.cheapest)
                    return 1;
                return 0;
            });
            return {
                itemId: item.id,
                itemName: item.name,
                results,
                ...(notes.length > 0 ? { message: notes.join('') } : {}),
            };
        }),
    });
    return [marketPrice, marketHistory, marketCompare];
}
