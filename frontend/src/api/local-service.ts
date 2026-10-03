import { MODULE_BY_KEY } from '@/data/modules'
import {
  buildPatrolCsv,
  buildPatrolFingerprint,
  queryPatrolSnapshot,
} from '@/data/patrol-core'
import { listFollowUps, reconcileFollowUps } from '@/data/followups'
import {
  allRows,
  listDocuments,
  listRows,
  resetRows,
  saveDocuments,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  FollowUpItem,
  ModuleMeta,
  OverviewResult,
  PageResult,
  PatrolPackage,
  PatrolPackageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  downloadTextFile(filename, content, 'text/csv;charset=utf-8')
}

const PATROL_KEY = 'stationpatrol'
const PATROL_DOC_KEY = 'stationpatrol-packages'

function nextDocId(items: { id: number }[]): number {
  return items.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

export function listPatrolPackages(): PatrolPackage[] {
  return listDocuments<PatrolPackage>(PATROL_DOC_KEY).sort((a, b) => b.id - a.id)
}

// 巡检列表与出包文件的唯一入口：同一份快照、同一套发现问题数口径。
export function loadPatrolSnapshot(filters: Record<string, string> = {}) {
  return queryPatrolSnapshot(listRows(PATROL_KEY), { filters })
}

// 提交出包：缺项记录照常导出并逐格标注；残留记录剔除并在结果里点名；
// 内容指纹相同的重复提交只落一条；到期结果同步到热费结算待跟进清单。
export function submitPatrolPackage(filters: Record<string, string> = {}): PatrolPackageResult {
  const now = new Date()
  const meta = moduleMeta(PATROL_KEY)
  // 全量核定一次，保证筛选视图下到期同步也不会漏行。
  const full = queryPatrolSnapshot(listRows(PATROL_KEY), { now })
  const filtered = queryPatrolSnapshot(listRows(PATROL_KEY), { filters, now })

  let content = ''
  let exported = 0
  // 缺项/挂起/到期按当前筛选视图点名，残留记录按全量口径点名（它在筛选前已统一剔除）。
  const viewIssues = filtered.issues.filter((issue) => issue.level !== 'residual')
  const issues = [
    ...viewIssues,
    ...full.issues.filter((issue) => issue.level === 'residual'),
  ]
  try {
    content = buildPatrolCsv(filtered.rows)
    exported = filtered.rows.length
  } catch (error) {
    const detail = error instanceof Error ? error.message : '未知错误'
    issues.push({
      level: 'error',
      rowKey: '-',
      message: `出包文件生成中断：${detail}`,
    })
  }

  const filename = `${meta.name}-巡检清单-${full.today}.csv`
  const fingerprint = buildPatrolFingerprint(content)
  const packages = listDocuments<PatrolPackage>(PATROL_DOC_KEY)
  const existing = packages.find((item) => item.fingerprint === fingerprint)

  // 到期（已上报且过整改期限）但未挂起的记录才同步；发现问题数缺失先挂起，不进待跟进。
  const overdueRows = full.rows.filter((row) => row.overdue)
  const activeKeys = new Set(overdueRows.map((row) => String(row['巡检编号'])))
  const synced = reconcileFollowUps(
    overdueRows.map((row) => ({
      sourceId: Number(row.id),
      bizKey: String(row['巡检编号']),
      station: String(row['巡检站点'] ?? ''),
      deadline: String(row['整改期限'] ?? ''),
      reason: '巡检已上报，整改期限到期未整改',
      createdAt: now.toISOString(),
    })),
    listFollowUps()
      .filter(
        (item) =>
          item.sourceModule === 'stationpatrol' &&
          item.resolvedAt === null &&
          !activeKeys.has(item.bizKey),
      )
      .map((item) => item.bizKey),
    now,
  ).added

  let record: PatrolPackage | null = null
  let deduped = false
  if (!issues.some((issue) => issue.level === 'error')) {
    if (existing) {
      deduped = true
      record = existing
    } else {
      record = {
        id: nextDocId(packages),
        filename,
        fingerprint,
        rowCount: exported,
        createdAt: now.toISOString(),
      }
      packages.push(record)
      saveDocuments(PATROL_DOC_KEY, packages)
    }
  }

  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    deduped,
    filename,
    content,
    fingerprint,
    package: record,
    exported,
    suspended: filtered.rows.filter((row) => row.suspended).length,
    overdue: overdueRows.length,
    residual: full.residualRows.length,
    synced,
    issues,
  }
}

export function downloadPatrolPackage(result: PatrolPackageResult): void {
  downloadTextFile(result.filename, result.content, 'text/csv;charset=utf-8')
}

export function listHeatFollowUps(): FollowUpItem[] {
  return listFollowUps()
}

function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
