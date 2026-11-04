/** Static weather tables and common territory aliases (Chinese Data Center). @module dsh-plugin-ffxiv/data/weather */
/**
 * Hardcoded WeatherRate rows for the most commonly queried zones.
 * Data captured from XIVAPI (`/api/sheet/WeatherRate/{id}?language=chs`).
 */
export const WEATHER_RATES = {
    1: { rate: [5, 15, 10, 10, 15, 30, 15, 0], weather: ['小雨', '小雨', '薄雾', '阴云', '晴朗', '碧空', '晴朗', ''] },
    2: { rate: [5, 15, 10, 10, 15, 30, 15, 0], weather: ['小雨', '小雨', '薄雾', '阴云', '晴朗', '碧空', '晴朗', ''] },
    7: { rate: [40, 20, 25, 10, 5, 0, 0, 0], weather: ['碧空', '晴朗', '阴云', '薄雾', '小雨', '', '', ''] },
    14: { rate: [20, 30, 30, 10, 10, 0, 0, 0], weather: ['阴云', '碧空', '晴朗', '薄雾', '小雨', '', '', ''] },
    15: { rate: [20, 30, 30, 10, 10, 0, 0, 0], weather: ['阴云', '碧空', '晴朗', '薄雾', '小雨', '', '', ''] },
    21: { rate: [20, 40, 10, 5, 15, 10, 0, 0], weather: ['暴雪', '小雪', '晴朗', '碧空', '阴云', '薄雾', '', ''] },
    22: { rate: [15, 15, 30, 15, 25, 0, 0, 0], weather: ['阴云', '薄雾', '妖雾', '碧空', '晴朗', '', '', ''] },
    47: { rate: [60, 10, 5, 15, 10, 0, 0, 0], weather: ['小雪', '晴朗', '碧空', '阴云', '薄雾', '', '', ''] },
    82: { rate: [10, 10, 20, 40, 20, 0, 0, 0], weather: ['小雨', '薄雾', '阴云', '晴朗', '碧空', '', '', ''] },
    112: { rate: [20, 40, 15, 10, 10, 5, 0, 0], weather: ['碧空', '晴朗', '阴云', '薄雾', '小雨', '雷雨', '', ''] },
    132: { rate: [10, 10, 5, 15, 40, 20, 0, 0], weather: ['薄雾', '小雨', '暴雨', '碧空', '晴朗', '阴云', '', ''] },
    137: { rate: [10, 40, 20, 15, 15, 0, 0, 0], weather: ['碧空', '晴朗', '阴云', '薄雾', '小雪', '', '', ''] },
    159: { rate: [40, 40, 5, 10, 5, 0, 0, 0], weather: ['碧空', '晴朗', '阴云', '薄雾', '小雨', '', '', ''] },
};
/** Known territories and their aliases; used before falling back to XIVAPI. */
export const WEATHER_TERRITORIES = [
    { id: 132, name: '格里达尼亚新街', weatherRateId: 1, aliases: ['森都', '格里达尼亚', '新街'] },
    { id: 133, name: '格里达尼亚旧街', weatherRateId: 2, aliases: ['旧街'] },
    { id: 128, name: '利姆萨·罗敏萨上层甲板', weatherRateId: 14, aliases: ['海都', '利姆萨', '利姆萨·罗敏萨', '上层甲板'] },
    { id: 129, name: '利姆萨·罗敏萨下层甲板', weatherRateId: 15, aliases: ['下层甲板'] },
    { id: 130, name: '乌尔达哈现世回廊', weatherRateId: 7, aliases: ['沙都', '乌尔达哈', '现世回廊'] },
    { id: 418, name: '伊修加德基础层', weatherRateId: 47, aliases: ['伊修加德', '基础层'] },
    { id: 628, name: '黄金港', weatherRateId: 82, aliases: ['黄金港'] },
    { id: 819, name: '水晶都', weatherRateId: 112, aliases: ['水晶都'] },
    { id: 962, name: '旧萨雷安', weatherRateId: 137, aliases: ['萨雷安', '旧萨雷安'] },
    { id: 1185, name: '图莱尤拉', weatherRateId: 159, aliases: ['图莱尤拉'] },
    { id: 957, name: '萨维奈岛', weatherRateId: 132, aliases: ['萨维奈'] },
    { id: 156, name: '摩杜纳', weatherRateId: 22, aliases: ['摩杜纳'] },
    { id: 155, name: '库尔札斯中央高地', weatherRateId: 21, aliases: ['库尔札斯', '中央高地'] },
];
/** Flattened alias → canonical territory-name map (lowercase keys). */
export const TERRITORY_ALIASES = (() => {
    const map = {};
    for (const territory of WEATHER_TERRITORIES) {
        map[territory.name.toLowerCase()] = territory.name;
        for (const alias of territory.aliases ?? [])
            map[alias.toLowerCase()] = territory.name;
    }
    return map;
})();
/** Find one known territory by name or alias. */
export function findKnownTerritory(raw) {
    const name = TERRITORY_ALIASES[raw.trim().toLowerCase()];
    if (!name)
        return undefined;
    return WEATHER_TERRITORIES.find((territory) => territory.name === name);
}
