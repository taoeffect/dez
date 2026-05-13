import { defineStore } from 'pinia'
import { ref } from 'vue'

export interface Prompt {
  id: string
  name: string
  content: string
}

export const usePromptsStore = defineStore('prompts', () => {
  const prompts = ref<Prompt[]>([])

  function addPrompt(name: string, content: string): Prompt {
    const prompt: Prompt = {
      id: crypto.randomUUID(),
      name,
      content,
    }
    prompts.value.push(prompt)
    return prompt
  }

  function updatePrompt(id: string, patch: Partial<Omit<Prompt, 'id'>>): boolean {
    const p = prompts.value.find((x) => x.id === id)
    if (!p) return false
    if (patch.name !== undefined) p.name = patch.name
    if (patch.content !== undefined) p.content = patch.content
    return true
  }

  function removePrompt(id: string): boolean {
    const idx = prompts.value.findIndex((p) => p.id === id)
    if (idx < 0) return false
    prompts.value.splice(idx, 1)
    return true
  }

  function getByName(name: string): Prompt | undefined {
    return prompts.value.find((p) => p.name === name)
  }

  function getById(id: string): Prompt | undefined {
    return prompts.value.find((p) => p.id === id)
  }

  return {
    prompts,
    addPrompt,
    updatePrompt,
    removePrompt,
    getByName,
    getById,
  }
})
