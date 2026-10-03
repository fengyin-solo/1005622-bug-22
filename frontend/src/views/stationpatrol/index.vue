<template>
  <section class="page" data-module="stationpatrol">
    <header class="page-head">
      <div>
        <h2>站点巡检管理</h2>
        <p class="page-desc">维护巡检记录，围绕巡检编号、巡检站点、巡检路线、巡检人做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记巡检记录</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows">
          {{ exporting ? '出包中…' : '导出站点巡检清单' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column" :class="{ 'cell-missing': isMissing(row, column) }">
            {{ displayCell(row, column) }}
          </td>
          <td :class="{ 'tag tag-suspended': row.suspended, 'tag tag-overdue': row.overdue && !row.suspended }">
            {{ row.displayStatus }}<span v-if="row.overdue && !row.suspended" class="tag-suffix">到期</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无站点巡检数据，可先登记巡检记录</td>
        </tr>
      </tbody>
    </table>

    <section v-if="packages.length" class="package-panel">
      <h3>出包记录</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>出包编号</th>
            <th>文件名</th>
            <th>内容指纹</th>
            <th>条数</th>
            <th>提交时间</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in packages" :key="item.id">
            <td>{{ item.id }}</td>
            <td>{{ item.filename }}</td>
            <td>{{ item.fingerprint }}</td>
            <td>{{ item.rowCount }}</td>
            <td>{{ formatTime(item.createdAt) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>
        共 {{ total }} 条站点巡检记录
        <template v-if="residualCount">（另有 {{ residualCount }} 条残留记录未纳入清单）</template>
      </span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="exportResult" class="modal-mask" @click.self="exportResult = null">
      <div class="modal-card" role="dialog" aria-modal="true">
        <header class="modal-head">
          <h3>出包结果</h3>
          <button class="link" type="button" @click="exportResult = null">关闭</button>
        </header>
        <p v-if="exportResult.deduped" class="modal-line">
          本次提交与出包记录 #{{ exportResult.package?.id }} 内容一致（指纹 {{ exportResult.fingerprint }}），未重复落条，文件已重新下发。
        </p>
        <p v-else class="modal-line">
          已生成 {{ exportResult.filename }}，共导出 {{ exportResult.exported }} 条；
          挂起 {{ exportResult.suspended }} 条，到期 {{ exportResult.overdue }} 条，
          新增同步热费待跟进 {{ exportResult.synced }} 条，剔除残留记录 {{ exportResult.residual }} 条。
        </p>
        <ul v-if="exportResult.issues.length" class="issue-list">
          <li v-for="(issue, index) in exportResult.issues" :key="index" :class="`issue-${issue.level}`">
            {{ issue.message }}
          </li>
        </ul>
        <p v-else class="modal-line modal-ok">全部记录字段齐全，无缺项、无残留。</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadPatrolPackage,
  listPatrolPackages,
  loadPatrolSnapshot,
  moduleMeta,
  runAction as applyAction,
  submitPatrolPackage,
} from '@/api/local-service'
import { MISSING_MARK, PATROL_FIELDS } from '@/data/patrol-core'
import type {
  PatrolPackage,
  PatrolPackageResult,
  PatrolViewRow,
} from '@/data/types'

const meta = moduleMeta('stationpatrol')
const columns = [...PATROL_FIELDS]
const actions = ['提交巡检', '确认整改', '上报问题']
const statuses = ['待巡检', '巡检中', '已整改', '已上报', '已挂起']
const FILTER_FIELDS = ['巡检编号', '巡检站点', '巡检路线']
const COUNT_FIELD = '发现问题数'

const rows = ref<PatrolViewRow[]>([])
const total = ref(0)
const residualCount = ref(0)
const errorMessage = ref('')
const exporting = ref(false)
const exportResult = ref<PatrolPackageResult | null>(null)
const packages = ref<PatrolPackage[]>([])
const filters = ref<Record<string, string>>({})
const filterFields = FILTER_FIELDS

const stats = computed(() => {
  const now = new Date()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const approved = rows.value.filter((row) => row.issueCount !== null)
  return [
    { label: '待巡检站点', value: rows.value.filter((row) => row.displayStatus === '待巡检').length },
    { label: '待整改问题', value: approved.reduce((sum, row) => sum + (row.issueCount ?? 0), 0) },
    {
      label: '本月巡检次数',
      value: rows.value.filter((row) => String(row['巡检日期'] ?? '').startsWith(month)).length,
    },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => row.displayStatus === status).length,
  })),
)

function isMissing(row: PatrolViewRow, field: string): boolean {
  if (field === COUNT_FIELD) {
    return row.issueCount === null
  }
  return row.missingFields.includes(field)
}

function displayCell(row: PatrolViewRow, field: string): string {
  if (field === COUNT_FIELD) {
    return row.issueCount === null
      ? `${MISSING_MARK}${row.unapprovedCount ? `原值：${String(row[COUNT_FIELD] ?? '')}` : '待核定'}`
      : String(row.issueCount)
  }
  return isMissing(row, field) ? MISSING_MARK : String(row[field] ?? MISSING_MARK)
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  errorMessage.value = ''
  exporting.value = true
  try {
    const result = submitPatrolPackage(filters.value)
    exportResult.value = result
    // 缺项也照常出文件；只有文件生成失败时才不下发。
    if (result.ok) {
      downloadPatrolPackage(result)
    }
    packages.value = listPatrolPackages()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '站点巡检出包失败'
  } finally {
    exporting.value = false
  }
}

function openCreate() {
  errorMessage.value = '巡检记录登记入口尚未接入审批流'
}

function runAction(action: string, row: Pick<PatrolViewRow, 'id'>) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 列表与出包读同一份快照：同一套核定口径、同一条残留剔除规则。
    const snapshot = loadPatrolSnapshot(filters.value)
    rows.value = snapshot.rows
    total.value = snapshot.rows.length
    residualCount.value = snapshot.residualRows.length
    packages.value = listPatrolPackages()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '站点巡检列表读取失败'
  }
}

onMounted(reload)
</script>
