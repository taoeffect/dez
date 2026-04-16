import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Message, Role } from '../types/chat'

export const useChatStore = defineStore('chat', () => {
  const messages = ref<Message[]>([])
  const showPillSeparators = ref(true)

  function addMessage(role: Role, content: string) {
    const message: Message = {
      id: crypto.randomUUID(),
      role,
      content,
      timestamp: Date.now(),
    }
    messages.value.push(message)
    return message
  }

  function clearMessages() {
    messages.value = []
  }

  function togglePillSeparators() {
    showPillSeparators.value = !showPillSeparators.value
  }

  return {
    messages,
    showPillSeparators,
    addMessage,
    clearMessages,
    togglePillSeparators,
  }
})
