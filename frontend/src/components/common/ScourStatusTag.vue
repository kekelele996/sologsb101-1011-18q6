<script setup lang="ts">
/**
 * <ScourStatusTag> 冲淤挂靠状态徽标：
 * 待挂（挂靠作废退回 / 升级补不上成果）、已挂合格、已挂且存在冲淤偏差。
 * 被断面测次列表、垂线页、大断面成果台账、比测与导出页消费。
 */
import { computed } from 'vue'
import { CircleCheckFilled, Link, WarningFilled } from '@element-plus/icons-vue'
import type { LinkStatus } from '@/types/survey'

const props = withDefaults(
  defineProps<{
    linkStatus: LinkStatus
    /** 已挂时的冲淤偏差垂线条数，> 0 显示「冲淤偏差」 */
    deviationCount?: number
    size?: 'default' | 'small'
    /** 是否以文字代替「已挂/待挂」显示结论文案 */
    showText?: boolean
  }>(),
  {
    deviationCount: 0,
    size: 'default',
    showText: false
  }
)

const tone = computed<'pending' | 'deviation' | 'ok'>(() => {
  if (props.linkStatus === '待挂') return 'pending'
  return props.deviationCount > 0 ? 'deviation' : 'ok'
})

const TONE_STYLE = {
  pending: { color: '#b9770e', bg: '#fdf3e3', border: '#d68910', icon: Link, text: '待挂', tip: '挂靠作废或尚无当时生效成果，待流量测验组本侧重挂' },
  deviation: { color: '#c0392b', bg: '#fdecea', border: '#c0392b', icon: WarningFilled, text: '冲淤偏差', tip: '逐条水深对比超限，断面已冲淤改样，请重算流量与比测结论' },
  ok: { color: '#1e8449', bg: '#eaf6ee', border: '#1e8449', icon: CircleCheckFilled, text: '已挂', tip: '已挂上当时生效的大断面成果，逐条水深对比在限值内' }
} as const

const style = computed(() => TONE_STYLE[tone.value])
const label = computed(() => {
  if (props.showText && props.linkStatus === '已挂' && props.deviationCount > 0) return `冲淤偏差 ${props.deviationCount} 条`
  return style.value.text
})
</script>

<template>
  <el-tooltip :content="style.tip" placement="top">
    <span
      class="scour-tag"
      :class="[`is-${size}`, `is-${tone}`]"
      :style="{ color: style.color, backgroundColor: style.bg, borderColor: style.border }"
    >
      <el-icon class="scour-tag__icon"><component :is="style.icon" /></el-icon>
      <span>{{ label }}</span>
    </span>
  </el-tooltip>
</template>

<style scoped>
.scour-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  white-space: nowrap;
}

.scour-tag.is-small {
  padding: 0 8px;
  font-size: 12px;
  line-height: 18px;
}

.scour-tag__icon {
  font-size: 13px;
}
</style>
