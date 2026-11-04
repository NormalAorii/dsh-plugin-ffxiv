/**
 * 真实网络冒烟脚本（可选）。
 *
 * 用法：先在插件目录执行 `npm run build`，再运行 `node scripts/smoke.mjs`。
 * 会真实调用 XIVAPI / Universalis / house.ffxiv.cyou / xivpf / Lodestone 等第三方接口；
 * 部分端点在本机网络下可能超时或限流，因此只把核心行情/物品/青魔/天气结果视为必须通过，
 * 社区端点（雇员/房屋/招募/公告）失败时仅提示。
 */

import { createTools } from '../dist/index.js'
import { createFallbackDefineTool } from '../dist/core/define.js'

const define = createFallbackDefineTool()
const tools = createTools(define)
const byName = new Map(tools.map((tool) => [tool.name, tool]))

const failures = []
const softFailures = []

function render(tool, args, value) {
  try {
    const blocks = tool.output.render(args, value)
    return blocks.map((block) => block.text).join('\n')
  } catch (error) {
    return `[render 失败] ${error instanceof Error ? error.message : error}`
  }
}

async function run(name, args, { soft = false, timeoutMs = 60_000 } = {}) {
  const tool = byName.get(name)
  if (!tool) {
    failures.push(`${name}: 工具缺失`)
    return null
  }
  try {
    const value = await tool.execute(args, { signal: AbortSignal.timeout(timeoutMs) })
    const text = render(tool, args, value)
    console.log(`\n── ${name} ${JSON.stringify(args)}`)
    console.log(text.split('\n').slice(0, 12).join('\n'))
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`\n── ${name} ${JSON.stringify(args)}\n✗ 抛错：${message}`)
    if (soft) softFailures.push(`${name}: ${message}`)
    else failures.push(`${name}: ${message}`)
    return null
  }
}

console.log('=== dsh-plugin-ffxiv 真实网络冒烟 ===')

const search = await run('ffxiv_search_item', { query: '暗物质', limit: 3 })
const info = await run('ffxiv_item_info', { itemName: '亚拉戈高位合成兽革' })
const price = await run('ffxiv_market_price', { itemName: '亚拉戈高位合成兽革', server: '神意之地' })
await run('ffxiv_market_history', { itemName: '亚拉戈高位合成兽革', server: '神意之地', entries: 5 })
await run('ffxiv_market_compare', { itemName: '亚拉戈高位合成兽革', servers: '神意之地,红玉海,莫古力' })
await run('ffxiv_recipe_cost', { itemName: '亚拉戈高位合成兽革', server: '神意之地', quantity: 1 })
await run('ffxiv_profit_estimate', { itemName: '亚拉戈高位合成兽革', server: '神意之地' })
await run('ffxiv_blue_mage_spell', { spellName: '冰焰' })
const weather = await run('ffxiv_weather', { territory: '萨维奈岛', windows: 3 })
const employee = await run('ffxiv_employee_items', { job: '园艺工', level: 90 }, { soft: true, timeoutMs: 90_000 })
const housing = await run('ffxiv_housing', { server: '神意之地', limit: 3 }, { soft: true, timeoutMs: 120_000 })
const party = await run('ffxiv_party_finder', { dc: '陆行鸟', limit: 3 }, { soft: true, timeoutMs: 120_000 })
const news = await run('ffxiv_official_news', { limit: 3 }, { soft: true, timeoutMs: 60_000 })
const jobGuide = await run('ffxiv_job_guide', { job: '龙骑士', level: 90 }, { soft: true, timeoutMs: 90_000 })
const dutyGuide = await run('ffxiv_duty_guide', { duty: '万魔殿 边境之狱4' }, { soft: true, timeoutMs: 90_000 })

if (search && search.matches.length === 0) failures.push('ffxiv_search_item: 未返回匹配')
if (info && info.found !== true) failures.push('ffxiv_item_info: found 不是 true')
if (price && !price.message && !Array.isArray(price.listings)) failures.push('ffxiv_market_price: 返回结构异常')
if (weather && !weather.current?.weather) failures.push('ffxiv_weather: 缺少当前天气')
if (employee && employee.supported && !Array.isArray(employee.items)) failures.push('ffxiv_employee_items: items 结构异常')
if (housing && housing.supported && !Array.isArray(housing.plots)) failures.push('ffxiv_housing: plots 结构异常')
if (party && party.supported && !Array.isArray(party.listings)) failures.push('ffxiv_party_finder: listings 结构异常')
if (news && news.supported && !Array.isArray(news.items)) failures.push('ffxiv_official_news: items 结构异常')
if (jobGuide && jobGuide.found && !Array.isArray(jobGuide.gcdSkills)) failures.push('ffxiv_job_guide: gcdSkills 结构异常')
if (jobGuide && jobGuide.found && jobGuide.gcdSkills.length === 0) failures.push('ffxiv_job_guide: 未返回 GCD 技能')
if (dutyGuide && dutyGuide.found !== true) softFailures.push('ffxiv_duty_guide: 未找到副本')
if (dutyGuide && dutyGuide.found && !dutyGuide.duty?.name) failures.push('ffxiv_duty_guide: 缺少副本名')

console.log('\n=== 总结 ===')
if (softFailures.length > 0) console.log(`软失败（可接受，端点可能不可达）：\n- ${softFailures.join('\n- ')}`)
if (failures.length > 0) {
  console.error(`失败：\n- ${failures.join('\n- ')}`)
  process.exitCode = 1
} else {
  console.log('核心冒烟全部通过。')
}
