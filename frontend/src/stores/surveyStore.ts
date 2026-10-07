/**
 * 大断面成果 store（断面测量组侧）：
 * 维护各站大断面成果（施测日期 + 起点距河底高程测点），同站同一时刻只留一份生效；
 * 新成果生效时旧成果自动转存档，测量组这份成果不随流量测次时间改动而变化。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, detachLinksForSurvey, watchTable } from '@/utils/db'
import type { SurveyDraft, SurveyResult, SurveyStatus } from '@/types/survey'
import { effectiveSurveyAt, normalizeSurveyPoints } from '@/types/survey'

export const useSurveyStore = defineStore('survey', () => {
  const surveys = ref<SurveyResult[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<SurveyResult>(() => db.surveyResults).subscribe((rows) => {
      surveys.value = rows
      ready.value = true
      error.value = null
    })
  }

  const surveyById = (id: string | null | undefined): SurveyResult | null =>
    id ? surveys.value.find((survey) => survey.id === id) ?? null : null

  /** 某测站的成果：生效在前，其余按施测日期倒序 */
  function surveysOfStation(stationId: string | null | undefined): SurveyResult[] {
    if (!stationId) return []
    return surveys.value
      .filter((survey) => survey.stationId === stationId)
      .sort((a, b) => {
        if (a.status !== b.status) return a.status === '生效' ? -1 : 1
        return Date.parse(b.measuredAt) - Date.parse(a.measuredAt)
      })
  }

  /** 某测站当前唯一生效成果 */
  function activeSurveyOfStation(stationId: string | null | undefined): SurveyResult | null {
    if (!stationId) return null
    return surveys.value.find((survey) => survey.stationId === stationId && survey.status === '生效') ?? null
  }

  /** 某测次时刻应挂靠的成果：施测日期不晚于测次时间的最近一份（不限状态） */
  function surveyForSection(stationId: string, measuredAt: string): SurveyResult | null {
    return effectiveSurveyAt(surveys.value, stationId, measuredAt)
  }

  /** 全站生效成果统计 */
  const activeCount = computed(
    () => surveys.value.filter((survey) => survey.status === '生效').length
  )

  const stationSurveyStats = computed<
    Record<string, { total: number; activeSurveyNo: string | null; activeMeasuredAt: string | null }>
  >(() => {
    const stats: Record<string, { total: number; activeSurveyNo: string | null; activeMeasuredAt: string | null }> = {}
    surveys.value.forEach((survey) => {
      const bucket = stats[survey.stationId] ?? { total: 0, activeSurveyNo: null, activeMeasuredAt: null }
      bucket.total += 1
      if (survey.status === '生效') {
        bucket.activeSurveyNo = survey.surveyNo
        bucket.activeMeasuredAt = survey.measuredAt
      }
      stats[survey.stationId] = bucket
    })
    return stats
  })

  /** 草稿落库前规整：测点排序去重、日期转 ISO */
  function buildSurveyRecord(
    stationId: string,
    draft: SurveyDraft,
    status: SurveyStatus
  ): Omit<SurveyResult, 'id' | 'createdAt' | 'updatedAt'> {
    return {
      stationId,
      surveyNo: draft.surveyNo.trim(),
      measuredAt: new Date(`${draft.measuredAt.slice(0, 10)}T00:00:00`).toISOString(),
      status,
      points: normalizeSurveyPoints(draft.points),
      remark: draft.remark.trim()
    }
  }

  /**
   * 新增成果：默认置为生效，并把同站原生效成果转为存档（同站只留一份生效）。
   */
  async function createSurvey(
    stationId: string,
    draft: SurveyDraft,
    status: SurveyStatus = '生效'
  ): Promise<SurveyResult> {
    const now = Date.now()
    const row: SurveyResult = {
      ...buildSurveyRecord(stationId, draft, status),
      id: createId('surv'),
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.surveyResults], async () => {
      if (status === '生效') {
        await db.surveyResults
          .where('stationId')
          .equals(stationId)
          .modify((existing) => {
            if (existing.status === '生效') {
              existing.status = '存档'
              existing.updatedAt = now
            }
          })
      }
      await db.surveyResults.put(row)
    })
    return row
  }

  async function updateSurvey(id: string, patch: Partial<Omit<SurveyResult, 'id' | 'stationId'>>): Promise<void> {
    await db.surveyResults.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /**
   * 设为生效：同站其余生效成果转存档（同站只留一份生效）。
   * 测量组操作不改动任何测次挂靠，历史测次继续挂在原成果上。
   */
  async function activateSurvey(id: string): Promise<void> {
    const target = surveyById(id)
    if (!target || target.status === '生效') return
    const now = Date.now()
    await db.transaction('rw', [db.surveyResults], async () => {
      await db.surveyResults
        .where('stationId')
        .equals(target.stationId)
        .modify((existing) => {
          if (existing.status === '生效' && existing.id !== id) {
            existing.status = '存档'
            existing.updatedAt = now
          }
        })
      await db.surveyResults.update(id, { status: '生效', updatedAt: now } as never)
    })
  }

  /** 删除成果：引用它的流量侧挂靠退回待挂，由流量测验组重挂 */
  async function removeSurvey(id: string): Promise<number> {
    const detached = await detachLinksForSurvey(id)
    await db.surveyResults.delete(id)
    return detached
  }

  return {
    surveys,
    ready,
    error,
    activeCount,
    stationSurveyStats,
    start,
    surveyById,
    surveysOfStation,
    activeSurveyOfStation,
    surveyForSection,
    buildSurveyRecord,
    createSurvey,
    updateSurvey,
    activateSurvey,
    removeSurvey
  }
})
