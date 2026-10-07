/**
 * 大断面成果 store（断面测量组侧）：维护成果台账、生效标记与测次挂靠。
 * - 同站只留一份生效：设为生效时同事物内顶替旧成果
 * - 测次挂靠在流量测验组本侧（断面测次页）发起，本 store 只改测次的挂靠字段，不动成果
 * - 测次时间改动导致成果对不上时作废退回待挂
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Survey, SurveyPoint } from '@/types/survey'
import { findEffectiveSurveyAt, sortSurveyPoints } from '@/types/survey'
import type { Section } from '@/types/section'
import { useRatingStore } from '@/stores/ratingStore'

/** 成果录入草稿（新增/编辑表单共享结构） */
export interface SurveyDraft {
  surveyedAt: string
  note: string
  points: SurveyPoint[]
}

export function createEmptySurveyDraft(): SurveyDraft {
  return {
    surveyedAt: new Date().toISOString().slice(0, 16),
    note: '',
    points: [
      { startDistanceM: 0, bedElevationM: 0 },
      { startDistanceM: 10, bedElevationM: 0 }
    ]
  }
}

export const useSurveyStore = defineStore('survey', () => {
  const surveys = ref<Survey[]>([])
  /** 订阅测次表：挂靠状态、待挂清单与作废扫描共用 */
  const sections = ref<Section[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Survey>(() => db.surveys).subscribe((rows) => {
      surveys.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Section>(() => db.sections).subscribe((rows) => {
      sections.value = rows
    })
  }

  /** 某测站的大断面成果（按施测日期倒序） */
  function surveysOfStation(stationId: string | null | undefined): Survey[] {
    if (!stationId) return []
    return surveys.value
      .filter((survey) => survey.stationId === stationId)
      .sort((a, b) => Date.parse(b.surveyedAt) - Date.parse(a.surveyedAt))
  }

  const surveyById = (id: string | null | undefined): Survey | null =>
    id ? surveys.value.find((survey) => survey.id === id) ?? null : null

  /** 某测站当前生效的成果（同站只留一份） */
  function effectiveSurveyOf(stationId: string | null | undefined): Survey | null {
    if (!stationId) return null
    return surveys.value.find((survey) => survey.stationId === stationId && survey.effective) ?? null
  }

  /** 测次当时应挂的成果（施测日期不晚于测流时间的最近一份） */
  function matchForSection(section: Pick<Section, 'stationId' | 'measuredAt'>): Survey | null {
    return findEffectiveSurveyAt(surveys.value, section.stationId, section.measuredAt)
  }

  /** 已挂测次的挂靠是否仍然对得上（测次时间改动后应为 false → 作废退回待挂） */
  function isLinkStale(section: Section): boolean {
    if (section.linkStatus !== '已挂' || !section.surveyId) return false
    return matchForSection(section)?.id !== section.surveyId
  }

  /** 全部待挂测次（升级补不上成果的也在这里单列） */
  const pendingSections = computed<Section[]>(() =>
    sections.value
      .filter((section) => section.linkStatus === '待挂')
      .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  )

  /** 成果 id → 已挂测次数（成果台账回显用） */
  const linkedCounts = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = {}
    sections.value.forEach((section) => {
      if (section.linkStatus === '已挂' && section.surveyId) {
        counts[section.surveyId] = (counts[section.surveyId] ?? 0) + 1
      }
    })
    return counts
  })

  /* ------------------------------ 成果台账 ------------------------------ */

  async function createSurvey(
    payload: Omit<Survey, 'id' | 'createdAt' | 'updatedAt' | 'points' | 'effective'> & {
      points: SurveyPoint[]
      effective?: boolean
    }
  ): Promise<Survey> {
    const now = Date.now()
    // 本站首份成果自动生效，其余默认不生效（同站只留一份生效）
    const effective = payload.effective ?? surveysOfStation(payload.stationId).length === 0
    const row: Survey = {
      ...payload,
      points: sortSurveyPoints(payload.points),
      effective,
      id: createId('svy'),
      createdAt: now,
      updatedAt: now
    }
    await db.transaction('rw', [db.surveys], async () => {
      if (effective) {
        await db.surveys.where('stationId').equals(payload.stationId).modify({ effective: false })
      }
      await db.surveys.put(row)
    })
    return row
  }

  async function updateSurvey(
    id: string,
    patch: Partial<Omit<Survey, 'id' | 'stationId' | 'createdAt' | 'updatedAt'>>
  ): Promise<void> {
    const next = { ...patch, updatedAt: Date.now() }
    if (patch.points) next.points = sortSurveyPoints(patch.points)
    await db.surveys.update(id, next as never)
  }

  /** 删除成果：挂到该成果的测次一并作废退回待挂 */
  async function removeSurvey(id: string): Promise<void> {
    await db.transaction('rw', [db.surveys, db.sections], async () => {
      const now = Date.now()
      await db.sections
        .where('surveyId')
        .equals(id)
        .modify((section) => {
          section.surveyId = null
          section.linkStatus = '待挂'
          section.updatedAt = now
        })
      await db.surveys.delete(id)
    })
  }

  /** 设为生效：同站其余成果同事物内取消生效 */
  async function setEffective(id: string): Promise<void> {
    const target = surveyById(id)
    if (!target) return
    await db.transaction('rw', [db.surveys], async () => {
      await db.surveys.where('stationId').equals(target.stationId).modify({ effective: false })
      await db.surveys.update(id, { effective: true, updatedAt: Date.now() } as never)
    })
  }

  /* ------------------------------ 测次挂靠 ------------------------------ */

  /**
   * 挂靠后跟着重算：断面流量由垂线实测水深实时派生（照旧），
   * 这里按测站重刷比测记录与判定结论，保证对账状态变化后结论同步。
   */
  async function refreshComparesOfStation(stationId: string): Promise<void> {
    const ratingStore = useRatingStore()
    const lineNos = Array.from(
      new Set(ratingStore.ratings.filter((rating) => rating.stationId === stationId).map((rating) => rating.lineNo))
    )
    for (const lineNo of lineNos) {
      await ratingStore.rebuildCompares(lineNo)
    }
  }

  /** 流量测验组本侧重挂：把测次挂到指定成果（只改测次侧，成果不动） */
  async function linkSection(sectionId: string, surveyId: string): Promise<void> {
    const section = sections.value.find((item) => item.id === sectionId)
    await db.sections.update(sectionId, {
      surveyId,
      linkStatus: '已挂',
      updatedAt: Date.now()
    } as never)
    if (section) await refreshComparesOfStation(section.stationId)
  }

  /** 按测次时间自动挂靠当时生效的成果；测不到成果保持待挂，返回是否挂上 */
  async function autoLinkSection(sectionId: string): Promise<boolean> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section) return false
    const match = matchForSection(section)
    if (!match) return false
    await linkSection(sectionId, match.id)
    return true
  }

  /** 退回待挂：作废当前挂靠（成果侧不动） */
  async function unlinkSection(sectionId: string): Promise<void> {
    const section = sections.value.find((item) => item.id === sectionId)
    await db.sections.update(sectionId, {
      surveyId: null,
      linkStatus: '待挂',
      updatedAt: Date.now()
    } as never)
    if (section) await refreshComparesOfStation(section.stationId)
  }

  /** 测次时间改动后调用：挂靠对不上则作废退回待挂，返回是否作废 */
  async function voidLinkIfMismatch(sectionId: string): Promise<boolean> {
    const section = sections.value.find((item) => item.id === sectionId)
    if (!section || !isLinkStale(section)) return false
    await unlinkSection(sectionId)
    return true
  }

  /** 全量扫描：把所有对不上的挂靠作废退回待挂（页面挂载时幂等调用） */
  async function voidStaleLinks(): Promise<number> {
    const stale = sections.value.filter((section) => isLinkStale(section))
    for (const section of stale) {
      await unlinkSection(section.id)
    }
    return stale.length
  }

  return {
    surveys,
    sections,
    ready,
    error,
    pendingSections,
    linkedCounts,
    start,
    surveysOfStation,
    surveyById,
    effectiveSurveyOf,
    matchForSection,
    isLinkStale,
    createSurvey,
    updateSurvey,
    removeSurvey,
    setEffective,
    linkSection,
    autoLinkSection,
    unlinkSection,
    voidLinkIfMismatch,
    voidStaleLinks
  }
})
