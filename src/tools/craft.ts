/** Crafting cost & profit: recipe material pricing and margin estimate (C1, C2). @module dsh-plugin-ffxiv/tools/craft */

import { guardTool, requireString } from '../core/define.js'
import { withDisclaimer } from '../core/env.js'
import { clampInt, formatGil, formatPercent, gil } from '../core/format.js'
import type { DefineToolFn } from '../core/types.js'
import { text } from '../core/types.js'
import { cheapestListing, getMarket, resolveServerInput } from '../core/universalis.js'
import type { RecipeInfo } from '../core/xivapi.js'
import { findRecipeId, getRecipe, resolveItem } from '../core/xivapi.js'

const materialSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    amount: { type: 'integer' },
    unitPrice: { type: 'integer' },
    subtotal: { type: 'integer' },
  },
  required: ['name', 'amount', 'unitPrice', 'subtotal'],
} as const

const missingSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    amount: { type: 'integer' },
  },
  required: ['name', 'amount'],
} as const

/** One priced recipe ingredient (amount already multiplied by the craft count). */
interface CostMaterial {
  name: string
  amount: number
  unitPrice: number
  subtotal: number
}

/** One ingredient with no market listing in the requested scope. */
interface CostMissing {
  name: string
  amount: number
}

/** Fully priced recipe: found materials, unpriced ones, failed lookups, and the priced subtotal. */
interface RecipeCost {
  materials: CostMaterial[]
  missing: CostMissing[]
  failed: CostMissing[]
  totalCost: number
}

/** Fetch one market snapshot, retrying once: CN listings can be cold/slow. */
async function fetchSnapshot(serverQuery: string, itemId: number, signal: AbortSignal): Promise<any> {
  try {
    return await getMarket(serverQuery, itemId, { listings: 1, signal, timeoutMs: 10000 })
  } catch {
    return getMarket(serverQuery, itemId, { listings: 1, signal, timeoutMs: 12000 })
  }
}

/**
 * Price every recipe ingredient serially against one Universalis scope.
 * The shared global limiter serializes requests; do not parallelize here.
 * Ingredients without a live listing are reported in `missing`; ingredients
 * whose lookup fails are reported in `failed` — neither ever gets a fabricated
 * price, and one slow world must not abort the whole estimate.
 */
async function computeRecipeCost(
  serverQuery: string,
  recipe: RecipeInfo,
  quantity: number,
  signal: AbortSignal,
): Promise<RecipeCost> {
  const materials: CostMaterial[] = []
  const missing: CostMissing[] = []
  const failed: CostMissing[] = []
  let totalCost = 0
  for (const ingredient of recipe.ingredients) {
    const amount = ingredient.amount * quantity
    let snapshot: any
    try {
      snapshot = await fetchSnapshot(serverQuery, ingredient.itemId, signal)
    } catch {
      failed.push({ name: ingredient.name, amount })
      continue
    }
    const best = snapshot ? cheapestListing(snapshot.listings, false) : undefined
    if (!best || best.pricePerUnit <= 0) {
      missing.push({ name: ingredient.name, amount })
      continue
    }
    const subtotal = best.pricePerUnit * amount
    materials.push({ name: ingredient.name, amount, unitPrice: best.pricePerUnit, subtotal })
    totalCost += subtotal
  }
  return { materials, missing, failed, totalCost }
}

/** Build the craft-domain tool definitions. */
export function createCraftTools(define: DefineToolFn): unknown[] {
  const recipeCost = define({
    name: 'ffxiv_recipe_cost',
    description:
      '当用户询问 FF14 某成品（制作物品）的制作材料、制作成本、材料清单，或想按当前服务器物价估算做一件/多件要花多少钱时调用此工具。只适用于可制作物品；纯采集/掉落/兑换物没有配方。',
    parameters: {
      itemName: {
        type: 'string',
        required: true,
        description: '成品中文名，支持部分名称，例如“亚拉戈高位合成兽革”',
      },
      server: {
        type: 'string',
        required: true,
        description: '服务器名、大区名或 DC 名，例如“神意之地”“莫古力”“陆行鸟”',
      },
      quantity: {
        type: 'integer',
        description: '制作数量（默认 1，范围 1–99）',
        default: 1,
      },
    },
    timeoutMs: 45000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemName: { type: 'string' },
          server: { type: 'string' },
          quantity: { type: 'integer' },
          materials: { type: 'array', items: materialSchema },
          missing: { type: 'array', items: missingSchema },
          totalCost: { type: 'integer' },
          message: { type: 'string' },
        },
        required: ['itemName', 'server', 'quantity', 'materials', 'missing', 'totalCost'],
      },
      render(args: any, value: any) {
        const lines: string[] = [
          `${value.itemName} · ${value.server} · 制作 ${value.quantity} 件成本：${gil(value.totalCost)}`,
        ]
        if (value.materials.length > 0) {
          lines.push('材料清单：')
          for (const material of value.materials) {
            lines.push(
              `- ${material.name} × ${material.amount}：${formatGil(material.unitPrice)} G × ${material.amount} = ${formatGil(material.subtotal)} G`,
            )
          }
        }
        if (value.missing.length > 0) {
          lines.push('缺价材料：')
          for (const material of value.missing) {
            lines.push(`- ${material.name} × ${material.amount}：无在售记录，未计入成本`)
          }
        }
        if (value.message) lines.push(String(value.message))
        return [text(lines.join('\n'))]
      },
    },
    execute: guardTool('ffxiv_recipe_cost', async (args: any, ctx) => {
      const itemName = requireString(args, 'itemName', '物品名称')
      const serverInput = requireString(args, 'server', '服务器')
      const quantity = clampInt(args.quantity, 1, 1, 99)
      const server = resolveServerInput(serverInput)
      const item = await resolveItem(itemName, ctx.signal)
      if (!item) {
        return {
          itemName,
          server: server.display,
          quantity,
          materials: [],
          missing: [],
          totalCost: 0,
          message: `未找到与“${itemName}”匹配的物品，请先用 ffxiv_search_item 确认标准名称。`,
        }
      }
      const recipeId = await findRecipeId(item.name, ctx.signal)
      if (recipeId === undefined) {
        return {
          itemName: item.name,
          server: server.display,
          quantity,
          materials: [],
          missing: [],
          totalCost: 0,
          message: `未找到“${item.name}”的配方（该物品可能不是制作产出，或中文配方名不匹配）。`,
        }
      }
      const recipe = await getRecipe(recipeId, ctx.signal)
      if (!recipe) {
        return {
          itemName: item.name,
          server: server.display,
          quantity,
          materials: [],
          missing: [],
          totalCost: 0,
          message: `未找到“${item.name}”的配方（该物品可能不是制作产出，或中文配方名不匹配）。`,
        }
      }
      const cost = await computeRecipeCost(server.query, recipe, quantity, ctx.signal)
      const name = recipe.itemName.length > 0 ? recipe.itemName : item.name
      const missingText = cost.missing.map((entry) => `${entry.name}×${entry.amount}`).join('、')
      const failedText = cost.failed.map((entry) => `${entry.name}×${entry.amount}`).join('、')
      const notes: string[] = []
      if (cost.missing.length > 0) notes.push(`以下材料无在售记录，成本未计入：${missingText}`)
      if (cost.failed.length > 0) notes.push(`以下材料价格查询失败，未计入成本：${failedText}`)
      return {
        itemName: name,
        server: server.display,
        quantity,
        materials: cost.materials,
        missing: cost.missing,
        totalCost: cost.totalCost,
        ...(notes.length > 0 ? { message: `${notes.join('；')}。实际成本可能更高。` } : {}),
      }
    }),
  })

  const profitEstimate = define({
    name: 'ffxiv_profit_estimate',
    description:
      '当用户问制作某成品能不能赚钱、利润/利润率多少、值不值得做时调用此工具。估算成本与成品当前最低售价的差额。',
    parameters: {
      itemName: { type: 'string', required: true, description: '成品中文名称（支持部分名称）' },
      server: {
        type: 'string',
        required: true,
        description: '服务器名、大区名或 DC 名，例如“神意之地”“莫古力”“陆行鸟”',
      },
    },
    timeoutMs: 45000,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemName: { type: 'string' },
          server: { type: 'string' },
          cost: { type: 'integer' },
          sellPrice: { type: 'integer' },
          profit: { type: 'integer' },
          marginPercent: { type: 'number' },
          message: { type: 'string' },
        },
        required: ['itemName', 'server', 'cost', 'sellPrice', 'profit', 'marginPercent'],
      },
      render(args: any, value: any) {
        const lines: string[] = [`${value.itemName} · ${value.server}`]
        if (value.sellPrice > 0) {
          lines.push(
            `制作成本：${formatGil(value.cost)} G · 成品最低售价：${formatGil(value.sellPrice)} G`,
          )
          lines.push(
            `利润估算：${formatGil(value.profit)} G（利润率 ${formatPercent(value.marginPercent)}）`,
          )
        } else if (value.cost > 0) {
          lines.push(`制作成本：${formatGil(value.cost)} G · 成品当前无在售记录`)
        }
        lines.push('估算，不含税、不含制作时间成本；销量参考需结合走货量指数。')
        if (value.message) lines.push(String(value.message))
        return [text(withDisclaimer(lines))]
      },
    },
    execute: guardTool('ffxiv_profit_estimate', async (args: any, ctx) => {
      const itemName = requireString(args, 'itemName', '物品名称')
      const serverInput = requireString(args, 'server', '服务器')
      const server = resolveServerInput(serverInput)
      const item = await resolveItem(itemName, ctx.signal)
      if (!item) {
        return {
          itemName,
          server: server.display,
          cost: 0,
          sellPrice: 0,
          profit: 0,
          marginPercent: 0,
          message: `未找到与“${itemName}”匹配的物品，请先用 ffxiv_search_item 确认标准名称。`,
        }
      }
      const recipeId = await findRecipeId(item.name, ctx.signal)
      if (recipeId === undefined) {
        return {
          itemName: item.name,
          server: server.display,
          cost: 0,
          sellPrice: 0,
          profit: 0,
          marginPercent: 0,
          message: `未找到“${item.name}”的配方，无法估算利润。`,
        }
      }
      const recipe = await getRecipe(recipeId, ctx.signal)
      if (!recipe) {
        return {
          itemName: item.name,
          server: server.display,
          cost: 0,
          sellPrice: 0,
          profit: 0,
          marginPercent: 0,
          message: `未找到“${item.name}”的配方，无法估算利润。`,
        }
      }
      const cost = await computeRecipeCost(server.query, recipe, 1, ctx.signal)
      const snapshot = await getMarket(server.query, item.id, { listings: 1, signal: ctx.signal })
      const best = snapshot ? cheapestListing(snapshot.listings, false) : undefined
      const name = recipe.itemName.length > 0 ? recipe.itemName : item.name
      if (!best || best.pricePerUnit <= 0) {
        return {
          itemName: name,
          server: server.display,
          cost: cost.totalCost,
          sellPrice: 0,
          profit: 0,
          marginPercent: 0,
          message: '成品当前无在售记录，无法估算利润（成本为材料最低价合计）。',
        }
      }
      const sellPrice = best.pricePerUnit
      const profit = sellPrice - cost.totalCost
      const marginPercent = sellPrice > 0 ? Math.round((profit / sellPrice) * 1000) / 10 : 0
      const missingText = cost.missing.map((entry) => `${entry.name}×${entry.amount}`).join('、')
      const failedText = cost.failed.map((entry) => `${entry.name}×${entry.amount}`).join('、')
      const notes: string[] = []
      if (cost.missing.length > 0) notes.push(`部分材料无在售记录，成本偏低：${missingText}`)
      if (cost.failed.length > 0) notes.push(`部分材料价格查询失败，成本偏低：${failedText}`)
      return {
        itemName: name,
        server: server.display,
        cost: cost.totalCost,
        sellPrice,
        profit,
        marginPercent,
        ...(notes.length > 0 ? { message: `${notes.join('；')}。` } : {}),
      }
    }),
  })

  return [recipeCost, profitEstimate]
}
