import { onMounted, onUnmounted } from "vue";
import sbp from "@sbp/sbp";
import { findState } from "../editor/findState";
import { isMacPlatform } from "../../utils/platform";

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
      // Esc closes the innermost open thing first: the model dropdown
      // (ModelSelector.vue takes the key before this handler), Settings or
      // History, the prompt autocomplete, find. With none open, it stops
      // the active tab's stream. tests/e2e/submit-stop.e2e.ts covers the
      // order.
      //
      // Only this handler closes Settings and History on Esc. An Esc
      // handler on a modal would run first when the focus is inside it,
      // and this handler would then see no modal and also close find or
      // stop the stream.
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
      } else if (!e.defaultPrevented && !e.isComposing && e.keyCode !== 229) {
        // Esc with the focus outside the editor (the page, a button, a
        // thinking panel) stops the stream. In the editor the stop binding
        // runs first. During an IME composition CodeMirror ignores the key,
        // and that Esc only ends the composition.
        const activeTabId = sbp("dez.model/tabs/activeId") as string;
        if (sbp("dez.model/streams/isStreaming", activeTabId) as boolean) {
          e.preventDefault();
          void sbp("dez.stream/stop", activeTabId);
        }
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
        // Shift makes `key` "T", which the switch lowercases.
        e.preventDefault();
        if (e.shiftKey) sbp("dez.model/tabs/reopenClosed");
        else sbp("dez.model/tabs/create");
        break;
      case "w":
        e.preventDefault();
        void sbp("dez.controller/closeTab", sbp("dez.model/tabs/activeId"));
        break;
      case "c":
        // Copy Markdown. Shift makes `key` "C", which the switch lowercases.
        if (e.shiftKey && (sbp("dez.editor/copyMarkdown") as boolean)) e.preventDefault();
        break;
      case "s":
        e.preventDefault();
        void sbp("dez.controller/saveConversationAs", sbp("dez.model/tabs/activeId"));
        break;
      case "f":
        // On macOS, Ctrl+F is emacs-style "forward char" in CodeMirror and in
        // native text fields, so only Cmd+F opens find there. CodeMirror does
        // not prevent the default when the cursor cannot move (doc end), so
        // this checks the platform.
        if (e.ctrlKey && !e.metaKey && isMacPlatform) break;
        if (e.shiftKey) break;
        if (sbp("dez.editor/openFind") as boolean) e.preventDefault();
        break;
      case "g":
        if (sbp("dez.editor/selectFindMatch", e.shiftKey ? "previous" : "next") as boolean) e.preventDefault();
        break;
      case "=":
      case "+":
        // "+" too: on a US layout Ctrl+Shift+= gives "+", and on some
        // layouts (German) "+" has its own key.
        e.preventDefault();
        sbp("dez.model/settings/changeEditorFontSize", 1);
        break;
      case "-":
        e.preventDefault();
        sbp("dez.model/settings/changeEditorFontSize", -1);
        break;
    }
  }

  onMounted(() => window.addEventListener("keydown", handleKeydown));
  onUnmounted(() => window.removeEventListener("keydown", handleKeydown));
}
