/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | null
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 站点巡检：列表与出包文件共用同一份读模型，缺项、挂起、到期都在这一层核定。
export type PatrolViewRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | null | string[]
  issueCount: number | null
  missingFields: string[]
  // 发现问题数填了值但无法按巡检口径核定（非非负整数），同样先挂起。
  unapprovedCount: boolean
  suspended: boolean
  overdue: boolean
  displayStatus: string
}

export type PatrolIssueLevel = 'missing' | 'invalid' | 'overdue' | 'residual' | 'error'

export type PatrolIssue = {
  level: PatrolIssueLevel
  rowKey: string
  message: string
}

export type PatrolSnapshot = {
  today: string
  rows: PatrolViewRow[]
  residualRows: EntryRow[]
  issues: PatrolIssue[]
}

// 到期未整改的巡检记录同步到热费结算后，落成一条待跟进事项。
export type FollowUpItem = {
  id: number
  sourceModule: string
  sourceId: number
  bizKey: string
  station: string
  deadline: string
  reason: string
  createdAt: string
  resolvedAt: string | null
}

// 一次出包一条记录；内容指纹相同的重复提交只落一条。
export type PatrolPackage = {
  id: number
  filename: string
  fingerprint: string
  rowCount: number
  createdAt: string
}

export type PatrolPackageResult = {
  ok: boolean
  deduped: boolean
  filename: string
  content: string
  fingerprint: string
  package: PatrolPackage | null
  exported: number
  suspended: number
  overdue: number
  residual: number
  synced: number
  issues: PatrolIssue[]
}
