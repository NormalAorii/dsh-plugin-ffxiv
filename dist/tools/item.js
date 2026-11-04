/** Item basics: name search and detailed attributes (A1, A2). @module dsh-plugin-ffxiv/tools/item */
import { clampInt } from '../core/format.js';
import { guardTool, requireString } from '../core/define.js';
import { text } from '../core/types.js';
import { findItems, getItemInfo, resolveItem, resolveItemById } from '../core/xivapi.js';
const itemIdSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
    },
    required: ['id', 'name'],
};
/** Build the item-domain tool definitions. */
export function createItemTools(define) {
    const searchItem = define({
        name: 'ffxiv_search_item',
        description: '当用户想知道 FF14 物品的标准中文名称、物品 ID，或只给出模糊/部分物品名需要先确认具体是哪个物品时调用此工具。输入中文物品名（支持部分匹配），返回匹配的物品 ID 与标准名称列表。',
        parameters: {
            query: {
                type: 'string',
                required: true,
                description: '物品中文名称，可以是部分名称，例如“暗物质”“亚拉戈高位合成兽革”',
            },
            limit: {
                type: 'integer',
                description: '最多返回多少个匹配（默认 5，最大 20）',
                default: 5,
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    matches: { type: 'array', items: itemIdSchema },
                    message: { type: 'string' },
                },
                required: ['matches'],
            },
            render(args, value) {
                if (value.message)
                    return [text(String(value.message))];
                const lines = [`找到 ${value.matches.length} 个物品：`];
                for (const match of value.matches)
                    lines.push(`- ${match.name}（ID: ${match.id}）`);
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_search_item', async (args, ctx) => {
            const query = requireString(args, 'query', '物品名称');
            const limit = clampInt(args.limit, 5, 1, 20);
            const matches = await findItems(query, limit, ctx.signal);
            if (matches.length === 0) {
                return { matches: [], message: `未找到与“${query}”匹配的物品，请尝试更短或更常见的中文名。` };
            }
            return { matches };
        }),
    });
    const itemInfo = define({
        name: 'ffxiv_item_info',
        description: '当用户询问某个 FF14 物品的详细属性（品级、类型、是否可交易、是否可 HQ、物品简介、获取来源简述）时调用此工具。可用物品名（内部自动搜索第一个匹配）或物品 ID 查询。',
        parameters: {
            itemName: { type: 'string', description: '物品中文名称（与 itemId 二选一）' },
            itemId: { type: 'integer', description: '物品 ID（与 itemName 二选一）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    found: { type: 'boolean' },
                    id: { type: 'integer' },
                    name: { type: 'string' },
                    itemLevel: { type: 'integer' },
                    category: { type: 'string' },
                    marketCategory: { type: 'string' },
                    canBeHq: { type: 'boolean' },
                    tradable: { type: 'boolean' },
                    description: { type: 'string' },
                    source: { type: 'string' },
                    message: { type: 'string' },
                },
                required: ['found'],
            },
            render(args, value) {
                if (!value.found)
                    return [text(String(value.message ?? '未找到该物品。'))];
                const lines = [`${value.name}（ID: ${value.id}）`];
                const meta = [];
                meta.push(`品级：${value.itemLevel ? value.itemLevel : '—'}`);
                meta.push(`类型：${value.category ?? '—'}`);
                if (value.marketCategory)
                    meta.push(`板子分类：${value.marketCategory}`);
                lines.push(meta.join(' · '));
                lines.push(`交易：${value.tradable ? '可交易' : '不可交易'} · HQ：${value.canBeHq ? '可 HQ' : '不可 HQ'}`);
                if (value.description)
                    lines.push(`简介：${value.description}`);
                if (value.source)
                    lines.push(`来源：${value.source}`);
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        execute: guardTool('ffxiv_item_info', async (args, ctx) => {
            const itemName = typeof args.itemName === 'string' ? args.itemName.trim() : '';
            const rawId = Number(args.itemId);
            const itemId = Number.isFinite(rawId) && rawId > 0 ? Math.trunc(rawId) : undefined;
            if (!itemName && itemId === undefined)
                throw new Error('需要提供 itemName 或 itemId');
            const item = itemId !== undefined ? await resolveItemById(itemId, ctx.signal) : await resolveItem(itemName, ctx.signal);
            if (!item) {
                return {
                    found: false,
                    message: itemId !== undefined ? `未找到物品 ID ${itemId}。` : `未找到与“${itemName}”匹配的物品。`,
                };
            }
            const info = await getItemInfo(item.id, ctx.signal);
            if (!info)
                return { found: false, id: item.id, message: `未找到物品 ID ${item.id} 的详细信息。` };
            const itemLevel = Number(info.LevelItem?.value ?? info.LevelItem?.row_id ?? 0) || 0;
            const category = typeof info.ItemUICategory?.Name === 'string' ? info.ItemUICategory.Name : undefined;
            const marketCategory = typeof info.ItemSearchCategory?.Name === 'string' ? info.ItemSearchCategory.Name : undefined;
            const description = typeof info.Description === 'string' && info.Description.trim().length > 0
                ? info.Description.replace(/\s+/g, ' ').trim().slice(0, 200) +
                    (info.Description.replace(/\s+/g, ' ').trim().length > 200 ? '…' : '')
                : undefined;
            const tradable = info.IsUntradable !== true;
            const canBeHq = info.CanBeHq === true;
            const sourceParts = [];
            if (tradable)
                sourceParts.push('可交易');
            else
                sourceParts.push('不可交易（通常来自任务/活动/兑换/副本）');
            if (canBeHq)
                sourceParts.push('可 HQ（制作或采集产出）');
            else if (tradable)
                sourceParts.push('不可 HQ（多为商店/兑换/掉落物品）');
            if (marketCategory)
                sourceParts.push(`板上分类：${marketCategory}`);
            return {
                found: true,
                id: item.id,
                name: typeof info.Name === 'string' && info.Name.length > 0 ? info.Name : item.name,
                ...(itemLevel > 0 ? { itemLevel } : {}),
                ...(category ? { category } : {}),
                ...(marketCategory ? { marketCategory } : {}),
                canBeHq,
                tradable,
                ...(description ? { description } : {}),
                ...(sourceParts.length > 0 ? { source: sourceParts.join('；') } : {}),
                message: '来源为根据可交易/可 HQ 属性的基础判断，具体掉落与配方请以游戏内实际为准。',
            };
        }),
    });
    return [searchItem, itemInfo];
}
