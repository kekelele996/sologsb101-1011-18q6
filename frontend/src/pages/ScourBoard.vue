<script setup lang="ts">
/**
 * 模块 8：/sections/:id/scour 汛后冲淤对账（流量测验组侧重挂 / 比对）
 * 测次按测次号与测量组对账：挂上当时生效的大断面成果后，拿垂线起点距与实测水深，
 * 与成果河底高程按测次水位折算的成果水深逐条对比，超限标冲淤偏差；
 * 实测水深照旧算断面流量，河底高程只判偏差。测次时间改动后挂靠作废退回待挂，本侧重挂。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Connection, Histogram, Refresh, Right, Aim } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import ScourStatusTag from '@/components/common/ScourStatusTag.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { useScourStore } from '@/stores/scourStore'
import { SCOUR_DEPTH_LIMIT_M } from '@/types/scour'
import { evaluateScour } from '@/utils/scour'
import { calcMeanVelocity } from '@/utils/flow'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const surveyStore = useSurveyStore()
const scourStore = useScourStore()

const sectionId = computed(() => String(route.params.id ?? ''))
const section = computed(() => sectionStore.sectionById(sectionId.value))
const station = computed(() => (section.value ? stationStore.stationById(section.value.stationId) : null))
const link = computed(() => scourStore.linkOfSection(sectionId.value))
const linkedSurvey = computed(() =>
  link.value?.surveyResultId ? surveyStore.surveyById(link.value.surveyResultId) : null
)
const detachedSurvey = computed(() =>
  link.value?.detachedFromId ? surveyStore.surveyById(link.value.detachedFromId) : null
)

/** 手工挂靠候选：本站全部成果（按施测日期倒序），首项为按测次时间自动匹配项 */
const surveyOptions = computed(() =>
  station.value
    ? surveyStore.surveysOfStation(station.value.id).map((survey) => ({
        value: survey.id,
        label: `${survey.surveyNo}（${survey.measuredAt.slice(0, 10)}，${survey.status}，${survey.points.length} 点）`,
        afterSection: Date.parse(survey.measuredAt) > Date.parse(section.value?.measuredAt ?? '')
      }))
    : []
)

const recommendedSurveyId = computed<string | null>(() => {
  if (!section.value) return null
  return surveyStore.surveyForSection(section.value.stationId, section.value.measuredAt)?.id ?? null
})

const selectedSurveyId = ref<string>('')

/** 用当前垂线 / 测点实时重算比对结果（保存值由 store 去抖落库，两处算法一致）。
 *  待挂（linkedSurvey 为 null）时仍按实测水深算出断面流量，河底高程比对全部记为不可比。 */
const liveResult = computed(() => {
  if (!section.value) return null
  const inputs = sectionStore.verticalsOfSection(section.value.id).map((vertical) => ({
    vertical,
    points: sectionStore.pointsOfVertical(vertical.id)
  }))
  return evaluateScour(section.value, linkedSurvey.value, inputs)
})

const isAttached = computed(() => link.value?.linkStatus === '已挂' && linkedSurvey.value !== null)
const checks = computed(() => (isAttached.value ? liveResult.value?.checks ?? link.value?.checks ?? [] : []))
const sectionFlow = computed(() => liveResult.value?.sectionFlowM3s ?? link.value?.sectionFlowM3s ?? 0)
const deviationCount = computed(() =>
  isAttached.value ? liveResult.value?.deviationCount ?? link.value?.deviationCount ?? 0 : 0
)
const comparedCount = computed(() =>
  isAttached.value ? liveResult.value?.comparedCount ?? link.value?.comparedCount ?? 0 : 0
)
const maxDeviationM = computed(() =>
  isAttached.value ? liveResult.value?.maxDeviationM ?? link.value?.maxDeviationM ?? 0 : 0
)

/** 本站其他待挂测次，便于连续处理 */
const otherPending = computed(() =>
  scourStore.pendingLinks.filter(
    (item) => item.stationId === station.value?.id && item.sectionId !== sectionId.value
  )
)

function gotoVerticals(): void {
  void router.push(`/sections/${sectionId.value}/verticals`)
}

function gotoSurveys(): void {
  if (station.value) void router.push(`/stations/${station.value.id}/surveys`)
}

function goPending(): void {
  void router.push('/scour-pending')
}

function goSection(id: string): void {
  void router.push(`/sections/${id}/scour`)
}

async function attachSelected(): Promise<void> {
  if (!selectedSurveyId.value) {
    ElMessage.warning('请先选择一份大断面成果')
    return
  }
  await scourStore.relinkSection(sectionId.value, selectedSurveyId.value)
  ElMessage.success('已重新挂靠并完成逐条比对、断面流量与比测结论重算')
}

async function attachRecommended(): Promise<void> {
  if (!section.value) return
  const result = await scourStore.autoRelinkSection(sectionId.value)
  ElMessage[result.ok ? 'success' : 'warning'](result.message)
}

async function refreshCompare(): Promise<void> {
  const updated = await scourStore.recomputeSection(sectionId.value)
  if (!updated) {
    ElMessage.warning('当前为待挂状态，请先挂上成果再比对')
    return
  }
  ElMessage.success('已按最新垂线测深重新比对并重算断面流量')
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  sectionStore.selectSection(sectionId.value)
  selectedSurveyId.value = recommendedSurveyId.value ?? surveyOptions.value[0]?.value ?? ''
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!sectionStore.ready || !scourStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!section"
      entity-label="断面测次"
      :missing-id="sectionId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        sectionStore.sections.slice(0, 3).map((item) => ({
          id: item.id,
          label: `测次 ${item.measureNo} 的垂线`,
          path: `/sections/${item.id}/verticals`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item :to="{ path: `/stations/${section.stationId}/sections` }">
              {{ station?.name ?? '测站' }} 断面测次
            </el-breadcrumb-item>
            <el-breadcrumb-item>汛后冲淤对账</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            测次 {{ section.measureNo }} · 汛后冲淤对账
            <ScourStatusTag
              :link-status="link?.linkStatus ?? '待挂'"
              :deviation-count="deviationCount"
              show-text
            />
          </h2>
          <p class="gb-hint">
            测次时间 {{ new Date(section.measuredAt).toLocaleString('zh-CN') }} · 水位
            {{ section.stageM.toFixed(2) }} m · {{ section.method }}。成果水深 = 水位 − 成果同起点距河底高程，
            实测水深与成果水深差过 {{ SCOUR_DEPTH_LIMIT_M }} m 标冲淤偏差；河底高程只判偏差，流量仍按实测水深算。
          </p>
        </div>
        <div class="page__actions">
          <el-button :icon="Histogram" @click="gotoVerticals">垂线测深</el-button>
          <el-button :icon="Aim" @click="gotoSurveys">大断面成果</el-button>
        </div>
      </div>

      <div class="gb-stats-row">
        <StatBadge
          label="断面流量（实测水深）"
          :value="sectionFlow.toFixed(2)"
          suffix="m³/s"
          tone="success"
          icon="TrendCharts"
        />
        <StatBadge label="可比垂线" :value="comparedCount" suffix="条" tone="info" icon="Histogram" />
        <StatBadge
          label="冲淤偏差垂线"
          :value="deviationCount"
          suffix="条"
          :tone="deviationCount > 0 ? 'danger' : 'primary'"
          icon="WarningFilled"
        />
        <StatBadge
          label="最大冲淤偏差"
          :value="maxDeviationM.toFixed(2)"
          suffix="m"
          :tone="maxDeviationM > SCOUR_DEPTH_LIMIT_M ? 'warning' : 'primary'"
          icon="Odometer"
        />
      </div>

      <!-- 挂靠面板 -->
      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>成果挂靠（流量测验组侧）</h3>
          <span class="gb-hint">两边按测次号对账，测量组那份成果不动</span>
        </div>

        <template v-if="link?.linkStatus === '已挂' && linkedSurvey">
          <el-descriptions :column="3" border size="small">
            <el-descriptions-item label="挂靠成果">
              <el-tag size="small" :type="linkedSurvey.status === '生效' ? 'success' : 'info'" effect="plain">
                {{ linkedSurvey.status }}
              </el-tag>
              <span class="gb-mono page__survey-no">{{ linkedSurvey.surveyNo }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="施测日期">{{ linkedSurvey.measuredAt.slice(0, 10) }}</el-descriptions-item>
            <el-descriptions-item label="成果测点">{{ linkedSurvey.points.length }} 点</el-descriptions-item>
            <el-descriptions-item label="比测结论" :span="3">
              <el-tag
                size="small"
                :type="deviationCount > 0 ? 'danger' : 'success'"
                effect="plain"
              >
                {{ liveResult?.conclusion ?? link.conclusion }}
              </el-tag>
              <span v-if="link.checkedAt" class="gb-hint">
                最近比对 {{ new Date(link.checkedAt).toLocaleString('zh-CN') }}
              </span>
            </el-descriptions-item>
          </el-descriptions>
          <div class="page__relink-row">
            <el-button :icon="Refresh" @click="refreshCompare">重新比对并重算</el-button>
            <el-select v-model="selectedSurveyId" placeholder="改挂其他成果" class="page__survey-select">
              <el-option
                v-for="option in surveyOptions"
                :key="option.value"
                :label="`${option.label}${option.afterSection ? '（晚于测次时间）' : ''}`"
                :value="option.value"
              />
            </el-select>
            <el-button type="primary" plain :icon="Connection" @click="attachSelected">改挂并重算</el-button>
          </div>
        </template>

        <template v-else>
          <el-alert
            type="warning"
            show-icon
            :closable="false"
            :title="
              detachedSurvey
                ? `测次时间已改动，原挂靠成果「${detachedSurvey.surveyNo}」对不上，挂靠已作废退回待挂（测量组那份成果未动）`
                : '该测次尚未挂上大断面成果：升级补挂失败或测次时间改动后退回，请在流量测验组本侧重挂'
            "
          />
          <div class="page__relink-row">
            <el-button type="primary" :icon="Connection" @click="attachRecommended">按测次时间挂最近成果</el-button>
            <el-select v-model="selectedSurveyId" placeholder="手工选择成果" class="page__survey-select">
              <el-option v-for="option in surveyOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <el-button :icon="Right" @click="attachSelected">挂靠并重算</el-button>
            <el-button text type="primary" :icon="Aim" @click="gotoSurveys">没有成果？去施测</el-button>
          </div>
        </template>
      </el-card>

      <!-- 逐条比对明细 -->
      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>逐条垂线水深对比</h3>
          <span class="gb-hint">
            偏差 = 实测水深 − 成果折算水深；正为冲刷、负为淤积；同起点距取成果点，否则相邻点线性内插
          </span>
        </div>

        <EmptyPanel
          v-if="checks.length === 0"
          title="尚无逐条比对结果"
          :description="link?.linkStatus === '待挂' ? '先把大断面成果挂上来，系统按垂线逐条比对并出比测结论。' : '该测次还没有垂线，先去布设垂线并录实测水深。'"
          :action-text="link?.linkStatus === '待挂' ? '去选择成果' : '去布设垂线'"
          compact
          @action="link?.linkStatus === '待挂' ? gotoSurveys() : gotoVerticals()"
        />

        <el-table v-else :data="checks" border stripe class="gb-table-compact">
          <el-table-column prop="no" label="垂线号" width="80" align="center" />
          <el-table-column label="起点距 (m)" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.startDistanceM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="实测水深 (m)" width="120" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.measuredDepthM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="成果河底高程 (m)" width="150" align="right">
            <template #default="{ row }">
              <span v-if="row.bedElevM !== null" class="gb-mono">{{ row.bedElevM.toFixed(3) }}</span>
              <span v-else class="page__muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="成果折算水深 (m)" width="150" align="right">
            <template #default="{ row }">
              <span v-if="row.surveyDepthM !== null" class="gb-mono">{{ row.surveyDepthM.toFixed(3) }}</span>
              <span v-else class="page__muted">超出成果范围</span>
            </template>
          </el-table-column>
          <el-table-column label="偏差 (m)" width="110" align="right">
            <template #default="{ row }">
              <span
                v-if="row.deviationM !== null"
                class="gb-mono"
                :class="row.verdict === '冲淤偏差' ? 'page__danger' : ''"
              >
                {{ row.deviationM > 0 ? '+' : '' }}{{ row.deviationM.toFixed(2) }}
              </span>
              <span v-else class="page__muted">—</span>
            </template>
          </el-table-column>
          <el-table-column label="冲 / 淤" width="90" align="center">
            <template #default="{ row }">
              <el-tag
                v-if="row.verdict !== '不可比'"
                size="small"
                :type="row.kind === '冲刷' ? 'danger' : row.kind === '淤积' ? 'warning' : 'success'"
                effect="plain"
              >
                {{ row.kind }}
              </el-tag>
              <span v-else class="page__muted">不可比</span>
            </template>
          </el-table-column>
          <el-table-column label="判定" width="120" align="center">
            <template #default="{ row }">
              <el-tag
                v-if="row.verdict === '冲淤偏差'"
                type="danger"
                size="small"
                effect="dark"
              >
                冲淤偏差
              </el-tag>
              <el-tag v-else-if="row.verdict === '合格'" type="success" size="small" effect="plain">合格</el-tag>
              <el-tag v-else type="info" size="small" effect="plain">不可比</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="取值方式" min-width="110">
            <template #default="{ row }">
              <span class="gb-hint">
                {{ row.match === 'exact' ? '同起点距成果点' : row.match === 'interpolate' ? '相邻点内插' : '超出成果范围' }}
              </span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <el-card v-if="otherPending.length > 0" shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>本站其他待挂测次</h3>
          <el-button size="small" type="warning" plain :icon="Connection" @click="goPending">
            去待挂队列（{{ scourStore.stats.pending }}）
          </el-button>
        </div>
        <el-table :data="otherPending" border size="small" class="gb-table-compact">
          <el-table-column prop="measureNo" label="测次号" min-width="150" />
          <el-table-column label="水位 (m)" width="110" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110" align="center">
            <template #default="{ row }">
              <ScourStatusTag :link-status="row.linkStatus" />
            </template>
          </el-table-column>
          <el-table-column label="操作" width="130" align="center">
            <template #default="{ row }">
              <el-button size="small" type="primary" text @click="goSection(row.sectionId)">去处理</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>
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

.page__actions {
  display: flex;
  gap: 8px;
}

.page__relink-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.page__survey-select {
  width: 340px;
}

.page__survey-no {
  margin-left: 8px;
  font-weight: 600;
}

.page__danger {
  color: #c0392b;
  font-weight: 700;
}

.page__muted {
  color: #9aa9b4;
  font-size: 12px;
}
</style>
