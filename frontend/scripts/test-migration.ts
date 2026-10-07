/**
 * 升级迁移验证：模拟一个 v2 旧库（无大断面成果归属），由应用代码打开后自动升级到 v3。
 * 场景覆盖：
 *  1) 升级时 scourLinks 表建立，旧测次全部单列为「待挂」（旧库没有成果表，补不上）；
 *  2) 施测成果后「按测次时间补最近成果」：晚于成果的测次自动挂上，早于成果的保持待挂。
 * 运行：npx tsx scripts/test-migration.ts
 */
import 'fake-indexeddb/auto'
import Dexie from 'dexie'

const DB_NAME = 'gbhydrogaug'

async function seedV2(): Promise<void> {
  const old = new Dexie(DB_NAME)
  old.version(2).stores({
    stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
    sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
    verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
    points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
    ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
    compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
  })
  const now = Date.now()
  await old.table('stations').bulkPut([
    { id: 'stn_old1', name: '旧站甲', river: '河甲', catchmentKm2: 100, sectionCode: 'CS-OLD-1', remark: '', createdAt: now, updatedAt: now }
  ])
  await old.table('sections').bulkPut([
    { id: 'sec_old_a', stationId: 'stn_old1', measureNo: '2024-02-001', startDistanceM: 0, stageM: 5, method: '流速仪', measuredAt: '2024-02-01T00:00:00.000Z', createdAt: now, updatedAt: now },
    { id: 'sec_old_b', stationId: 'stn_old1', measureNo: '2023-12-009', startDistanceM: 0, stageM: 4, method: '浮标', measuredAt: '2023-12-01T00:00:00.000Z', createdAt: now, updatedAt: now }
  ])
  await old.close()
}

async function main(): Promise<void> {
  await seedV2()
  const { db, DB_VERSION, createId } = await import('../src/utils/db')
  await db.open()
  console.log('打开后结构版本 =', db.verno, '期望', DB_VERSION)

  let links = await db.table('scourLinks').toArray()
  const allPending = links.every((l: { linkStatus: string }) => l.linkStatus === '待挂')
  console.log('升级补挂（无成果）：', links.length, '条全部待挂 =', allPending)

  // 模拟测量组施测一份 2024-01-10 的生效成果
  const now = Date.now()
  await db.table('surveyResults').put({
    id: createId('surv'),
    stationId: 'stn_old1',
    surveyNo: 'DC-OLD-1',
    measuredAt: '2024-01-10T00:00:00.000Z',
    status: '生效',
    points: [
      { startDistanceM: 0, bedElevM: 1 },
      { startDistanceM: 10, bedElevM: 0 }
    ],
    remark: '',
    createdAt: now,
    updatedAt: now
  })

  // 按测次时间补最近成果（effectiveSurveyAt），并模拟 relink：能补上的挂、补不上的保持待挂
  const { effectiveSurveyAt } = await import('../src/types/survey')
  const sections = await db.table('sections').toArray()
  const surveys = await db.table('surveyResults').toArray()
  let attached = 0
  let pending = 0
  for (const section of sections) {
    const link = links.find((l: { sectionId: string }) => l.sectionId === section.id)
    const survey = effectiveSurveyAt(surveys, section.stationId, section.measuredAt)
    if (survey) {
      link.surveyResultId = survey.id
      link.linkStatus = '已挂'
      attached += 1
    } else {
      pending += 1
    }
  }

  const a = links.find((l: { sectionId: string }) => l.sectionId === 'sec_old_a')
  const b = links.find((l: { sectionId: string }) => l.sectionId === 'sec_old_b')
  console.log('晚于成果的测次 sec_old_a：', a.linkStatus, a.surveyResultId != null, '期望 已挂 true')
  console.log('早于成果的测次 sec_old_b：', b.linkStatus, b.surveyResultId == null, '期望 待挂 true')

  const ok =
    db.verno === DB_VERSION &&
    links.length === 2 &&
    allPending === true &&
    attached === 1 &&
    pending === 1 &&
    a.linkStatus === '已挂' &&
    a.surveyResultId != null &&
    b.linkStatus === '待挂' &&
    b.surveyResultId === null
  console.log(ok ? 'MIGRATION_OK' : 'MIGRATION_FAIL')
  process.exitCode = ok ? 0 : 1
  db.close()
}

void main()
