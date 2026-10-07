/**
 * 联动验证：改测次时间 → 挂靠作废退回待挂（测量组成果不动）→ 流量侧重挂 →
 * 改测点流速触发去抖重算（实测水深照常算流量，冲淤偏差条数只取决于水深对比）。
 * 运行：npx tsx scripts/test-relink.ts
 */
import 'fake-indexeddb/auto'
import { createPinia, setActivePinia } from 'pinia'
import { db, resetDatabase } from '../src/utils/db'
import { useSectionStore } from '../src/stores/sectionStore'
import { useScourStore } from '../src/stores/scourStore'

setActivePinia(createPinia())
await resetDatabase()
const sectionStore = useSectionStore()
const scourStore = useScourStore()
scourStore.start()
sectionStore.start()
await new Promise((resolve) => setTimeout(resolve, 150))

// 1) 改测次时间 → 挂靠作废退回待挂，测量组成果不动
await sectionStore.updateSection('sec_qj_2408', { measuredAt: '2030-01-01T00:00:00.000Z' })
await new Promise((resolve) => setTimeout(resolve, 150))
const detached = scourStore.linkOfSection('sec_qj_2408')
const surveyStillExists = (await db.surveyResults.get('surv_qj_01')) != null
console.log('改时间后：', detached?.linkStatus, 'surveyResultId=', detached?.surveyResultId, '原成果=', detached?.detachedFromId)

// 2) 流量侧手工重挂
await scourStore.relinkSection('sec_qj_2408', 'surv_qj_01')
const relinked = scourStore.linkOfSection('sec_qj_2408')
console.log('重挂后：', relinked?.linkStatus, '偏差', relinked?.deviationCount, '流量', relinked?.sectionFlowM3s)

// 3) 改测点流速 → 去抖重算断面流量（冲淤偏差条数不变）
const before = relinked!.sectionFlowM3s
const firstPoint = (await db.points.where('verticalId').equals('vrt_qj_3').toArray())[0]
await sectionStore.updatePoint(firstPoint.id, { velocityMs: 5 })
await new Promise((resolve) => setTimeout(resolve, 600))
const after = scourStore.linkOfSection('sec_qj_2408')
console.log('改测点流速：流量', before, '->', after?.sectionFlowM3s, '偏差条数', after?.deviationCount)

const pass =
  detached?.linkStatus === '待挂' &&
  detached.surveyResultId === null &&
  detached.detachedFromId === 'surv_qj_01' &&
  surveyStillExists &&
  after?.linkStatus === '已挂' &&
  after.surveyResultId === 'surv_qj_01' &&
  after.deviationCount === 2 &&
  after.sectionFlowM3s !== before
console.log(pass ? 'RELINK_OK' : 'RELINK_FAIL')
process.exitCode = pass ? 0 : 1
db.close()
