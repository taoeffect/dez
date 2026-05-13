import { onMounted, onUnmounted } from "vue";
import sbp from "@sbp/sbp";

export function useKeyboardShortcuts() {
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (sbp("dez.model/settings/isOpen") as boolean) {
        e.preventDefault();
        sbp("dez.controller/closeSettings");
      } else if (sbp("dez.model/settings/isHistoryOpen") as boolean) {
        e.preventDefault();
        sbp("dez.controller/closeHistory");
      }
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    // Cmd/Ctrl+1-9: switch to tab by index
    if (e.key >= "1" && e.key <= "9" && !e.shiftKey) {
      e.preventDefault();
      sbp("dez.controller/switchToIndex", parseInt(e.key) - 1);
      return;
    }

    // Cmd/Ctrl+Shift+[ or ]: cycle tabs
    if (e.shiftKey && (e.key === "[" || e.key === "{")) {
      e.preventDefault();
      sbp("dez.controller/cycleTab", -1);
      return;
    }
    if (e.shiftKey && (e.key === "]" || e.key === "}")) {
      e.preventDefault();
      sbp("dez.controller/cycleTab", 1);
      return;
    }

    switch (e.key.toLowerCase()) {
      case ",":
        e.preventDefault();
        (sbp("dez.model/settings/isOpen") as boolean) ? sbp("dez.controller/closeSettings") : sbp("dez.controller/openSettings");
        break;
      case "h":
        e.preventDefault();
        (sbp("dez.model/settings/isHistoryOpen") as boolean) ? sbp("dez.controller/closeHistory") : sbp("dez.controller/openHistory");
        break;
      case "n":
        e.preventDefault();
        sbp("dez.controller/createTab");
        break;
      case "t":
        e.preventDefault();
        sbp("dez.controller/createTab");
        break;
      case "w":
        e.preventDefault();
        void sbp("dez.controller/closeTab", sbp("dez.model/tabs/activeId"));
        break;
    }
  }

  onMounted(() => window.addEventListener("keydown", handleKeydown));
  onUnmounted(() => window.removeEventListener("keydown", handleKeydown));
}
