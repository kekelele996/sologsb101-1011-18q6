/**
 * 冲淤对账计算：把测次垂线（实测水深）与挂靠的大断面成果
 * （河底高程按测次水位折算成果水深）逐条对比，并汇总比测结论。
 * 纯函数，store 重算、页面展示与数据库播种共用同一套算法。
 */
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { SurveyResult } from '@/types/survey'
import { bedElevationAt } from '@/types/survey'
import {
  buildScourConclusion,
  classifyScourSilt,
  judgeVerticalCheck,
  SCOUR_DEPTH_LIMIT_M,
  type ScourVerticalCheck
} from '@/types/scour'
import { calcMeanVelocity, calcSectionDischarge, round } from '@/utils/flow'

/** 单条垂线比对所需的实测数据 */
export interface ScourVerticalInput {
  vertical: Vertical
  points: Point[]
}

export interface ScourCheckResult {
  checks: ScourVerticalCheck[]
  deviationCount: number
  comparedCount: number
  maxDeviationM: number
  /** 实测水深照旧算出的断面流量（m³/s） */
  sectionFlowM3s: number
  conclusion: string
}

/**
 * 执行一次冲淤比对：
 * - 成果水深 = 测次水位 − 成果同起点距河底高程（精确取值优先，否则相邻点线性内插）；
 * - 偏差 = 实测水深 − 成果水深，正冲负淤，绝对值超限值判冲淤偏差；
 * - 河底高程只判偏差，断面流量始终用实测水深计算。
 */
export function evaluateScour(
  section: Section,
  survey: SurveyResult | null,
  verticalInputs: ScourVerticalInput[],
  limitM = SCOUR_DEPTH_LIMIT_M
): ScourCheckResult {
  const sorted = [...verticalInputs].sort(
    (a, b) => a.vertical.startDistanceM - b.vertical.startDistanceM
  )

  const checks: ScourVerticalCheck[] = sorted.map(({ vertical }) => {
    if (!survey) {
      return {
        verticalId: vertical.id,
        no: vertical.no,
        startDistanceM: vertical.startDistanceM,
        measuredDepthM: round(vertical.depthM, 2),
        bedElevM: null,
        surveyDepthM: null,
        match: 'out',
        deviationM: null,
        kind: '一致',
        verdict: '不可比'
      }
    }
    const bed = bedElevationAt(survey.points, vertical.startDistanceM)
    const surveyDepthM = bed.elevM === null ? null : round(section.stageM - bed.elevM, 3)
    const deviationM = surveyDepthM === null ? null : round(vertical.depthM - surveyDepthM, 3)
    const verdict = judgeVerticalCheck(deviationM, limitM)
    return {
      verticalId: vertical.id,
      no: vertical.no,
      startDistanceM: round(vertical.startDistanceM, 2),
      measuredDepthM: round(vertical.depthM, 2),
      bedElevM: bed.elevM,
      surveyDepthM,
      match: bed.match,
      deviationM,
      kind: deviationM === null ? '一致' : classifyScourSilt(deviationM, limitM),
      verdict
    }
  })

  const comparable = checks.filter((check) => check.verdict !== '不可比')
  const deviationCount = checks.filter((check) => check.verdict === '冲淤偏差').length
  const maxDeviationM = comparable.reduce(
    (max, check) => Math.max(max, Math.abs(check.deviationM ?? 0)),
    0
  )

  // 实测水深照旧参与部分面积法流量计算
  const discharge = calcSectionDischarge(
    sorted.map(({ vertical, points }) => ({
      id: vertical.id,
      no: vertical.no,
      startDistanceM: vertical.startDistanceM,
      depthM: vertical.depthM,
      meanVelocityMs: calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
    }))
  )

  const conclusion = buildScourConclusion({
    linkStatus: survey ? '已挂' : '待挂',
    comparedCount: comparable.length,
    deviationCount,
    maxDeviationM: round(maxDeviationM, 3)
  })

  return {
    checks,
    deviationCount,
    comparedCount: comparable.length,
    maxDeviationM: round(maxDeviationM, 3),
    sectionFlowM3s: discharge.flowM3s,
    conclusion
  }
}
