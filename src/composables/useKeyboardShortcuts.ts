import { onMounted, onUnmounted } from "vue";
import { useSettingsStore } from "../stores/settingsStore";
import { useTabStore } from "../stores/tabStore";

export function useKeyboardShortcuts() {
  const settingsStore = useSettingsStore();
  const tabStore = useTabStore();

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

    // Cmd/Ctrl+1-9: switch to tab by index
    if (e.key >= "1" && e.key <= "9" && !e.shiftKey) {
      e.preventDefault();
      tabStore.switchToIndex(parseInt(e.key) - 1);
      return;
    }

    // Cmd/Ctrl+Shift+[ or ]: cycle tabs
    if (e.shiftKey && (e.key === "[" || e.key === "{")) {
      e.preventDefault();
      tabStore.cycleTab(-1);
      return;
    }
    if (e.shiftKey && (e.key === "]" || e.key === "}")) {
      e.preventDefault();
      tabStore.cycleTab(1);
      return;
    }

    switch (e.key.toLowerCase()) {
      case ",":
        e.preventDefault();
        settingsStore.settingsOpen ? settingsStore.closeSettings() : settingsStore.openSettings();
        break;
      case "n":
        e.preventDefault();
        tabStore.createTab();
        break;
      case "t":
        e.preventDefault();
        tabStore.createTab();
        break;
      case "w":
        e.preventDefault();
        tabStore.closeTab(tabStore.activeTabId);
        break;
    }
  }

  onMounted(() => window.addEventListener("keydown", handleKeydown));
  onUnmounted(() => window.removeEventListener("keydown", handleKeydown));
}
