import { onMounted, onUnmounted } from "vue";
import sbp from "@sbp/sbp";
import { findState } from "../editor/findState";

// While Settings or History is open, Esc closes it first, so the find Esc
// handlers in the editor and in the dropdown pass Esc on to this handler.
export function isModalOpen(): boolean {
  return (sbp("dez.model/settings/isOpen") as boolean) || (sbp("dez.model/settings/isHistoryOpen") as boolean);
}

export function useKeyboardShortcuts() {
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (sbp("dez.model/settings/isOpen") as boolean) {
        e.preventDefault();
        sbp("dez.model/settings/close");
      } else if (sbp("dez.model/settings/isHistoryOpen") as boolean) {
        e.preventDefault();
        sbp("dez.model/settings/historyClose");
      } else if (findState.open && !e.defaultPrevented) {
        // Esc in the editor was already handled by CodeMirror, which
        // prevents the default even when no binding ran (an open prompt
        // autocomplete takes Esc first). This branch covers focus elsewhere.
        e.preventDefault();
        sbp("dez.editor/closeFind");
      }
      return;
    }

    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    // Cmd/Ctrl+1-9: switch to tab by index
    if (e.key >= "1" && e.key <= "9" && !e.shiftKey) {
      e.preventDefault();
      sbp("dez.model/tabs/switchToIndex", parseInt(e.key) - 1);
      return;
    }

    // Cmd/Ctrl+Shift+[ or ]: cycle tabs
    if (e.shiftKey && (e.key === "[" || e.key === "{")) {
      e.preventDefault();
      sbp("dez.model/tabs/cycle", -1);
      return;
    }
    if (e.shiftKey && (e.key === "]" || e.key === "}")) {
      e.preventDefault();
      sbp("dez.model/tabs/cycle", 1);
      return;
    }

    const modalOpen = isModalOpen();
    switch (e.key.toLowerCase()) {
      case ",":
        e.preventDefault();
        (sbp("dez.model/settings/isOpen") as boolean) ? sbp("dez.model/settings/close") : sbp("dez.model/settings/open");
        break;
      case "h":
        e.preventDefault();
        (sbp("dez.model/settings/isHistoryOpen") as boolean) ? sbp("dez.model/settings/historyClose") : sbp("dez.model/settings/historyOpen");
        break;
      case "n":
        e.preventDefault();
        sbp("dez.model/tabs/create");
        break;
      case "t":
        e.preventDefault();
        sbp("dez.model/tabs/create");
        break;
      case "w":
        e.preventDefault();
        void sbp("dez.controller/closeTab", sbp("dez.model/tabs/activeId"));
        break;
      case "f":
        // This handler treats Ctrl as Mod on macOS too, where CodeMirror
        // uses Ctrl+F (cursor right) in the editor and prevents the default.
        if (e.shiftKey || e.defaultPrevented || modalOpen) break;
        e.preventDefault();
        sbp("dez.editor/openFind");
        break;
      case "g":
        if (!findState.open || modalOpen) break;
        e.preventDefault();
        sbp("dez.editor/selectFindMatch", e.shiftKey ? "previous" : "next");
        break;
    }
  }

  onMounted(() => window.addEventListener("keydown", handleKeydown));
  onUnmounted(() => window.removeEventListener("keydown", handleKeydown));
}
