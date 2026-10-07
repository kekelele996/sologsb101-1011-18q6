/**
 * 冲淤对账（流量测验组侧）：
 * 测次按测次号与断面测量组对账，测次挂上当时生效的大断面成果；
 * 拿垂线起点距和实测水深，与成果同起点距河底高程按测次水位折算的成果水深逐条对比，
 * 差值超过限值标记冲淤偏差；河底高程只用于判偏差，实测水深照旧参与断面流量计算。
 */
import type { LinkStatus } from './survey'

/** 冲淤性质：淤积（实测浅于成果）/ 冲刷（实测深于成果）/ 一致 */
export type ScourSiltKind = '淤积' | '冲刷' | '一致'

/** 垂线逐条水深比对结论 */
export type VerticalCheckVerdict = '合格' | '冲淤偏差' | '不可比'

/** 冲淤偏差水深允许限值（m）：实测水深与成果折算水深相差超过该值即判冲淤偏差 */
export const SCOUR_DEPTH_LIMIT_M = 0.3

/** 同起点距匹配容差（m） */
export const DISTANCE_TOLERANCE_M = 0.005

/** 测次—成果挂靠与冲淤比测结论 */
export interface ScourLink {
  id: string
  /** 所属测站 */
  stationId: string
  /** 对账测次号（两边按测次号对账） */
  measureNo: string
  /** 挂靠的断面测次（流量测验组侧） */
  sectionId: string
  /** 挂靠的大断面成果（测量组那份，挂靠作废时清空，测量组成果本身不动） */
  surveyResultId: string | null
  /** 已挂 / 待挂：测次时间一改，挂靠作废退回待挂，由流量测验组本侧重挂 */
  linkStatus: LinkStatus
  /** 挂靠作废前的成果 id（作废只动流量侧指针，测量组那份成果不动） */
  detachedFromId: string | null
  /** 对账水位（m）：取测次水位，成果水深 = 水位 − 河底高程 */
  stageM: number
  /** 逐条垂线比对结果 */
  checks: ScourVerticalCheck[]
  /** 冲淤偏差垂线条数 */
  deviationCount: number
  /** 参与比对的垂线条数（不含不可比） */
  comparedCount: number
  /** 最大冲淤偏差水深（m，绝对值） */
  maxDeviationM: number
  /** 断面流量（m³/s）：实测水深照旧算出，随垂线 / 测点改动重算 */
  sectionFlowM3s: number
  /** 比测结论：合格 / 冲淤偏差超限 / 待挂成果 / 暂无可比垂线 */
  conclusion: string
  /** 最近对账时间（ISO） */
  checkedAt: string | null
  createdAt: number
  updatedAt: number
}

/** 单条垂线的冲淤比对明细 */
export interface ScourVerticalCheck {
  verticalId: string
  /** 垂线号 */
  no: number
  /** 垂线起点距（m） */
  startDistanceM: number
  /** 实测水深（m，照旧用于流量计算） */
  measuredDepthM: number
  /** 成果河底高程（m，仅判偏差用） */
  bedElevM: number | null
  /** 成果折算水深（m）= 对账水位 − 成果河底高程 */
  surveyDepthM: number | null
  /** 匹配方式：exact 同起点距 / interpolate 相邻内插 / out 超出成果范围 */
  match: 'exact' | 'interpolate' | 'out'
  /** 实测 − 成果（m）：正为冲刷（实测更深）、负为淤积（实测更浅） */
  deviationM: number | null
  /** 冲 / 淤 / 一致 */
  kind: ScourSiltKind
  /** 合格 / 冲淤偏差 / 不可比 */
  verdict: VerticalCheckVerdict
}

/** 按水深差判定冲淤性质 */
export function classifyScourSilt(deviationM: number, limitM = SCOUR_DEPTH_LIMIT_M): ScourSiltKind {
  if (deviationM > limitM) return '冲刷'
  if (deviationM < -limitM) return '淤积'
  return '一致'
}

/** 按水深差判定单垂线结论 */
export function judgeVerticalCheck(deviationM: number | null, limitM = SCOUR_DEPTH_LIMIT_M): VerticalCheckVerdict {
  if (deviationM === null || !Number.isFinite(deviationM)) return '不可比'
  return Math.abs(deviationM) > limitM ? '冲淤偏差' : '合格'
}

/** 汇总比测结论文本 */
export function buildScourConclusion(input: {
  linkStatus: LinkStatus
  comparedCount: number
  deviationCount: number
  maxDeviationM: number
}): string {
  if (input.linkStatus === '待挂') return '待挂成果'
  if (input.comparedCount === 0) return '暂无可比垂线'
  if (input.deviationCount > 0) {
    return `冲淤偏差超限 ${input.deviationCount} 条（最大 ${input.maxDeviationM.toFixed(2)} m），断面已冲淤改样`
  }
  return `比测合格（${input.comparedCount} 条垂线均在限值内）`
}
