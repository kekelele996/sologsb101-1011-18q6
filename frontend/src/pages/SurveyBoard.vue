<script setup lang="ts">
/**
 * 模块 2b：/stations/:id/surveys 大断面成果台账（断面测量组侧）
 * 测一次大断面出一份成果，记施测日期与各起点距河底高程，同站只留一份生效。
 * 测次挂靠 / 重挂在流量测验组本侧（断面测次页）进行，本页成果不被挂靠操作修改；
 * 待挂测次（含升级补不上成果的）在本页底部分列。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, Delete, Edit, Plus, Right } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { createEmptySurveyDraft } from '@/stores/surveyStore'
import { SILT_LIMIT_M, type Survey } from '@/types/survey'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const surveyStore = useSurveyStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive(createEmptySurveyDraft())

const surveys = computed(() => surveyStore.surveysOfStation(stationId.value))
const effectiveSurvey = computed(() => surveyStore.effectiveSurveyOf(stationId.value))

/** 待挂测次单列：升级补不上成果的与作废退回的都在这里 */
const pendingSections = computed(() =>
  surveyStore.pendingSections.filter((section) => section.stationId === stationId.value)
)

const stats = computed(() => ({
  surveyCount: surveys.value.length,
  effectiveAt: effectiveSurvey.value?.surveyedAt ?? null,
  linkedCount: surveys.value.reduce((sum, survey) => sum + (surveyStore.linkedCounts[survey.id] ?? 0), 0),
  pendingCount: pendingSections.value.length
}))

/** 成果高程范围回显 */
function elevationRange(survey: Survey): string {
  if (survey.points.length === 0) return '—'
  const values = survey.points.map((point) => point.bedElevationM)
  return `${Math.min(...values).toFixed(2)} ~ ${Math.max(...values).toFixed(2)}`
}

function openCreate(): void {
  editingId.value = null
  const fresh = createEmptySurveyDraft()
  form.surveyedAt = fresh.surveyedAt
  form.note = ''
  form.points = fresh.points
  dialogVisible.value = true
}

function openEdit(survey: Survey): void {
  editingId.value = survey.id
  form.surveyedAt = survey.surveyedAt.slice(0, 16)
  form.note = survey.note
  form.points = survey.points.map((point) => ({ ...point }))
  dialogVisible.value = true
}

function addPointRow(): void {
  const last = form.points[form.points.length - 1]
  form.points.push({
    startDistanceM: last ? Number((last.startDistanceM + 10).toFixed(1)) : 0,
    bedElevationM: last ? last.bedElevationM : 0
  })
}

function removePointRow(index: number): void {
  form.points.splice(index, 1)
}

async function submitForm(): Promise<void> {
  if (!form.surveyedAt) {
    ElMessage.warning('请选择施测日期')
    return
  }
  const points = form.points.filter(
    (point) => Number.isFinite(point.startDistanceM) && Number.isFinite(point.bedElevationM)
  )
  if (points.length < 2) {
    ElMessage.warning('成果至少需要 2 个起点距 / 河底高程点')
    return
  }
  const distances = new Set(points.map((point) => Number(point.startDistanceM.toFixed(3))))
  if (distances.size !== points.length) {
    ElMessage.warning('成果点起点距存在重复，请逐点核对')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: stationId.value,
      surveyedAt: new Date(form.surveyedAt).toISOString(),
      note: form.note.trim(),
      points
    }
    if (editingId.value) {
      await surveyStore.updateSurvey(editingId.value, payload)
      ElMessage.success('成果已更新（已挂测次的对账结果随之刷新）')
    } else {
      const created = await surveyStore.createSurvey(payload)
      ElMessage.success(
        created.effective ? '成果已登记，并作为本站首份成果生效' : '成果已登记，如需启用请点「设为生效」'
      )
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function makeEffective(survey: Survey): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `同站只留一份生效：将「${new Date(survey.surveyedAt).toLocaleDateString('zh-CN')}」成果设为生效，其余成果自动失效。确认继续？`,
      '设为生效',
      { type: 'warning', confirmButtonText: '设为生效', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.setEffective(survey.id)
  ElMessage.success('已切换生效成果（已挂测次的挂靠不受影响，新挂测次按测次时间取当时生效成果）')
}

async function removeSurvey(survey: Survey): Promise<void> {
  const linked = surveyStore.linkedCounts[survey.id] ?? 0
  try {
    await ElMessageBox.confirm(
      `删除该成果后${linked > 0 ? `，挂到它的 ${linked} 个测次将作废退回待挂` : ''}，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await surveyStore.removeSurvey(survey.id)
  ElMessage.success('成果已删除')
}

function gotoSections(): void {
  void router.push(`/stations/${stationId.value}/sections`)
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  // 幂等扫描：测次时间改动留下的失效挂靠统一作废退回待挂
  void surveyStore.voidStaleLinks()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!surveyStore.ready" :rows="5" animated />

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
            <el-breadcrumb-item :to="{ path: `/stations/${stationId}/sections` }">{{ station.name }}</el-breadcrumb-item>
            <el-breadcrumb-item>大断面成果</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ station.name }} · 大断面成果
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }}</el-tag>
            <el-tag size="small" type="info" effect="plain">断面测量组</el-tag>
          </h2>
          <p class="gb-hint">
            测一次大断面出一份成果，记施测日期与各起点距河底高程，同站只留一份生效。
            测次挂靠在断面测次页（流量测验组本侧）进行，本页成果不被挂靠操作修改。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="Right" @click="gotoSections">去断面测次</el-button>
          <el-button type="primary" :icon="Plus" @click="openCreate">登记成果</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="成果份数" :value="stats.surveyCount" suffix="份" icon="Files" />
        <StatBadge
          label="当前生效"
          :value="stats.effectiveAt === null ? '—' : new Date(stats.effectiveAt).toLocaleDateString('zh-CN')"
          tone="success"
          icon="Odometer"
        />
        <StatBadge label="已挂测次" :value="stats.linkedCount" suffix="次" tone="info" icon="Histogram" />
        <StatBadge
          label="待挂测次"
          :value="stats.pendingCount"
          suffix="次"
          :tone="stats.pendingCount > 0 ? 'warning' : 'primary'"
          icon="WarningFilled"
        />
      </div>

      <EmptyPanel
        v-if="surveys.length === 0"
        title="该测站还没有大断面成果"
        description="登记一次大断面测量成果（施测日期 + 各起点距河底高程）后，测次即可按测流时间挂靠当时生效的成果。"
        action-text="登记成果"
        @action="openCreate"
      />

      <el-table v-else :data="surveys" border stripe class="gb-table-compact">
        <el-table-column label="施测日期" min-width="130">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.surveyedAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.effective" size="small" type="success">生效</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">历史</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="成果点数" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.points.length }}</span>
          </template>
        </el-table-column>
        <el-table-column label="河底高程范围 (m)" width="160" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ elevationRange(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="已挂测次" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ surveyStore.linkedCounts[row.id] ?? 0 }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="备注" min-width="180" show-overflow-tooltip />
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button v-if="!row.effective" size="small" type="success" plain :icon="Check" @click="makeEffective(row)">
              设为生效
            </el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeSurvey(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="gb-panel">
        <div class="gb-panel-title">
          <h3>
            待挂测次单列
            <el-tag v-if="pendingSections.length > 0" type="warning" size="small" effect="plain">
              {{ pendingSections.length }} 次待挂
            </el-tag>
          </h3>
          <span class="gb-hint">
            升级补不上成果的、测次时间改动后作废退回的测次在此单列；重挂请到断面测次页（流量测验组本侧）操作
          </span>
        </div>
        <EmptyPanel
          v-if="pendingSections.length === 0"
          title="没有待挂测次"
          description="该站全部测次均已挂上当时生效的大断面成果。"
          compact
        />
        <el-table v-else :data="pendingSections" border size="small" class="gb-table-compact">
          <el-table-column prop="measureNo" label="测次号" min-width="140" />
          <el-table-column label="测法" width="100" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.method }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="水位 (m)" width="100" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="测流时间" min-width="160">
            <template #default="{ row }">
              <span class="gb-mono">{{ new Date(row.measuredAt).toLocaleString('zh-CN') }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="140" fixed="right">
            <template #default>
              <el-button size="small" type="primary" plain @click="gotoSections">去重挂</el-button>
            </template>
          </el-table-column>
        </el-table>
      </div>

      <p class="gb-hint">
        对账口径：垂线实测水深与成果同起点距河底高程按水位折算的水深逐条比对，差值超过 {{ SILT_LIMIT_M }} m
        标冲淤偏差；实测水深照旧算流量，河底高程只判偏差。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑成果' : '登记大断面成果'" width="640px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="施测日期" required>
          <el-date-picker v-model="form.surveyedAt" type="datetime" placeholder="选择施测日期" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="如：汛后大断面，主槽冲刷" maxlength="60" />
        </el-form-item>
        <el-form-item label="成果点" required>
          <div class="points-editor">
            <div class="points-editor__head">
              <span>起点距 (m)</span>
              <span>河底高程 (m)</span>
              <span />
            </div>
            <div v-for="(point, index) in form.points" :key="index" class="points-editor__row">
              <el-input-number v-model="point.startDistanceM" :min="0" :max="5000" :step="1" :precision="1" controls-position="right" />
              <el-input-number v-model="point.bedElevationM" :min="-50" :max="200" :step="0.05" :precision="2" controls-position="right" />
              <el-button size="small" type="danger" plain :icon="Delete" :disabled="form.points.length <= 2" @click="removePointRow(index)" />
            </div>
            <el-button size="small" :icon="Plus" @click="addPointRow">添加成果点</el-button>
            <p class="gb-hint">至少 2 个点，起点距不可重复；保存时按起点距自动升序，对账时相邻点线性插值。</p>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '登记成果' }}
        </el-button>
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

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.points-editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.points-editor__head,
.points-editor__row {
  display: grid;
  grid-template-columns: 1fr 1fr 40px;
  gap: 8px;
  align-items: center;
}

.points-editor__head {
  font-size: 12px;
  color: #5b6b78;
}
</style>
