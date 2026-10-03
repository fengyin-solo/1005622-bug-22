import { listDocuments, saveDocuments } from './local-store'
import type { FollowUpItem } from './types'

const DOC_KEY = 'stationpatrol-followups'
const SOURCE_MODULE = 'stationpatrol'

function nextId(items: FollowUpItem[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

export function listFollowUps(): FollowUpItem[] {
  return listDocuments<FollowUpItem>(DOC_KEY).sort((a, b) =>
    a.deadline === b.deadline ? b.id - a.id : a.deadline < b.deadline ? -1 : 1,
  )
}

type OverdueInput = {
  sourceId: number
  bizKey: string
  station: string
  deadline: string
  reason: string
  createdAt: string
}

// 到期结果同步到热费结算的待跟进清单：按来源记录幂等 upsert，重复出包不会产生第二条。
// 已整改/已解除的到期记录把对应事项关掉，清单始终反映最新结果。
export function reconcileFollowUps(
  overdue: OverdueInput[],
  resolvedKeys: string[],
  now: Date,
): { items: FollowUpItem[]; added: number } {
  const items = listDocuments<FollowUpItem>(DOC_KEY)
  const byKey = new Map(items.map((item) => [item.bizKey, item]))
  const stamp = now.toISOString()
  let added = 0

  for (const input of overdue) {
    const existing = byKey.get(input.bizKey)
    if (existing) {
      existing.deadline = input.deadline
      existing.reason = input.reason
      existing.resolvedAt = null
    } else {
      const created: FollowUpItem = {
        id: nextId(items),
        sourceModule: SOURCE_MODULE,
        sourceId: input.sourceId,
        bizKey: input.bizKey,
        station: input.station,
        deadline: input.deadline,
        reason: input.reason,
        createdAt: input.createdAt,
        resolvedAt: null,
      }
      items.push(created)
      byKey.set(input.bizKey, created)
      added += 1
    }
  }

  for (const key of resolvedKeys) {
    const existing = byKey.get(key)
    if (existing && existing.resolvedAt === null) {
      existing.resolvedAt = stamp
    }
  }

  saveDocuments(DOC_KEY, items)
  return { items, added }
}
