/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/**
 * 测次挂靠大断面成果的状态：
 * 待挂（未挂靠或时间改动后作废退回）/ 已挂（挂上当时生效的成果）
 */
export type SectionLinkStatus = '待挂' | '已挂'

/** 断面测次：一次完整的流量测验 */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离 */
  startDistanceM: number
  /** 水位（m） */
  stageM: number
  /** 流速仪 / 浮标 / ADCP */
  method: MeasureMethod
  /** 测流时间 */
  measuredAt: string
  /** 挂靠的大断面成果 id（待挂时为 null） */
  surveyId: string | null
  /** 挂靠状态：测次时间改动导致成果对不上时作废退回待挂 */
  linkStatus: SectionLinkStatus
  createdAt: number
  updatedAt: number
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null
  }
}
