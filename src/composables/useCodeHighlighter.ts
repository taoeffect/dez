import { ref } from 'vue'
import { codeToHtml, type BundledLanguage, bundledLanguages } from 'shiki'

const highlightCache = new Map<string, string>()

export function useCodeHighlighter() {
  const isReady = ref(true)

  async function highlight(code: string, language: string): Promise<string> {
    const cacheKey = `${language}:${code}`
    const cached = highlightCache.get(cacheKey)
    if (cached) return cached

    const lang = language in bundledLanguages ? language as BundledLanguage : 'text'

    try {
      const html = await codeToHtml(code, {
        lang,
        theme: 'github-dark',
      })
      highlightCache.set(cacheKey, html)
      return html
    } catch {
      const escaped = code
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
      const fallback = `<pre><code>${escaped}</code></pre>`
      highlightCache.set(cacheKey, fallback)
      return fallback
    }
  }

  return { highlight, isReady }
}
