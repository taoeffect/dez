import { regExpSource } from '../../utils/regExpSource'
import { WORK_VIRTUAL_ROOT } from '../tools/conversationWork'

// The data files that a user pastes or drops into a conversation: Dez
// copies each into the work folder of the conversation
// (model/tools/conversationWork.ts), where the Dez tools and the code of
// the runs read it, and the conversation gets its path there as plain text
// (`/work/data-1.csv`). A data file is no asset: it has no id, no tag, and
// no stored file of its own. The copy has a neutral name, so no request
// holds the name of the user's file.

/** The endings of the files that a paste or a drop copies as data files:
 *  the text data that the Dez tools and the libraries read. */
export const DATA_FILE_EXTENSIONS = ['csv', 'tsv', 'json', 'txt'] as const

export type DataFileExtension = typeof DATA_FILE_EXTENSIONS[number]

/** The largest data file that a paste or a drop copies. A larger file is
 *  left out without being read. */
export const MAX_DATA_FILE_BYTES = 50 * 1024 ** 2

/** The ending of the data file `fileName` (any case), as Dez names the
 *  copy; null for a file that is no data file. */
export function dataFileExtension(fileName: string): DataFileExtension | null {
  const extension = /\.([A-Za-z0-9]+)$/.exec(fileName)?.[1].toLowerCase()
  return DATA_FILE_EXTENSIONS.find((known) => known === extension) ?? null
}

// The number of a data file name, in a name of the work folder
// (`data-3.csv`) and in a path of a text (`/work/data-3.csv`). Any case, as
// the files of macOS are; at most 15 digits, which stay exact as a number.
const NAME_NUMBER = /^data-(\d{1,15})\./i
const TEXT_NUMBER = new RegExp(`${regExpSource(WORK_VIRTUAL_ROOT)}/data-(\\d{1,15})\\.`, 'gi')

/** The name of the copy of a new data file of `extension` in a work
 *  folder whose entries are `takenNames`, in a conversation with the texts
 *  `texts`: `data-<n>.<extension>`, where n is one more than the highest
 *  number of a data file name in the folder or in a path of the texts. So
 *  the copy replaces no file, and a path that the conversation named
 *  before (of a file that is gone now) never names another file. */
export function nextDataFileName(extension: DataFileExtension, takenNames: readonly string[], texts: readonly string[]): string {
  const numbers = [
    ...takenNames.map((name) => NAME_NUMBER.exec(name)?.[1]),
    ...texts.flatMap((text) => [...text.matchAll(TEXT_NUMBER)].map((match) => match[1])),
  ]
  // A reduce, not `Math.max(...numbers)`: a work folder can hold more
  // names than a call takes arguments.
  const highest = numbers.reduce((max, digits) => (digits === undefined ? max : Math.max(max, Number(digits))), 0)
  return `data-${highest + 1}.${extension}`
}

/** The text of the data file `name` of the work folder in a conversation:
 *  its path as a model names it. */
export function dataFileText(name: string): string {
  return `${WORK_VIRTUAL_ROOT}/${name}`
}
