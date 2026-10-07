import type { Vertical } from './vertical'

/** 冲淤偏差限值（m）：|实测水深 − 折算水深| 超过该值即标记冲淤偏差 */
export const SILT_LIMIT_M = 0.1

/** 大断面成果点：某起点距处的河底高程 */
export interface SurveyPoint {
  /** 起点距（m） */
  startDistanceM: number
  /** 河底高程（m） */
  bedElevationM: number
}

/**
 * 大断面成果：断面测量组一次大断面测量的成果。
 * 记施测日期与各起点距河底高程；同一测站只留一份生效，
 * 测次挂靠「当时生效」的成果后，河底高程只用于冲淤偏差判定，不参与流量计算。
 */
export interface Survey {
  id: string
  /** 所属测站 */
  stationId: string
  /** 施测日期 */
  surveyedAt: string
  /** 是否当前生效（同站仅一份，新成果生效即顶替旧成果） */
  effective: boolean
  /** 各起点距河底高程（按起点距升序保存） */
  points: SurveyPoint[]
  /** 成果备注（如汛前 / 汛后、施测方式） */
  note: string
  createdAt: number
  updatedAt: number
}

/** 冲淤对账行：一条垂线的实测水深与成果折算水深比对结果 */
export interface SiltRow {
  verticalId: string
  /** 垂线号 */
  no: number
  /** 起点距（m） */
  startDistanceM: number
  /** 实测水深（m）：照旧参与流量计算 */
  measuredDepthM: number
  /** 成果同起点距河底高程（m，端点外按最近点取值） */
  bedElevationM: number
  /** 折算水深（m）= 水位 − 河底高程 */
  expectedDepthM: number
  /** 差值（m）= 实测水深 − 折算水深；正为冲刷偏深、负为淤积偏浅 */
  diffM: number
  /** 是否超限（|差值| > 限值 → 冲淤偏差） */
  overLimit: boolean
}

/** 成果点按起点距升序排序（保存与插值前统一调用） */
export function sortSurveyPoints(points: SurveyPoint[]): SurveyPoint[] {
  return [...points].sort((a, b) => a.startDistanceM - b.startDistanceM)
}

/**
 * 查某起点距处的河底高程：相邻成果点线性插值，
 * 超出成果范围时按最近端点取值；成果为空返回 null。
 */
export function bedElevationAt(points: SurveyPoint[], distanceM: number): number | null {
  const sorted = sortSurveyPoints(points)
  if (sorted.length === 0) return null
  if (distanceM <= sorted[0].startDistanceM) return sorted[0].bedElevationM
  const last = sorted[sorted.length - 1]
  if (distanceM >= last.startDistanceM) return last.bedElevationM
  for (let index = 1; index < sorted.length; index += 1) {
    const right = sorted[index]
    if (distanceM > right.startDistanceM) continue
    const left = sorted[index - 1]
    const span = right.startDistanceM - left.startDistanceM
    if (span <= 0) return right.bedElevationM
    const ratio = (distanceM - left.startDistanceM) / span
    return Number((left.bedElevationM + ratio * (right.bedElevationM - left.bedElevationM)).toFixed(3))
  }
  return last.bedElevationM
}

/**
 * 当时生效的成果：同站成果中施测日期不晚于测流时间的最近一份。
 * 测不到（测次早于本站全部成果）返回 null，调用方按「待挂」处理。
 */
export function findEffectiveSurveyAt<T extends Pick<Survey, 'id' | 'stationId' | 'surveyedAt'>>(
  surveys: T[],
  stationId: string,
  isoTime: string
): T | null {
  const time = Date.parse(isoTime)
  if (!Number.isFinite(time)) return null
  let best: T | null = null
  surveys.forEach((survey) => {
    if (survey.stationId !== stationId) return
    const surveyedTime = Date.parse(survey.surveyedAt)
    if (!Number.isFinite(surveyedTime) || surveyedTime > time) return
    if (!best || surveyedTime > Date.parse(best.surveyedAt)) best = survey
  })
  return best
}

/**
 * 逐垂线对账：拿垂线起点距与实测水深，跟成果同起点距河底高程
 * 按水位折算的水深逐条对，差过限（SILT_LIMIT_M）标冲淤偏差。
 * 实测水深照旧算流量，本函数只产出偏差判定，不改写任何水深。
 */
export function buildSiltRows(
  verticals: Array<Pick<Vertical, 'id' | 'no' | 'startDistanceM' | 'depthM'>>,
  survey: Pick<Survey, 'points'>,
  stageM: number,
  limitM = SILT_LIMIT_M
): SiltRow[] {
  return [...verticals]
    .sort((a, b) => a.startDistanceM - b.startDistanceM)
    .map((vertical) => {
      const bedElevationM = bedElevationAt(survey.points, vertical.startDistanceM)
      const expectedDepthM = bedElevationM === null ? 0 : Number((stageM - bedElevationM).toFixed(2))
      const diffM = Number((vertical.depthM - expectedDepthM).toFixed(2))
      return {
        verticalId: vertical.id,
        no: vertical.no,
        startDistanceM: vertical.startDistanceM,
        measuredDepthM: vertical.depthM,
        bedElevationM: bedElevationM ?? 0,
        expectedDepthM,
        diffM,
        overLimit: Math.abs(diffM) > limitM
      }
    })
}

/** 统计对账行中超限（冲淤偏差）条数 */
export function countSiltOverLimit(rows: SiltRow[]): number {
  return rows.filter((row) => row.overLimit).length
}
