<script setup lang="ts">
/**
 * 模块 9：/scour-pending 待挂成果队列（流量测验组重挂工作台）
 * 汇总各站退回待挂的测次：测次时间改动挂靠作废、升级补不上成果、新建未挂；
 * 支持一键按测次时间补最近成果（补不上的继续单列），或逐条手工选择成果重挂。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Connection, Right, Aim } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import ScourStatusTag from '@/components/common/ScourStatusTag.vue'
import { useScourStore } from '@/stores/scourStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useStationStore } from '@/stores/stationStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { effectiveSurveyAt } from '@/types/survey'
import { initDatabase } from '@/utils/db'

const router = useRouter()
const scourStore = useScourStore()
const sectionStore = useSectionStore()
const stationStore = useStationStore()
const surveyStore = useSurveyStore()

const onlyPending = ref(true)
const stationFilter = ref<string>('')
const working = ref(false)

const rows = computed(() => {
  const source = onlyPending.value ? scourStore.pendingLinks : scourStore.links
  return source
    .filter((link) => (stationFilter.value ? link.stationId === stationFilter.value : true))
    .map((link) => {
      const section = sectionStore.sectionById(link.sectionId)
      const station = stationStore.stationById(link.stationId)
      const recommended = section
        ? effectiveSurveyAt(surveyStore.surveys, link.stationId, section.measuredAt)
        : null
      return { link, section, station, recommended }
    })
    .sort((a, b) => Date.parse(b.section?.measuredAt ?? '') - Date.parse(a.section?.measuredAt ?? ''))
})

const stationOptions = computed(() =>
  stationStore.stations.map((station) => ({ value: station.id, label: `${station.name}（${station.sectionCode}）` }))
)

async function attachRecommended(sectionId: string): Promise<void> {
  const result = await scourStore.autoRelinkSection(sectionId)
  ElMessage[result.ok ? 'success' : 'warning'](result.message)
}

async function attachAllPending(): Promise<void> {
  working.value = true
  try {
    const { attached, stillPending } = await scourStore.autoRelinkAllPending()
    if (stillPending > 0) {
      ElMessage.warning(`已自动补挂 ${attached} 个测次，${stillPending} 个因测次时间之前无成果继续单列待挂`)
    } else {
      ElMessage.success(`已按测次时间补挂全部 ${attached} 个待挂测次`)
    }
  } finally {
    working.value = false
  }
}

function openScour(sectionId: string): void {
  void router.push(`/sections/${sectionId}/scour`)
}

function openSurveys(stationId: string): void {
  void router.push(`/stations/${stationId}/surveys`)
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">汛后冲淤 · 待挂成果队列</h2>
        <p class="gb-hint">
          两边按测次号对账：测次时间一改动挂靠就作废退回待挂，旧数据升级时按测次时间补最近成果、补不上的在此单列；
          测量组那份成果不动，重挂只发生在流量测验组侧。
        </p>
      </div>
      <el-button
        type="primary"
        :icon="Connection"
        :loading="working"
        :disabled="scourStore.stats.pending === 0"
        @click="attachAllPending"
      >
        一键按测次时间补挂（{{ scourStore.stats.pending }}）
      </el-button>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="挂靠总数" :value="scourStore.stats.total" suffix="次" icon="Files" />
      <StatBadge label="已挂" :value="scourStore.stats.attached" suffix="次" tone="success" icon="Connection" />
      <StatBadge
        label="待挂"
        :value="scourStore.stats.pending"
        suffix="次"
        :tone="scourStore.stats.pending > 0 ? 'warning' : 'primary'"
        icon="WarningFilled"
      />
      <StatBadge
        label="冲淤偏差测次"
        :value="scourStore.stats.deviation"
        suffix="次"
        :tone="scourStore.stats.deviation > 0 ? 'danger' : 'primary'"
        icon="Aim"
      />
    </div>

    <div class="page__filters">
      <el-radio-group v-model="onlyPending">
        <el-radio-button :value="true">只看待挂</el-radio-button>
        <el-radio-button :value="false">全部挂靠</el-radio-button>
      </el-radio-group>
      <el-select v-model="stationFilter" placeholder="全部测站" clearable class="page__station-filter">
        <el-option v-for="option in stationOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </div>

    <EmptyPanel
      v-if="rows.length === 0"
      title="没有待挂测次"
      description="所有测次都已挂上当时生效的大断面成果。修改测次时间或施测新成果后，退回待挂的测次会出现在这里。"
      action-text="去测站台账"
      @action="router.push('/stations')"
    />

    <el-table v-else :data="rows" border stripe class="gb-table-compact">
      <el-table-column label="测站" min-width="150">
        <template #default="{ row }">
          {{ row.station?.name ?? '未知测站' }}
          <el-tag size="small" type="info" effect="plain" class="page__code">
            {{ row.station?.sectionCode ?? '-' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="测次号" min-width="140">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.section?.measureNo ?? row.link.measureNo }}</span>
        </template>
      </el-table-column>
      <el-table-column label="测流时间" min-width="165">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.section ? new Date(row.section.measuredAt).toLocaleString('zh-CN') : '测次已删除' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="水位 (m)" width="100" align="right">
        <template #default="{ row }">
          <span class="gb-mono">{{ row.section ? row.section.stageM.toFixed(2) : '—' }}</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="120" align="center">
        <template #default="{ row }">
          <ScourStatusTag
            :link-status="row.link.linkStatus"
            :deviation-count="row.link.deviationCount"
            show-text
          />
        </template>
      </el-table-column>
      <el-table-column label="按时间可补的最近成果" min-width="240">
        <template #default="{ row }">
          <template v-if="row.recommended">
            <el-tag size="small" :type="row.recommended.status === '生效' ? 'success' : 'info'" effect="plain">
              {{ row.recommended.status }}
            </el-tag>
            <span class="gb-mono page__survey-name">{{ row.recommended.surveyNo }}</span>
            <span class="gb-hint">{{ row.recommended.measuredAt.slice(0, 10) }}</span>
          </template>
          <el-button
            v-else
            text
            type="warning"
            size="small"
            :icon="Aim"
            @click="openSurveys(row.link.stationId)"
          >
            测次时间之前无成果，去施测
          </el-button>
        </template>
      </el-table-column>
      <el-table-column label="比测结论" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <span :class="{ 'page__danger': row.link.deviationCount > 0 }">{{ row.link.conclusion }}</span>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="row.link.linkStatus === '待挂' && row.recommended"
            size="small"
            type="primary"
            :icon="Connection"
            @click="attachRecommended(row.link.sectionId)"
          >
            补挂最近
          </el-button>
          <el-button size="small" :icon="Right" @click="openScour(row.link.sectionId)">
            {{ row.link.linkStatus === '待挂' ? '手工重挂' : '查看比对' }}
          </el-button>
        </template>
      </el-table-column>
    </el-table>
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
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.page__station-filter {
  width: 240px;
}

.page__code {
  margin-left: 6px;
  font-weight: 400;
}

.page__survey-name {
  margin: 0 6px;
  font-weight: 600;
}

.page__danger {
  color: #c0392b;
  font-weight: 600;
}
</style>
