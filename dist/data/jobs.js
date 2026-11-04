/** Combat job metadata used to resolve aliases and role labels. @module dsh-plugin-ffxiv/data/jobs */
/** All combat jobs, including the limited job Blue Mage. */
export const COMBAT_JOBS = [
    { name: '骑士', abbr: 'PLD', role: '防护', aliases: ['pld', 'paladin', '圣骑士'] },
    { name: '战士', abbr: 'WAR', role: '防护', aliases: ['war', 'warrior'] },
    { name: '暗黑骑士', abbr: 'DRK', role: '防护', aliases: ['drk', 'darkknight', '黑骑', '暗骑'] },
    { name: '绝枪战士', abbr: 'GNB', role: '防护', aliases: ['gnb', 'gunbreaker', '绝枪', '枪刃'] },
    { name: '白魔法师', abbr: 'WHM', role: '治疗', aliases: ['whm', 'whitemage', '白魔'] },
    { name: '学者', abbr: 'SCH', role: '治疗', aliases: ['sch', 'scholar'] },
    { name: '占星术士', abbr: 'AST', role: '治疗', aliases: ['ast', 'astrologian', '占星', '占星师'] },
    { name: '贤者', abbr: 'SGE', role: '治疗', aliases: ['sge', 'sage', '贤者'] },
    { name: '武僧', abbr: 'MNK', role: '近战', aliases: ['mnk', 'monk', '武憎'] },
    { name: '龙骑士', abbr: 'DRG', role: '近战', aliases: ['drg', 'dragoon', '龙骑'] },
    { name: '忍者', abbr: 'NIN', role: '近战', aliases: ['nin', 'ninja'] },
    { name: '武士', abbr: 'SAM', role: '近战', aliases: ['sam', 'samurai'] },
    { name: '钐镰客', abbr: 'RPR', role: '近战', aliases: ['rpr', 'reaper', '镰刀', '钐镰', '收割者'] },
    { name: '蝰蛇剑士', abbr: 'VPR', role: '近战', aliases: ['vpr', 'viper', '蝰蛇', '毒蛇剑士'] },
    { name: '吟游诗人', abbr: 'BRD', role: '远程物理', aliases: ['brd', 'bard', '诗人'] },
    { name: '机工士', abbr: 'MCH', role: '远程物理', aliases: ['mch', 'machinist', '机工', '机械师'] },
    { name: '舞者', abbr: 'DNC', role: '远程物理', aliases: ['dnc', 'dancer'] },
    { name: '黑魔法师', abbr: 'BLM', role: '远程魔法', aliases: ['blm', 'blackmage', '黑魔'] },
    { name: '召唤师', abbr: 'SMN', role: '远程魔法', aliases: ['smn', 'summoner', '召唤'] },
    { name: '赤魔法师', abbr: 'RDM', role: '远程魔法', aliases: ['rdm', 'redmage', '赤魔'] },
    { name: '绘灵法师', abbr: 'PCT', role: '远程魔法', aliases: ['pct', 'pictomancer', '绘灵'] },
    { name: '青魔法师', abbr: 'BLU', role: '限定', aliases: ['blu', 'bluemage', '青魔'] },
];
function normalize(raw) {
    return raw.trim().toLowerCase().replace(/[\s_·・-]+/g, '');
}
/** Resolve a user-supplied job name/alias to one job, or `undefined`. */
export function resolveCombatJob(raw) {
    if (!raw)
        return undefined;
    const key = normalize(raw);
    if (key.length === 0)
        return undefined;
    return COMBAT_JOBS.find((job) => {
        const names = [job.name, job.abbr, ...(job.aliases ?? [])];
        return names.some((name) => normalize(name) === key);
    });
}
