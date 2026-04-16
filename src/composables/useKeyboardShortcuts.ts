import { onMounted, onUnmounted } from "vue";

export function useKeyboardShortcuts() {
  function handleKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    switch (e.key.toLowerCase()) {
      case "n":
        e.preventDefault();
        // TODO: new conversation
        break;
      case "t":
        e.preventDefault();
        // TODO: new tab
        break;
      case "w":
        e.preventDefault();
        // TODO: close current tab
        break;
    }
  }

  onMounted(() => window.addEventListener("keydown", handleKeydown));
  onUnmounted(() => window.removeEventListener("keydown", handleKeydown));
}
