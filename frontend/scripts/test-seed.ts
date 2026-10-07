import 'fake-indexeddb/auto'
import { db, resetDatabase } from '../src/utils/db'

await resetDatabase()
const links = await db.scourLinks.toArray()
const bySection = Object.fromEntries(links.map((l) => [l.sectionId, l]))
const check = (id: string) => {
  const l = bySection[id]
  console.log(id, l.linkStatus, '偏差', l.deviationCount, '/ 可比', l.comparedCount,
    '最大', l.maxDeviationM, '流量', l.sectionFlowM3s, '|', l.conclusion)
  return l
}
const lh06 = check('sec_lh_2406')
const lh07 = check('sec_lh_2407')
const qj05 = check('sec_qj_2405')
const qj08 = check('sec_qj_2408')
const bs = check('sec_bs_2406')

const kinds = (l: { checks: Array<{ kind: string; verdict: string; deviationM: number | null }> }) =>
  l.checks.map((c) => `${c.kind}:${c.verdict}:${c.deviationM}`)
console.log('lh07 明细', kinds(lh07))
console.log('qj08 明细', kinds(qj08))

const ok =
  lh06.linkStatus === '已挂' && lh06.deviationCount === 0 && lh06.sectionFlowM3s > 0 &&
  lh07.linkStatus === '已挂' && lh07.deviationCount === 1 &&
  lh07.checks[0].kind === '冲刷' && lh07.sectionFlowM3s > 0 &&
  qj05.linkStatus === '已挂' && qj05.deviationCount === 0 &&
  qj08.linkStatus === '已挂' && qj08.deviationCount === 2 &&
  qj08.checks.every((c: { kind: string }) => c.kind === '淤积') &&
  bs.linkStatus === '待挂' && bs.surveyResultId === null && bs.conclusion === '待挂成果'
console.log(ok ? 'SEED_OK' : 'SEED_FAIL')
process.exitCode = ok ? 0 : 1
db.close()
