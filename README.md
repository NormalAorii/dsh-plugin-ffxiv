# dsh-plugin-ffxiv

面向 DeepSeek Harness 的 FF14（最终幻想14）中文查询工具插件。通过 Cordis 插件在 `ctx.tools` 上注册 **21 个模型可调用工具**，覆盖物品、板子行情、配方成本、角色/FFLogs、艾欧泽亚时间/天气/重置、房屋/招募/青魔/官方公告、职业循环与副本攻略等常见查询场景。模型在 Agent Loop 中根据自然语言自行选择工具，插件不包含 UI、定时任务或消息推送逻辑。

- 插件格式：Cordis 插件，`export const inject = ['tools']`，`apply` 中批量注册 `defineTool`。
- 工具实现：真实 `@deepseek-ai/dsh-tools` 的 `defineTool` 可解析时直接使用；不可解析时自动回退到等价的原始 JSON Schema 工具定义（Harness 注册器同样接受），因此插件在宿主 profile 中不依赖额外运行时依赖。
- 数据源：XIVAPI v2（国服 `language=chs`）、Universalis、Lodestone、FFLogs（OAuth）、艾欧泽亚售楼中心（房屋）、xivpf（远程招募）、RSSHub（中文公告）；依赖社区端点/OAuth 的工具在缺少端点或凭据时返回 `supported: false`，**绝不返回编造的假数据**。

## 工具一览

| # | 工具 | 何时调用 | 关键参数 | 数据源 | 需环境变量/凭据 | 不支持时行为 |
|---|------|----------|----------|--------|-----------------|--------------|
| 1 | `ffxiv_search_item` | 想确认物品标准中文名/物品 ID，或只给了模糊物品名 | `query`(必填)、`limit`(1–20，默认 5) | XIVAPI `/api/search?sheets=Item&language=chs` | — | `matches: []` + `message` |
| 2 | `ffxiv_item_info` | 查物品品级/类型/可交易/可 HQ/简介/来源简述 | `itemName` 或 `itemId` 二选一 | XIVAPI Item sheet | — | `found: false` + `message` |
| 3 | `ffxiv_market_price` | 查某服/大区/DC 板子当前最低价与在售 | `itemName`、`server`(必填)、`hqOnly`、`limit` | Universalis `/api/v2/{server}/{itemId}` | — | 空在售 → `listings: []` + `message`“无在售记录” |
| 4 | `ffxiv_market_history` | 看近期成交与行情走势 | `itemName`、`server`、`entries`(1–20，默认 10) | Universalis `recentHistory` | — | 空 → `entries: []` + `message` |
| 5 | `ffxiv_market_compare` | 跨服比价，决定去哪买 | `itemName`、`servers`(逗号分隔，≤6) | Universalis（逐个串行查询） | — | 无数据行显示“无在售”+ `message` |
| 6 | `ffxiv_employee_items` | 查雇员可带回物品，按狩猎/采矿/采伐/捕鱼分类 | `job`、`level`（均可选） | XIVAPI 官方 `RetainerTask` 表（中文数据集） | —（可选 `FFXIV_EMPLOYEE_ENDPOINT` 覆盖） | 职业无法识别 → `supported: false` + 说明 |
| 7 | `ffxiv_recipe_cost` | 按配方和服务器物价估算制作成本 | `itemName`(成品)、`server`、`quantity`(默认 1) | XIVAPI Recipe + Universalis | — | 无配方/材料缺价 → `message` 说明缺口，不编价格 |
| 8 | `ffxiv_profit_estimate` | 估算制作利润与利润率 | `itemName`、`server` | 复用配方成本 + 成品最低售价 | — | 无配方/成品无在售 → `message` |
| 9 | `ffxiv_character_lookup` | 查角色 Lodestone 档案（服务器/种族/部队/平均品级） | `name`(全名)、`server` | Lodestone 搜索页/详情页（尽力解析） | `FFXIV_CHARACTER_ENDPOINT`（国服/自定义端点） | `supported: false` + `message` |
| 10 | `ffxiv_fflogs_summary` | 查 FFLogs 报告摘要或角色输出分位 | `reportUrl` 或 `characterName`+`server`、`metric` | FFLogs GraphQL（OAuth） | `FFLOGS_CLIENT_ID`、`FFLOGS_CLIENT_SECRET`（可选 `FFLOGS_REGION`） | 缺凭据 → `supported: false` + `message` |
| 11 | `ffxiv_et_now` | 查当前艾欧泽亚时间（ET）与本地对照 | 无 | 本地确定性计算 | — | 不适用（纯本地） |
| 12 | `ffxiv_reset_timers` | 查每日/每周重置倒计时 | 无 | 本地确定性计算（UTC 08:00 重置） | — | 不适用；不含房屋 demolish（无可靠来源） |
| 13 | `ffxiv_weather` | 查地图当前天气与后续天气窗口 | `territory`(支持森都/海都/沙都等别名)、`windows`(1–6，默认 3) | 本地确定性算法 + 内置 WeatherRate 表；未知地图回退 XIVAPI TerritoryType/WeatherRate | — | 未知地图 → `upcoming: []` + `message` |
| 14 | `ffxiv_server_status` | 查服务器在线状态 | `dc`（可选） | 默认无公开接口 | `FFXIV_SERVER_STATUS_ENDPOINT` | `supported: false` + 说明端点格式 |
| 15 | `ffxiv_housing` | 查某服空房/抽签 | `server`、`district`、`size`、`limit` | 艾欧泽亚售楼中心 `https://house.ffxiv.cyou/api/sales?server=<worldId>`（默认可用） | —（可选 `FFXIV_HOUSING_ENDPOINT` 覆盖） | 接口不可达 → `supported: false` + 说明 |
| 16 | `ffxiv_party_finder` | 查远程招募板 | `dc`、`category`、`keyword`、`limit` | xivpf v1 `https://xivpf.littlenightmare.top/api/listings`（默认可用） | —（可选 `FFXIV_PARTY_FINDER_ENDPOINT` 覆盖） | 接口不可达 → `supported: false` + 说明 |
| 17 | `ffxiv_fashion_report` | 查本周时尚品鉴作业 | `week`（默认 `current`） | 社区周更数据（默认不可用） | `FFXIV_FASHION_ENDPOINT` | `supported: false` + 说明端点格式 |
| 18 | `ffxiv_blue_mage_spell` | 查青魔法师技能说明与学习地点 | `spellName`（支持部分匹配） | XIVAPI AozAction/AozActionTransient | — | 未命中 → `found: false` + `message`；地点缺失时只返回说明并提示 |
| 19 | `ffxiv_official_news` | 查官方最新公告/更新摘要 | `limit`(1–5，默认 3) | 中文公告 RSS（RSSHub，默认）/Lodestone Topics 回退/自定义端点 | 可选 `FFXIV_NEWS_RSS`、`FFXIV_NEWS_ENDPOINT` | 全部不可达 → `supported: false` + 说明；只有标题链接时明确说明“无摘要” |
| 20 | `ffxiv_job_guide` | 查某战斗职业的技能循环结构：连击链、GCD、能力技 CD、特性 | `job`(必填，支持 WHM/DRG/白魔/龙骑等简称)、`level`（可选） | XIVAPI ClassJob/Action/ActionCombo/Trait（合并父职业基础技能） | 可选 `FFXIV_JOB_GUIDE_ENDPOINT`（社区循环 JSON） | 职业无法识别 → `found: false` + `message`；不编造“最优起手” |
| 21 | `ffxiv_duty_guide` | 查某副本的攻略/机制/官方信息 | `duty`（必填，支持部分名） | 官方 ContentFinderCondition/CFCTransient + 灰机 wiki 机制摘要 | 可选 `FFXIV_WIKI_API`（wiki 镜像）、`FFXIV_DUTY_GUIDE_ENDPOINT` | wiki 不可达时降级为官方信息 + 链接 + `message`，不编造机制 |

## 快速开始

```bash
# 1. 安装开发依赖并构建（在插件目录内）
npm install
npm run build

# 2. 安装到 Harness profile（本机实例使用 desktop profile；命令中的 profile 名按实际环境替换）
npx @deepseek-ai/dsh plugin --profile web add ./dsh-plugin-ffxiv
#   本机 deepseek-harness 实例：npx @deepseek-ai/dsh plugin --profile desktop add ./dsh-plugin-ffxiv

# 3. 重启 Harness，模型即可在 Agent Loop 中调用全部 ffxiv_* 工具
```

安装后可用以下方式确认：

```bash
npm run typecheck   # TypeScript 严格编译
npm run verify      # 离线校验：21 个工具、schema、渲染、local-only 与不支持路径
node scripts/smoke.mjs   # 真实网络冒烟（可选，需外网；部分端点在本机可能超时）
```

卸载：

```bash
npx @deepseek-ai/dsh plugin --profile web remove dsh-plugin-ffxiv
```

## 环境变量

| 变量 | 默认值 | 用途 |
|------|--------|------|
| `FFXIV_XIVAPI_BASE` | `https://xivapi-v2.xivcdn.com/api` | XIVAPI 节点（国服 chs） |
| `FFXIV_UNIVERSALIS_BASE` | `https://universalis.app/api/v2` | Universalis 行情 API |
| `FFXIV_LODESTONE_TOPICS` | `https://na.finalfantasyxiv.com/lodestone/topics/` | 官方公告页 |
| `FFXIV_LODESTONE_CHARACTER` | `https://na.finalfantasyxiv.com/lodestone/character/` | 角色搜索/详情页前缀 |
| `FFXIV_DISCLAIMER` | 启用 | 设为 `0` 关闭行情类输出末尾的第三方免责声明 |
| `FFXIV_CONFIG_FILE` | 未设置 | 显式指定配置文件路径（优先于默认路径） |
| `FFXIV_CHARACTER_ENDPOINT` | 未设置 | 角色查询自定义端点（国服角色或代理），替代 Lodestone 解析 |
| `FFXIV_HOUSING_ENDPOINT` | `https://house.ffxiv.cyou/api/sales` | 房屋查询端点（兼容售楼中心 `/api/sales?server=` 结构） |
| `FFXIV_PARTY_FINDER_ENDPOINT` | `https://xivpf.littlenightmare.top/api/listings` | 招募板端点（xivpf v1 结构） |
| `FFXIV_FASHION_ENDPOINT` | 未设置 | 时尚品鉴周更数据端点 |
| `FFXIV_EMPLOYEE_ENDPOINT` | 未设置 | 可选：雇员带回物品自定义端点（默认已用 XIVAPI 官方表，无需配置） |
| `FFXIV_SERVER_STATUS_ENDPOINT` | 未设置 | 服务器状态端点（自建代理） |
| `FFXIV_NEWS_RSS` | `https://rsshub.app/ff14/zh/all` | 中文公告 RSS（RSSHub 或镜像/自建实例） |
| `FFXIV_NEWS_ENDPOINT` | 未设置 | 官方新闻 JSON 端点（优先于 RSS/Lodestone） |
| `FFXIV_WIKI_API` | `https://ff14.huijiwiki.com/api.php` | 灰机 wiki MediaWiki API（副本攻略机制摘要；站点启用了 Cloudflare，可能返回 403 挑战，可换成镜像/代理） |
| `FFXIV_JOB_GUIDE_ENDPOINT` | 未设置 | 可选：社区职业循环 JSON 端点（`{summary,rotation[],tips[],url}`），覆盖自动推导的基础循环说明 |
| `FFXIV_DUTY_GUIDE_ENDPOINT` | 未设置 | 可选：副本攻略 JSON 端点（`{description,guideText,source,url}`），wiki 不可达时使用 |
| `FFLOGS_CLIENT_ID` | 未设置 | FFLogs OAuth 客户端 ID |
| `FFLOGS_CLIENT_SECRET` | 未设置 | FFLogs OAuth 客户端密钥 |
| `FFLOGS_TOKEN_URL` | `https://www.fflogs.com/oauth/token` | FFLogs Token 端点 |
| `FFLOGS_API_URL` | `https://www.fflogs.com/api/v2/client` | FFLogs GraphQL 端点 |
| `FFLOGS_REGION` | 自动（国服 `CN`，否则 `NA`） | FFLogs 区域覆盖 |

### 本地配置文件（可选）

除环境变量外，也可以把端点/凭据写进配置文件，避免每次设置环境变量。读取顺序：`FFXIV_CONFIG_FILE` 指定的路径 → `%USERPROFILE%\.dsh\profiles\<DSH_PROFILE>\ffxiv-plugin.json`（当前 profile）→ `%USERPROFILE%\.dsh\ffxiv-plugin.json`。**环境变量优先于配置文件**。文件缺失、JSON 损坏或字段类型不对时静默忽略（回退默认值），不会阻塞插件加载。

```jsonc
// %USERPROFILE%\.dsh\profiles\desktop\ffxiv-plugin.json
{
  "endpoints": {
    "housing": "https://house.ffxiv.cyou/api/sales",
    "partyFinder": "https://xivpf.littlenightmare.top/api/listings",
    "newsRss": "https://rsshub.app/ff14/zh/all",
    "character": "",
    "fashion": "",
    "serverStatus": "",
    "employee": "",
    "news": "",
    "wikiApi": "https://ff14.huijiwiki.com/api.php",
    "jobGuide": "",
    "dutyGuide": ""
  },
  "fflogs": { "clientId": "...", "clientSecret": "...", "region": "CN" }
}
```

### 社区端点 JSON 约定

房屋（`FFXIV_HOUSING_ENDPOINT`，默认已指向售楼中心）与招募（`FFXIV_PARTY_FINDER_ENDPOINT`，默认已指向 xivpf v1）都自带真实默认端点，通常无需配置。只有换用自建/镜像端点时，才需要让端点返回下述结构（字段缺失时尽量容错，但不会补造数据）。

```jsonc
// FFXIV_CHARACTER_ENDPOINT?name=&server=  → 单个角色对象或数组
{ "name": "塔塔露", "server": "神意之地", "race": "拉拉菲尔族", "clan": "平原之民",
  "guardian": "梅茵菲娜", "grandCompany": "双蛇党", "freeCompany": "部队名",
  "avgItemLevel": 710, "url": "https://..." }

// FFXIV_HOUSING_ENDPOINT?server=<worldId>  → 默认售楼中心返回数组；自定义端点也可返回 { plots: [...] }
[{ "Server": 1081, "Area": 0, "Slot": 2, "ID": 3, "Price": 3000000, "Size": 0,
   "PurchaseType": 2, "RegionType": 2, "State": 1, "EndTime": 0 }]
// Area: 0 海雾村 / 1 薰衣草苗圃 / 2 高脚孤丘 / 3 白银乡 / 4 穹顶皓天；Size: 0 S / 1 M / 2 L
// PurchaseType: 1 先到先得 / 2 抽签；State: 1 可购买 / 2 结果公示 / 3 准备中

// FFXIV_PARTY_FINDER_ENDPOINT?page=&per_page=&datacenter=&category=&search=  → 默认 xivpf v1
{ "data": [{ "id": 177099, "name": "玩家名", "description": "...", "home_world": "萌芽池",
  "home_world_id": 1060, "category": "HighEndDuty", "category_id": 2, "duty": "副本名",
  "slots_filled": 1, "slots_available": 8, "time_left": 1800, "datacenter": "陆行鸟" }],
  "pagination": { "total": 1, "page": 1, "per_page": 12, "total_pages": 1 } }
// 也可返回 { listings: [...] }；详情 /api/listing/{id} 的 slots[] 用于职业需求

// FFXIV_FASHION_ENDPOINT?week=current
{ "week": "current", "entries": [{ "slot": "头部", "item": "示例装备", "dye": "无染色", "hq": false }] }

// FFXIV_EMPLOYEE_ENDPOINT?job=&category=&level=
{ "items": [{ "name": "示例物品", "category": "狩猎", "level": 90 }] }

// FFXIV_SERVER_STATUS_ENDPOINT  → 数组，或 { servers: [...] }，或 { dataCenters: [{ name, worlds: [{ name, status }] }] }
[{ "dc": "陆行鸟", "world": "红玉海", "status": "online" }]

// FFXIV_NEWS_ENDPOINT?limit=
{ "items": [{ "title": "标题", "url": "https://...", "summary": "可选摘要", "publishedAt": "2026-10-29" }] }
```

## 工具详情

### A. 物品基础

**`ffxiv_search_item`** — 参数：`query`（string，必填，物品中文名可部分匹配）、`limit`（integer，默认 5，最大 20）。返回 `{ matches: [{ id, name }], message? }`。空结果返回 `matches: []` + 提示更短/更常见的中文名。渲染为“找到 N 个物品：”+ 每行 `- 名称（ID: xxx）`。

**`ffxiv_item_info`** — 参数：`itemName`（string）或 `itemId`（integer），二选一；传名称时内部先走搜索逻辑取第一个匹配并写缓存。返回品级（`itemLevel`）、类型（`itemCategory`）、板子分类、`canBeHq`、`tradable`、简介（超 200 字符截断加省略号）、来源简述（根据可交易/可 HQ 属性给出的基础判断，渲染时注明“具体掉落与配方以游戏内为准”）。`found: false` 表示未找到。

### B. 市场与交易

**`ffxiv_market_price`** — 参数：`itemName`（必填）、`server`（必填，服务器/大区/DC 名，支持“神意之地”“莫古力”“陆行鸟”、鸟区/猪区/猫区/狗区等别名与数字 world id）、`hqOnly`（默认 false）、`limit`（默认 5，最大 20）。返回 `{ itemId, itemName, server, cheapest: { price, hq, quantity, worldName? }, listings: [...], lastUploadAgeMinutes?, message? }`。首行渲染“服务器 · 物品名 · 最低价 X G（HQ/NQ）”，随后按价格升序列出在售；空 listings 输出“该范围当前无在售记录”。末尾附免责声明（可由 `FFXIV_DISCLAIMER=0` 关闭）。

**`ffxiv_market_history`** — 参数：`itemName`、`server`、`entries`（默认 10，最大 20）。读取 Universalis `recentHistory`，按时间倒序渲染相对时间（“2 小时前”）。

**`ffxiv_market_compare`** — 参数：`itemName`、`servers`（逗号/顿号/空白分隔，最多 6 个，多余项忽略并在 message 说明）。对每个服务器串行调用 Universalis（全局节流），按最低价升序渲染表格：`服务器 | 最低价 | 数量 | HQ`。

**`ffxiv_employee_items`** — 参数：`job`（可选，“战斗精英/园艺工/采矿工/捕鱼人”，也接受“狩猎/采伐/采矿/捕鱼”）、`level`（可选，1–100）。数据来自 **XIVAPI 官方 `RetainerTask` 表**（中文数据集），按 4 类筹集方式映射：战斗精英→狩猎、园艺工→采伐、采矿工→采矿、捕鱼人→捕鱼；返回 `{ supported, total, items: [{ name, category, level, minAmount, maxAmount }], message? }`。`level` 过滤 `RetainerLevel <= level`，结果最多渲染 60 条并提示截断。随机委托（RetainerTaskRandom）只给“探索委托”名称、不含具体物品，因此不计入物品列表（message 中说明）。职业无法识别时返回 `{ supported: false, items: [], message }`，不返回静态假数据。可用 `FFXIV_EMPLOYEE_ENDPOINT` 覆盖为自建数据源。

### C. 生产与成本

**`ffxiv_recipe_cost`** — 参数：`itemName`（成品）、`server`、`quantity`（默认 1）。流程：解析成品 → XIVAPI Recipe 按 `ItemResult.Name` 反查 → 取 `Ingredient`/`AmountIngredient` 材料表（空槽跳过）→ 每种材料串行查 Universalis 最低价 → 汇总。返回 `{ itemName, server, quantity, materials: [{ name, amount, unitPrice, subtotal }], missing: [{ name, amount }], totalCost, message? }`。成本按“数量 × 材料用量”计算；无在售材料放入 `missing` 且不计价，message 明确说明缺口，不编造价格。

**`ffxiv_profit_estimate`** — 参数：`itemName`、`server`。复用配方成本，再取成品当前最低在售价。返回 `{ cost, sellPrice, profit, marginPercent, message? }`。渲染固定包含：“估算，不含税、不含制作时间成本；销量参考需结合走货量指数。”

### D. 角色与战斗

**`ffxiv_character_lookup`** — 参数：`name`（角色全名含姓氏）、`server`。国服服务器默认返回 `supported: false`（国服角色不在国际服 Lodestone），除非配置 `FFXIV_CHARACTER_ENDPOINT`；国际服会解析 Lodestone 搜索页（按名字+服务器匹配）并尽力解析详情页的种族/部族/守护神/大国防联军/部队/平均品级，解析不到时只返回基础字段并在 message 说明，绝不返回猜测值。网络失败抛错（错误带工具名前缀）。

**`ffxiv_fflogs_summary`** — 参数：`reportUrl`（可选）、`characterName`（可选）、`server`（可选）、`metric`（默认 `rdps`，可选 `adps`/`ndps`/`pdps`）。缺少 `FFLOGS_CLIENT_ID`/`FFLOGS_CLIENT_SECRET` 时返回 `{ supported: false, message }`，不崩溃、不请求网络。`reportUrl` 分支返回报告标题、战斗场次、击杀/团灭、最佳 pull（剩余 Boss 百分比）；角色名+服务器分支返回该 metric 的最佳分位。国服区域需通过 `FFLOGS_REGION` 显式指定。

### E. 世界状态与时间

**`ffxiv_et_now`** — 无参数。ET 与真实时间换算：1 ET 小时 = 175 秒，1 ET 日 = 4200 秒（70 分钟），Unix 0 对应 ET 00:00。返回 `{ et: "HH:mm", etDay: "第 N 天", etDayNumber, localTime, utcTime }`，渲染“艾欧泽亚时间：14:32（ET 第 3 天） · 本地：……”一行。

**`ffxiv_reset_timers`** — 无参数。每日重置 = UTC 08:00（= 北京时间 16:00），每周重置 = 周二 UTC 08:00。返回倒计时与下次重置时间（UTC/本地双格式）。房屋 demolition 状态没有可靠公开数据源，不显示、不猜测。

> 说明：任务简报中曾写作“每日重置为 JST 05:00（UTC 20:00）”，该值不正确；FF14 的实际重置时间为 UTC 08:00（JST 17:00 / 北京时间 16:00），插件按后者实现。

**`ffxiv_weather`** — 参数：`territory`（必填，支持“森都/海都/沙都/伊修加德/黄金港/水晶都/旧萨雷安/图莱尤拉/萨维奈岛”等别名与官方全名）、`windows`（1–6，默认 3）。天气算法为公开的确定性计算：天气窗口 1400 秒（8 ET 小时），以 `bell/unix` 计算目标值后按 WeatherRate 累积概率选择天气。内置 13 张常用 WeatherRate 表；未知地图回退到 XIVAPI `TerritoryType`/`WeatherRate` 动态解析并缓存。返回 `{ territory, current: { weather, remainingSeconds }, upcoming: [{ weather, startsIn, startsAt }] }`。

**`ffxiv_server_status`** — 参数：`dc`（可选，大区名过滤）。默认返回 `{ supported: false, message }`（FF14 没有稳定公开的官方状态 JSON API）；配置 `FFXIV_SERVER_STATUS_ENDPOINT` 后按约定结构解析并过滤大区。

### F. 生活与社区

**`ffxiv_housing`** — 参数：`server`（必填）、`district`（可选房区名）、`size`（可选 S/M/L）、`limit`（默认 5，最大 20）。默认端点 `https://house.ffxiv.cyou/api/sales?server=<worldId>`（艾欧泽亚售楼中心，社区数据）。服务器名先解析为国服 world id（也接受数字 id）；返回数组按 `Size`、`PurchaseType`、`State` 解码为“尺寸/先到先得或抽签/状态”，渲染“第 X 区 第 Y 号 · 尺寸 · 价格 · 抽签状态”。可用 `FFXIV_HOUSING_ENDPOINT` 覆盖。接口不可达或该服无数据时返回 `{ supported: false, plots: [], message }`（数据量大的服务器可能较慢，工具超时 45 秒）。

**`ffxiv_party_finder`** — 参数：`dc`（可选，大区名或数字 id）、`category`（可选，“高难/讨伐/大型任务/团队任务/随机/行会令/怪物狩猎/寻宝/金碟/PvP/其他”，也接受英文枚举如 `HighEndDuty`）、`keyword`（可选）、`limit`（默认 5，最大 20）。默认端点 `https://xivpf.littlenightmare.top/api/listings`（xivpf v1，社区远程招募板）。渲染每条标题、世界/大区、职业需求（`缺：坦克`/`缺：治疗` 或详情页 slot 的职业缩写）、剩余时间、描述摘要；`category` 过滤后如仍不足会继续翻页（最多 5 页）。接口不可达时返回 `{ supported: false, listings: [], message }`（xivpf 响应较慢，重试 2 次、超时 30 秒）。

**`ffxiv_fashion_report`** — 参数：`week`（默认 `current`）。未配置端点返回 `supported: false`；配置后按部位/物品/染色渲染。

**`ffxiv_blue_mage_spell`** — 参数：`spellName`（必填，支持部分匹配）。XIVAPI `AozAction` 按 `Action.Name` 搜索（全名失败时逐级截短重试），配合 `AozActionTransient` 获取中文说明与学习地点（`Location` 为副本/地点中文名）。返回 `{ found, id, name, actionId?, description?, learnLocation?, candidates?, message? }`。学习地点数据不可得时只返回技能说明并明确说明来源缺失。

**`ffxiv_official_news`** — 参数：`limit`（1–5，默认 3）。默认先请求中文公告 RSS（`FFXIV_NEWS_RSS`，默认 `https://rsshub.app/ff14/zh/all`，RSSHub 可能被墙/限流，可用镜像或自建实例），失败再回退 Lodestone Topics 页面解析；配置 `FFXIV_NEWS_ENDPOINT` 时优先使用 JSON 端点（可含 summary/publishedAt）。RSS 正文摘要截断展示；只有标题+链接时明确提示“仅能获取标题与链接”，绝不编造摘要。全部不可达时返回 `{ supported: false, items: [], message }`。

### G. 职业与副本

**`ffxiv_job_guide`** — 参数：`job`（必填，职业全名或简称：`WHM`/`DRG`/`白魔`/`龙骑`/`学者` 等 22 个战斗职业）、`level`（可选，1–100）。数据来自 XIVAPI 官方 `ClassJob`/`Action`/`ActionCombo`/`Trait` 表：按 `ActionCombo` 构建**分支连击链**（自动合并父职业基础技能，如龙骑士会补上枪术师的精准刺→贯通刺→直刺），按 `ActionCategory`/`Recast100ms`/`Cast100ms` 区分 GCD 与能力技并给冷却/读条，按等级过滤并排序，输出职业特性与等级。返回 `{ found, job{name,abbr,role,category?}, level?, combos[{steps[{name,level}]}], gcdSkills[{name,level,castSeconds?,combo?}], abilities[{name,level,cooldownSeconds?}], traits[{name,level,description?}], guideText?, source?, message? }`。**这是从官方技能表整理的结构化循环信息，不是“最优起手/进阶循环”**；需要进阶攻略时可配置 `FFXIV_JOB_GUIDE_ENDPOINT`（返回 `{summary,rotation[],tips[],url}`）。

**`ffxiv_duty_guide`** — 参数：`duty`（必填，副本名或部分名，如“万魔殿 边境之狱4”“零式万魔殿 炼净之狱4”）。先查官方 `ContentFinderCondition` 拿等级/装等同步、人数构成、内容类型、是否高难、所在地图；再取 `ContentFinderConditionTransient` 的**官方中文简介**；随后用灰机 wiki（`FFXIV_WIKI_API`）搜索副本页并抓取机制摘要（最多 2600 字、带页面缓存与小时间隔）。wiki 被 Cloudflare 挑战或不可达时**降级为官方信息 + wiki 搜索链接 + `message` 说明**，不编造机制；配置 `FFXIV_DUTY_GUIDE_ENDPOINT` 时可返回自定义攻略 JSON。返回 `{ found, duty{name,level?,ilvl?,contentType?,party?,highEnd,territory?}, description?, guideText?, source?, message? }`。

## 工程实现

- **物品名 → itemId 共享缓存**：`src/core/cache.ts` 维护进程内 `Map`，key 为归一化中文名（去空白 + 小写），所有需要 itemId 的工具共享；命中时跳过 XIVAPI 搜索。`resolveItem` 优先返回归一化全等匹配，避免“暗物质”命中“1级暗物质”这类模糊优先问题。
- **Universalis 全局限速**：`src/core/throttle.ts` 的 `RateLimiter(60ms)`，所有 Universalis 请求（含跨服比价循环）串行排队，约 16 req/s，低于 20–25 req/s 上限。
- **超时与错误边界**：`src/core/http.ts` 默认 9 秒超时（可传 `timeoutMs`），网络/DNS/HTTP 4xx/5xx 全部抛错；`guardTool` 统一加 `工具名: ` 前缀（已带前缀不重复）。业务空结果（没搜到/没在售/暂无数据/端点未配置）返回带 `message` 的 canonical 值，不抛错。
- **输出可读性**：所有 `render` 为中文短行、列表或极简表格；金额统一 `formatGil` 千分位 + ` G`；不渲染原始 JSON；行情类输出末尾可配置免责声明。
- **凭据安全**：FFLogs 凭据、社区端点从环境变量或本地配置文件读取（环境变量优先）；代码中没有任何硬编码密钥、Token 或静态假数据。缺少凭据/端点时返回 `supported: false` 并说明启用方式。本机实测 FFLogs **V1 Client Key 无法用于 v2 GraphQL**（v1 API 已下线、v2 OAuth 会 `invalid_client`），请务必在 API Clients 页面创建 v2 凭据。
- **时区**：ET/天气/重置均用 UTC 计算并转本地显示；天气算法用 `>>> 0` 模拟 32 位无符号整数，与游戏内确定性一致。
- **wiki 限流与缓存**：`src/core/wiki.ts` 对灰机 wiki 请求以 1200ms 间隔串行、403/429/5xx 退避重试 3 次，页面正文缓存 6 小时，避免触发 Cloudflare 挑战；失败错误信息会提示配置 `FFXIV_WIKI_API` 或 `FFXIV_DUTY_GUIDE_ENDPOINT`。

## 目录结构

```
dsh-plugin-ffxiv/
├── package.json
├── tsconfig.json
├── cordis.patch.yml        # Cordis bundle patch：insert dsh-plugin-ffxiv
├── README.md
├── scripts/
│   └── smoke.mjs           # 真实网络冒烟脚本（可选）
└── src/
    ├── index.ts            # 插件入口：inject ['tools'] + apply 批量注册
    ├── core/
    │   ├── types.ts        # ToolSpec / ParamSpec / ValueSpec / ContentBlock
    │   ├── define.ts       # defineTool 适配（真实/回退）、guardTool、参数校验
    │   ├── env.ts          # 环境变量/配置文件、端点、免责声明
    │   ├── config.ts       # 本地配置文件读取（ffxiv-plugin.json）
    │   ├── http.ts         # fetch 封装（超时、UA、错误边界）
    │   ├── throttle.ts     # Universalis 请求节流
    │   ├── cache.ts        # 物品名 → itemId 进程内缓存
    │   ├── format.ts       # 金额/时长/相对时间/截断
    │   ├── xivapi.ts       # XIVAPI 搜索/Sheet/配方/青魔法/天气表
    │   ├── universalis.ts  # Universalis 行情与服务器解析
    │   ├── wiki.ts         # 灰机 wiki 搜索/正文抓取（限流、缓存、降级）
    │   └── eorzea.ts       # ET、重置、天气确定性算法
    ├── data/
    │   ├── worlds.ts       # 国服 world / 大区 / 别名
    │   ├── jobs.ts         # 22 个战斗职业（名称/缩写/职能/别名）
    │   └── weather.ts      # WeatherRate 表与常用地图别名
    ├── tools/
    │   ├── item.ts         # 1–2
    │   ├── market.ts       # 3–5
    │   ├── employee.ts     # 6
    │   ├── craft.ts        # 7–8
    │   ├── character.ts    # 9–10
    │   ├── world.ts        # 11–14
    │   ├── social.ts       # 15–19
    │   └── combat.ts       # 20–21
    └── scripts/
        └── verify.ts       # 离线校验（npm run verify）
```

## 验证记录（本机实测）

- `npm run typecheck`：严格模式编译通过（ES2022 / NodeNext / strict）。
- `npm run verify`：21 个工具的名称/参数/输出 schema/渲染全部校验通过；`@deepseek-ai/dsh-tools` 的真实 `defineTool` 成功编译 21 个工具，canonical 值与编译后的 schema 双向校验通过；模拟 Cordis `ctx.tools.register` 注册 21 个工具。退出码 0。
- 职业与副本（本机实测）：`ffxiv_job_guide`（龙骑士，Lv.90）返回完整分支连击链（精准刺→贯通刺→直刺→龙牙龙爪、精准刺→开膛枪→樱花怒放→龙尾大回旋，已合并枪术师基础技能）、GCD 按等级排序、能力技 CD 与特性；`ffxiv_duty_guide`（万魔殿 边境之狱4）返回官方等级/装等/8 人构成/大型任务/高难标记与所在地图，灰机 wiki 可用时追加真实机制摘要。
- 在 desktop profile 中安装并激活插件后，通过真实工具调用验证（均为实时第三方数据）：`ffxiv_et_now`、`ffxiv_weather`（森都）、`ffxiv_search_item`（暗物质）、`ffxiv_market_price` / `ffxiv_market_history`（亚拉戈高位合成兽革，神意之地/莫古力）、`ffxiv_recipe_cost` 与 `ffxiv_profit_estimate`（36,784 G 成本 / 47.4% 利润率）、`ffxiv_blue_mage_spell`（冰焰，含学习地点）。
- 国服数据源二次实测（本机直连、未使用 VPN）：`ffxiv_employee_items` 官方 `RetainerTask` 表可用（园艺工 Lv.90 返回数百条，含 冰之碎晶 等）；`ffxiv_housing` 售楼中心 `?server=1081` 返回 477 条空房（海雾村等，含 S/M/L、抽签/先到先得）；`ffxiv_party_finder` xivpf v1 可用（陆行鸟/猫小胖，含职业缺口与剩余时间），个别请求 7–25 秒、已加重试；`ffxiv_official_news` 成功解析 Lodestone 3 条公告（RSSHub 在本机不可达时自动回退）。红玉海（1167）等数据量大的服务器房屋接口可能超时，工具会返回明确的不可达说明而不是假数据。
- 网络限制：本机网络下 RSSHub、国服官网与部分 Lodestone 区域不可达属外部可达性问题；工具均返回明确的 `supported: false`/网络错误，配置端点或 RSS 镜像即可启用。国服 Universalis 个别物品首次查询较慢，`ffxiv_recipe_cost` 对单个材料做一次重试，仍失败的材料会在 `message` 中标注为缺口而不是编造价格。

## 已知限制与合规

- **第三方数据**：XIVAPI、Universalis、Lodestone 均为第三方公开接口，可能存在延迟、误差或结构变化；国服数据以游戏内实际为准。插件与 Square Enix 及国服运营方无关联。
- **社区端点**：房屋、招募、公告默认已接入可用的国服社区源（售楼中心、xivpf v1、RSSHub/Lodestone）；时尚品鉴、国服角色、服务器状态仍没有可靠公开接口，默认返回 `supported: false`，只有配置自建/可信端点后才启用。xivpf 原域名 `xivpf.ff14.xin` 的 `/api` 返回前端 HTML（不可用），请使用默认的 `xivpf.littlenightmare.top`。
- **FFLogs**：需要自行申请 **v2** API 客户端并配置 `FFLOGS_CLIENT_ID`/`FFLOGS_CLIENT_SECRET`；V1 Client Key 不能用于 v2 GraphQL（实测 401 `invalid_client`）。国服数据不在国际服站点，需用 `FFLOGS_REGION` 或 `reportUrl` 指定。
- **Lodestone**：NA 站点在本机网络下可能超时；角色详情页解析为尽力而为，解析不到的字段不会伪造，只返回可得字段并说明。
- **职业循环**：`ffxiv_job_guide` 从官方 `Action`/`ActionCombo`/`Trait` 表推导“技能结构”（连击链、GCD、能力技 CD、特性），不是社区最优起手/进阶循环；需要进阶攻略请配置 `FFXIV_JOB_GUIDE_ENDPOINT`。
- **副本攻略**：`ffxiv_duty_guide` 依赖灰机 wiki 抓取机制摘要；该站点启用 Cloudflare 挑战，连续请求后可能暂时 403，工具会降级为官方信息 + wiki 链接 + `message`（并已做 1200ms 间隔与 6 小时页面缓存）。可配置 `FFXIV_WIKI_API` 镜像或 `FFXIV_DUTY_GUIDE_ENDPOINT` 自建攻略端点。
- **免责声明**：行情类工具输出末尾默认附加“数据来自第三方公开接口，可能存在延迟或误差，以游戏内实际为准；与 Square Enix 及国服运营方无关联。”，可用 `FFXIV_DISCLAIMER=0` 关闭。
