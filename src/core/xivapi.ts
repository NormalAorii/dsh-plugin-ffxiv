/** XIVAPI v2 access helpers with the shared item-name cache. @module dsh-plugin-ffxiv/core/xivapi */

import type { ItemRef } from './cache.js'
import { getCachedItem, getCachedItemById, normalizeItemName, setCachedItem } from './cache.js'
import { ENDPOINTS } from './env.js'
import { requestJson } from './http.js'

/** One raw search result. */
export interface SearchHit<T = Record<string, unknown>> {
  id: number
  score?: number
  fields: T
}

/** One sheet row payload. */
export type SheetRow = Record<string, any>

function base(): string {
  return ENDPOINTS.xivapiBase().replace(/\/+$/, '')
}

/** Build the field search expression, e.g. `Name~"暗物质"`. */
export function fieldQuery(field: string, value: string): string {
  return `${field}~"${value}"`
}

/** Run one XIVAPI search and normalize `row_id` to `id`. */
export async function searchSheet<T = Record<string, unknown>>(
  sheet: string,
  query: string,
  options: { fields?: string; limit?: number; language?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Array<SearchHit<T>>> {
  const params = new URLSearchParams({
    sheets: sheet,
    query,
    language: options.language ?? 'chs',
    limit: String(options.limit ?? 10),
  })
  if (options.fields) params.set('fields', options.fields)
  const payload = await requestJson<{ results?: Array<Record<string, any>> }>(`${base()}/search?${params.toString()}`, {
    timeoutMs: options.timeoutMs ?? 12000,
    signal: options.signal,
  })
  const results = Array.isArray(payload.results) ? payload.results : []
  return results.map((row) => ({
    id: Number(row.row_id ?? row.row_id),
    score: typeof row.score === 'number' ? row.score : undefined,
    fields: (row.fields ?? {}) as T,
  }))
}

/** Fetch one sheet row's selected fields; a 404 resolves to `undefined`. */
export async function getSheetRow<T = SheetRow>(
  sheet: string,
  id: number,
  fields: string,
  options: { language?: string; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T | undefined> {
  const params = new URLSearchParams({ language: options.language ?? 'chs', fields })
  try {
    const payload = await requestJson<{ fields?: T }>(`${base()}/sheet/${sheet}/${id}?${params.toString()}`, {
      timeoutMs: options.timeoutMs ?? 12000,
      signal: options.signal,
    })
    return (payload.fields ?? undefined) as T | undefined
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('HTTP 404')) return undefined
    throw error
  }
}

/** Extract a nested display name from a XI VAPI relation field (best effort). */
export function relationName(value: any): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (typeof value.fields?.Name === 'string') return value.fields.Name
  return undefined
}

/** Extract a nested numeric id from a XIVAPI relation field. */
export function relationId(value: any): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const id = Number(value.row_id ?? value.value)
  return Number.isFinite(id) && id > 0 ? id : undefined
}

/** Search the Item sheet by Chinese name and return every plausible match. */
export async function findItems(query: string, limit = 5, signal?: AbortSignal): Promise<ItemRef[]> {
  const hits = await searchSheet<{ Name?: string }>('Item', fieldQuery('Name', query), {
    fields: 'Name',
    limit: Math.min(20, Math.max(1, limit)),
    signal,
  })
  const items: ItemRef[] = []
  for (const hit of hits) {
    const name = hit.fields?.Name
    if (typeof name === 'string' && name.length > 0) items.push({ id: hit.id, name })
  }
  return items
}

/**
 * Resolve an arbitrary Chinese/partial item name to one item id.
 * Uses the shared cache; prefers an exact normalized name match over the
 * first fuzzy hit.
 */
export async function resolveItem(query: string, signal?: AbortSignal): Promise<ItemRef | undefined> {
  const cached = getCachedItem(query)
  if (cached) return cached
  const matches = await findItems(query, 8, signal)
  if (matches.length === 0) return undefined
  const wanted = normalizeItemName(query)
  const exact = matches.find((item) => normalizeItemName(item.name) === wanted)
  const picked = exact ?? matches[0]
  setCachedItem(query, picked)
  return picked
}

/** Resolve a numeric item id to a named reference (cached when possible). */
export async function resolveItemById(id: number, signal?: AbortSignal): Promise<ItemRef | undefined> {
  const cached = getCachedItemById(id)
  if (cached) return cached
  const row = await getSheetRow<{ Name?: string }>('Item', id, 'Name', { signal })
  const name = row?.Name
  if (typeof name !== 'string' || name.length === 0) return undefined
  const item = { id, name }
  setCachedItem(name, item)
  return item
}

/** Detailed item fields used by `ffxiv_item_info`. */
export interface ItemInfoFields {
  Name?: string
  LevelItem?: { value?: number; row_id?: number }
  ItemUICategory?: { Name?: string }
  ItemSearchCategory?: { Name?: string }
  CanBeHq?: boolean
  IsUntradable?: boolean
  Description?: string
}

/** Fetch the documented item detail field set. */
export async function getItemInfo(id: number, signal?: AbortSignal): Promise<ItemInfoFields | undefined> {
  const fields =
    'Name,LevelItem,ItemUICategory.Name,CanBeHq,IsUntradable,Description,ItemSearchCategory.Name'
  const row = await getSheetRow<ItemInfoFields>('Item', id, fields, { signal })
  return row
}

/** One recipe ingredient row. */
export interface RecipeIngredient {
  itemId: number
  name: string
  amount: number
}

/** One parsed recipe. */
export interface RecipeInfo {
  recipeId: number
  itemId: number
  itemName: string
  canHq: boolean
  craftType?: string
  ingredients: RecipeIngredient[]
}

/** Search recipes by the produced item's Chinese name. */
export async function findRecipeId(itemName: string, signal?: AbortSignal): Promise<number | undefined> {
  const exact = await searchSheet('Recipe', fieldQuery('ItemResult.Name', itemName), {
    fields: 'ItemResult',
    limit: 5,
    signal,
  })
  if (exact.length > 0) return exact[0].id
  return undefined
}

/** Fetch and flatten one recipe into ingredient amounts. */
export async function getRecipe(recipeId: number, signal?: AbortSignal): Promise<RecipeInfo | undefined> {
  const row = await getSheetRow<any>(
    'Recipe',
    recipeId,
    'ItemResult,AmountIngredient,Ingredient,CanHq,CraftType',
    // This payload is large (~150 KB): give it a longer budget than small rows.
    { signal, timeoutMs: 15000 },
  )
  if (!row) return undefined
  const itemId = relationId(row.ItemResult) ?? 0
  const itemName = relationName(row.ItemResult) ?? ''
  const amounts: number[] = Array.isArray(row.AmountIngredient) ? row.AmountIngredient : []
  const rawIngredients: any[] = Array.isArray(row.Ingredient) ? row.Ingredient : []
  const ingredients: RecipeIngredient[] = []
  rawIngredients.forEach((entry, index) => {
    const itemIdRaw = relationId(entry)
    const amount = Number(amounts[index] ?? 0)
    if (!itemIdRaw || amount <= 0) return
    const name = relationName(entry) ?? `物品 #${itemIdRaw}`
    ingredients.push({ itemId: itemIdRaw, name, amount })
  })
  if (ingredients.length === 0) return undefined
  return {
    recipeId,
    itemId,
    itemName,
    canHq: row.CanHq === true,
    craftType: relationName(row.CraftType),
    ingredients,
  }
}

/** One blue-mage spell search hit. */
export interface BlueMageSpellHit {
  aozActionId: number
  name: string
  actionId?: number
}

/**
 * Search blue mage spells. XIVAPI only exposes the nested `Action.Name`, so a
 * full-name miss is retried with progressively shorter prefixes.
 */
export async function findBlueMageSpells(spellName: string, signal?: AbortSignal): Promise<BlueMageSpellHit[]> {
  const attempts = [spellName]
  for (let length = spellName.length - 1; length >= 2; length -= 1) attempts.push(spellName.slice(0, length))
  if (spellName.length > 2) attempts.push(spellName.slice(0, 1))

  const seen = new Set<number>()
  const hits: BlueMageSpellHit[] = []
  for (const attempt of [...new Set(attempts)]) {
    const rows = await searchSheet<any>('AozAction', fieldQuery('Action.Name', attempt), {
      fields: 'Action.Name',
      limit: 20,
      signal,
    })
    for (const row of rows) {
      const name = relationName(row.fields?.Action)
      if (!name || seen.has(row.id)) continue
      if (!name.includes(spellName) && !spellName.includes(name)) continue
      seen.add(row.id)
      hits.push({ aozActionId: row.id, name, actionId: relationId(row.fields?.Action) })
    }
    if (hits.length > 0) break
  }
  return hits
}

/** Blue mage transient data: description plus learning location. */
export interface BlueMageTransient {
  description?: string
  location?: string
}

/** Fetch the documented AozActionTransient fields. */
export async function getBlueMageTransient(aozActionId: number, signal?: AbortSignal): Promise<BlueMageTransient> {
  const row = await getSheetRow<any>('AozActionTransient', aozActionId, 'Description,Location.Name', { signal })
  return {
    description: typeof row?.Description === 'string' ? row.Description : undefined,
    location: relationName(row?.Location),
  }
}

/** One territory weather lookup hit. */
export interface TerritoryWeatherHit {
  territoryId: number
  name: string
  weatherRateId: number
}

/** Search TerritoryType rows whose PlaceName matches the Chinese territory input. */
export async function findTerritoriesByPlaceName(
  placeName: string,
  signal?: AbortSignal,
): Promise<TerritoryWeatherHit[]> {
  const rows = await searchSheet<any>('TerritoryType', fieldQuery('PlaceName.Name', placeName), {
    fields: 'PlaceName.Name,WeatherRate',
    limit: 10,
    signal,
  })
  const hits: TerritoryWeatherHit[] = []
  for (const row of rows) {
    const name = relationName(row.fields?.PlaceName)
    const weatherRateId = relationId(row.fields?.WeatherRate)
    if (!name || !weatherRateId) continue
    hits.push({ territoryId: row.id, name, weatherRateId })
  }
  return hits
}

/** One WeatherRate row. */
export interface WeatherRateRow {
  rate: number[]
  weatherIds: number[]
}

/** Fetch one WeatherRate row (rates and the aligned Weather relation ids). */
export async function getWeatherRate(weatherRateId: number, signal?: AbortSignal): Promise<WeatherRateRow | undefined> {
  const row = await getSheetRow<any>('WeatherRate', weatherRateId, 'Rate,Weather', { signal })
  if (!row) return undefined
  const rate: number[] = Array.isArray(row.Rate) ? row.Rate.map((value: any) => Number(value) || 0) : []
  const weather: any[] = Array.isArray(row.Weather) ? row.Weather : []
  const weatherIds = weather.map((entry) => relationId(entry) ?? 0)
  if (rate.length === 0 || weatherIds.length === 0) return undefined
  return { rate, weatherIds }
}

/** Fetch one Weather row's Chinese name. */
export async function getWeatherName(weatherId: number, signal?: AbortSignal): Promise<string | undefined> {
  if (!weatherId) return undefined
  const row = await getSheetRow<{ Name?: string }>('Weather', weatherId, 'Name', { signal })
  return row?.Name
}

/** Resolve the parent class of one job (e.g. 龙骑士 → 枪术师), if any. */
export async function getClassJobParentName(jobId: number, signal?: AbortSignal): Promise<string | undefined> {
  if (!jobId) return undefined
  const row = await getSheetRow<any>('ClassJob', jobId, 'ClassJobParent.Name', { signal })
  return relationName(row?.ClassJobParent)
}

/** Resolve one territory's Chinese place name (used to label duties). */
export async function getTerritoryPlaceName(territoryId: number, signal?: AbortSignal): Promise<string | undefined> {
  if (!territoryId) return undefined
  const row = await getSheetRow<any>('TerritoryType', territoryId, 'PlaceName.Name', { signal })
  return relationName(row?.PlaceName)
}

/** One combat job row (ClassJob sheet). */
export interface ClassJobInfo {
  id: number
  name: string
  abbreviation: string
  category?: string
}

/** Resolve one Chinese job name through the ClassJob sheet. */
export async function findClassJob(query: string, signal?: AbortSignal): Promise<ClassJobInfo | undefined> {
  const rows = await searchSheet<any>('ClassJob', fieldQuery('Name', query), {
    fields: 'Name,Abbreviation,ClassJobCategory.Name',
    limit: 6,
    signal,
  })
  for (const row of rows) {
    const name = typeof row.fields?.Name === 'string' ? row.fields.Name : undefined
    const abbreviation = typeof row.fields?.Abbreviation === 'string' ? row.fields.Abbreviation : undefined
    if (!name || !abbreviation) continue
    return { id: row.id, name, abbreviation, category: relationName(row.fields?.ClassJobCategory) }
  }
  return undefined
}

/** One job action with the fields needed to describe a rotation skeleton. */
export interface JobAction {
  id: number
  name: string
  level: number
  category?: string
  recast100ms?: number
  cast100ms?: number
  comboId?: number
  comboName?: string
  comboLevel?: number
  isPvp: boolean
}

/** Fetch every action learned by one combat job (PvP actions included, filtered by callers). */
export async function findJobActions(jobName: string, signal?: AbortSignal): Promise<JobAction[]> {
  const rows = await searchSheet<any>('Action', fieldQuery('ClassJob.Name', jobName), {
    fields: 'Name,ClassJobLevel,ActionCategory.Name,IsPvP,Recast100ms,Cast100ms,ActionCombo.Name,PreservesCombo,Range',
    limit: 300,
    timeoutMs: 20000,
    signal,
  })
  const actions: JobAction[] = []
  for (const row of rows) {
    const fields = row.fields ?? {}
    const name = typeof fields.Name === 'string' ? fields.Name.trim() : ''
    if (name.length === 0) continue
    const combo = fields.ActionCombo
    const comboId = relationId(combo)
    actions.push({
      id: row.id,
      name,
      level: Number(fields.ClassJobLevel) || 0,
      category: relationName(fields.ActionCategory),
      recast100ms: Number.isFinite(Number(fields.Recast100ms)) ? Number(fields.Recast100ms) : undefined,
      cast100ms: Number.isFinite(Number(fields.Cast100ms)) ? Number(fields.Cast100ms) : undefined,
      ...(comboId && comboId !== row.id ? { comboId, comboName: relationName(combo) } : {}),
      isPvp: fields.IsPvP === true,
    })
  }
  return actions
}

/** One job trait. */
export interface JobTrait {
  id: number
  name: string
  level: number
  description?: string
}

/** Fetch the traits of one combat job. */
export async function findJobTraits(jobName: string, signal?: AbortSignal): Promise<JobTrait[]> {
  const rows = await searchSheet<any>('Trait', fieldQuery('ClassJob.Name', jobName), {
    fields: 'Name,Level,Description',
    limit: 120,
    signal,
  })
  const traits: JobTrait[] = []
  for (const row of rows) {
    const name = typeof row.fields?.Name === 'string' ? row.fields.Name.trim() : ''
    const level = Number(row.fields?.Level) || 0
    if (name.length === 0) continue
    traits.push({
      id: row.id,
      name,
      level,
      ...(typeof row.fields?.Description === 'string' ? { description: row.fields.Description } : {}),
    })
  }
  traits.sort((left, right) => left.level - right.level || left.name.localeCompare(right.name, 'zh-Hans-CN'))
  return traits
}

/** Party composition describing one duty's member layout. */
export interface DutyMemberType {
  membersPerParty?: number
  partyCount?: number
  tanks?: number
  healers?: number
  melees?: number
  ranged?: number
}

/** One duty finder entry (ContentFinderCondition). */
export interface DutyInfo {
  id: number
  name: string
  levelRequired?: number
  levelSync?: number
  ilvlRequired?: number
  ilvlSync?: number
  contentType?: string
  highEnd: boolean
  member?: DutyMemberType
  territoryId?: number
}

function memberTypeFromRelation(value: any): DutyMemberType | undefined {
  const fields = value?.fields
  if (!fields || typeof fields !== 'object') return undefined
  const membersPerParty = Number(fields.MembersPerParty)
  if (!Number.isFinite(membersPerParty) || membersPerParty <= 0) return undefined
  return {
    membersPerParty,
    partyCount: Number(fields.PartyCount) || 1,
    tanks: Number(fields.TanksPerParty) || 0,
    healers: Number(fields.HealersPerParty) || 0,
    melees: Number(fields.MeleesPerParty) || 0,
    ranged: Number(fields.RangedPerParty) || 0,
  }
}

/** Search duty finder entries by Chinese name. */
export async function findDuties(query: string, signal?: AbortSignal): Promise<DutyInfo[]> {
  const rows = await searchSheet<any>('ContentFinderCondition', fieldQuery('Name', query), {
    fields:
      'Name,ClassJobLevelRequired,ClassJobLevelSync,ItemLevelRequired,ItemLevelSync,ContentType.Name,ContentMemberType,HighEndDuty,TerritoryType',
    limit: 10,
    signal,
  })
  const duties: DutyInfo[] = []
  for (const row of rows) {
    const fields = row.fields ?? {}
    const name = typeof fields.Name === 'string' ? fields.Name.trim() : ''
    if (name.length === 0) continue
    duties.push({
      id: row.id,
      name,
      levelRequired: Number(fields.ClassJobLevelRequired) || undefined,
      levelSync: Number(fields.ClassJobLevelSync) || undefined,
      ilvlRequired: Number(fields.ItemLevelRequired) || undefined,
      ilvlSync: Number(fields.ItemLevelSync) || undefined,
      contentType: relationName(fields.ContentType),
      highEnd: fields.HighEndDuty === true || /零式|绝境战|歼殛战/.test(name),
      member: memberTypeFromRelation(fields.ContentMemberType),
      territoryId: relationId(fields.TerritoryType),
    })
  }
  return duties
}

/** Fetch the official one-paragraph description of one duty (ContentFinderConditionTransient). */
export async function getDutyTransientDescription(
  dutyId: number,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const row = await getSheetRow<{ Description?: string }>('ContentFinderConditionTransient', dutyId, 'Description', {
    signal,
  })
  const description = typeof row?.Description === 'string' ? row.Description.trim() : ''
  return description.length > 0 ? description : undefined
}
