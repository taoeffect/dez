import { computed, onMounted, onUnmounted } from "vue";
import sbp from "@sbp/sbp";
import { findState } from "../editor/findState";
import { useModelState } from "../modelState";
import { matchShortcut, type ShortcutIdOfScope } from "../../model/shortcuts";

// While Settings or History is open, Esc closes it first, so the find Esc
// handlers in the editor and in the dropdown pass Esc on to this handler.
// The find selectors also do nothing while one of them covers the editor.
export function isModalOpen(): boolean {
  return (sbp("dez.model/settings/isOpen") as boolean) || (sbp("dez.model/settings/isHistoryOpen") as boolean);
}

// Esc closes the innermost open thing first: the model dropdown
// (ModelSelector.vue takes the key before this handler), Settings or
// History, the prompt autocomplete, find. With none open, it is the Stop
// key (Esc by default). tests/e2e/submit-stop.e2e.ts covers the order.
//
// Only this handler closes Settings and History on Esc. An Esc handler on a
// modal would run first when the focus is inside it, and this handler would
// then see no modal and also close find or stop the stream.
//
// Returns whether one of them was open.
function closeOnEscape(e: KeyboardEvent): boolean {
  if (sbp("dez.model/settings/isOpen") as boolean) {
    e.preventDefault();
    sbp("dez.model/settings/close");
  } else if (sbp("dez.model/settings/isHistoryOpen") as boolean) {
    e.preventDefault();
    sbp("dez.model/settings/historyClose");
  } else if (findState.open) {
    // Esc in the editor was already handled by CodeMirror, which prevents
    // the default even when no binding ran (an open prompt autocomplete
    // takes Esc first). This covers focus elsewhere.
    if (!e.defaultPrevented) {
      e.preventDefault();
      sbp("dez.editor/closeFind");
    }
  } else {
    return false;
  }
  return true;
}

// Stop is an editor shortcut, but this handler also runs it while the focus
// is outside the editor (the page, a button, a thinking panel).
type WindowShortcutId = ShortcutIdOfScope<"app"> | "stop";

// What each window shortcut does. An action that returns false did nothing,
// so the key keeps its default action.
//
// The app shortcuts are also native menu items, which call the same
// selectors. On Linux a menu accelerator takes the key before this handler
// sees it, so context checks (a modal is open, find is closed, …) belong in
// the selector, not here.
const windowActions: Record<WindowShortcutId, (e: KeyboardEvent) => boolean | undefined> = {
  stop: (e) => {
    // In the editor the Stop binding runs first and prevents the default.
    // During an IME composition CodeMirror ignores the key, and that Esc
    // only ends the composition.
    if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return false;
    const activeTabId = sbp("dez.model/tabs/activeId") as string;
    if (!(sbp("dez.model/streams/isStreaming", activeTabId) as boolean)) return false;
    void sbp("dez.stream/stop", activeTabId);
    return true;
  },
  saveAs: () => void sbp("dez.controller/saveConversationAs", sbp("dez.model/tabs/activeId")),
  copyMarkdown: () => sbp("dez.editor/copyMarkdown") as boolean,
  find: () => sbp("dez.editor/openFind") as boolean,
  findNext: () => sbp("dez.editor/selectFindMatch", "next") as boolean,
  findPrevious: () => sbp("dez.editor/selectFindMatch", "previous") as boolean,
  newConversation: () => void sbp("dez.model/tabs/create"),
  newTab: () => void sbp("dez.model/tabs/create"),
  reopenClosedTab: () => void sbp("dez.model/tabs/reopenClosed"),
  closeTab: () => void sbp("dez.controller/closeTab", sbp("dez.model/tabs/activeId")),
  previousTab: () => void sbp("dez.model/tabs/cycle", -1),
  nextTab: () => void sbp("dez.model/tabs/cycle", 1),
  goToTab1: () => void sbp("dez.model/tabs/switchToIndex", 0),
  goToTab2: () => void sbp("dez.model/tabs/switchToIndex", 1),
  goToTab3: () => void sbp("dez.model/tabs/switchToIndex", 2),
  goToTab4: () => void sbp("dez.model/tabs/switchToIndex", 3),
  goToTab5: () => void sbp("dez.model/tabs/switchToIndex", 4),
  goToTab6: () => void sbp("dez.model/tabs/switchToIndex", 5),
  goToTab7: () => void sbp("dez.model/tabs/switchToIndex", 6),
  goToTab8: () => void sbp("dez.model/tabs/switchToIndex", 7),
  goToTab9: () => void sbp("dez.model/tabs/switchToIndex", 8),
  history: () => void sbp("dez.model/settings/historyToggle"),
  settings: () => void sbp("dez.model/settings/toggle"),
  increaseFontSize: () => void sbp("dez.model/settings/changeEditorFontSize", 1),
  decreaseFontSize: () => void sbp("dez.model/settings/changeEditorFontSize", -1),
};

export function useKeyboardShortcuts() {
  const { shortcuts } = useModelState();
  const windowShortcuts = computed(() => shortcuts.value.filter((shortcut) => Object.hasOwn(windowActions, shortcut.id)));

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && closeOnEscape(e)) return;
    const shortcut = matchShortcut(windowShortcuts.value, e);
    // `windowShortcuts` has only the ids of `windowActions`.
    if (shortcut && windowActions[shortcut.id as WindowShortcutId](e) !== false) e.preventDefault();
  }

  onMounted(() => window.addEventListener("keydown", handleKeydown));
  onUnmounted(() => window.removeEventListener("keydown", handleKeydown));
}
