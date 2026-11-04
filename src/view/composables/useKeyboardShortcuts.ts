import { onMounted, onUnmounted } from "vue";
import sbp from "@sbp/sbp";
import { findState } from "../editor/findState";

// While Settings or History is open, Esc closes it first, so the find Esc
// handlers in the editor and in the dropdown pass Esc on to this handler.
// The find selectors also do nothing while one of them covers the editor.
export function isModalOpen(): boolean {
  return (sbp("dez.model/settings/isOpen") as boolean) || (sbp("dez.model/settings/isHistoryOpen") as boolean);
}

// The Mod shortcuts below are also native menu items, which call the same
// selectors. On Linux a menu accelerator takes the key before this handler
// sees it, so context checks (a modal is open, find is closed, …) belong in
// the selector, not here. A selector that returns false did nothing, so the
// key keeps its default action.
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

    switch (e.key.toLowerCase()) {
      case ",":
        e.preventDefault();
        sbp("dez.model/settings/toggle");
        break;
      case "h":
        e.preventDefault();
        sbp("dez.model/settings/historyToggle");
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
      case "s":
        e.preventDefault();
        void sbp("dez.controller/saveConversationAs", sbp("dez.model/tabs/activeId"));
        break;
      case "f":
        // On macOS, Ctrl+F is emacs-style "forward char" in CodeMirror and in
        // native text fields, so only Cmd+F opens find there. CodeMirror does
        // not prevent the default when the cursor cannot move (doc end), so
        // this checks the platform, using the same test as CodeMirror's keymap.
        if (e.ctrlKey && !e.metaKey && /Mac/.test(navigator.platform)) break;
        if (e.shiftKey) break;
        if (sbp("dez.editor/openFind") as boolean) e.preventDefault();
        break;
      case "g":
        if (sbp("dez.editor/selectFindMatch", e.shiftKey ? "previous" : "next") as boolean) e.preventDefault();
        break;
    }
  }

  onMounted(() => window.addEventListener("keydown", handleKeydown));
  onUnmounted(() => window.removeEventListener("keydown", handleKeydown));
}
