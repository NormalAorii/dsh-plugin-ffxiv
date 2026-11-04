/** Social and community tools: housing, party finder, fashion report, blue mage, official news (F1–F5). @module dsh-plugin-ffxiv/tools/social */
import { guardTool, optionalString, requireString } from '../core/define.js';
import { ENDPOINTS } from '../core/env.js';
import { clampInt, formatGil, truncate } from '../core/format.js';
import { requestJson, requestText } from '../core/http.js';
import { text } from '../core/types.js';
import { CN_DATACENTERS, CN_WORLDS, canonicalChineseServer } from '../data/worlds.js';
import { findBlueMageSpells, getBlueMageTransient } from '../core/xivapi.js';
const housingPlotSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        area: { type: 'string' },
        ward: { type: 'integer' },
        plot: { type: 'integer' },
        size: { type: 'string' },
        price: { type: 'integer' },
        lotteryStatus: { type: 'string' },
    },
    required: ['ward', 'plot', 'size', 'price'],
};
const partyListingSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'integer' },
        title: { type: 'string' },
        world: { type: 'string' },
        dc: { type: 'string' },
        category: { type: 'string' },
        slotsFilled: { type: 'integer' },
        slotsAvailable: { type: 'integer' },
        timeLeftMinutes: { type: 'integer' },
        roles: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
    },
    required: ['title'],
};
const fashionEntrySchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        slot: { type: 'string' },
        item: { type: 'string' },
        dye: { type: 'string' },
        hq: { type: 'boolean' },
    },
    required: ['slot', 'item'],
};
const newsItemSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        title: { type: 'string' },
        url: { type: 'string' },
        summary: { type: 'string' },
        publishedAt: { type: 'string' },
    },
    required: ['title', 'url'],
};
/** Read one trimmed non-empty string field without trusting the remote shape. */
function asString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
/** Append only the non-empty query parameters to one endpoint URL. */
function endpointUrl(endpoint, pairs) {
    const query = [];
    for (const [key, value] of pairs) {
        if (value === undefined || value === '')
            continue;
        query.push(`${key}=${encodeURIComponent(String(value))}`);
    }
    if (query.length === 0)
        return endpoint;
    const glue = endpoint.endsWith('?') || endpoint.endsWith('&') ? '' : endpoint.includes('?') ? '&' : '?';
    return `${endpoint}${glue}${query.join('&')}`;
}
/** Normalize a roles field that may be an array or a delimited string. */
function roleList(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
    }
    if (typeof value === 'string') {
        return value
            .split(/[,，、/;；]+/)
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0);
    }
    return [];
}
/** Sleep for the given number of milliseconds. */
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/** Fetch JSON with a small retry loop; community endpoints are slow and flaky. */
async function fetchJsonWithRetry(url, attempts, timeoutMs, signal) {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await requestJson(url, { timeoutMs, signal });
        }
        catch (error) {
            lastError = error;
            if (signal?.aborted)
                throw error;
            if (attempt < attempts)
                await sleep(2000);
        }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
/* ------------------------------------------------------------------ */
/* Housing                                                             */
/* ------------------------------------------------------------------ */
/** Housing district ids used by the sales feed. */
const HOUSING_AREAS = [
    { id: 0, name: '海雾村', aliases: ['海雾', '海雾村', 'mist'] },
    { id: 1, name: '薰衣草苗圃', aliases: ['薰衣草', '薰衣草苗圃', 'lavender', '薰衣草園'] },
    { id: 2, name: '高脚孤丘', aliases: ['高脚', '高脚孤丘', 'goblet'] },
    { id: 3, name: '白银乡', aliases: ['白银', '白银乡', 'shirogane'] },
    { id: 4, name: '穹顶皓天', aliases: ['穹顶', '穹顶皓天', 'empyreum'] },
];
/** Plot size enum used by the sales feed (0 = S, 1 = M, 2 = L). */
const HOUSING_SIZE_NAMES = ['S', 'M', 'L'];
/** Resolve a Chinese world name to its numeric world id. */
function resolveWorldId(raw) {
    const canonical = canonicalChineseServer(raw) ?? raw.trim();
    const world = CN_WORLDS.find((entry) => entry.name === canonical);
    if (world)
        return world.id;
    if (/^\d+$/.test(canonical))
        return Number(canonical);
    return undefined;
}
/** Resolve a district alias to its sales-feed id. */
function resolveHousingArea(raw) {
    if (!raw)
        return undefined;
    const key = raw.trim().toLowerCase();
    const found = HOUSING_AREAS.find((area) => area.aliases.some((alias) => alias.toLowerCase() === key) || area.name === raw.trim());
    return found ? { id: found.id, name: found.name } : undefined;
}
/** Resolve one user size token (S/M/L or 小/中/大) to the feed enum. */
function resolveHousingSize(raw) {
    if (!raw)
        return undefined;
    const key = raw.trim().toLowerCase();
    const byLetter = HOUSING_SIZE_NAMES.indexOf(key.toUpperCase());
    if (byLetter >= 0)
        return byLetter;
    if (key === '小')
        return 0;
    if (key === '中')
        return 1;
    if (key === '大')
        return 2;
    return undefined;
}
/** Describe one sale row's status in Chinese. */
function describeHousingStatus(row) {
    if (row.PurchaseType === 2)
        return row.State === 2 ? '抽签公示中' : '抽签中';
    return '先到先得';
}
/* ------------------------------------------------------------------ */
/* Party finder                                                        */
/* ------------------------------------------------------------------ */
/** Chinese party category names mapped to the xivpf v1 category enum. */
const PARTY_CATEGORY_MAP = [
    { aliases: ['高难', '高难度', '零式', '绝', '绝境战'], value: 'HighEndDuty', label: '高难' },
    { aliases: ['讨伐', '讨伐战', '极神', '歼殛战'], value: 'Trials', label: '讨伐' },
    { aliases: ['大型任务', '大型', '零式大型', '副本'], value: 'Raids', label: '大型任务' },
    { aliases: ['团队任务', '团队', '24人'], value: 'AllianceRaid', label: '团队任务' },
    { aliases: ['迷宫', '迷宫挑战', '四人本'], value: 'Dungeons', label: '副本' },
    { aliases: ['随机', '随机任务'], value: 'DutyRoulette', label: '随机任务' },
    { aliases: ['行会令'], value: 'Guildhests', label: '行会令' },
    { aliases: ['狩猎', '怪物狩猎', 'fate', 'FATE'], value: 'TheHunt', label: '怪物狩猎' },
    { aliases: ['寻宝', '挖宝', '宝图'], value: 'TreasureHunt', label: '寻宝' },
    { aliases: ['金碟', '金碟游乐场'], value: 'GoldSaucer', label: '金碟' },
    { aliases: ['PvP', 'pvp', '战场', '竞技场'], value: 'PvP', label: 'PvP' },
    { aliases: ['其他', '其它'], value: 'None', label: '其他' },
];
/** English category enum → Chinese label shown in output. */
const PARTY_CATEGORY_LABELS = Object.fromEntries(PARTY_CATEGORY_MAP.map((entry) => [entry.value, entry.label]));
/** ClassJob id → Chinese job name used by party finder detail slots. */
const JOB_NAMES = {
    19: '骑士',
    20: '武僧',
    21: '战士',
    22: '龙骑士',
    23: '吟游诗人',
    24: '白魔法师',
    25: '黑魔法师',
    26: '秘术师',
    27: '召唤师',
    28: '学者',
    30: '忍者',
    31: '机工士',
    32: '暗黑骑士',
    33: '占星术士',
    34: '武士',
    35: '赤魔法师',
    36: '青魔法师',
    37: '绝枪战士',
    38: '舞者',
    39: '钐镰客',
    40: '贤者',
    41: '蝰蛇剑士',
    42: '绘灵法师',
};
/** Translate one unfilled slot into a required-job label. */
function describeSlot(slot) {
    if (!slot || typeof slot !== 'object' || slot.filled === true)
        return undefined;
    const jobIds = Array.isArray(slot.job_id)
        ? slot.job_id.map((value) => Number(value)).filter((value) => Number.isFinite(value))
        : [];
    if (jobIds.length === 1) {
        const jobId = jobIds[0];
        const name = JOB_NAMES[jobId];
        if (name)
            return name;
    }
    const role = asString(slot.role)?.toLowerCase();
    if (role === 'tank')
        return '坦克';
    if (role === 'healer')
        return '治疗';
    if (role === 'dps')
        return '输出';
    return '任意职业';
}
/* ------------------------------------------------------------------ */
/* News                                                               */
/* ------------------------------------------------------------------ */
const LODESTONE_ORIGIN = 'https://na.finalfantasyxiv.com';
/** Decode the small HTML entity set found in Lodestone titles. */
function decodeHtmlEntities(value) {
    const fromCode = (raw, radix) => {
        const code = Number.parseInt(raw, radix);
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff)
            return '';
        return String.fromCodePoint(code);
    };
    return value
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCode(hex, 16))
        .replace(/&#(\d+);/g, (_, dec) => fromCode(dec, 10))
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&nbsp;/g, ' ');
}
/** Strip HTML tags and decode entities from a feed description. */
function plainText(value) {
    return decodeHtmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
/** Extract one tag's text from an RSS item block. */
function rssTag(block, tag) {
    const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
    if (!match)
        return undefined;
    const raw = match[1] ?? '';
    const cdata = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
    return cdata ? (cdata[1] ?? '') : raw;
}
/** Extract an Atom link href from an entry block. */
function atomLink(block) {
    const match = block.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i);
    return match?.[1];
}
/** Parse RSS 2.0 items or Atom entries into news rows. */
function parseRssItems(xml, limit) {
    const items = [];
    const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) ?? [];
    for (const block of blocks) {
        const titleRaw = rssTag(block, 'title');
        if (!titleRaw)
            continue;
        const title = plainText(titleRaw);
        if (title.length === 0)
            continue;
        const link = rssTag(block, 'link')?.trim() ?? atomLink(block) ?? '';
        const url = plainText(link);
        if (!url.startsWith('http'))
            continue;
        const summaryRaw = rssTag(block, 'description') ?? rssTag(block, 'summary') ?? rssTag(block, 'content');
        const summary = summaryRaw ? truncate(plainText(summaryRaw), 120) : undefined;
        const published = rssTag(block, 'pubDate') ?? rssTag(block, 'published') ?? rssTag(block, 'updated');
        const publishedAt = published ? plainText(published) : undefined;
        items.push({
            title,
            url,
            ...(summary ? { summary } : {}),
            ...(publishedAt ? { publishedAt } : {}),
        });
        if (items.length >= limit)
            break;
    }
    return items;
}
/** Build one news row from a detail href plus its visible title text. */
function newsItemFrom(href, rawTitle, seen) {
    const path = href.split(/[?#]/)[0] ?? '';
    const title = decodeHtmlEntities(rawTitle.replace(/\s+/g, ' ').trim());
    if (!path.startsWith('/lodestone/topics/detail/') || title.length === 0 || seen.has(path))
        return undefined;
    seen.add(path);
    return { title, url: `${LODESTONE_ORIGIN}${path}` };
}
/** Extract Lodestone topic entries from the Topics page HTML (fallback source). */
function parseLodestoneTopics(html, limit) {
    const items = [];
    const seen = new Set();
    const anchors = /<a[^>]*href="(\/lodestone\/topics\/detail\/[^"]+)"[^>]*>([^<]{2,})<\/a>/g;
    for (const match of html.matchAll(anchors)) {
        const item = newsItemFrom(match[1] ?? '', match[2] ?? '', seen);
        if (!item)
            continue;
        items.push(item);
        if (items.length >= limit)
            return items;
    }
    return items;
}
/** Build the social-domain tool definitions. */
export function createSocialTools(define) {
    const housing = define({
        name: 'ffxiv_housing',
        description: '当用户询问 FF14 某国服服务器的空房、在售房屋、抽签房屋或想找可买房地时调用此工具。数据来自艾欧泽亚售楼中心公开接口（house.ffxiv.cyou），返回在售/抽签中的房屋列表。',
        parameters: {
            server: { type: 'string', required: true, description: '国服服务器名，例如“神意之地”“红玉海”' },
            district: {
                type: 'string',
                description: '房区名，可选，例如“海雾村”“薰衣草苗圃”“高脚孤丘”“白银乡”“穹顶皓天”',
            },
            size: { type: 'string', description: '只返回指定大小：S / M / L（可选）' },
            limit: { type: 'integer', description: '最多返回多少条房屋记录（默认 5，最大 20）', default: 5 },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    supported: { type: 'boolean' },
                    server: { type: 'string' },
                    district: { type: 'string' },
                    size: { type: 'string' },
                    plots: { type: 'array', items: housingPlotSchema },
                    message: { type: 'string' },
                },
                required: ['supported', 'server', 'plots'],
            },
            render(args, value) {
                if (!value.supported)
                    return [text(String(value.message ?? '房屋数据接口暂不可用。'))];
                if (!Array.isArray(value.plots) || value.plots.length === 0) {
                    return [text(String(value.message ?? '该条件下暂无在售/抽签房屋。'))];
                }
                const lines = [
                    `房屋信息：${value.server}${value.district ? ` · ${value.district}` : ''}${value.size ? ` · ${value.size}` : ''}`,
                ];
                for (const plot of value.plots) {
                    const price = typeof plot.price === 'number' ? `${formatGil(plot.price)} G` : '价格未知';
                    lines.push(`- ${plot.area ?? value.district ?? '房屋'} ${plot.ward} 区 ${plot.plot} 号（${plot.size}）· ${price}${plot.lotteryStatus ? ` · ${plot.lotteryStatus}` : ''}`);
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_housing', async (args, ctx) => {
            const server = requireString(args, 'server', '服务器');
            const limit = clampInt(args.limit, 5, 1, 20);
            const districtRaw = optionalString(args, 'district');
            const sizeRaw = optionalString(args, 'size');
            const worldId = resolveWorldId(server);
            const area = resolveHousingArea(districtRaw);
            const sizeId = resolveHousingSize(sizeRaw);
            if (districtRaw && !area) {
                return {
                    supported: false,
                    server,
                    plots: [],
                    message: `无法识别房区“${districtRaw}”。可用：海雾村、薰衣草苗圃、高脚孤丘、白银乡、穹顶皓天。`,
                };
            }
            if (sizeRaw && sizeId === undefined) {
                return { supported: false, server, plots: [], message: `无法识别房屋大小“${sizeRaw}”。可用：S、M、L。` };
            }
            if (worldId === undefined) {
                return {
                    supported: false,
                    server,
                    plots: [],
                    message: `无法把“${server}”解析为国服服务器 ID。请使用国服服务器名，如“神意之地”。`,
                };
            }
            const endpoint = ENDPOINTS.housing();
            let payload;
            try {
                payload = await fetchJsonWithRetry(endpointUrl(endpoint, [['server', worldId]]), 2, 40000, ctx.signal);
            }
            catch (error) {
                return {
                    supported: false,
                    server,
                    plots: [],
                    message: `房屋数据接口暂时不可用（${error instanceof Error ? error.message : String(error)}）。可设置 FFXIV_HOUSING_ENDPOINT 指向兼容接口。`,
                };
            }
            const rows = Array.isArray(payload) ? payload : [];
            const plots = [];
            for (const row of rows) {
                if (!row || typeof row !== 'object')
                    continue;
                const areaId = Number(row.Area);
                const size = Number(row.Size);
                const purchaseType = Number(row.PurchaseType);
                if (area && areaId !== area.id)
                    continue;
                if (sizeId !== undefined && size !== sizeId)
                    continue;
                if (purchaseType !== 1 && purchaseType !== 2)
                    continue;
                const ward = Number(row.Slot);
                const plotNumber = Number(row.ID);
                const price = Number(row.Price);
                if (!Number.isFinite(ward) || !Number.isFinite(plotNumber) || !Number.isFinite(price))
                    continue;
                plots.push({
                    ...(HOUSING_AREAS[areaId]?.name ? { area: HOUSING_AREAS[areaId]?.name } : {}),
                    ward: Math.trunc(ward) + 1,
                    plot: Math.trunc(plotNumber),
                    size: HOUSING_SIZE_NAMES[size] ?? '?',
                    price: Math.trunc(price),
                    lotteryStatus: describeHousingStatus(row),
                });
            }
            plots.sort((left, right) => left.price - right.price);
            const total = plots.length;
            const limited = plots.slice(0, limit);
            const messages = ['房屋数据来自艾欧泽亚售楼中心公开接口，存在采集延迟，以游戏内实际为准。'];
            if (total > limited.length)
                messages.push(`共 ${total} 条可购买记录，已显示最低价前 ${limited.length} 条。`);
            if (limited.length === 0)
                messages.push(`该条件下暂无在售/抽签房屋。`);
            return {
                supported: true,
                server,
                ...(area ? { district: area.name } : {}),
                ...(sizeId !== undefined ? { size: HOUSING_SIZE_NAMES[sizeId] } : {}),
                plots: limited,
                message: messages.join(' '),
            };
        }),
        timeoutMs: 90000,
    });
    const partyFinder = define({
        name: 'ffxiv_party_finder',
        description: '当用户询问 FF14 远程招募板、当前高难/讨伐/大型任务招募、想找缺人队伍时调用此工具。数据来自社区远程招募板 xivpf，可按大区、分类、关键词筛选。',
        parameters: {
            dc: { type: 'string', description: '大区或服务器，例如“陆行鸟”“猫小胖”“神意之地”（可选）' },
            category: { type: 'string', description: '分类，例如“高难”“讨伐”“大型任务”（可选）' },
            keyword: { type: 'string', description: '在标题/描述中搜索的关键词（可选）' },
            limit: { type: 'integer', description: '最多返回多少条招募（默认 5，最大 20）', default: 5 },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    supported: { type: 'boolean' },
                    listings: { type: 'array', items: partyListingSchema },
                    message: { type: 'string' },
                },
                required: ['supported', 'listings'],
            },
            render(args, value) {
                if (!value.supported)
                    return [text(String(value.message ?? '远程招募板暂不可用。'))];
                if (!Array.isArray(value.listings) || value.listings.length === 0) {
                    return [text(String(value.message ?? '该条件下暂无招募。'))];
                }
                const lines = [`远程招募板（${value.listings.length} 条）：`];
                for (const listing of value.listings) {
                    const slots = listing.slotsFilled !== undefined && listing.slotsAvailable !== undefined
                        ? `${listing.slotsFilled}/${listing.slotsAvailable}`
                        : '人数未知';
                    const roles = Array.isArray(listing.roles) && listing.roles.length > 0 ? listing.roles.join('、') : '任意职业';
                    const timeLeft = listing.timeLeftMinutes !== undefined ? ` · 剩余 ${listing.timeLeftMinutes} 分钟` : '';
                    const where = listing.world ?? listing.dc ?? '未知服务器';
                    lines.push(`- ${slots} · ${where}${listing.category ? ` · ${listing.category}` : ''} · 缺：${roles}${timeLeft}`);
                    lines.push(`  ${listing.title}`);
                    if (listing.description)
                        lines.push(`  ${truncate(listing.description, 60)}`);
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_party_finder', async (args, ctx) => {
            const dcRaw = optionalString(args, 'dc');
            const categoryRaw = optionalString(args, 'category');
            const keyword = optionalString(args, 'keyword');
            const limit = clampInt(args.limit, 5, 1, 20);
            let datacenter;
            let world;
            if (dcRaw) {
                const canonical = canonicalChineseServer(dcRaw);
                if (canonical && CN_DATACENTERS.some((entry) => entry.name === canonical))
                    datacenter = canonical;
                else if (canonical && CN_WORLDS.some((entry) => entry.name === canonical))
                    world = canonical;
                else {
                    return {
                        supported: false,
                        listings: [],
                        message: `无法识别大区/服务器“${dcRaw}”。可用：陆行鸟、莫古力、猫小胖、豆豆柴，或具体服务器名。`,
                    };
                }
            }
            let categoryValue;
            let categoryLabel;
            if (categoryRaw) {
                const mapped = PARTY_CATEGORY_MAP.find((entry) => entry.aliases.some((alias) => alias.toLowerCase() === categoryRaw.toLowerCase()));
                if (mapped) {
                    categoryValue = mapped.value;
                    categoryLabel = mapped.label;
                }
                else if (/^[A-Za-z]+$/.test(categoryRaw)) {
                    categoryValue = categoryRaw;
                    categoryLabel = categoryRaw;
                }
            }
            const endpoint = ENDPOINTS.partyFinder();
            const perPage = Math.min(50, Math.max(10, limit * 4));
            const url = endpointUrl(endpoint, [
                ['page', 1],
                ['per_page', perPage],
                ['datacenter', datacenter],
                ['world', world],
                ['search', keyword],
                ['category', categoryValue],
            ]);
            let payload;
            try {
                payload = await fetchJsonWithRetry(url, 3, 30000, ctx.signal);
            }
            catch (error) {
                return {
                    supported: false,
                    listings: [],
                    message: `远程招募板暂时不可用（${error instanceof Error ? error.message : String(error)}）。可设置 FFXIV_PARTY_FINDER_ENDPOINT 指向兼容接口。`,
                };
            }
            const rawListings = Array.isArray(payload)
                ? payload
                : Array.isArray(payload?.data)
                    ? payload.data
                    : Array.isArray(payload?.listings)
                        ? payload.listings
                        : [];
            const listings = [];
            for (const row of rawListings) {
                if (!row || typeof row !== 'object')
                    continue;
                const duty = asString(row.duty);
                const description = asString(row.description);
                const meaningfulDuty = duty && duty !== '无' ? duty : undefined;
                const title = meaningfulDuty ?? description?.slice(0, 40) ?? asString(row.name) ?? asString(row.title);
                if (!title)
                    continue;
                if (keyword) {
                    const haystack = `${title} ${description ?? ''} ${duty ?? ''}`.toLowerCase();
                    if (!haystack.includes(keyword.toLowerCase()))
                        continue;
                }
                const rawCategory = asString(row.category) ?? meaningfulDuty;
                const categoryText = rawCategory
                    ? (PARTY_CATEGORY_LABELS[rawCategory] ?? rawCategory)
                    : undefined;
                if (categoryRaw && !mappedCategoryMatches(categoryRaw, categoryLabel, categoryText))
                    continue;
                const id = Number(row.id);
                const slotsFilled = Number(row.slots_filled);
                const slotsAvailable = Number(row.slots_available);
                const timeLeft = Number(row.time_left);
                const listing = {
                    title,
                    ...(Number.isFinite(id) ? { id: Math.trunc(id) } : {}),
                    ...(asString(row.home_world) ?? asString(row.created_world)
                        ? { world: asString(row.home_world) ?? asString(row.created_world) }
                        : {}),
                    ...(datacenter ? { dc: datacenter } : {}),
                    ...(categoryText ? { category: categoryText } : {}),
                    ...(Number.isFinite(slotsFilled) ? { slotsFilled: Math.trunc(slotsFilled) } : {}),
                    ...(Number.isFinite(slotsAvailable) ? { slotsAvailable: Math.trunc(slotsAvailable) } : {}),
                    ...(Number.isFinite(timeLeft) ? { timeLeftMinutes: Math.max(1, Math.trunc(timeLeft / 60)) } : {}),
                    ...(description ? { description } : {}),
                };
                listings.push(listing);
                if (listings.length >= limit)
                    break;
            }
            if (listings.length === 0) {
                return { supported: true, listings: [], message: '该条件下暂无招募。' };
            }
            await Promise.all(listings.map(async (listing) => {
                if (listing.id === undefined)
                    return;
                try {
                    const detail = await fetchJsonWithRetry(`${endpoint.replace(/\/listings\/?$/, '')}/listing/${listing.id}`, 2, 12000, ctx.signal);
                    const slots = Array.isArray(detail?.slots) ? detail.slots : [];
                    const roles = [];
                    for (const slot of slots) {
                        const label = describeSlot(slot);
                        if (label && !roles.includes(label))
                            roles.push(label);
                    }
                    if (roles.length > 0)
                        listing.roles = roles;
                }
                catch {
                    // Detail lookup is best effort; the listing itself remains useful.
                }
            }));
            return { supported: true, listings, message: '数据来自社区远程招募板 xivpf，存在上传延迟，以游戏内为准。' };
        }),
        timeoutMs: 120000,
    });
    const fashionReport = define({
        name: 'ffxiv_fashion_report',
        description: '当用户询问本周 FF14 时尚品鉴（暖暖）作业、评鉴主题或穿搭参考时调用此工具。数据源默认不可用，未配置 FFXIV_FASHION_ENDPOINT 时返回不支持。',
        parameters: {
            week: {
                type: 'string',
                description: '目标周：current 为本周，也可传入具体周标识（默认 current）',
                default: 'current',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    supported: { type: 'boolean' },
                    week: { type: 'string' },
                    entries: { type: 'array', items: fashionEntrySchema },
                    message: { type: 'string' },
                },
                required: ['supported', 'week', 'entries'],
            },
            render(args, value) {
                if (!value.supported)
                    return [text(String(value.message ?? '当前不支持时尚品鉴查询。'))];
                if (!Array.isArray(value.entries) || value.entries.length === 0) {
                    return [text(String(value.message ?? '暂无本周数据。'))];
                }
                const lines = [`时尚品鉴（${value.week}）：`];
                for (const entry of value.entries) {
                    const dye = entry.dye ? `（${entry.dye}）` : '';
                    const hq = entry.hq ? '（HQ）' : '';
                    lines.push(`- ${entry.slot}：${entry.item}${dye}${hq}`);
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_fashion_report', async (args, ctx) => {
            const week = optionalString(args, 'week') ?? 'current';
            const endpoint = ENDPOINTS.fashion();
            if (!endpoint) {
                return {
                    supported: false,
                    week,
                    entries: [],
                    message: '时尚品鉴数据需要可用的社区数据源。可设置环境变量 FFXIV_FASHION_ENDPOINT 后启用（需返回 JSON：{week,entries:[{slot,item,dye?,hq?}]}）。',
                };
            }
            const payload = await requestJson(endpointUrl(endpoint, [['week', week]]), {
                timeoutMs: 10000,
                signal: ctx.signal,
            });
            const rawEntries = Array.isArray(payload)
                ? payload
                : Array.isArray(payload?.entries)
                    ? payload.entries
                    : [];
            const entries = [];
            for (const row of rawEntries) {
                if (!row || typeof row !== 'object')
                    continue;
                const slot = asString(row.slot) ?? asString(row.position);
                const item = asString(row.item) ?? asString(row.name);
                if (!slot || !item)
                    continue;
                const dye = asString(row.dye) ?? asString(row.color);
                entries.push({
                    slot,
                    item,
                    ...(dye ? { dye } : {}),
                    ...(row.hq === true ? { hq: true } : {}),
                });
            }
            if (entries.length === 0) {
                return { supported: true, week, entries: [], message: '暂无本周数据。' };
            }
            const returnedWeek = asString(payload?.week) ?? week;
            return { supported: true, week: returnedWeek, entries };
        }),
        timeoutMs: 15000,
    });
    const blueMageSpell = define({
        name: 'ffxiv_blue_mage_spell',
        description: '当用户询问 FF14 青魔法师某技能的学习地点、学习条件、技能说明，或只知道部分技能名时调用此工具。支持部分匹配。',
        parameters: {
            spellName: {
                type: 'string',
                required: true,
                description: '青魔法技能中文名，支持部分匹配，例如“冰焰”“寒冰咆哮”',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    found: { type: 'boolean' },
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    actionId: { type: 'integer' },
                    description: { type: 'string' },
                    learnLocation: { type: 'string' },
                    candidates: { type: 'array', items: { type: 'string' } },
                    message: { type: 'string' },
                },
                required: ['found'],
            },
            render(args, value) {
                if (!value.found)
                    return [text(String(value.message ?? '未找到该青魔法技能。'))];
                const lines = [`青魔法：${value.name}（ID: ${value.id}）`];
                lines.push(`说明：${value.description ? truncate(String(value.description), 200) : '暂无说明。'}`);
                lines.push(`学习地点：${value.learnLocation ?? '暂无数据。'}`);
                if (Array.isArray(value.candidates) && value.candidates.length > 0) {
                    lines.push(`其它候选：${value.candidates.join('、')}`);
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_blue_mage_spell', async (args, ctx) => {
            const spellName = requireString(args, 'spellName', '技能名称');
            const hits = await findBlueMageSpells(spellName, ctx.signal);
            if (hits.length === 0) {
                return { found: false, message: `未找到与“${spellName}”匹配的青魔法技能。` };
            }
            const primary = hits[0];
            const transient = await getBlueMageTransient(primary.aozActionId, ctx.signal);
            const candidateNames = [];
            for (const hit of hits.slice(1)) {
                if (hit.name === primary.name || candidateNames.includes(hit.name))
                    continue;
                candidateNames.push(hit.name);
                if (candidateNames.length >= 5)
                    break;
            }
            const description = asString(transient.description);
            const location = asString(transient.location);
            return {
                found: true,
                id: primary.aozActionId,
                name: primary.name,
                ...(primary.actionId !== undefined && Number.isFinite(primary.actionId)
                    ? { actionId: Math.trunc(primary.actionId) }
                    : {}),
                ...(description ? { description } : {}),
                ...(location ? { learnLocation: location } : {}),
                ...(candidateNames.length > 0 ? { candidates: candidateNames } : {}),
                message: location
                    ? '学习地点来自社区数据映射，可能随版本变化。'
                    : '学习地点数据缺失（XIVAPI 的 AozActionTransient 未提供），请以游戏内青魔法书/攻略为准。',
            };
        }),
        timeoutMs: 25000,
    });
    const officialNews = define({
        name: 'ffxiv_official_news',
        description: '当用户询问 FF14 官方最新公告、更新笔记、活动新闻时调用此工具。默认读取 FF14 中文公告 RSS（RSSHub），失败时尝试国际服 Lodestone；只拿得到标题与链接时会明确说明。',
        parameters: {
            limit: { type: 'integer', description: '返回多少条公告（默认 3，最大 5）', default: 3 },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    supported: { type: 'boolean' },
                    source: { type: 'string' },
                    items: { type: 'array', items: newsItemSchema },
                    message: { type: 'string' },
                },
                required: ['supported', 'items'],
            },
            render(args, value) {
                if (!Array.isArray(value.items) || value.items.length === 0) {
                    return [text(String(value.message ?? '暂无公告。'))];
                }
                const lines = [`FF14 官方公告（最新 ${value.items.length} 条）：`];
                for (const item of value.items) {
                    lines.push(`- ${item.title}`);
                    lines.push(`  ${item.url}`);
                    if (item.summary)
                        lines.push(`  ${truncate(item.summary, 100)}`);
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_official_news', async (args, ctx) => {
            const limit = clampInt(args.limit, 3, 1, 5);
            const jsonEndpoint = ENDPOINTS.news();
            if (jsonEndpoint) {
                try {
                    const payload = await requestJson(jsonEndpoint, { timeoutMs: 10000, signal: ctx.signal });
                    const rawItems = Array.isArray(payload)
                        ? payload
                        : Array.isArray(payload?.items)
                            ? payload.items
                            : [];
                    const items = parseNewsJson(rawItems, limit);
                    if (items.length > 0)
                        return { supported: true, source: '自定义 JSON 端点', items };
                }
                catch {
                    // Fall through to the RSS source.
                }
            }
            let rssError;
            try {
                const xml = await requestText(ENDPOINTS.newsRss(), { timeoutMs: 20000, signal: ctx.signal });
                const items = parseRssItems(xml, limit);
                if (items.length > 0)
                    return { supported: true, source: '中文公告 RSS', items };
                rssError = new Error('RSS 中没有解析到条目（可能不是 RSS 格式）');
            }
            catch (error) {
                rssError = error;
            }
            try {
                const html = await requestText(ENDPOINTS.lodestoneTopics(), { timeoutMs: 15000, signal: ctx.signal });
                const items = parseLodestoneTopics(html, limit);
                if (items.length > 0) {
                    return { supported: true, source: 'Lodestone Topics', items, message: '仅能获取标题与链接，正文摘要暂无稳定来源。' };
                }
            }
            catch {
                // Both sources failed; report one concise message.
            }
            return {
                supported: false,
                items: [],
                message: `公告数据源暂不可达（${rssError instanceof Error ? rssError.message : String(rssError)}）。可设置 FFXIV_NEWS_RSS 或 FFXIV_NEWS_ENDPOINT 指向可访问的公告源。`,
            };
        }),
        timeoutMs: 45000,
    });
    return [housing, partyFinder, fashionReport, blueMageSpell, officialNews];
}
/** Match one user category filter against a listing's raw category text. */
function mappedCategoryMatches(raw, mappedLabel, rowCategory) {
    if (mappedLabel)
        return true;
    if (!rowCategory)
        return false;
    const key = raw.trim().toLowerCase();
    return rowCategory.toLowerCase().includes(key) || key.includes(rowCategory.toLowerCase());
}
/** Build news rows from a JSON endpoint payload. */
function parseNewsJson(rawItems, limit) {
    const items = [];
    for (const row of rawItems) {
        if (!row || typeof row !== 'object')
            continue;
        const title = asString(row.title);
        const url = asString(row.url) ?? asString(row.link);
        if (!title || !url)
            continue;
        const summary = asString(row.summary) ?? asString(row.description);
        const publishedAt = asString(row.publishedAt) ?? asString(row.date);
        items.push({
            title,
            url,
            ...(summary ? { summary } : {}),
            ...(publishedAt ? { publishedAt } : {}),
        });
        if (items.length >= limit)
            break;
    }
    return items;
}
