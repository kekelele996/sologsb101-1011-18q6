<script setup lang="ts">
/**
 * 模块 7：/stations/:id/surveys 大断面成果台账（断面测量组侧）
 * 每测一次大断面出一份成果：记施测日期与各起点距河底高程，同站只留一份生效；
 * 新成果生效时旧成果自动转存档，测量组这份成果不随流量测次时间改动而变化。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Aim, Delete, DocumentCopy, Edit, Plus, Promotion } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useScourStore } from '@/stores/scourStore'
import {
  createEmptySurveyDraft,
  normalizeSurveyPoints,
  parseSurveyPointPaste,
  type SurveyDraft,
  type SurveyResult,
  type SurveyStatus
} from '@/types/survey'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const surveyStore = useSurveyStore()
const scourStore = useScourStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

const dialogVisible = ref(false)
const pasteVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const pasteText = ref('')
const pasteErrors = ref<string[]>([])
/** 测点编辑表的本地行（el-table 直接改单元格） */
const pointRows = ref<Array<{ startDistanceM: number; bedElevM: number }>>([])
const form = reactive<SurveyDraft & { status: SurveyStatus }>({
  ...createEmptySurveyDraft(),
  status: '生效'
})

const surveys = computed(() => surveyStore.surveysOfStation(stationId.value))
const activeSurvey = computed(() => surveyStore.activeSurveyOfStation(stationId.value))

const stats = computed(() => {
  const list = surveys.value
  const pendingCount = scourStore.links.filter(
    (link) => link.stationId === stationId.value && link.linkStatus === '待挂'
  ).length
  return {
    total: list.length,
    active: list.filter((survey) => survey.status === '生效').length,
    pointCount: activeSurvey.value?.points.length ?? 0,
    pendingCount
  }
})

/** 某成果被哪些已挂测次引用（删除前提示用） */
function attachedSectionsOf(survey: SurveyResult): number {
  return scourStore.links.filter((link) => link.surveyResultId === survey.id && link.linkStatus === '已挂').length
}

function addPointRow(): void {
  const last = pointRows.value[pointRows.value.length - 1]
  pointRows.value.push({
    startDistanceM: last ? Number((last.startDistanceM + 6).toFixed(1)) : 0,
    bedElevM: activeSurvey.value ? Number((activeSurvey.value.points[0]?.bedElevM ?? 0).toFixed(2)) : 0
  })
}

function removePointRow(index: number): void {
  pointRows.value.splice(index, 1)
}

function openCreate(): void {
  editingId.value = null
  Object.assign(form, createEmptySurveyDraft(), { status: '生效' })
  form.surveyNo = `DC-${station.value?.sectionCode?.slice(3) ?? 'NEW'}-${String(surveys.value.length + 1).padStart(2, '0')}`
  pointRows.value = (activeSurvey.value?.points ?? []).map((point) => ({ ...point }))
  dialogVisible.value = true
}

function openEdit(survey: SurveyResult): void {
  editingId.value = survey.id
  Object.assign(form, {
    surveyNo: survey.surveyNo,
    measuredAt: survey.measuredAt.slice(0, 10),
    remark: survey.remark,
    status: survey.status,
    points: survey.points
  })
  pointRows.value = survey.points.map((point) => ({ ...point }))
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.surveyNo.trim()) {
    ElMessage.warning('请填写成果编号')
    return
  }
  const points = normalizeSurveyPoints(pointRows.value)
  if (points.length < 2) {
    ElMessage.warning('至少录入 2 个起点距—河底高程测点才能用于水深折算')
    return
  }
  if (!form.measuredAt) {
    ElMessage.warning('请选择施测日期')
    return
  }
  submitting.value = true
  try {
    const draft = { ...form, points }
    if (editingId.value) {
      const record = surveyStore.buildSurveyRecord(stationId.value, draft, form.status)
      await surveyStore.updateSurvey(editingId.value, record)
      ElMessage.success('大断面成果已更新（测量组成果不动流量侧挂靠）')
    } else {
      const created = await surveyStore.createSurvey(stationId.value, draft, form.status)
      ElMessage.success(
        form.status === '生效'
          ? `成果「${created.surveyNo}」已生效，同站原成果转存档`
          : `成果「${created.surveyNo}」已存档`
      )
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function activate(survey: SurveyResult): Promise<void> {
  await surveyStore.activateSurvey(survey.id)
  ElMessage.success(`成果「${survey.surveyNo}」已设为生效；历史测次挂靠不变，待挂测次可据此重挂`)
}

async function removeSurvey(survey: SurveyResult): Promise<void> {
  const attached = attachedSectionsOf(survey)
  try {
    await ElMessageBox.confirm(
      `删除成果「${survey.surveyNo}」${
        attached > 0 ? `将使 ${attached} 个已挂测次退回待挂（流量侧重挂，成果原件删除不可恢复）` : ''
      }，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  const detached = await surveyStore.removeSurvey(survey.id)
  ElMessage.success(detached > 0 ? `成果已删除，${detached} 个测次退回待挂` : '成果已删除')
}

function applyPaste(): void {
  const { rows, errors } = parseSurveyPointPaste(pasteText.value)
  pasteErrors.value = errors
  if (rows.length === 0) {
    ElMessage.error('没有可导入的测点行')
    return
  }
  pointRows.value = normalizeSurveyPoints([...pointRows.value, ...rows])
  ElMessage.success(`已导入 ${rows.length} 个测点（按起点距排序去重）`)
  pasteVisible.value = false
  pasteText.value = ''
}

function gotoScour(survey: SurveyResult): void {
  const link = scourStore.links.find((item) => item.surveyResultId === survey.id)
  if (link) {
    void router.push(`/sections/${link.sectionId}/scour`)
  } else {
    ElMessage.info('该成果当前没有已挂测次，可到待挂队列或断面测次处选择它挂靠')
  }
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!stationStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!station"
      entity-label="测站"
      :missing-id="stationId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        stationStore.stations.slice(0, 3).map((item) => ({
          id: item.id,
          label: `${item.name} 的大断面成果`,
          path: `/stations/${item.id}/surveys`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item>{{ station.name }}</el-breadcrumb-item>
            <el-breadcrumb-item>大断面成果</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ station.name }} · 大断面成果
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }}</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ station.river }}</el-tag>
          </h2>
          <p class="gb-hint">
            断面测量组每测一次大断面出一份成果，记施测日期与各起点距河底高程；同站只留一份生效，新成果生效时旧成果转存档。
          </p>
        </div>
        <el-button type="primary" :icon="Plus" @click="openCreate">施测新成果</el-button>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="成果份数" :value="stats.total" suffix="份" icon="Files" />
        <StatBadge label="生效成果" :value="stats.active" suffix="份" tone="success" icon="Aim" />
        <StatBadge label="生效成果测点" :value="stats.pointCount" suffix="点" tone="info" icon="Histogram" />
        <StatBadge
          label="本站待挂测次"
          :value="stats.pendingCount"
          suffix="次"
          :tone="stats.pendingCount > 0 ? 'warning' : 'primary'"
          icon="Promotion"
        />
      </div>

      <el-alert
        v-if="activeSurvey"
        type="success"
        :closable="false"
        show-icon
        :title="`当前生效：${activeSurvey.surveyNo}（${activeSurvey.measuredAt.slice(0, 10)} 施测，${activeSurvey.points.length} 个测点）`"
        :description="activeSurvey.remark || '新测次将按测流时间自动匹配该成果；历史测次挂靠不受成果转存档影响。'"
      />

      <EmptyPanel
        v-if="surveys.length === 0"
        title="该测站还没有大断面成果"
        description="施测第一份大断面成果（起点距—河底高程），流量测验组即可把测次挂上来做汛后冲淤对账。"
        action-text="施测新成果"
        @action="openCreate"
      />

      <el-table v-else :data="surveys" border stripe class="gb-table-compact" row-key="id">
        <el-table-column type="expand">
          <template #default="{ row }">
            <div class="page__expand">
              <div class="gb-hint">起点距—河底高程（m，按起点距升序）</div>
              <el-table :data="row.points" border size="small" class="gb-table-compact">
                <el-table-column type="index" label="#" width="60" align="center" />
                <el-table-column label="起点距 (m)" align="right">
                  <template #default="{ row: point }">
                    <span class="gb-mono">{{ point.startDistanceM.toFixed(2) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="河底高程 (m)" align="right">
                  <template #default="{ row: point }">
                    <span class="gb-mono">{{ point.bedElevM.toFixed(3) }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="surveyNo" label="成果编号" min-width="160" />
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.status === '生效' ? 'success' : 'info'" effect="dark">
              {{ row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="施测日期" width="130">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.measuredAt.slice(0, 10) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="points.length" label="测点数" width="90" align="center" />
        <el-table-column label="挂靠测次" width="100" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoScour(row)">
              {{ attachedSectionsOf(row) }} 次
            </el-button>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="施测说明" min-width="200" show-overflow-tooltip />
        <el-table-column label="操作" width="270" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status !== '生效'"
              size="small"
              type="success"
              plain
              :icon="Promotion"
              @click="activate(row)"
            >
              设为生效
            </el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeSurvey(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </template>

    <el-dialog
      v-model="dialogVisible"
      :title="editingId ? '编辑大断面成果' : '施测新大断面成果'"
      width="720px"
      :close-on-click-modal="false"
    >
      <el-form label-width="104px">
        <el-form-item label="成果编号" required>
          <el-input v-model="form.surveyNo" placeholder="如：DC-LM-2024-02" maxlength="32" />
        </el-form-item>
        <el-form-item label="施测日期" required>
          <el-date-picker v-model="form.measuredAt" type="date" placeholder="选择施测日期" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="成果状态" required>
          <el-radio-group v-model="form.status" :disabled="editingId !== null">
            <el-radio-button value="生效">生效（同站唯一）</el-radio-button>
            <el-radio-button value="存档">存档</el-radio-button>
          </el-radio-group>
          <p v-if="!editingId && form.status === '生效'" class="gb-hint">
            保存后同站原生效成果自动转为存档；历史测次仍挂原成果，不受影响。
          </p>
        </el-form-item>
        <el-form-item label="施测说明">
          <el-input v-model="form.remark" placeholder="如：汛后冲淤复测，主槽刷深" maxlength="60" />
        </el-form-item>
        <el-form-item label="断面测点" required>
          <div class="page__points">
            <div class="page__points-actions">
              <el-button size="small" :icon="Plus" @click="addPointRow">追加测点</el-button>
              <el-button size="small" :icon="DocumentCopy" @click="pasteVisible = true">批量粘贴</el-button>
              <span class="gb-hint">每行「起点距, 河底高程」，保存时按起点距排序去重</span>
            </div>
            <el-table :data="pointRows" border size="small" class="gb-table-compact">
              <el-table-column type="index" label="#" width="56" align="center" />
              <el-table-column label="起点距 (m)" min-width="180">
                <template #default="{ $index }">
                  <el-input-number
                    v-model="pointRows[$index].startDistanceM"
                    :min="0"
                    :max="5000"
                    :step="0.5"
                    :precision="2"
                    controls-position="right"
                    class="page__number"
                  />
                </template>
              </el-table-column>
              <el-table-column label="河底高程 (m)" min-width="180">
                <template #default="{ $index }">
                  <el-input-number
                    v-model="pointRows[$index].bedElevM"
                    :min="-100"
                    :max="5000"
                    :step="0.05"
                    :precision="3"
                    controls-position="right"
                    class="page__number"
                  />
                </template>
              </el-table-column>
              <el-table-column label="操作" width="90" align="center">
                <template #default="{ $index }">
                  <el-button size="small" type="danger" text :icon="Delete" @click="removePointRow($index)" />
                </template>
              </el-table-column>
            </el-table>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :icon="Aim" @click="submitForm">
          {{ editingId ? '保存成果' : '保存并生效' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pasteVisible" title="批量粘贴断面测点" width="560px" :close-on-click-modal="false">
      <el-input
        v-model="pasteText"
        type="textarea"
        :rows="8"
        placeholder="每行一个测点：起点距,河底高程，如&#10;0,4.55&#10;8.0,2.85&#10;14.0,2.05"
      />
      <div v-if="pasteErrors.length > 0" class="page__paste-errors">
        <el-alert
          v-for="(error, index) in pasteErrors"
          :key="index"
          :title="error"
          type="error"
          :closable="false"
          class="page__paste-error"
        />
      </div>
      <template #footer>
        <el-button @click="pasteVisible = false">取消</el-button>
        <el-button type="primary" :icon="DocumentCopy" @click="applyPaste">导入测点</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0f4c75;
}

.page__tag {
  font-weight: 400;
}

.page__expand {
  padding: 8px 24px 16px;
}

.page__points {
  width: 100%;
}

.page__points-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}

.page__number {
  width: 100%;
}

.page__paste-errors {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.page__paste-error {
  font-size: 12px;
}
</style>
