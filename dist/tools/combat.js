/** Combat job structure and duty guide tools (added after 0.2.0). @module dsh-plugin-ffxiv/tools/combat */
import { guardTool, requireString } from '../core/define.js';
import { ENDPOINTS } from '../core/env.js';
import { clampInt, truncate } from '../core/format.js';
import { requestJson } from '../core/http.js';
import { text } from '../core/types.js';
import { extractMechanics, wikiPageText, wikiPageUrl, wikiSearch } from '../core/wiki.js';
import { findClassJob, findDuties, findJobActions, findJobTraits, getClassJobParentName, getDutyTransientDescription, getTerritoryPlaceName, } from '../core/xivapi.js';
import { COMBAT_JOBS, resolveCombatJob } from '../data/jobs.js';
/** Normalize names for fuzzy comparisons (drops spaces and punctuation). */
function normalizeName(raw) {
    return raw
        .trim()
        .toLowerCase()
        .replace(/[\s·・_:\-—（）()「」【】[\]]+/g, '');
}
/** Cooldown milliseconds (Recast100ms × 100 ms) rendered as seconds. */
function cooldownSeconds(action) {
    if (!action.recast100ms || action.recast100ms <= 0)
        return undefined;
    return Math.round((action.recast100ms / 10) * 10) / 10;
}
/** Cast time milliseconds rendered as seconds. */
function castSeconds(action) {
    if (!action.cast100ms || action.cast100ms <= 0)
        return undefined;
    return Math.round((action.cast100ms / 10) * 10) / 10;
}
const GCD_CATEGORIES = new Set(['战技', '魔法', '武器技能']);
/** Build combo chains (A → B → C) from `ActionCombo` links, following every branch. */
function buildComboChains(actions) {
    const byId = new Map();
    for (const action of actions)
        byId.set(action.id, action);
    const next = new Map();
    for (const action of actions) {
        if (!action.comboId || !byId.has(action.comboId))
            continue;
        const list = next.get(action.comboId) ?? [];
        list.push(action);
        next.set(action.comboId, list);
    }
    const chains = [];
    const seen = new Set();
    const walk = (current, steps) => {
        const follow = next.get(current.id) ?? [];
        if (follow.length === 0) {
            if (steps.length >= 2) {
                const key = steps.map((step) => step.name).join('>');
                if (!seen.has(key)) {
                    seen.add(key);
                    chains.push({ steps });
                }
            }
            return;
        }
        for (const item of follow)
            walk(item, [...steps, { name: item.name, level: item.level }]);
    };
    for (const action of actions) {
        if (action.comboId && byId.has(action.comboId))
            continue;
        if (!next.has(action.id))
            continue;
        walk(action, [{ name: action.name, level: action.level }]);
        if (chains.length >= 12)
            break;
    }
    chains.sort((left, right) => (left.steps[0]?.level ?? 0) - (right.steps[0]?.level ?? 0));
    return chains;
}
/** Resolve one user job input to job sheet info plus the static role table. */
async function resolveJob(raw, signal) {
    const known = resolveCombatJob(raw);
    if (known) {
        const info = await findClassJob(known.name, signal);
        if (info)
            return { info: { ...info, name: known.name, abbreviation: known.abbr }, static: known };
        return { info: { id: 0, name: known.name, abbreviation: known.abbr }, static: known };
    }
    const info = await findClassJob(raw, signal);
    if (!info)
        return undefined;
    const byAbbr = COMBAT_JOBS.find((job) => job.abbr.toLowerCase() === info.abbreviation.toLowerCase());
    return { info, static: byAbbr };
}
/** One curated guide line parsed from the optional JSON endpoint. */
function shortReason(error) {
    const message = error instanceof Error ? error.message : String(error);
    const http = /^HTTP (\d{3})/.exec(message);
    if (http)
        return `HTTP ${http[1]}（可能触发了 Cloudflare 挑战或限流）`;
    return message.length > 120 ? `${message.slice(0, 120)}…` : message;
}
/** One curated guide line parsed from the optional JSON endpoint. */
function readGuideEndpointPayload(payload) {
    if (!payload || typeof payload !== 'object')
        return {};
    const lines = [];
    if (typeof payload.summary === 'string' && payload.summary.trim())
        lines.push(payload.summary.trim());
    const rotation = payload.rotation ?? payload.rotations ?? payload.opener;
    if (typeof rotation === 'string' && rotation.trim())
        lines.push(rotation.trim());
    if (Array.isArray(rotation)) {
        for (const entry of rotation) {
            if (typeof entry === 'string' && entry.trim())
                lines.push(`- ${entry.trim()}`);
            else if (entry && typeof entry === 'object' && typeof entry.name === 'string') {
                const steps = Array.isArray(entry.steps) ? entry.steps.join(' → ') : '';
                lines.push(`- ${entry.name}${steps ? `：${steps}` : ''}`);
            }
        }
    }
    const tips = payload.tips ?? payload.notes;
    if (Array.isArray(tips))
        for (const tip of tips)
            if (typeof tip === 'string' && tip.trim())
                lines.push(`提示：${tip.trim()}`);
    const url = typeof payload.url === 'string' ? payload.url : undefined;
    const name = typeof payload.source === 'string' ? payload.source : typeof payload.name === 'string' ? payload.name : '自定义攻略端点';
    return {
        ...(lines.length > 0 ? { guideText: lines.join('\n') } : {}),
        ...(url ? { source: { name, url } } : {}),
    };
}
/** Build the combat-domain tool definitions. */
export function createCombatTools(define) {
    const jobGuide = define({
        name: 'ffxiv_job_guide',
        description: '当用户询问 FF14 某职业的技能循环、基础手法、连击、能力技 CD、职业特性或“这个职业怎么玩/输出怎么打”时调用此工具。返回按官方技能表整理的基础循环结构（连击链、GCD、能力技、特性）；不返回编造的最优起手，进阶循环会给出社区/wiki 参考与可配置攻略端点。',
        parameters: {
            job: { type: 'string', required: true, description: '职业名，如“龙骑士”“白魔法师”，或简称 WHM/DRG/白魔/龙骑' },
            level: { type: 'integer', description: '只看该等级及以下可用的技能（可选，1–100）' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    found: { type: 'boolean' },
                    job: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            name: { type: 'string' },
                            abbr: { type: 'string' },
                            role: { type: 'string' },
                            category: { type: 'string' },
                        },
                        required: ['name', 'abbr', 'role'],
                    },
                    level: { type: 'integer' },
                    combos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                steps: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        additionalProperties: false,
                                        properties: { name: { type: 'string' }, level: { type: 'integer' } },
                                        required: ['name', 'level'],
                                    },
                                },
                            },
                            required: ['steps'],
                        },
                    },
                    gcdSkills: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                name: { type: 'string' },
                                level: { type: 'integer' },
                                castSeconds: { type: 'number' },
                                combo: { type: 'string' },
                            },
                            required: ['name', 'level'],
                        },
                    },
                    abilities: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                name: { type: 'string' },
                                level: { type: 'integer' },
                                cooldownSeconds: { type: 'number' },
                            },
                            required: ['name', 'level'],
                        },
                    },
                    traits: {
                        type: 'array',
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                name: { type: 'string' },
                                level: { type: 'integer' },
                                description: { type: 'string' },
                            },
                            required: ['name', 'level'],
                        },
                    },
                    guideText: { type: 'string' },
                    source: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { name: { type: 'string' }, url: { type: 'string' } },
                        required: ['name', 'url'],
                    },
                    message: { type: 'string' },
                },
                required: ['found', 'combos', 'gcdSkills', 'abilities', 'traits'],
            },
            render(args, value) {
                if (!value.found || !value.job)
                    return [text(String(value.message ?? '没有找到该职业的技能数据。'))];
                const job = value.job;
                const lines = [
                    `职业：${job.name}（${job.abbr} · ${job.role}${job.category ? ` · ${job.category}` : ''}）${value.level ? ` · 仅列 ≤Lv.${value.level}` : ''}`,
                ];
                if (Array.isArray(value.combos) && value.combos.length > 0) {
                    lines.push('连击链：');
                    for (const chain of value.combos) {
                        const steps = chain.steps.map((step) => `${step.name}（Lv.${step.level}）`).join(' → ');
                        lines.push(`- ${steps}`);
                    }
                }
                else {
                    lines.push('连击链：该职业没有连击技能，或以单体循环为主。');
                }
                const gcd = Array.isArray(value.gcdSkills) ? value.gcdSkills : [];
                if (gcd.length > 0) {
                    lines.push('GCD 技能：');
                    for (const skill of gcd.slice(0, 40)) {
                        const cast = skill.castSeconds ? ` · 读条 ${skill.castSeconds}s` : '';
                        lines.push(`- Lv.${skill.level} ${skill.name}${cast}`);
                    }
                    if (gcd.length > 40)
                        lines.push(`… 共 ${gcd.length} 个，仅列前 40 个。`);
                }
                const abilities = Array.isArray(value.abilities) ? value.abilities : [];
                if (abilities.length > 0) {
                    lines.push('能力技（oGCD）：');
                    for (const ability of abilities.slice(0, 30)) {
                        const cd = ability.cooldownSeconds ? ` · CD ${ability.cooldownSeconds}s` : '';
                        lines.push(`- Lv.${ability.level} ${ability.name}${cd}`);
                    }
                    if (abilities.length > 30)
                        lines.push(`… 共 ${abilities.length} 个，仅列前 30 个。`);
                }
                const traits = Array.isArray(value.traits) ? value.traits : [];
                if (traits.length > 0) {
                    lines.push('职业特性：');
                    for (const trait of traits.slice(0, 12)) {
                        lines.push(`- Lv.${trait.level} ${trait.name}${trait.description ? `：${truncate(trait.description, 70)}` : ''}`);
                    }
                    if (traits.length > 12)
                        lines.push(`… 共 ${traits.length} 条特性，仅列前 12 条。`);
                }
                if (value.guideText)
                    lines.push('进阶循环/攻略：', String(value.guideText));
                if (value.source)
                    lines.push(`参考：${value.source.name} · ${value.source.url}`);
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        timeoutMs: 90000,
        execute: guardTool('ffxiv_job_guide', async (args, ctx) => {
            const jobRaw = requireString(args, 'job', '职业');
            const level = args.level !== undefined ? clampInt(args.level, 1, 1, 100) : undefined;
            const resolved = await resolveJob(jobRaw, ctx.signal);
            if (!resolved) {
                return {
                    found: false,
                    combos: [],
                    gcdSkills: [],
                    abilities: [],
                    traits: [],
                    message: `没有识别出职业“${jobRaw}”。请使用官方职业名（如“龙骑士”“白魔法师”）或简称（DRG/WHM/龙骑/白魔）。`,
                };
            }
            const { info, static: staticJob } = resolved;
            const parentName = info.id > 0 ? await getClassJobParentName(info.id, ctx.signal).catch(() => undefined) : undefined;
            const [jobActions, parentActions, traits] = await Promise.all([
                findJobActions(info.name, ctx.signal),
                parentName && parentName !== info.name
                    ? findJobActions(parentName, ctx.signal).catch(() => [])
                    : Promise.resolve([]),
                findJobTraits(info.name, ctx.signal),
            ]);
            // Base-class actions (e.g. 枪术师) supply the first combo steps of the job.
            const merged = new Map();
            for (const action of parentActions)
                merged.set(action.id, action);
            for (const action of jobActions)
                merged.set(action.id, action);
            const visibleActions = [...merged.values()].filter((action) => !action.isPvp && action.level > 0);
            const filtered = level === undefined ? visibleActions : visibleActions.filter((action) => action.level <= level);
            const filteredTraits = level === undefined ? traits : traits.filter((trait) => trait.level <= level);
            const gcd = filtered
                .filter((action) => GCD_CATEGORIES.has(action.category ?? ''))
                .sort((left, right) => left.level - right.level || left.name.localeCompare(right.name, 'zh-Hans-CN'));
            const abilities = filtered
                .filter((action) => action.category === '能力')
                .sort((left, right) => left.level - right.level || (cooldownSeconds(left) ?? 0) - (cooldownSeconds(right) ?? 0));
            const comboName = new Map();
            for (const action of filtered)
                comboName.set(action.id, action.name);
            const chains = buildComboChains(filtered);
            const value = {
                found: true,
                job: {
                    name: info.name,
                    abbr: info.abbreviation,
                    role: staticJob?.role ?? '战斗职业',
                    ...(info.category ? { category: info.category } : {}),
                },
                ...(level !== undefined ? { level } : {}),
                combos: chains,
                gcdSkills: gcd.slice(0, 60).map((action) => {
                    const cast = castSeconds(action);
                    const combo = action.comboId ? comboName.get(action.comboId) : undefined;
                    return {
                        name: action.name,
                        level: action.level,
                        ...(cast !== undefined ? { castSeconds: cast } : {}),
                        ...(combo ? { combo } : {}),
                    };
                }),
                abilities: abilities.slice(0, 50).map((action) => {
                    const cd = cooldownSeconds(action);
                    return { name: action.name, level: action.level, ...(cd !== undefined ? { cooldownSeconds: cd } : {}) };
                }),
                traits: filteredTraits.slice(0, 40).map((trait) => ({
                    name: trait.name,
                    level: trait.level,
                    ...(trait.description ? { description: truncate(trait.description, 200) } : {}),
                })),
            };
            const messages = [
                '技能结构自动整理自 XIVAPI 中文数据集的官方 Action/Trait 表；不包含最优起手或循环优先级，实际输出请结合版本与队伍调整。',
            ];
            const guideEndpoint = ENDPOINTS.jobGuide();
            if (guideEndpoint) {
                try {
                    const params = new URLSearchParams({ job: info.name, abbr: info.abbreviation });
                    if (level !== undefined)
                        params.set('level', String(level));
                    const payload = await requestJson(`${guideEndpoint}?${params.toString()}`, {
                        timeoutMs: 10000,
                        signal: ctx.signal,
                    });
                    const curated = readGuideEndpointPayload(payload);
                    if (curated.guideText)
                        value.guideText = curated.guideText;
                    if (curated.source)
                        value.source = curated.source;
                }
                catch (error) {
                    messages.push(`自定义攻略端点不可用（${shortReason(error)}）。`);
                }
            }
            if (!value.guideText) {
                value.source = { name: `灰机wiki · ${info.name}`, url: wikiPageUrl(info.name) };
                messages.push('灰机wiki 职业页提供技能连击/特性/量谱说明；更详细的输出手法请参考 NGA/素素等社区攻略。');
            }
            if (filtered.length === 0)
                messages.push('该等级下没有技能数据（可能是等级过低或职业名不匹配）。');
            value.message = messages.join(' ');
            return value;
        }),
    });
    const dutyGuide = define({
        name: 'ffxiv_duty_guide',
        description: '当用户询问 FF14 某个副本的攻略、机制、打法、开放条件或“这个本怎么打”时调用此工具。返回副本官方信息（等级/装等/人数/是否高难/官方简介）以及灰机 wiki 的机制与打法摘要；数据来自官方 ContentFinderCondition 表与 FF14 中文 wiki，可配置自定义攻略端点。',
        parameters: {
            duty: { type: 'string', required: true, description: '副本名，可写全名或部分名，如“万魔殿 边境之狱4”“零式万魔殿 炼净之狱4”' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    found: { type: 'boolean' },
                    duty: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            name: { type: 'string' },
                            level: { type: 'integer' },
                            ilvl: { type: 'integer' },
                            contentType: { type: 'string' },
                            party: { type: 'string' },
                            highEnd: { type: 'boolean' },
                            territory: { type: 'string' },
                        },
                        required: ['name'],
                    },
                    description: { type: 'string' },
                    guideText: { type: 'string' },
                    source: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { name: { type: 'string' }, url: { type: 'string' } },
                        required: ['name', 'url'],
                    },
                    message: { type: 'string' },
                },
                required: ['found'],
            },
            render(args, value) {
                if (!value.found)
                    return [text(String(value.message ?? '没有找到该副本的攻略数据。'))];
                const duty = value.duty ?? {};
                const meta = [];
                if (duty.contentType)
                    meta.push(String(duty.contentType));
                if (duty.level)
                    meta.push(`Lv.${duty.level}`);
                if (duty.ilvl)
                    meta.push(`装等 ${duty.ilvl}`);
                meta.push(`高难：${duty.highEnd ? '是' : '否'}`);
                const lines = [`副本：${duty.name}（${meta.join(' · ')}）`];
                if (duty.party)
                    lines.push(`队伍构成：${duty.party}`);
                if (duty.territory)
                    lines.push(`所在地图：${duty.territory}`);
                if (value.description)
                    lines.push(`官方简介：${truncate(value.description, 220)}`);
                if (value.guideText)
                    lines.push('机制与攻略要点：', String(value.guideText));
                if (value.source)
                    lines.push(`来源：${value.source.name} · ${value.source.url}`);
                if (value.message)
                    lines.push(String(value.message));
                return [text(lines.join('\n'))];
            },
        },
        timeoutMs: 120000,
        execute: guardTool('ffxiv_duty_guide', async (args, ctx) => {
            const dutyRaw = requireString(args, 'duty', '副本名');
            const messages = [];
            let matched;
            try {
                const candidates = await findDuties(dutyRaw, ctx.signal);
                if (candidates.length > 0) {
                    const wanted = normalizeName(dutyRaw);
                    matched =
                        candidates.find((item) => normalizeName(item.name) === wanted) ??
                            candidates.find((item) => normalizeName(item.name).includes(wanted) || wanted.includes(normalizeName(item.name))) ??
                            candidates[0];
                }
            }
            catch (error) {
                messages.push(`官方副本资料查询失败（${shortReason(error)}）。`);
            }
            let description;
            let placeName;
            if (matched) {
                try {
                    description = await getDutyTransientDescription(matched.id, ctx.signal);
                }
                catch {
                    // Description is optional flavor; ignore transient failures.
                }
                if (matched.territoryId) {
                    placeName = await getTerritoryPlaceName(matched.territoryId, ctx.signal).catch(() => undefined);
                }
            }
            let guideText;
            let source;
            const dutyEndpoint = ENDPOINTS.dutyGuide();
            if (dutyEndpoint) {
                try {
                    const params = new URLSearchParams({ duty: dutyRaw });
                    const payload = await requestJson(`${dutyEndpoint}?${params.toString()}`, {
                        timeoutMs: 10000,
                        signal: ctx.signal,
                    });
                    const curated = readGuideEndpointPayload(payload);
                    if (curated.guideText)
                        guideText = curated.guideText;
                    if (curated.source)
                        source = curated.source;
                }
                catch (error) {
                    messages.push(`自定义攻略端点不可用（${shortReason(error)}）。`);
                }
            }
            if (!guideText) {
                try {
                    const hits = await wikiSearch(matched?.name ?? dutyRaw, 6, ctx.signal);
                    const wanted = normalizeName(matched?.name ?? dutyRaw);
                    const page = hits.find((hit) => normalizeName(hit.title) === wanted) ??
                        hits.find((hit) => normalizeName(hit.title).includes(wanted) || wanted.includes(normalizeName(hit.title))) ??
                        hits[0];
                    if (page) {
                        const pageText = await wikiPageText(page.title, ctx.signal);
                        if (pageText) {
                            const mechanics = extractMechanics(pageText);
                            if (mechanics.length > 30) {
                                guideText = mechanics;
                                source = { name: '灰机wiki', url: wikiPageUrl(page.title) };
                            }
                        }
                    }
                }
                catch (error) {
                    messages.push(`灰机wiki 暂时不可用（${shortReason(error)}）。`);
                }
            }
            if (!matched && !guideText) {
                return {
                    found: false,
                    message: `没有找到副本“${dutyRaw}”的资料。请尝试更完整的副本名，例如“万魔殿 边境之狱4”；也可以设置 FFXIV_DUTY_GUIDE_ENDPOINT 使用自定义攻略端点。`,
                };
            }
            const party = matched?.member
                ? `${matched.member.tanks ?? 0} 坦克 / ${matched.member.healers ?? 0} 治疗 / ${Math.max(0, (matched.member.membersPerParty ?? 0) - (matched.member.tanks ?? 0) - (matched.member.healers ?? 0))} 输出${(matched.member.partyCount ?? 1) > 1 ? ` × ${matched.member.partyCount} 队` : ''}`
                : undefined;
            const value = {
                found: true,
                duty: {
                    name: matched?.name ?? dutyRaw,
                    ...(matched?.levelRequired ? { level: matched.levelRequired } : {}),
                    ...(matched?.ilvlRequired ? { ilvl: matched.ilvlRequired } : {}),
                    ...(matched?.contentType ? { contentType: matched.contentType } : {}),
                    ...(party ? { party } : {}),
                    highEnd: matched?.highEnd ?? false,
                    ...(placeName ? { territory: placeName } : {}),
                },
                ...(description ? { description } : {}),
                ...(guideText ? { guideText } : {}),
                ...(source ? { source } : {}),
            };
            if (!guideText)
                messages.push('攻略正文来源（灰机wiki）暂不可达；以上为官方基础信息，可稍后重试或配置 FFXIV_DUTY_GUIDE_ENDPOINT。');
            messages.push('攻略内容来自社区 wiki，可能随版本变化；机制细节请以当前版本和团队实际为准。');
            value.message = messages.join(' ');
            return value;
        }),
    });
    return [jobGuide, dutyGuide];
}
