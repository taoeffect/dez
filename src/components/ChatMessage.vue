<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import type { Message } from '../types/chat'
import { parseMessageContent, type MessageSegment } from '../composables/useMessageParser'
import { useCodeHighlighter } from '../composables/useCodeHighlighter'

const props = defineProps<{
  message: Message
}>()

const { highlight } = useCodeHighlighter()
const renderedSegments = ref<Array<{ type: 'text' | 'code'; content: string }>>([])

async function renderSegments(segments: MessageSegment[]) {
  const result: Array<{ type: 'text' | 'code'; content: string }> = []
  for (const seg of segments) {
    if (seg.type === 'code') {
      const html = await highlight(seg.content, seg.language)
      result.push({ type: 'code', content: html })
    } else {
      result.push({ type: 'text', content: seg.content })
    }
  }
  renderedSegments.value = result
}

onMounted(() => {
  renderSegments(parseMessageContent(props.message.content))
})

watch(() => props.message.content, (content) => {
  renderSegments(parseMessageContent(content))
})
</script>

<template>
  <div class="chat-message" :class="[`chat-message--${message.role}`]">
    <div class="chat-message-content">
      <template v-for="(seg, i) in renderedSegments" :key="i">
        <span v-if="seg.type === 'text'" class="chat-message-text">{{ seg.content }}</span>
        <div v-else class="chat-message-code" v-html="seg.content" />
      </template>
    </div>
  </div>
</template>

<style scoped>
.chat-message {
  padding: 8px 16px;
}

.chat-message--user {
  opacity: 0.9;
}

.chat-message--agent {
  opacity: 1;
}

.chat-message-content {
  white-space: pre-wrap;
  word-wrap: break-word;
  line-height: 1.5;
}

.chat-message-text {
  white-space: pre-wrap;
}

.chat-message-code {
  margin: 8px 0;
  border-radius: 6px;
  overflow-x: auto;
}

.chat-message-code :deep(pre) {
  padding: 12px;
  border-radius: 6px;
  font-size: 14px;
  line-height: 1.4;
  margin: 0;
}
</style>
