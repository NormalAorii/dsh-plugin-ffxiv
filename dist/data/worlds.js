/** Static Chinese world / data-center data (used for server resolution and display). @module dsh-plugin-ffxiv/data/worlds */
/** All Chinese-region worlds with their Universalis world ids. */
export const CN_WORLDS = [
    { id: 1167, name: '红玉海' },
    { id: 1081, name: '神意之地' },
    { id: 1042, name: '拉诺西亚' },
    { id: 1044, name: '幻影群岛' },
    { id: 1060, name: '萌芽池' },
    { id: 1173, name: '宇宙和音' },
    { id: 1174, name: '沃仙曦染' },
    { id: 1175, name: '晨曦王座' },
    { id: 1172, name: '白银乡' },
    { id: 1076, name: '白金幻象' },
    { id: 1171, name: '神拳痕' },
    { id: 1170, name: '潮风亭' },
    { id: 1113, name: '旅人栈桥' },
    { id: 1121, name: '拂晓之间' },
    { id: 1166, name: '龙巢神殿' },
    { id: 1176, name: '梦羽宝境' },
    { id: 1043, name: '紫水栈桥' },
    { id: 1169, name: '延夏' },
    { id: 1106, name: '静语庄园' },
    { id: 1045, name: '摩杜纳' },
    { id: 1177, name: '海猫茶屋' },
    { id: 1178, name: '柔风海湾' },
    { id: 1179, name: '琥珀原' },
    { id: 1192, name: '水晶塔' },
    { id: 1183, name: '银泪湖' },
    { id: 1180, name: '太阳海岸' },
    { id: 1186, name: '伊修加德' },
    { id: 1201, name: '红茶川' },
    { id: 4028, name: '伊弗利特' },
    { id: 4029, name: '迦樓羅' },
    { id: 4030, name: '利維坦' },
    { id: 4031, name: '鳳凰' },
    { id: 4032, name: '奧汀' },
    { id: 4033, name: '巴哈姆特' },
    { id: 4034, name: '拉姆' },
    { id: 4035, name: '泰坦' },
];
/** Chinese data centers. */
export const CN_DATACENTERS = [
    { name: '陆行鸟', worlds: [1167, 1081, 1042, 1044, 1060, 1173, 1174, 1175] },
    { name: '莫古力', worlds: [1172, 1076, 1171, 1170, 1113, 1121, 1166, 1176] },
    { name: '猫小胖', worlds: [1043, 1169, 1106, 1045, 1177, 1178, 1179] },
    { name: '豆豆柴', worlds: [1192, 1183, 1180, 1186, 1201] },
];
/** Common shorthand for Chinese data centers. */
export const CN_DC_ALIASES = {
    鸟区: '陆行鸟',
    鸟服: '陆行鸟',
    陆行鸟区: '陆行鸟',
    猪区: '莫古力',
    猪服: '莫古力',
    莫古力区: '莫古力',
    猫区: '猫小胖',
    猫服: '猫小胖',
    猫小胖区: '猫小胖',
    狗区: '豆豆柴',
    狗服: '豆豆柴',
    豆豆柴区: '豆豆柴',
};
/** Non-Chinese data center names accepted by Universalis. */
export const INTERNATIONAL_DATACENTERS = [
    'Aether',
    'Primal',
    'Crystal',
    'Dynamis',
    'Light',
    'Chaos',
    'Elemental',
    'Gaia',
    'Mana',
    'Meteor',
    'Materia',
    'Shadow',
    'Vana\'diel',
];
/** Set of Chinese world names for fast membership checks. */
export const CN_WORLD_NAMES = new Set(CN_WORLDS.map((world) => world.name));
/** Set of Chinese data center names. */
export const CN_DC_NAMES = new Set(CN_DATACENTERS.map((dc) => dc.name));
/** Resolve one Chinese world or data center name to its canonical spelling. */
export function canonicalChineseServer(raw) {
    const key = raw.trim();
    if (key.length === 0)
        return undefined;
    const alias = CN_DC_ALIASES[key];
    if (alias)
        return alias;
    if (CN_DC_NAMES.has(key))
        return key;
    if (CN_WORLD_NAMES.has(key))
        return key;
    return undefined;
}
/** Whether the given world belongs to the Chinese region. */
export function isChineseWorld(name) {
    return CN_WORLD_NAMES.has(name);
}
