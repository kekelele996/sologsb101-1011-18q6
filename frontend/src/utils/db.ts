/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 升级时按 version().stores() 补齐索引
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 比测，
 *   以及断面测量组的大断面成果与流量测验组的冲淤对账挂靠）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { SurveyResult } from '@/types/survey'
import { effectiveSurveyAt } from '@/types/survey'
import type { ScourLink } from '@/types/scour'
import { calcDeviationPct, judgeDeviation } from '@/types/compare'
import { fitPowerCurve } from '@/types/rating'
import { calcMeanVelocity, DEFAULT_WEIGHTS, round } from '@/utils/flow'
import { evaluateScour } from '@/utils/scour'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  compares: Compare[]
  /** 大断面成果（断面测量组） */
  surveyResults: SurveyResult[]
  /** 冲淤对账挂靠与比测结论（流量测验组） */
  scourLinks: ScourLink[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  surveyResults!: Table<SurveyResult, string>
  scourLinks!: Table<ScourLink, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(2).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
      compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
    })

    // v3：新增大断面成果（测量组）与冲淤对账（流量测验组）两张表。
    // 旧数据没记归属：升级时按测次时间补最近一份成果，补不上的单列为待挂。
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
        sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt',
        surveyResults: 'id, stationId, status, measuredAt, surveyNo, updatedAt',
        scourLinks: 'id, stationId, sectionId, surveyResultId, measureNo, linkStatus, updatedAt'
      })
      .upgrade(async (tx) => {
        // 历史字段补齐（仅补缺失项，绝不覆盖旧值，尤其不能覆盖 measuredAt，
        // 否则「按测次时间补最近成果」会对不上）
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: new Date().toISOString() })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: new Date().toISOString() })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              const now = Date.now()
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.entries(defaults()).forEach(([key, value]) => {
                if (row[key] === undefined || row[key] === null) row[key] = value
              })
            })
        }

        // 旧测次没记成果归属：按测次时间补同站最近一份成果；补不上的单列为「待挂」
        const surveys = (await tx.table<SurveyResult, string>('surveyResults').toArray()) as SurveyResult[]
        const sections = (await tx.table<Section, string>('sections').toArray()) as Section[]
        const now = Date.now()
        const legacyLinks: ScourLink[] = sections.map((section) => {
          const survey = effectiveSurveyAt(surveys, section.stationId, section.measuredAt)
          return {
            id: createId('lnk'),
            stationId: section.stationId,
            measureNo: section.measureNo,
            sectionId: section.id,
            surveyResultId: survey ? survey.id : null,
            linkStatus: survey ? '已挂' : '待挂',
            stageM: section.stageM,
            checks: [],
            deviationCount: 0,
            comparedCount: 0,
            maxDeviationM: 0,
            sectionFlowM3s: 0,
            conclusion: survey ? '升级时按测次时间补挂最近成果，请重新比对' : '待挂成果',
            checkedAt: null,
            detachedFromId: null,
            createdAt: now,
            updatedAt: now
          }
        })
        if (legacyLinks.length > 0) {
          await tx.table('scourLinks').bulkPut(legacyLinks)
        }
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 业务表清单（清库、统计、导入事务共用） */
export const BUSINESS_TABLES = [
  db.stations,
  db.sections,
  db.verticals,
  db.points,
  db.ratings,
  db.compares,
  db.surveyResults,
  db.scourLinks
] as const

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedStationBundle {
  station: Omit<Station, 'createdAt' | 'updatedAt'>
  sections: Array<Omit<Section, 'createdAt' | 'updatedAt'>>
  verticals: Array<Omit<Vertical, 'createdAt' | 'updatedAt'>>
  points: Array<Omit<Point, 'createdAt' | 'updatedAt'>>
}

/**
 * 播种演示数据：3 个测站 → 4 个断面测次 → 8 条垂线 → 16 个流速测点，
 * 并据此生成水位流量关系点据与比测记录；同时播种 3 份大断面成果与 4 条冲淤挂靠
 * （含汛后冲刷、汛后淤积各一例，以及 1 个补不上成果的待挂测次），
 * 保证父 → 子 → 孙三层链路与「成果 → 挂靠 → 逐条比对」链路均可点开。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          stationId: 'stn_lh01',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          measuredAt: '2024-06-12T08:30:00.000Z'
        },
        {
          id: 'sec_lh_2407',
          stationId: 'stn_lh01',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          measuredAt: '2024-07-18T09:10:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_lh_1', sectionId: 'sec_lh_2406', no: 1, startDistanceM: 6.5, depthM: 1.4, pointCount: 2, bedNote: '左岸浅滩，砾石河床' },
        { id: 'vrt_lh_2', sectionId: 'sec_lh_2406', no: 2, startDistanceM: 14.0, depthM: 3.2, pointCount: 3, bedNote: '主流，砂卵石' },
        { id: 'vrt_lh_3', sectionId: 'sec_lh_2406', no: 3, startDistanceM: 22.0, depthM: 2.1, pointCount: 2, bedNote: '右岸缓流，细砂' },
        { id: 'vrt_lh_4', sectionId: 'sec_lh_2407', no: 1, startDistanceM: 8.0, depthM: 3.8, pointCount: 3, bedNote: 'ADCP 走航断面，主槽' }
      ],
      points: [
        { id: 'pnt_lh_11', verticalId: 'vrt_lh_1', relativeDepth: 0.2, velocityMs: 0.62, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_12', verticalId: 'vrt_lh_1', relativeDepth: 0.8, velocityMs: 0.48, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_21', verticalId: 'vrt_lh_2', relativeDepth: 0.2, velocityMs: 1.42, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_22', verticalId: 'vrt_lh_2', relativeDepth: 0.6, velocityMs: 1.18, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_23', verticalId: 'vrt_lh_2', relativeDepth: 0.8, velocityMs: 0.96, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_lh_31', verticalId: 'vrt_lh_3', relativeDepth: 0.2, velocityMs: 0.82, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_32', verticalId: 'vrt_lh_3', relativeDepth: 0.8, velocityMs: 0.64, weight: 0.5, durationS: 100 },
        { id: 'pnt_lh_41', verticalId: 'vrt_lh_4', relativeDepth: 0.2, velocityMs: 1.86, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_42', verticalId: 'vrt_lh_4', relativeDepth: 0.6, velocityMs: 1.64, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_lh_43', verticalId: 'vrt_lh_4', relativeDepth: 0.8, velocityMs: 1.32, weight: 1 / 3, durationS: 120 }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2405',
          stationId: 'stn_qj02',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          measuredAt: '2024-05-22T07:50:00.000Z'
        },
        {
          id: 'sec_qj_2408',
          stationId: 'stn_qj02',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          measuredAt: '2024-08-09T06:40:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_qj_1', sectionId: 'sec_qj_2405', no: 1, startDistanceM: 2.4, depthM: 1.1, pointCount: 2, bedNote: '浮标上断面' },
        { id: 'vrt_qj_2', sectionId: 'sec_qj_2405', no: 2, startDistanceM: 6.8, depthM: 1.9, pointCount: 2, bedNote: '浮标中泓' },
        { id: 'vrt_qj_3', sectionId: 'sec_qj_2408', no: 1, startDistanceM: 3.1, depthM: 1.6, pointCount: 3, bedNote: '涨水期，流速仪三点法' },
        { id: 'vrt_qj_4', sectionId: 'sec_qj_2408', no: 2, startDistanceM: 7.6, depthM: 2.4, pointCount: 3, bedNote: '主槽，卵石夹砂' }
      ],
      points: [
        { id: 'pnt_qj_11', verticalId: 'vrt_qj_1', relativeDepth: 0.2, velocityMs: 0.54, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_12', verticalId: 'vrt_qj_1', relativeDepth: 0.8, velocityMs: 0.42, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_21', verticalId: 'vrt_qj_2', relativeDepth: 0.2, velocityMs: 0.88, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_22', verticalId: 'vrt_qj_2', relativeDepth: 0.8, velocityMs: 0.7, weight: 0.5, durationS: 100 },
        { id: 'pnt_qj_31', verticalId: 'vrt_qj_3', relativeDepth: 0.2, velocityMs: 1.06, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_32', verticalId: 'vrt_qj_3', relativeDepth: 0.6, velocityMs: 0.92, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_33', verticalId: 'vrt_qj_3', relativeDepth: 0.8, velocityMs: 0.78, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_41', verticalId: 'vrt_qj_4', relativeDepth: 0.2, velocityMs: 1.34, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_42', verticalId: 'vrt_qj_4', relativeDepth: 0.6, velocityMs: 1.2, weight: 1 / 3, durationS: 100 },
        { id: 'pnt_qj_43', verticalId: 'vrt_qj_4', relativeDepth: 0.8, velocityMs: 1.04, weight: 1 / 3, durationS: 100 }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测；尚未施测大断面成果'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          stationId: 'stn_bs03',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          measuredAt: '2024-06-20T10:05:00.000Z'
        }
      ],
      verticals: [
        { id: 'vrt_bs_1', sectionId: 'sec_bs_2406', no: 1, startDistanceM: 10.0, depthM: 2.6, pointCount: 3, bedNote: 'ADCP 左半断面' },
        { id: 'vrt_bs_2', sectionId: 'sec_bs_2406', no: 2, startDistanceM: 24.0, depthM: 3.4, pointCount: 3, bedNote: 'ADCP 右半断面' }
      ],
      points: [
        { id: 'pnt_bs_11', verticalId: 'vrt_bs_1', relativeDepth: 0.2, velocityMs: 1.22, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_12', verticalId: 'vrt_bs_1', relativeDepth: 0.6, velocityMs: 1.08, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_13', verticalId: 'vrt_bs_1', relativeDepth: 0.8, velocityMs: 0.9, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_21', verticalId: 'vrt_bs_2', relativeDepth: 0.2, velocityMs: 1.46, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_22', verticalId: 'vrt_bs_2', relativeDepth: 0.6, velocityMs: 1.3, weight: 1 / 3, durationS: 120 },
        { id: 'pnt_bs_23', verticalId: 'vrt_bs_2', relativeDepth: 0.8, velocityMs: 1.1, weight: 1 / 3, durationS: 120 }
      ]
    }
  ]

  /* ------------------- 大断面成果（断面测量组） ------------------- */
  // 龙门站：汛前成果已存档，汛后复测成果生效；7 月测次挂汛后成果，实测主槽更深 → 冲刷偏差
  // 青矶站：仅汛前一份生效成果，8 月测次按内插高程折算，实测普遍偏浅 → 淤积偏差
  // 白沙滩站：没有成果，其测次升级/补挂时只能单列为待挂
  const surveySeeds: Array<Omit<SurveyResult, 'createdAt' | 'updatedAt'>> = [
    {
      id: 'surv_lh_01',
      stationId: 'stn_lh01',
      surveyNo: 'DC-LM-2024-01',
      measuredAt: '2024-03-15T02:00:00.000Z',
      status: '存档',
      remark: '汛前大断面，左岸砾石、主槽砂卵石',
      points: [
        { startDistanceM: 0, bedElevM: 4.6 },
        { startDistanceM: 6.5, bedElevM: 4.02 },
        { startDistanceM: 14.0, bedElevM: 2.22 },
        { startDistanceM: 22.0, bedElevM: 3.32 },
        { startDistanceM: 30.0, bedElevM: 3.8 }
      ]
    },
    {
      id: 'surv_lh_02',
      stationId: 'stn_lh01',
      surveyNo: 'DC-LM-2024-02',
      measuredAt: '2024-07-01T02:00:00.000Z',
      status: '生效',
      remark: '汛后冲淤复测，主槽刷深',
      points: [
        { startDistanceM: 0, bedElevM: 4.55 },
        { startDistanceM: 8.0, bedElevM: 2.85 },
        { startDistanceM: 14.0, bedElevM: 2.05 },
        { startDistanceM: 22.0, bedElevM: 3.2 },
        { startDistanceM: 30.0, bedElevM: 3.7 }
      ]
    },
    {
      id: 'surv_qj_01',
      stationId: 'stn_qj02',
      surveyNo: 'DC-QJ-2024-01',
      measuredAt: '2024-04-20T02:00:00.000Z',
      status: '生效',
      remark: '汛前大断面，浮标断面与流速仪断面共用',
      points: [
        { startDistanceM: 0, bedElevM: 2.6 },
        { startDistanceM: 2.4, bedElevM: 2.08 },
        { startDistanceM: 4.0, bedElevM: 2.0 },
        { startDistanceM: 6.8, bedElevM: 1.28 },
        { startDistanceM: 8.5, bedElevM: 1.2 }
      ]
    }
  ]

  // 水位流量关系点据：A 线为龙门站主定线，B 线为青矶站定线
  const ratingSeeds: Array<Omit<Rating, 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a1', stationId: 'stn_lh01', stageM: 4.01, flowM3s: 97.5, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z' },
    { id: 'rat_lh_a2', stationId: 'stn_lh01', stageM: 4.52, flowM3s: 138.7, lineNo: 'A', measureNo: '2024-05-002', measuredAt: '2024-05-16T08:00:00.000Z' },
    { id: 'rat_lh_a3', stationId: 'stn_lh01', stageM: 5.42, flowM3s: 217.2, lineNo: 'A', measureNo: '2024-06-001', measuredAt: '2024-06-12T08:30:00.000Z' },
    { id: 'rat_lh_a4', stationId: 'stn_lh01', stageM: 6.15, flowM3s: 298.5, lineNo: 'A', measureNo: '2024-07-002', measuredAt: '2024-07-18T09:10:00.000Z' },
    { id: 'rat_lh_a5', stationId: 'stn_lh01', stageM: 7.03, flowM3s: 428.1, lineNo: 'A', measureNo: '2024-08-006', measuredAt: '2024-08-21T08:20:00.000Z' },
    { id: 'rat_qj_b1', stationId: 'stn_qj02', stageM: 2.84, flowM3s: 42.3, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z' },
    { id: 'rat_qj_b2', stationId: 'stn_qj02', stageM: 3.18, flowM3s: 56.1, lineNo: 'B', measureNo: '2024-05-003', measuredAt: '2024-05-22T07:50:00.000Z' },
    { id: 'rat_qj_b3', stationId: 'stn_qj02', stageM: 3.72, flowM3s: 78.4, lineNo: 'B', measureNo: '2024-07-001', measuredAt: '2024-07-02T08:10:00.000Z' },
    { id: 'rat_qj_b4', stationId: 'stn_qj02', stageM: 4.36, flowM3s: 115.6, lineNo: 'B', measureNo: '2024-08-004', measuredAt: '2024-08-09T06:40:00.000Z' },
    // C 线：含两个明显偏离点，用于演示超限挂红与偏差分析
    { id: 'rat_bs_c1', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 168.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z' },
    { id: 'rat_bs_c2', stationId: 'stn_bs03', stageM: 5.36, flowM3s: 203.5, lineNo: 'C', measureNo: '2024-06-005', measuredAt: '2024-06-20T10:05:00.000Z' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 325.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 288.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z' }
  ]

  await db.transaction('rw', BUSINESS_TABLES, async () => {
    const stamp = (row: { id: string }): { createdAt: number; updatedAt: number } => ({
      createdAt: now + row.id.length,
      updatedAt: now + row.id.length
    })

    await db.stations.bulkPut(
      stationBundles.map((bundle) => ({ ...bundle.station, ...stamp(bundle.station) }))
    )
    await db.sections.bulkPut(
      stationBundles.flatMap((bundle) =>
        bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
      )
    )
    await db.verticals.bulkPut(
      stationBundles.flatMap((bundle) =>
        bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
      )
    )
    await db.points.bulkPut(
      stationBundles.flatMap((bundle) =>
        bundle.points.map((point) => ({ ...point, ...stamp(point) }))
      )
    )
    await db.ratings.bulkPut(ratingSeeds.map((rating) => ({ ...rating, ...stamp(rating) })))
    await db.surveyResults.bulkPut(surveySeeds.map((survey) => ({ ...survey, ...stamp(survey) })))

    // 比测记录：按定线拟合出曲线流量后计算偏差与判定，保证与页面展示一致
    const compares: Compare[] = []
    const lineGroups = new Map<string, Array<{ stageM: number; flowM3s: number }>>()
    ratingSeeds.forEach((rating) => {
      const list = lineGroups.get(rating.lineNo) ?? []
      list.push({ stageM: rating.stageM, flowM3s: rating.flowM3s })
      lineGroups.set(rating.lineNo, list)
    })
    ratingSeeds.forEach((rating) => {
      const fit = fitPowerCurve(lineGroups.get(rating.lineNo) ?? [], rating.lineNo)
      if (!fit.valid) return
      const predicted = round(fit.a * Math.pow(Math.max(rating.stageM - fit.h0, 1e-6), fit.b), 2)
      const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
      compares.push({
        id: `cmp_${rating.id}`,
        ratingId: rating.id,
        measuredFlow: rating.flowM3s,
        curveFlow: predicted,
        deviationPct,
        verdict: judgeDeviation(deviationPct),
        operator: rating.lineNo === 'C' ? '周渝' : '林昭',
        comparedAt: rating.measuredAt,
        createdAt: now,
        updatedAt: now
      })
    })
    await db.compares.bulkPut(compares)
    if (compares.length === 0) {
      await db.compares.put({
        id: 'cmp_fallback',
        ratingId: 'rat_lh_a1',
        measuredFlow: 97.5,
        curveFlow: 100.2,
        deviationPct: calcDeviationPct(97.5, 100.2),
        verdict: judgeDeviation(calcDeviationPct(97.5, 100.2)),
        operator: '林昭',
        comparedAt: iso,
        createdAt: now,
        updatedAt: now
      })
    }

    // 冲淤挂靠：逐条垂线用实测水深与成果折算水对比，断面流量仍按实测水深计算
    const allSections: Section[] = stationBundles.flatMap((bundle) =>
      bundle.sections.map((section) => ({ ...section, ...stamp(section) }))
    )
    const surveyRecords: SurveyResult[] = surveySeeds.map((survey) => ({ ...survey, ...stamp(survey) }))
    const allVerticals: Vertical[] = stationBundles.flatMap((bundle) =>
      bundle.verticals.map((vertical) => ({ ...vertical, ...stamp(vertical) }))
    )
    const allPoints: Point[] = stationBundles.flatMap((bundle) =>
      bundle.points.map((point) => ({ ...point, ...stamp(point) }))
    )
    const sectionSurvey: Record<string, string | null> = {
      sec_lh_2406: 'surv_lh_01',
      sec_lh_2407: 'surv_lh_02',
      sec_qj_2405: 'surv_qj_01',
      sec_qj_2408: 'surv_qj_01',
      sec_bs_2406: null
    }
    const scourLinks: ScourLink[] = allSections.map((section) => {
      const surveyId = sectionSurvey[section.id] ?? null
      const survey = surveyRecords.find((item) => item.id === surveyId) ?? null
      const verticalsOf = allVerticals.filter((vertical) => vertical.sectionId === section.id)
      const inputs = verticalsOf.map((vertical) => ({
        vertical,
        points: allPoints.filter((point) => point.verticalId === vertical.id)
      }))
      const result = evaluateScour(section, survey, inputs)
      return {
        id: `lnk_${section.id}`,
        stationId: section.stationId,
        measureNo: section.measureNo,
        sectionId: section.id,
        surveyResultId: survey ? survey.id : null,
        linkStatus: survey ? '已挂' : '待挂',
        stageM: section.stageM,
        checks: result.checks,
        deviationCount: result.deviationCount,
        comparedCount: result.comparedCount,
        maxDeviationM: result.maxDeviationM,
        sectionFlowM3s: result.sectionFlowM3s,
        conclusion: result.conclusion,
        checkedAt: section.measuredAt,
        detachedFromId: null,
        createdAt: now,
        updatedAt: now
      }
    })
    await db.scourLinks.bulkPut(scourLinks)
  })
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction('rw', BUSINESS_TABLES, async () => {
    await Promise.all([
      db.stations.clear(),
      db.sections.clear(),
      db.verticals.clear(),
      db.points.clear(),
      db.ratings.clear(),
      db.compares.clear(),
      db.surveyResults.clear(),
      db.scourLinks.clear()
    ])
  })
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, ratings, compares, surveyResults, scourLinks] = await Promise.all([
    db.stations.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.compares.count(),
    db.surveyResults.count(),
    db.scourLinks.count()
  ])
  return { stations, sections, verticals, points, ratings, compares, surveyResults, scourLinks }
}

/**
 * 测次时间改动后，把挂靠在该测次上的成果退回「待挂」（流量测验组本侧重挂）。
 * 测量组那份成果本身不动：只清流量侧的挂靠指针，并记下原挂靠成果供提示。
 */
export async function detachLinksForSection(sectionId: string): Promise<number> {
  const now = Date.now()
  let changed = 0
  await db.scourLinks.where('sectionId').equals(sectionId).modify((link) => {
    if (link.linkStatus === '待挂' && link.surveyResultId === null) return
    changed += 1
    link.detachedFromId = link.surveyResultId ?? link.detachedFromId
    link.surveyResultId = null
    link.linkStatus = '待挂'
    link.stageM = 0
    link.checks = []
    link.deviationCount = 0
    link.comparedCount = 0
    link.maxDeviationM = 0
    link.sectionFlowM3s = 0
    link.conclusion = '待挂成果'
    link.checkedAt = null
    link.updatedAt = now
  })
  return changed
}

/** 删除某测次的挂靠记录（测次删除时级联） */
export async function deleteLinksForSection(sectionId: string): Promise<void> {
  await db.scourLinks.where('sectionId').equals(sectionId).delete()
}

/** 删除测站时级联清理其成果与挂靠 */
export async function deleteSurveyDataForStation(stationId: string): Promise<void> {
  await db.transaction('rw', [db.surveyResults, db.scourLinks], async () => {
    await db.scourLinks.where('stationId').equals(stationId).delete()
    await db.surveyResults.where('stationId').equals(stationId).delete()
  })
}

/** 测量组删除成果后，引用它的挂靠退回待挂（成果原件已删，挂靠无法维持） */
export async function detachLinksForSurvey(surveyResultId: string): Promise<number> {
  const now = Date.now()
  let changed = 0
  await db.scourLinks.where('surveyResultId').equals(surveyResultId).modify((link) => {
    changed += 1
    link.detachedFromId = link.surveyResultId
    link.surveyResultId = null
    link.linkStatus = '待挂'
    link.checks = []
    link.deviationCount = 0
    link.comparedCount = 0
    link.maxDeviationM = 0
    link.conclusion = '原挂靠成果已删除，请重新挂靠'
    link.checkedAt = null
    link.updatedAt = now
  })
  return changed
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
