/**
 * 冲淤对账 store（流量测验组侧）：
 * 管测次—大断面成果的挂靠与逐条垂线冲淤比对。测次时间一改，挂靠作废退回待挂，
 * 由本侧重新挂靠；测量组那份成果不动。实测水深照旧算断面流量，河底高程只用于判偏差。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  db,
  createId,
  deleteLinksForSection,
  detachLinksForSection,
  watchTable
} from '@/utils/db'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { ScourLink } from '@/types/scour'
import { evaluateScour } from '@/utils/scour'
import { effectiveSurveyAt } from '@/types/survey'
import type { SurveyResult } from '@/types/survey'

/** 自动重挂结果，供页面提示 */
export interface AutoRelinkResult {
  ok: boolean
  message: string
  link: ScourLink | null
}

export const useScourStore = defineStore('scour', () => {
  const links = ref<ScourLink[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)

  /** 垂线 / 测点改动后的去抖重算计时器（按测次隔离） */
  const recomputeTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 测次挂靠状态版本号：作废 / 重挂时自增，使排队中的旧重算任务失效，防止竞态覆盖 */
  const recomputeTokens = new Map<string, number>()

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<ScourLink>(() => db.scourLinks).subscribe((rows) => {
      links.value = rows
      ready.value = true
      error.value = null
    })
  }

  /** 测次 → 挂靠记录（一个测次一条） */
  const linkBySection = computed<Record<string, ScourLink>>(() => {
    const map: Record<string, ScourLink> = {}
    links.value.forEach((link: ScourLink) => {
      map[link.sectionId] = link
    })
    return map
  })

  const linkOfSection = (sectionId: string | null | undefined): ScourLink | null =>
    sectionId ? linkBySection.value[sectionId] ?? null : null

  /** 待挂队列：时间改动退回 / 升级补不上成果 / 尚未挂靠的测次 */
  const pendingLinks = computed<ScourLink[]>(() =>
    links.value
      .filter((link) => link.linkStatus === '待挂')
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )

  /** 已挂但比对出冲淤偏差的测次 */
  const deviationLinks = computed<ScourLink[]>(() =>
    links.value
      .filter((link) => link.linkStatus === '已挂' && link.deviationCount > 0)
      .sort((a, b) => b.maxDeviationM - a.maxDeviationM)
  )

  const stats = computed(() => ({
    total: links.value.length,
    attached: links.value.filter((link) => link.linkStatus === '已挂').length,
    pending: pendingLinks.value.length,
    deviation: deviationLinks.value.length
  }))

  /** 读取重算所需的测次、垂线、测点与成果 */
  async function loadRecomputeContext(sectionId: string): Promise<{
    section: Section | null
    survey: SurveyResult | null
    verticalInputs: Array<{ vertical: Vertical; points: Point[] }>
  }> {
    const section = await db.sections.get(sectionId)
    if (!section) return { section: null, survey: null, verticalInputs: [] }
    const verticalRows = await db.verticals.where('sectionId').equals(sectionId).toArray()
    const verticalInputs: Array<{ vertical: Vertical; points: Point[] }> = []
    for (const vertical of verticalRows) {
      const points = await db.points.where('verticalId').equals(vertical.id).toArray()
      verticalInputs.push({ vertical, points })
    }
    const link = linkBySection.value[sectionId]
    const survey = link?.surveyResultId ? await db.surveyResults.get(link.surveyResultId) : undefined
    return { section, survey: survey ?? null, verticalInputs }
  }

  /**
   * 重算单个已挂测次的逐条比对、断面流量与比测结论并落库。
   * 待挂测次不重算（等重挂后再算）；记录被删则静默返回。
   * token 用于使作废 / 重挂前排入队的旧重算任务失效，避免竞态覆盖。
   */
  async function recomputeSection(sectionId: string, token?: number): Promise<ScourLink | null> {
    if (token !== undefined && recomputeTokens.get(sectionId) !== token) return null
    const link = linkBySection.value[sectionId]
    if (!link || link.linkStatus !== '已挂' || !link.surveyResultId) return link ?? null
    const { section, survey, verticalInputs } = await loadRecomputeContext(sectionId)
    if (!section) return link
    // 落库前再从库中确认挂靠未变（作废 / 改挂后不覆盖）
    const current = await db.scourLinks.where('sectionId').equals(sectionId).first()
    if (
      !current ||
      current.linkStatus !== '已挂' ||
      current.surveyResultId !== link.surveyResultId ||
      (token !== undefined && recomputeTokens.get(sectionId) !== token)
    ) {
      return current ?? null
    }
    const result = evaluateScour(section, survey, verticalInputs)
    const now = Date.now()
    const next: ScourLink = {
      ...link,
      stationId: section.stationId,
      measureNo: section.measureNo,
      stageM: section.stageM,
      checks: result.checks,
      deviationCount: result.deviationCount,
      comparedCount: result.comparedCount,
      maxDeviationM: result.maxDeviationM,
      sectionFlowM3s: result.sectionFlowM3s,
      conclusion: result.conclusion,
      checkedAt: new Date().toISOString(),
      updatedAt: now
    }
    await db.scourLinks.put(next)
    return next
  }

  /** 重算全部已挂测次（导入备份 / 批量刷新后调用） */
  async function recomputeAll(): Promise<number> {
    const targets = links.value.filter((link) => link.linkStatus === '已挂' && link.surveyResultId)
    for (const link of targets) {
      await recomputeSection(link.sectionId)
    }
    return targets.length
  }

  /** 垂线 / 测点录入后去抖触发所属测次重算，保证断面流量与比测结论跟着走 */
  function scheduleRecompute(sectionId: string): void {
    const existing = recomputeTimers.get(sectionId)
    if (existing) clearTimeout(existing)
    const token = (recomputeTokens.get(sectionId) ?? 0) + 1
    recomputeTokens.set(sectionId, token)
    const timer = setTimeout(() => {
      recomputeTimers.delete(sectionId)
      void recomputeSection(sectionId, token)
    }, 350)
    recomputeTimers.set(sectionId, timer)
  }

  /** 作废旧排队任务：挂靠作废或改挂时调用 */
  function invalidateRecompute(sectionId: string): void {
    const timer = recomputeTimers.get(sectionId)
    if (timer) {
      clearTimeout(timer)
      recomputeTimers.delete(sectionId)
    }
    recomputeTokens.set(sectionId, (recomputeTokens.get(sectionId) ?? 0) + 1)
  }

  /** 新建测次后补一条待挂记录（流量测验组侧先登记，等待挂成果） */
  async function ensureLinkForSection(section: Section): Promise<ScourLink> {
    const existing = linkBySection.value[section.id]
    if (existing) return existing
    const now = Date.now()
    const row: ScourLink = {
      id: createId('lnk'),
      stationId: section.stationId,
      measureNo: section.measureNo,
      sectionId: section.id,
      surveyResultId: null,
      linkStatus: '待挂',
      detachedFromId: null,
      stageM: section.stageM,
      checks: [],
      deviationCount: 0,
      comparedCount: 0,
      maxDeviationM: 0,
      sectionFlowM3s: 0,
      conclusion: '待挂成果',
      checkedAt: null,
      createdAt: now,
      updatedAt: now
    }
    await db.scourLinks.put(row)
    return row
  }

  /**
   * 挂靠指定成果并立即逐条比对、重算断面流量与比测结论。
   */
  async function relinkSection(sectionId: string, surveyResultId: string): Promise<ScourLink | null> {
    const section = await db.sections.get(sectionId)
    const survey = await db.surveyResults.get(surveyResultId)
    if (!section || !survey) return linkBySection.value[sectionId] ?? null
    const verticalRows = await db.verticals.where('sectionId').equals(sectionId).toArray()
    const verticalInputs: Array<{ vertical: Vertical; points: Point[] }> = []
    for (const vertical of verticalRows) {
      const points = await db.points.where('verticalId').equals(vertical.id).toArray()
      verticalInputs.push({ vertical, points })
    }
    const result = evaluateScour(section, survey, verticalInputs)
    const existing = linkBySection.value[sectionId]
    invalidateRecompute(sectionId)
    const now = Date.now()
    const row: ScourLink = {
      id: existing?.id ?? createId('lnk'),
      stationId: section.stationId,
      measureNo: section.measureNo,
      sectionId: section.id,
      surveyResultId: survey.id,
      linkStatus: '已挂',
      detachedFromId: existing?.detachedFromId ?? null,
      stageM: section.stageM,
      checks: result.checks,
      deviationCount: result.deviationCount,
      comparedCount: result.comparedCount,
      maxDeviationM: result.maxDeviationM,
      sectionFlowM3s: result.sectionFlowM3s,
      conclusion: result.conclusion,
      checkedAt: new Date().toISOString(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    // 新挂靠用新 token，排队中的旧重算任务不会覆盖它
    recomputeTokens.set(sectionId, (recomputeTokens.get(sectionId) ?? 0) + 1)
    await db.scourLinks.put(row)
    return row
  }

  /**
   * 按测次时间自动重挂：施测日期不晚于测次时间的最近一份成果（升级补挂 / 一键重挂共用）。
   * 补不上时保持待挂并给出说明，交人工选择。
   */
  async function autoRelinkSection(sectionId: string): Promise<AutoRelinkResult> {
    const section = await db.sections.get(sectionId)
    const current = linkBySection.value[sectionId]
    if (!section) {
      return { ok: false, message: '测次不存在，无法挂靠', link: current ?? null }
    }
    const stationSurveys = await db.surveyResults.where('stationId').equals(section.stationId).toArray()
    const survey = effectiveSurveyAt(stationSurveys, section.stationId, section.measuredAt)
    if (!survey) {
      await ensureLinkForSection(section)
      return {
        ok: false,
        message: '该测次时间之前没有任何大断面成果，请先在成果台账施测或手工选择成果',
        link: linkBySection.value[sectionId] ?? (await ensureLinkForSection(section))
      }
    }
    const link = await relinkSection(sectionId, survey.id)
    return {
      ok: true,
      message: `已按测次时间挂上成果「${survey.surveyNo}」（${survey.status}，${survey.measuredAt.slice(0, 10)}）`,
      link: link as ScourLink
    }
  }

  /** 测次时间改动：挂靠作废退回待挂（测量组成果不动），并使排队中的重算失效 */
  async function detachSection(sectionId: string): Promise<number> {
    invalidateRecompute(sectionId)
    return detachLinksForSection(sectionId)
  }

  async function removeForSection(sectionId: string): Promise<void> {
    await deleteLinksForSection(sectionId)
  }

  /** 待挂队列一键重挂：逐条按测次时间补最近成果，补不上的继续单列 */
  async function autoRelinkAllPending(): Promise<{ attached: number; stillPending: number }> {
    const pending = pendingLinks.value
    let attached = 0
    for (const link of pending) {
      const result = await autoRelinkSection(link.sectionId)
      if (result.ok) attached += 1
    }
    return { attached, stillPending: pending.length - attached }
  }

  return {
    links,
    ready,
    error,
    stats,
    pendingLinks,
    deviationLinks,
    start,
    linkOfSection,
    ensureLinkForSection,
    recomputeSection,
    recomputeAll,
    scheduleRecompute,
    relinkSection,
    autoRelinkSection,
    autoRelinkAllPending,
    detachSection,
    removeForSection
  }
})
