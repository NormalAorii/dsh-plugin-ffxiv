/**
 * dsh-plugin-ffxiv — Cordis plugin entry.
 *
 * Registers 21 FF14 query tools for the model to call from natural language.
 * Uses the real `@deepseek-ai/dsh-tools` `defineTool` when it is resolvable and
 * falls back to an equivalent raw JSON-Schema definition otherwise.
 * @module dsh-plugin-ffxiv
 */
import { createFallbackDefineTool, toDshToolsValueSpec } from './core/define.js';
import { createCharacterTools } from './tools/character.js';
import { createCombatTools } from './tools/combat.js';
import { createCraftTools } from './tools/craft.js';
import { createEmployeeTools } from './tools/employee.js';
import { createMarketTools } from './tools/market.js';
import { createItemTools } from './tools/item.js';
import { createSocialTools } from './tools/social.js';
import { createWorldTools } from './tools/world.js';
/** Cordis plugin name. */
export const name = 'dsh-plugin-ffxiv';
/** This plugin only needs the tool registry. */
export const inject = ['tools'];
/** Every tool name registered by this plugin, in registration order. */
export const TOOL_NAMES = [
    'ffxiv_search_item',
    'ffxiv_item_info',
    'ffxiv_market_price',
    'ffxiv_market_history',
    'ffxiv_market_compare',
    'ffxiv_employee_items',
    'ffxiv_recipe_cost',
    'ffxiv_profit_estimate',
    'ffxiv_character_lookup',
    'ffxiv_fflogs_summary',
    'ffxiv_et_now',
    'ffxiv_reset_timers',
    'ffxiv_weather',
    'ffxiv_server_status',
    'ffxiv_housing',
    'ffxiv_party_finder',
    'ffxiv_fashion_report',
    'ffxiv_blue_mage_spell',
    'ffxiv_official_news',
    'ffxiv_job_guide',
    'ffxiv_duty_guide',
];
/** Resolve `defineTool` from the host profile, or use the compatible fallback. */
export async function loadDefineTool() {
    try {
        const mod = await import('@deepseek-ai/dsh-tools');
        const defineTool = mod?.defineTool;
        if (typeof defineTool === 'function') {
            return (spec) => defineTool({
                ...spec,
                output: {
                    ...spec.output,
                    // The dsh-tools value-schema DSL uses per-property `required: true`.
                    schema: toDshToolsValueSpec(spec.output.schema),
                },
            });
        }
    }
    catch {
        // Host does not expose dsh-tools to plugin resolution: use raw JSON Schema.
    }
    return createFallbackDefineTool();
}
/** Build all tool definitions with the supplied `defineTool` implementation. */
export function createTools(define) {
    return [
        ...createItemTools(define),
        ...createMarketTools(define),
        ...createEmployeeTools(define),
        ...createCraftTools(define),
        ...createCharacterTools(define),
        ...createWorldTools(define),
        ...createSocialTools(define),
        ...createCombatTools(define),
    ];
}
/** Cordis entry point: register every FF14 tool on the tool registry. */
export async function apply(ctx) {
    const define = await loadDefineTool();
    const tools = createTools(define);
    for (const tool of tools) {
        ctx.tools.register(tool);
    }
}
