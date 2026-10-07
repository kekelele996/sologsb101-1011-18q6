/**
 * 大断面成果（断面测量组）：汛后断面常被冲淤改样，
 * 测量组每测一次大断面出一份成果，记施测日期与各起点距河底高程，同站只留一份生效。
 */

/** 成果状态：生效（当前有效）/ 存档（被新成果替代，历史测次仍可挂靠） */
export type SurveyStatus = '生效' | '存档'

/** 测次挂靠状态：已挂上当时生效的成果 / 待挂（测次时间改动后挂靠作废，退回本侧重挂） */
export type LinkStatus = '已挂' | '待挂'

/** 大断面测点：起点距 + 河底高程 */
export interface SurveyPoint {
  /** 起点距（m） */
  startDistanceM: number
  /** 河底高程（m，冻结/绝对基面，不随水位变） */
  bedElevM: number
}

/** 大断面成果：一次大断面测量出一份，同站同一时刻只保留一份生效 */
export interface SurveyResult {
  id: string
  /** 所属测站 */
  stationId: string
  /** 成果编号，如 DC-2024-01 */
  surveyNo: string
  /** 施测日期（ISO，按日期对账） */
  measuredAt: string
  /** 生效 / 存档：同站只留一份生效，新成果生效时旧成果自动转存档 */
  status: SurveyStatus
  /** 断面起点距—河底高程测点（按起点距升序保存） */
  points: SurveyPoint[]
  /** 施测说明（汛前 / 汛后 / 冲淤复测等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 大断面成果表单草稿 */
export interface SurveyDraft {
  surveyNo: string
  measuredAt: string
  remark: string
  points: SurveyPoint[]
}

export function createEmptySurveyDraft(todayIsoDate = new Date().toISOString().slice(0, 10)): SurveyDraft {
  return { surveyNo: '', measuredAt: todayIsoDate, remark: '', points: [] }
}

/** 解析批量粘贴文本：每行「起点距,河底高程」，逗号 / 空格 / 制表符均可作分隔 */
export function parseSurveyPointPaste(text: string): { rows: SurveyPoint[]; errors: string[] } {
  const rows: SurveyPoint[] = []
  const errors: string[] = []
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(/[,，\t;；\s]+/).filter((cell) => cell.length > 0)
    if (cells.length < 2) {
      errors.push(`第 ${index + 1} 行「${line}」缺少起点距或河底高程`)
      return
    }
    const startDistanceM = Number(cells[0])
    const bedElevM = Number(cells[1])
    if (!Number.isFinite(startDistanceM) || startDistanceM < 0) {
      errors.push(`第 ${index + 1} 行起点距应为非负数字`)
      return
    }
    if (!Number.isFinite(bedElevM)) {
      errors.push(`第 ${index + 1} 行河底高程应为数字`)
      return
    }
    rows.push({
      startDistanceM: Number(startDistanceM.toFixed(2)),
      bedElevM: Number(bedElevM.toFixed(3))
    })
  })
  return { rows, errors }
}

/** 成果测点排序并去重（同一起点距保留后者），供录入与保存共用 */
export function normalizeSurveyPoints(points: SurveyPoint[]): SurveyPoint[] {
  const byDistance = new Map<number, SurveyPoint>()
  points.forEach((point) => {
    if (!Number.isFinite(point.startDistanceM) || !Number.isFinite(point.bedElevM)) return
    byDistance.set(Number(point.startDistanceM.toFixed(3)), {
      startDistanceM: Number(point.startDistanceM.toFixed(2)),
      bedElevM: Number(point.bedElevM.toFixed(3))
    })
  })
  return Array.from(byDistance.values()).sort((a, b) => a.startDistanceM - b.startDistanceM)
}

/**
 * 按起点距取成果河底高程：同起点距优先精确取值（容差 0.005 m），
 * 否则在相邻成果点之间线性内插；超出成果范围或测点不足时不可比。
 */
export function bedElevationAt(points: SurveyPoint[], startDistanceM: number): {
  elevM: number | null
  /** exact 同起点距成果点 / interpolate 相邻点内插 / out 不可比 */
  match: 'exact' | 'interpolate' | 'out'
} {
  const sorted = normalizeSurveyPoints(points)
  if (sorted.length === 0) return { elevM: null, match: 'out' }
  const exact = sorted.find((point) => Math.abs(point.startDistanceM - startDistanceM) <= 0.005)
  if (exact) return { elevM: exact.bedElevM, match: 'exact' }
  if (sorted.length < 2) return { elevM: null, match: 'out' }
  if (startDistanceM < sorted[0].startDistanceM || startDistanceM > sorted[sorted.length - 1].startDistanceM) {
    return { elevM: null, match: 'out' }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const left = sorted[index - 1]
    const right = sorted[index]
    if (startDistanceM > left.startDistanceM && startDistanceM < right.startDistanceM) {
      const ratio = (startDistanceM - left.startDistanceM) / (right.startDistanceM - left.startDistanceM)
      return { elevM: Number((left.bedElevM + ratio * (right.bedElevM - left.bedElevM)).toFixed(3)), match: 'interpolate' }
    }
  }
  return { elevM: null, match: 'out' }
}

/** 选某时刻应生效的成果：同站施测日期不晚于该时刻的最近一份 */
export function effectiveSurveyAt(
  surveys: SurveyResult[],
  stationId: string,
  measuredAt: string | number | Date
): SurveyResult | null {
  const target = Date.parse(typeof measuredAt === 'string' ? measuredAt : new Date(measuredAt).toISOString())
  if (!Number.isFinite(target)) return null
  return surveys
    .filter((survey) => survey.stationId === stationId && Date.parse(survey.measuredAt) <= target)
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))[0] ?? null
}
