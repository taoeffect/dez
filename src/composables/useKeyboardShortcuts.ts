import { onMounted, onUnmounted } from "vue";
import { useSettingsStore } from "../stores/settingsStore";

export function useKeyboardShortcuts() {
  const settingsStore = useSettingsStore();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (settingsStore.settingsOpen) {
        e.preventDefault();
        settingsStore.closeSettings();
      }
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    switch (e.key.toLowerCase()) {
      case ",":
        e.preventDefault();
        settingsStore.settingsOpen ? settingsStore.closeSettings() : settingsStore.openSettings();
        break;
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
