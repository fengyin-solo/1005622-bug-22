import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ExportResult, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 巡检口径沿用模块登记字段，不另起定义：发现问题数只认非负整数，缺了或不是数字都按缺项处理。
const PATROL_KEY = 'stationpatrol'
const ISSUE_COUNT_FIELD = '发现问题数'
const DEADLINE_FIELD = '整改期限'
const PATROL_CODE_FIELD = '巡检编号'
// 巡检到期结果同步到热费结算的待跟进清单，跟进单按这个编号前缀落账。
const FOLLOWUP_KEY = 'heatbilling'
const FOLLOWUP_CODE_PREFIX = 'FJ-'

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

// 发现问题数的核定口径：非负整数才算有效，缺失或不是数字一律视为缺项。
// 巡检列表与出包文件都从这里取值，两处不会再各算各的。
export function patrolIssueCount(row: EntryRow): number | null {
  const raw = row[ISSUE_COUNT_FIELD]
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return null
  }
  const count = Number(String(raw).trim())
  if (!Number.isInteger(count) || count < 0) {
    return null
  }
  return count
}

// 发现问题数缺失的巡检记录先挂起：照常出包，但不往热费结算同步。
export function isPatrolSuspended(row: EntryRow): boolean {
  return patrolIssueCount(row) === null
}

export function patrolIssueCountLabel(row: EntryRow): string {
  const count = patrolIssueCount(row)
  return count === null ? `挂起（缺${ISSUE_COUNT_FIELD}）` : String(count)
}

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function patrolDeadline(row: EntryRow): string | null {
  const raw = String(row[DEADLINE_FIELD] ?? '').trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

// 到期（含逾期）且未挂起的巡检结果，随出包同步为热费结算的待跟进记录。
// 跟进单按「FJ-巡检编号」去重：重复提交出包只落一条，已存在的只刷新不落新账。
// 返回本次新落下的条数。
function syncPatrolFollowups(rows: EntryRow[]): number {
  const today = todayText()
  const due = rows.filter((row) => {
    if (isPatrolSuspended(row)) {
      return false
    }
    const deadline = patrolDeadline(row)
    return deadline !== null && deadline <= today
  })
  if (due.length === 0) {
    return 0
  }
  const next = [...listRows(FOLLOWUP_KEY)]
  let maxId = next.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
  let added = 0
  for (const row of due) {
    const code = `${FOLLOWUP_CODE_PREFIX}${String(row[PATROL_CODE_FIELD] ?? row.id)}`
    const note = `巡检到期跟进（${ISSUE_COUNT_FIELD} ${patrolIssueCount(row)} 项，${DEADLINE_FIELD} ${patrolDeadline(row)}）`
    const index = next.findIndex((item) => item['结算编号'] === code)
    if (index >= 0) {
      next[index] = {
        ...next[index],
        pending: true,
        收费员: String(row['巡检人'] ?? ''),
        结算状态: note,
      }
    } else {
      next.push({
        id: ++maxId,
        status: '待核算',
        pending: true,
        abnormal: false,
        结算编号: code,
        用户名称: String(row['巡检站点'] ?? ''),
        用热面积: '',
        热价标准: '',
        应缴金额: '',
        缴费日期: '',
        收费员: String(row['巡检人'] ?? ''),
        结算状态: note,
      })
      added += 1
    }
  }
  saveRows(FOLLOWUP_KEY, next)
  return added
}

function csvCell(value: string): string {
  // 格子里带逗号、引号、换行时加引号转义，免得一格错位吞掉整列、或凭空多出一行残留记录。
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function missingMark(field: string): string {
  return `【缺：${field}】`
}

// 缺项照常出，只在格子里标出缺哪一格；发现问题数按巡检口径核定，核定不过同样按缺项标。
function exportFieldValue(key: string, row: EntryRow, field: string): string {
  if (key === PATROL_KEY && field === ISSUE_COUNT_FIELD) {
    const count = patrolIssueCount(row)
    return count === null ? missingMark(field) : String(count)
  }
  const value = row[field]
  if (value === undefined || value === null || String(value).trim() === '') {
    return missingMark(field)
  }
  return String(value)
}

function exportStatusValue(key: string, row: EntryRow): string {
  const status = String(row.status ?? '')
  return key === PATROL_KEY && isPatrolSuspended(row) ? `${status}（挂起）` : status
}

function rowLabel(meta: ModuleMeta, row: EntryRow, index: number): string {
  const codeField = meta.fields[0]
  const code = row[codeField]
  return `第 ${index + 1} 条${meta.entity}（${codeField} ${code ?? row.id}）`
}

export function exportEntries(key: string, filters: Record<string, string> = {}): ExportResult {
  const meta = moduleMeta(key)
  // 出包跟列表读同一份数据：走同一个 listEntries，筛选条件由页面原样传进来。
  const rows = listEntries(key, filters).items
  // 巡检出包时把到期结果同步进热费结算的待跟进清单；重复出包只落一条。
  const followups = key === PATROL_KEY ? syncPatrolFollowups(rows) : 0
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.map(csvCell).join(',')]
  rows.forEach((row, index) => {
    try {
      const cells = [
        String(row.id),
        ...meta.fields.map((field) => exportFieldValue(key, row, field)),
        exportStatusValue(key, row),
      ]
      lines.push(cells.map(csvCell).join(','))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`导出${rowLabel(meta, row, index)}时出错：${reason}`)
    }
  })
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}`, followups }
}

export function downloadEntries(
  key: string,
  filters: Record<string, string> = {},
): { filename: string; followups: number } {
  const { filename, content, followups } = exportEntries(key, filters)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  return { filename, followups }
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
