/** Character profile and battle-log lookups: Lodestone profile (D1) + FFLogs summary (D2). @module dsh-plugin-ffxiv/tools/character */
import { guardTool, optionalString, requireString } from '../core/define.js';
import { ENDPOINTS } from '../core/env.js';
import { formatPercent, truncate } from '../core/format.js';
import { requestJson, requestText } from '../core/http.js';
import { text } from '../core/types.js';
import { isChineseWorld } from '../data/worlds.js';
/** Request budgets (one tool call can issue two Lodestone pages). */
const CHARACTER_ENDPOINT_TIMEOUT_MS = 10000;
const LODESTONE_PAGE_TIMEOUT_MS = 15000;
const FFLOGS_TIMEOUT_MS = 15000;
/** Metrics accepted by the FFLogs summary tool (CharacterRankingMetricType). */
const FFLOGS_METRICS = ['rdps', 'adps', 'ndps', 'pdps'];
let fflogsTokenCache;
/** Named HTML entities worth decoding for Lodestone pages. */
const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
};
/** Decode the small HTML-entity subset Lodestone actually emits. */
function decodeEntities(value) {
    return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
        if (body.length > 1 && (body[0] === '#x' || body[0] === '#X')) {
            const code = Number.parseInt(body.slice(2), 16);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        if (body[0] === '#') {
            const code = Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}
/** Normalize an entity name for label comparison. */
function normalizeLabel(value) {
    return value.replace(/[:：]\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
/** Normalize a character name for exact-but-case-insensitive comparison. */
function normalizeName(value) {
    return value.replace(/\s+/g, '').trim().toLowerCase();
}
/** Values that are navigation/label text, never real profile data. */
const NAV_VALUES = new Set([
    'race',
    'clan',
    'race / clan',
    'guardian',
    'grand company',
    'grand company standings',
    'free company',
    'free company standings',
    'item level',
    'avg. item level',
    'average item level',
    'search',
    'home',
    'news',
    'topics',
    'community',
    'links',
    'support',
    'lodestone',
].map(normalizeLabel));
/** Strip tags/entities and keep only one plausible short field value. */
function cleanValue(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const value = decodeEntities(raw)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (value.length === 0 || value.length > 80)
        return undefined;
    if (!/[A-Za-z0-9\u3040-\u30ff\u4e00-\u9fff]/.test(value))
        return undefined;
    if (NAV_VALUES.has(normalizeLabel(value)))
        return undefined;
    return value;
}
/** An organization slot: "none" is a real Lodestone answer, but carries no data. */
function cleanOrgValue(raw) {
    const value = cleanValue(raw);
    if (!value)
        return undefined;
    if (/^(none|no free company|n\/a|-|—)$/i.test(value))
        return undefined;
    return value;
}
/** Parse one integer item level out of a detail-page value. */
function parseItemLevel(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const match = /(\d{1,4})/.exec(raw);
    if (!match)
        return undefined;
    const value = Number(match[1]);
    return Number.isFinite(value) && value > 0 && value < 9999 ? Math.round(value) : undefined;
}
/** Convert any raw value to a finite number, or `undefined`. */
function toNumber(raw) {
    const value = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(value) ? value : undefined;
}
/**
 * Render the Lodestone page as visible text lines.
 * Structural tags become line breaks so a label and its value land on
 * separate lines even when they are nested in spans/definition lists.
 */
function plainTextLines(html) {
    const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, '\n')
        .replace(/<style[\s\S]*?<\/style>/gi, '\n')
        .replace(/<header[\s\S]*?<\/header>/gi, '\n')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '\n')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '\n')
        .replace(/<!--[\s\S]*?-->/g, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(?:p|div|li|dd|dt|h[1-6]|tr|td|th|section|article|span|a|strong|em)>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    return decodeEntities(stripped)
        .replace(/[\t\u00a0]+/g, ' ')
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter((line) => line.length > 0);
}
/**
 * Find the value that follows one visible label.
 * Handles `Label: value` inline forms, label/value adjacency, and
 * `Label value` prefixes; anything that looks like another label is rejected.
 */
function labelValue(lines, labels) {
    const wanted = new Set(labels.map(normalizeLabel));
    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index] ?? '';
        const inline = /^([^:：]{1,40})[:：]\s*(.+)$/.exec(raw);
        if (inline && wanted.has(normalizeLabel(inline[1] ?? ''))) {
            const value = cleanValue(inline[2]);
            if (value)
                return value;
        }
        if (wanted.has(normalizeLabel(raw))) {
            const next = lines[index + 1];
            const value = next ? cleanValue(next) : undefined;
            if (value)
                return value;
        }
        const lower = raw.toLowerCase();
        for (const label of labels) {
            const prefix = `${label.toLowerCase()} `;
            if (lower.startsWith(prefix)) {
                const value = cleanValue(raw.slice(prefix.length));
                if (value)
                    return value;
            }
        }
    }
    return undefined;
}
/** Best-effort parse of race/clan/guardian/companies/item level from a Lodestone detail page. */
function parseDetailFields(html) {
    const lines = plainTextLines(html);
    const raceClan = labelValue(lines, ['Race / Clan']);
    const raceClanParts = raceClan ? raceClan.split('/').map((part) => part.trim()) : [];
    const race = labelValue(lines, ['Race']) ?? (raceClanParts[0] && raceClanParts[0].length > 0 ? raceClanParts[0] : undefined);
    const clan = labelValue(lines, ['Clan']) ?? (raceClanParts[1] && raceClanParts[1].length > 0 ? raceClanParts[1] : undefined);
    const guardian = labelValue(lines, ['Guardian']);
    const grandCompany = cleanOrgValue(labelValue(lines, ['Grand Company']));
    const freeCompany = cleanOrgValue(labelValue(lines, ['Free Company']));
    const avgItemLevel = parseItemLevel(labelValue(lines, ['Avg. Item Level', 'Average Item Level', 'Item Level']));
    return {
        ...(race ? { race } : {}),
        ...(clan ? { clan } : {}),
        ...(guardian ? { guardian } : {}),
        ...(grandCompany ? { grandCompany } : {}),
        ...(freeCompany ? { freeCompany } : {}),
        ...(avgItemLevel !== undefined ? { avgItemLevel } : {}),
    };
}
/** Read one non-empty string property from a loose endpoint record. */
function pickString(record, keys) {
    for (const key of keys) {
        const value = record?.[key];
        if (typeof value === 'string' && value.trim().length > 0)
            return value.trim();
    }
    return undefined;
}
/** Read one finite number property from a loose endpoint record. */
function pickNumber(record, keys) {
    for (const key of keys) {
        const value = toNumber(record?.[key]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
/** Flatten the documented endpoint shapes (single object, array, or one wrapped array). */
function normalizeEndpointRows(payload) {
    const rowsOf = (value) => Array.isArray(value)
        ? value.filter((row) => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
        : [];
    if (Array.isArray(payload))
        return rowsOf(payload);
    if (!payload || typeof payload !== 'object')
        return [];
    const record = payload;
    for (const key of ['characters', 'results', 'data', 'matches', 'items']) {
        const nested = rowsOf(record[key]);
        if (nested.length > 0)
            return nested;
    }
    return [record];
}
/** Map one endpoint row onto the canonical character fields, omitting absent data. */
function mapEndpointRow(row, fallbackName, fallbackServer) {
    const name = pickString(row, ['name', 'characterName', 'character_name']) ?? fallbackName;
    const server = pickString(row, ['server', 'world', 'serverName', 'server_name']) ?? fallbackServer;
    const race = pickString(row, ['race']);
    const clan = pickString(row, ['clan']);
    const guardian = pickString(row, ['guardian']);
    const grandCompany = pickString(row, ['grandCompany', 'grand_company', 'grandCompanyName']);
    const freeCompany = pickString(row, ['freeCompany', 'free_company', 'freeCompanyName']);
    const avgItemLevel = pickNumber(row, [
        'avgItemLevel',
        'averageItemLevel',
        'avg_item_level',
        'average_item_level',
        'itemLevel',
        'item_level',
    ]);
    const url = pickString(row, ['url', 'lodestoneUrl', 'lodestone_url', 'link']);
    return {
        name,
        server,
        ...(race ? { race } : {}),
        ...(clan ? { clan } : {}),
        ...(guardian ? { guardian } : {}),
        ...(grandCompany ? { grandCompany } : {}),
        ...(freeCompany ? { freeCompany } : {}),
        ...(avgItemLevel !== undefined ? { avgItemLevel: Math.round(avgItemLevel) } : {}),
        ...(url ? { url } : {}),
    };
}
/** Query a configured character endpoint and normalize the response rows. */
async function fetchCharacterEndpoint(endpoint, name, server, signal) {
    const query = new URLSearchParams({ name, server, limit: '5' }).toString();
    const url = `${endpoint}${endpoint.includes('?') ? '&' : '?'}${query}`;
    const payload = await requestJson(url, { timeoutMs: CHARACTER_ENDPOINT_TIMEOUT_MS, signal });
    return normalizeEndpointRows(payload);
}
/** Normalize the Lodestone character-page prefix so `?` and `id/` URLs stay well formed. */
function lodestoneBase() {
    const raw = ENDPOINTS.lodestoneCharacter().trim();
    return raw.endsWith('/') ? raw : `${raw}/`;
}
/** Extract character entries from one Lodestone search-results page. */
function parseLodestoneEntries(html) {
    const entries = [];
    const anchorRe = /<a\s([^>]*href="\/lodestone\/character\/(\d+)\/"[^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = anchorRe.exec(html)) !== null) {
        const attributes = match[1] ?? '';
        if (!/entry__link/.test(attributes))
            continue;
        const block = match[3] ?? '';
        const id = Number(match[2]);
        if (!Number.isFinite(id) || id <= 0)
            continue;
        const nameMatch = /class="[^"]*entry__name[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        const name = cleanValue(nameMatch?.[1]);
        if (!name)
            continue;
        const worldMatch = /class="[^"]*entry__world[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        const worldRaw = worldMatch?.[1]
            ? decodeEntities(worldMatch[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
            : '';
        const world = worldRaw.split('[')[0]?.trim();
        entries.push({ id, name, ...(world ? { world } : {}) });
    }
    return entries;
}
/** Resolve one character through the official Lodestone search and detail pages. */
async function lookupLodestone(name, server, signal) {
    const base = lodestoneBase();
    const searchUrl = `${base}?${new URLSearchParams({ q: name, world: server }).toString()}`;
    const searchHtml = await requestText(searchUrl, { timeoutMs: LODESTONE_PAGE_TIMEOUT_MS, signal });
    const entries = parseLodestoneEntries(searchHtml);
    if (entries.length === 0) {
        return { supported: false, name, server, message: `未在 Lodestone 上找到角色“${name}”` };
    }
    const wanted = normalizeName(name);
    const picked = entries.find((entry) => normalizeName(entry.name) === wanted) ?? entries[0];
    const pageUrl = `${base}${picked.id}/`;
    let detail = {};
    let detailNote;
    try {
        const detailHtml = await requestText(pageUrl, { timeoutMs: LODESTONE_PAGE_TIMEOUT_MS, signal });
        detail = parseDetailFields(detailHtml);
    }
    catch (error) {
        // The detail page is an enhancement only: keep the verified search hit, report the gap.
        if (signal?.aborted)
            throw error;
        const reason = error instanceof Error ? error.message : String(error);
        detailNote = `详情页暂时无法访问（${truncate(reason, 60)}），仅返回基础信息。`;
    }
    const hasDetail = Object.keys(detail).length > 0;
    const notes = [];
    if (detailNote)
        notes.push(detailNote);
    else if (!hasDetail)
        notes.push('详情页解析不完整，仅返回基础信息。');
    return {
        supported: true,
        name: picked.name,
        server: picked.world ?? server,
        lodestoneId: picked.id,
        ...detail,
        url: pageUrl,
        ...(notes.length > 0 ? { message: notes.join('') } : {}),
    };
}
/** Read one FFLogs bearer token, reusing the cached token until 60 seconds before expiry. */
async function getFflogsToken(clientId, clientSecret, signal) {
    const cached = fflogsTokenCache;
    if (cached && cached.clientId === clientId && cached.expiresAt - 60_000 > Date.now())
        return cached.token;
    const payload = await requestJson(ENDPOINTS.fflogsToken(), {
        method: 'POST',
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`,
        },
        body: 'grant_type=client_credentials',
        timeoutMs: FFLOGS_TIMEOUT_MS,
        signal,
    });
    const token = typeof payload?.access_token === 'string' ? payload.access_token.trim() : '';
    if (!token)
        throw new Error('FFLogs 未返回访问令牌，请检查 API 凭据是否正确');
    const expiresIn = toNumber(payload?.expires_in);
    const ttlSeconds = expiresIn !== undefined && expiresIn > 0 ? expiresIn : 3600;
    fflogsTokenCache = { token, expiresAt: Date.now() + ttlSeconds * 1000, clientId };
    return token;
}
/** Run one FFLogs GraphQL query, surfacing reported GraphQL errors as thrown errors. */
async function fflogsQuery(query, variables, token, signal) {
    const payload = await requestJson(ENDPOINTS.fflogsApi(), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        timeoutMs: FFLOGS_TIMEOUT_MS,
        signal,
    });
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    if (errors.length > 0) {
        const first = errors[0];
        throw new Error(typeof first?.message === 'string' && first.message.length > 0 ? first.message : 'FFLogs 返回了未知错误');
    }
    if (!payload?.data)
        throw new Error('FFLogs 没有返回数据');
    return payload.data;
}
/** FFLogs report query: fights are enough to derive clears and best pull. */
const FFLOGS_REPORT_QUERY = 'query($code:String!){ reportData { report(code:$code){ title startTime endTime fights(killType:All){ id kill bossPercentage fightPercentage encounterID startTime } } } }';
/** FFLogs character query: zone rankings for one metric. */
const FFLOGS_CHARACTER_QUERY = 'query($name:String!,$server:String!,$region:String!,$metric:CharacterRankingMetricType!){ characterData { character(name:$name, serverSlug:$server, serverRegion:$region){ name server{name} zoneRankings(metric:$metric){ bestAmount medianAmount rankPercent medianPercent totalKills } } } }';
/** Join `label：value` fragments, dropping absent fields. */
function lineParts(parts) {
    const rendered = [];
    for (const [label, value] of parts) {
        if (value === undefined || value === null)
            continue;
        const chunk = String(value).trim();
        if (chunk.length === 0)
            continue;
        rendered.push(`${label}：${chunk}`);
    }
    return rendered.length > 0 ? rendered.join(' · ') : undefined;
}
/** Format a raw numeric amount (DPS etc.) with thousands separators. */
function formatAmount(value) {
    return Math.round(value).toLocaleString('en-US');
}
/** Build the character/combat-log domain tool definitions. */
export function createCharacterTools(define) {
    const characterLookup = define({
        name: 'ffxiv_character_lookup',
        description: '当用户想查询 FF14 角色的 Lodestone 档案（服务器、种族、部队、平均品级等）时调用此工具。需要角色全名（含姓氏）。国服角色不在国际服 Lodestone，除非配置了 FFXIV_CHARACTER_ENDPOINT，否则会明确返回不支持。',
        parameters: {
            name: { type: 'string', required: true, description: '角色全名（含姓氏），例如“Tataru Taru”' },
            server: {
                type: 'string',
                required: true,
                description: '服务器名，例如“神意之地”或国际服“Cerberus”',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    supported: { type: 'boolean' },
                    name: { type: 'string' },
                    server: { type: 'string' },
                    lodestoneId: { type: 'integer' },
                    race: { type: 'string' },
                    clan: { type: 'string' },
                    guardian: { type: 'string' },
                    grandCompany: { type: 'string' },
                    freeCompany: { type: 'string' },
                    avgItemLevel: { type: 'integer' },
                    url: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['supported'],
            },
            render(args, value) {
                if (!value.supported)
                    return [text(String(value.message ?? '角色查询暂不可用。'))];
                const lines = [`${value.name} · ${value.server}`];
                if (value.lodestoneId !== undefined)
                    lines.push(`Lodestone ID：${value.lodestoneId}`);
                const raceClan = lineParts([
                    ['种族', value.race],
                    ['部族', value.clan],
                ]);
                if (raceClan)
                    lines.push(raceClan);
                const faith = lineParts([
                    ['守护神', value.guardian],
                    ['大国防联军', value.grandCompany],
                ]);
                if (faith)
                    lines.push(faith);
                const organization = lineParts([
                    ['部队', value.freeCompany],
                    ['平均品级', value.avgItemLevel],
                ]);
                if (organization)
                    lines.push(organization);
                if (value.url)
                    lines.push(`链接：${value.url}`);
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_character_lookup', async (args, ctx) => {
            const name = requireString(args, 'name', '角色全名');
            const server = requireString(args, 'server', '服务器');
            const endpoint = ENDPOINTS.character();
            if (endpoint) {
                const rows = await fetchCharacterEndpoint(endpoint, name, server, ctx.signal);
                if (rows.length === 0) {
                    return { supported: false, name, server, message: '角色端点没有返回该角色的数据。' };
                }
                const wanted = normalizeName(name);
                const picked = rows.find((row) => normalizeName(pickString(row, ['name', 'characterName']) ?? '') === wanted) ?? rows[0];
                return { supported: true, ...mapEndpointRow(picked, name, server) };
            }
            if (isChineseWorld(server)) {
                return {
                    supported: false,
                    name,
                    server,
                    message: '角色查询需要可用的 Lodestone 解析端点：国服角色不在国际服 Lodestone。可设置环境变量 FFXIV_CHARACTER_ENDPOINT（返回 JSON 角色对象）后启用。',
                };
            }
            return await lookupLodestone(name, server, ctx.signal);
        }),
        timeoutMs: 30000,
    });
    const fflogsSummary = define({
        name: 'ffxiv_fflogs_summary',
        description: '当用户给出 FFLogs 报告链接、或问某角色 FFLogs 输出分位/战斗记录摘要时调用此工具。需要环境变量 FFLOGS_CLIENT_ID/FFLOGS_CLIENT_SECRET；未配置时明确返回不支持，不编造数据。',
        parameters: {
            reportUrl: {
                type: 'string',
                description: 'FFLogs 报告链接，例如 https://www.fflogs.com/reports/ABC123（与 characterName+server 二选一）',
            },
            characterName: { type: 'string', description: '角色全名（含姓氏），与 server 一起使用' },
            server: { type: 'string', description: '角色所在服务器，例如国际服“Cerberus”' },
            metric: {
                type: 'string',
                description: '输出指标：rdps（默认）、adps、ndps、pdps',
                default: 'rdps',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    supported: { type: 'boolean' },
                    kind: { type: 'string' },
                    title: { type: 'string' },
                    fights: { type: 'integer' },
                    kills: { type: 'integer' },
                    wipes: { type: 'integer' },
                    bestPullPercent: { type: 'number' },
                    name: { type: 'string' },
                    server: { type: 'string' },
                    metric: { type: 'string' },
                    bestPercent: { type: 'number' },
                    medianPercent: { type: 'number' },
                    bestAmount: { type: 'number' },
                    totalKills: { type: 'integer' },
                    url: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['supported'],
            },
            render(args, value) {
                if (!value.supported)
                    return [text(String(value.message ?? 'FFLogs 查询暂不可用。'))];
                const lines = [];
                if (value.kind === 'report') {
                    lines.push(`FFLogs 报告：${value.title ?? '（标题缺失）'}`);
                    lines.push(`战斗场次：${value.fights ?? 0} · 击杀：${value.kills ?? 0} · 团灭：${value.wipes ?? 0}`);
                    if (value.bestPullPercent !== undefined) {
                        lines.push(`最佳 pull：剩余 ${formatPercent(Number(value.bestPullPercent))}`);
                    }
                }
                else {
                    lines.push(`${value.name} · ${value.server} · 指标：${String(value.metric ?? '').toUpperCase()}`);
                    const percentLine = lineParts([
                        ['最佳分位', value.bestPercent !== undefined ? formatPercent(Number(value.bestPercent)) : undefined],
                        ['中位分位', value.medianPercent !== undefined ? formatPercent(Number(value.medianPercent)) : undefined],
                    ]);
                    if (percentLine)
                        lines.push(percentLine);
                    const amountLine = lineParts([
                        ['最佳输出', value.bestAmount !== undefined ? formatAmount(Number(value.bestAmount)) : undefined],
                        ['击杀数', value.totalKills],
                    ]);
                    if (amountLine)
                        lines.push(amountLine);
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_fflogs_summary', async (args, ctx) => {
            const reportUrl = optionalString(args, 'reportUrl');
            const characterName = optionalString(args, 'characterName');
            const server = optionalString(args, 'server');
            const metric = (optionalString(args, 'metric') ?? 'rdps').toLowerCase();
            const clientId = ENDPOINTS.fflogsClientId();
            const clientSecret = ENDPOINTS.fflogsClientSecret();
            if (!clientId || !clientSecret) {
                return {
                    supported: false,
                    message: 'FFLogs 查询需要配置 API 凭据（FFLOGS_CLIENT_ID / FFLOGS_CLIENT_SECRET）。',
                };
            }
            if (!reportUrl && (!characterName || !server)) {
                throw new Error('需要提供 reportUrl，或 characterName 与 server');
            }
            const token = await getFflogsToken(clientId, clientSecret, ctx.signal);
            if (reportUrl) {
                const code = /reports\/([A-Za-z0-9]+)/.exec(reportUrl)?.[1];
                if (!code)
                    throw new Error('无法从链接中解析出 FFLogs 报告代码，请检查报告链接');
                const data = await fflogsQuery(FFLOGS_REPORT_QUERY, { code }, token, ctx.signal);
                const report = data?.reportData?.report;
                if (!report) {
                    return { supported: false, kind: 'report', url: reportUrl, message: 'FFLogs 没有返回该报告的数据。' };
                }
                const fights = Array.isArray(report.fights) ? report.fights : [];
                const kills = fights.filter((fight) => fight?.kill === true).length;
                const wipes = fights.length - kills;
                let bestPull;
                for (const fight of fights) {
                    if (fight?.kill === true)
                        continue;
                    const percentage = toNumber(fight?.bossPercentage);
                    if (percentage === undefined)
                        continue;
                    if (bestPull === undefined || percentage < bestPull)
                        bestPull = percentage;
                }
                const bestPullPercent = bestPull === undefined ? undefined : Math.round(bestPull * 10) / 10;
                return {
                    supported: true,
                    kind: 'report',
                    ...(typeof report.title === 'string' && report.title.trim().length > 0 ? { title: report.title.trim() } : {}),
                    fights: fights.length,
                    kills,
                    wipes,
                    ...(bestPullPercent !== undefined ? { bestPullPercent } : {}),
                    url: reportUrl,
                };
            }
            const regionOverride = ENDPOINTS.fflogsRegion();
            const region = regionOverride ?? (isChineseWorld(server ?? '') ? 'CN' : 'NA');
            if (region === 'CN' && !regionOverride) {
                return {
                    supported: false,
                    kind: 'character',
                    name: characterName,
                    server,
                    metric,
                    message: 'FFLogs 国服数据不在国际服站点；可设置 FFLOGS_REGION 后重试，或改用 reportUrl。',
                };
            }
            if (!FFLOGS_METRICS.includes(metric)) {
                return {
                    supported: false,
                    kind: 'character',
                    name: characterName,
                    server,
                    message: `不支持的指标“${metric}”，可选值为 rdps、adps、ndps、pdps（默认 rdps）。`,
                };
            }
            const serverSlug = (server ?? '').trim().toLowerCase().replace(/\s+/g, '-');
            const data = await fflogsQuery(FFLOGS_CHARACTER_QUERY, { name: characterName, server: serverSlug, region, metric }, token, ctx.signal);
            const character = data?.characterData?.character;
            const rankings = character?.zoneRankings;
            if (!character || !rankings) {
                return {
                    supported: true,
                    kind: 'character',
                    name: characterName,
                    server,
                    metric,
                    message: '未找到该角色或该角色没有该指标的排名数据。',
                };
            }
            const bestPercent = toNumber(rankings.rankPercent);
            if (bestPercent === undefined) {
                return {
                    supported: true,
                    kind: 'character',
                    name: characterName,
                    server,
                    metric,
                    message: 'FFLogs 没有返回该角色的分位数据。',
                };
            }
            const medianPercent = toNumber(rankings.medianPercent);
            const bestAmount = toNumber(rankings.bestAmount);
            const totalKills = toNumber(rankings.totalKills);
            return {
                supported: true,
                kind: 'character',
                name: typeof character.name === 'string' && character.name.trim().length > 0 ? character.name.trim() : characterName,
                server: typeof character.server?.name === 'string' && character.server.name.trim().length > 0
                    ? character.server.name.trim()
                    : server,
                metric,
                bestPercent,
                ...(medianPercent !== undefined ? { medianPercent } : {}),
                ...(bestAmount !== undefined ? { bestAmount } : {}),
                ...(totalKills !== undefined ? { totalKills: Math.round(totalKills) } : {}),
            };
        }),
        timeoutMs: 30000,
    });
    return [characterLookup, fflogsSummary];
}
