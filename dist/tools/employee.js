/** Employee (retainer venture) items from the official RetainerTask sheets (B4). @module dsh-plugin-ffxiv/tools/employee */
import { guardTool, optionalString } from '../core/define.js';
import { clampInt } from '../core/format.js';
import { text } from '../core/types.js';
import { fieldQuery, searchSheet } from '../core/xivapi.js';
const VENTURE_CATEGORIES = [
    { label: '狩猎', sheetCategory: '战斗精英 魔法导师', jobs: ['战斗精英', '魔法导师', '战斗精英 魔法导师', '狩猎', '战斗职业'] },
    { label: '采伐', sheetCategory: '园艺工', jobs: ['园艺工', '采伐', '采集'] },
    { label: '采矿', sheetCategory: '采矿工', jobs: ['采矿工', '采矿'] },
    { label: '捕鱼', sheetCategory: '捕鱼人', jobs: ['捕鱼人', '捕鱼'] },
];
const VENTURE_CACHE_TTL_MS = 30 * 60 * 1000;
const ventureCache = new Map();
/** Resolve one user job name to a venture category. */
function resolveCategory(job) {
    if (!job)
        return undefined;
    const key = job.trim();
    return VENTURE_CATEGORIES.find((entry) => entry.jobs.some((alias) => alias === key));
}
/** Fetch every normal venture task for one sheet category, cached for 30 minutes. */
async function loadVentureRows(category, signal) {
    const cached = ventureCache.get(category.sheetCategory);
    if (cached && cached.expiresAt > Date.now())
        return cached.rows;
    const hits = await searchSheet('RetainerTask', fieldQuery('ClassJobCategory.Name', category.sheetCategory), {
        fields: 'RetainerLevel,IsRandom,Task',
        limit: 500,
        timeoutMs: 30000,
        signal,
    });
    const rows = [];
    for (const hit of hits) {
        const fields = hit.fields ?? {};
        if (fields.IsRandom === true)
            continue;
        const name = fields.Task?.fields?.Item?.fields?.Name;
        const level = Number(fields.RetainerLevel);
        if (typeof name !== 'string' || name.trim().length === 0)
            continue;
        if (!Number.isFinite(level) || level <= 0)
            continue;
        const quantities = fields.Task?.fields?.Quantity;
        const amounts = Array.isArray(quantities)
            ? quantities.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
            : [];
        const minAmount = amounts.length > 0 ? Math.min(...amounts) : 1;
        const maxAmount = amounts.length > 0 ? Math.max(...amounts) : minAmount;
        rows.push({ name: name.trim(), category: category.label, level: Math.trunc(level), minAmount, maxAmount });
    }
    rows.sort((left, right) => left.level - right.level || left.name.localeCompare(right.name, 'zh-Hans-CN'));
    ventureCache.set(category.sheetCategory, { expiresAt: Date.now() + VENTURE_CACHE_TTL_MS, rows });
    return rows;
}
const ventureItemSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        name: { type: 'string' },
        category: { type: 'string' },
        level: { type: 'integer' },
        minAmount: { type: 'integer' },
        maxAmount: { type: 'integer' },
    },
    required: ['name', 'category', 'level'],
};
/** Build the employee-domain tool definitions. */
export function createEmployeeTools(define) {
    const employeeItems = define({
        name: 'ffxiv_employee_items',
        description: '当用户询问 FF14 雇员能带回哪些物品、想按狩猎/采矿/采伐/捕鱼查看雇员筹集列表，或问某等级雇员能派什么探索委托时调用此工具。数据来自 XIVAPI 中文数据集里的官方 RetainerTask 表（正常探索委托），不返回编造数据。',
        parameters: {
            job: {
                type: 'string',
                description: '雇员职业，如“战斗精英”“园艺工”“采矿工”“捕鱼人”；不传则返回全部四类',
            },
            level: { type: 'integer', description: '雇员等级，用于过滤可用委托（可选，1–100）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    supported: { type: 'boolean' },
                    job: { type: 'string' },
                    level: { type: 'integer' },
                    total: { type: 'integer' },
                    items: { type: 'array', items: ventureItemSchema },
                    message: { type: 'string' },
                },
                required: ['supported', 'items'],
            },
            render(args, value) {
                if (!value.supported)
                    return [text(String(value.message ?? '雇员带回数据暂不可用。'))];
                if (!Array.isArray(value.items) || value.items.length === 0) {
                    return [text(String(value.message ?? '没有符合条件的雇员物品。'))];
                }
                const lines = [
                    `雇员可带回物品${value.job ? `（职业：${value.job}）` : ''}${value.level ? ` · 等级 ≤${value.level}` : ''}：`,
                ];
                const categories = [...new Set(value.items.map((item) => String(item.category)))];
                for (const category of categories) {
                    lines.push(`【${category}】`);
                    for (const item of value.items.filter((entry) => entry.category === category)) {
                        const amount = Number(item.maxAmount) > Number(item.minAmount)
                            ? ` ×${item.minAmount}–${item.maxAmount}`
                            : ` ×${item.minAmount ?? item.maxAmount}`;
                        lines.push(`- Lv.${item.level} ${item.name}${amount}`);
                    }
                }
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        timeoutMs: 60000,
        execute: guardTool('ffxiv_employee_items', async (args, ctx) => {
            const job = optionalString(args, 'job');
            const level = args.level !== undefined ? clampInt(args.level, 1, 1, 100) : undefined;
            const category = resolveCategory(job);
            if (job && !category) {
                return {
                    supported: false,
                    items: [],
                    job,
                    ...(level !== undefined ? { level } : {}),
                    message: `无法识别雇员职业“${job}”。请使用：战斗精英、园艺工、采矿工、捕鱼人（或对应的狩猎/采伐/采矿/捕鱼）。`,
                };
            }
            const categories = category ? [category] : VENTURE_CATEGORIES;
            const rows = [];
            for (const entry of categories) {
                rows.push(...(await loadVentureRows(entry, ctx.signal)));
            }
            const filtered = level === undefined ? rows : rows.filter((row) => row.level <= level);
            const total = filtered.length;
            const items = filtered.slice(0, 60).map((row) => ({
                name: row.name,
                category: row.category,
                level: row.level,
                minAmount: row.minAmount,
                maxAmount: row.maxAmount,
            }));
            const messages = ['数据来自 XIVAPI 中文数据集的官方 RetainerTask 表，随游戏版本更新；自由探索委托的随机战利品不在本表内。'];
            if (total > items.length)
                messages.push(`共 ${total} 条，已显示前 ${items.length} 条；可用 level 缩小范围。`);
            if (items.length === 0) {
                return {
                    supported: true,
                    items: [],
                    ...(job ? { job } : {}),
                    ...(level !== undefined ? { level } : {}),
                    total,
                    message: '该条件下暂无雇员物品数据。',
                };
            }
            return {
                supported: true,
                items,
                ...(job ? { job } : {}),
                ...(level !== undefined ? { level } : {}),
                total,
                message: messages.join(' '),
            };
        }),
    });
    return [employeeItems];
}
