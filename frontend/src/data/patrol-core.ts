import type { EntryRow } from './types'
import type { PatrolIssue, PatrolSnapshot, PatrolViewRow } from './types'

// 巡检口径：发现问题数只认非负整数；空值或缺其他必填格都在导出文件里逐格标注，不再整份报错。
export const PATROL_FIELDS = [
  '巡检编号',
  '巡检站点',
  '巡检路线',
  '巡检人',
  '巡检日期',
  '发现问题数',
  '整改期限',
] as const

export const PATROL_REPORTED_STATUS = '已上报'
export const SUSPENDED_STATUS = '已挂起'
export const MISSING_MARK = '【缺项】'
const COUNT_FIELD = '发现问题数'
const DEADLINE_FIELD = '整改期限'

type FieldValue = string | number | boolean | null | undefined

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

// 沿用既有巡检口径：只认非负整数，其余（如「三处」）一律视为无法核定。
export function normalizeIssueCount(value: FieldValue): number | null {
  if (isBlank(value)) {
    return null
  }
  const text = String(value).trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  return Number(text)
}

function todayText(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isResidualRow(row: EntryRow): boolean {
  // 巡检编号是出包定位到具体记录的主键，缺失的视为历史残留，不进清单、不进文件。
  return isBlank(row['巡检编号'])
}

function toViewRow(row: EntryRow, today: string): PatrolViewRow {
  const rawCount = row[COUNT_FIELD]
  const issueCount = normalizeIssueCount(rawCount)
  const unapprovedCount = !isBlank(rawCount) && issueCount === null
  const missingFields = PATROL_FIELDS.filter((field) => {
    if (field === COUNT_FIELD) {
      return isBlank(rawCount)
    }
    return isBlank(row[field])
  })
  // 发现问题数缺失或无法核定时先挂起，待补录核定后自动恢复原状态。
  const suspended = issueCount === null
  const deadline = String(row[DEADLINE_FIELD] ?? '').trim()
  const overdue =
    !suspended && String(row.status) === PATROL_REPORTED_STATUS && deadline !== '' && deadline < today
  const displayStatus = suspended ? SUSPENDED_STATUS : String(row.status)
  return {
    ...row,
    issueCount,
    missingFields,
    unapprovedCount,
    suspended,
    overdue,
    displayStatus,
  }
}

export type PatrolQueryOptions = {
  filters?: Record<string, string>
  now?: Date
}

// 列表与出包都从这里读同一份数据：残留记录统一剔除，口径在 toViewRow 里统一核定。
export function queryPatrolSnapshot(
  rows: EntryRow[],
  options: PatrolQueryOptions = {},
): PatrolSnapshot {
  const today = todayText(options.now ?? new Date())
  const filters = options.filters ?? {}
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  const residualRows = rows.filter(isResidualRow)
  const viewRows = rows
    .filter((row) => !isResidualRow(row))
    .map((row) => toViewRow(row, today))
    .filter((row) =>
      pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
    )

  const issues: PatrolIssue[] = []
  for (const row of viewRows) {
    const rowKey = String(row['巡检编号'])
    for (const field of row.missingFields) {
      issues.push({
        level: 'missing',
        rowKey,
        message: `巡检记录 ${rowKey} 的「${field}」为空，已在文件中标注缺项`,
      })
    }
    if (row.unapprovedCount) {
      issues.push({
        level: 'invalid',
        rowKey,
        message: `巡检记录 ${rowKey} 的「发现问题数」为「${String(row[COUNT_FIELD])}」，无法按非负整数口径核定，已先挂起`,
      })
    }
    if (row.overdue) {
      issues.push({
        level: 'overdue',
        rowKey,
        message: `巡检记录 ${rowKey} 已上报且整改期限 ${String(row[DEADLINE_FIELD])} 已到期，已同步热费结算待跟进清单`,
      })
    }
  }
  for (const row of residualRows) {
    issues.push({
      level: 'residual',
      rowKey: `id=${String(row.id ?? '未知')}`,
      message: `残留记录（id=${String(row.id ?? '未知')}，巡检编号缺失，站点：${
        isBlank(row['巡检站点']) ? '未知' : String(row['巡检站点'])
      }）未纳入清单与出包文件`,
    })
  }
  return { today, rows: viewRows, residualRows, issues }
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// 出包文件列：与列表读同一份 rows，缺项格追加【缺项】标记，不再因整格为空而失败。
export function buildPatrolCsv(rows: PatrolViewRow[]): string {
  const header = ['巡检编号', ...PATROL_FIELDS.slice(1), '当前状态', '备注']
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) {
    const { issueCount } = row
    const rawCount = row[COUNT_FIELD]
    const notes: string[] = []
    if (row.suspended) {
      notes.push(row.unapprovedCount ? '发现问题数无法核定，已挂起' : '发现问题数缺失，已挂起')
    }
    if (row.overdue) {
      notes.push('已上报且整改期限到期，已同步热费结算待跟进')
    }
    const cells = PATROL_FIELDS.map((field) => {
      if (field === COUNT_FIELD) {
        // 缺失留【缺项】；填了但无法核定的保留原值并加标注，便于班组核对。
        if (issueCount === null) {
          return isBlank(rawCount) ? MISSING_MARK : `${MISSING_MARK}原值：${csvCell(rawCount)}`
        }
        return csvCell(issueCount)
      }
      const value = row[field]
      return isBlank(value) ? MISSING_MARK : csvCell(value)
    })
    lines.push([...cells, csvCell(row.displayStatus), csvCell(notes.join('；'))].join(','))
  }
  return `﻿${lines.join('\n')}`
}

// 内容指纹：只由出包文件里的有效行决定，重复提交命中同指纹就只保留第一条出包记录。
export function buildPatrolFingerprint(content: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
