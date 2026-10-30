import { reactive } from 'vue'
import type { SearchQuery } from '@codemirror/search'
import { createFindQuery, type FindStatus } from './find'

/** View state of the find dropdown, shared by all tabs. It lives outside
 *  CodeMirror because `view.setState()` (tab switch, stream finish) rebuilds
 *  every CM field; `ThreadEditor.vue` seeds the find query from here. */
export const findState = reactive({
  open: false,
  search: '',
  regexp: false,
  /** Replace field text; used only by the replace selectors, so it is not
   *  part of the CM find query. */
  replace: '',
  /** Whether the replace row is expanded. */
  replaceOpen: false,
  /** Match count for the open query; `null` while closed, or while the
   *  query is empty or an invalid regex. */
  status: null as FindStatus | null,
  /** Typing in the search field selects the first match at or after this
   *  doc position: where the user last put the selection, or the last
   *  match that next/previous moved to. */
  origin: 0,
  /** Incremented to make `FindDropdown.vue` focus and select its search
   *  field. */
  focusRequest: 0,
})

/** The query for the CM find field: `null` while the dropdown is closed. */
export function activeFindQuery(): SearchQuery | null {
  return findState.open ? createFindQuery(findState) : null
}
