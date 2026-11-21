import sbp from '@sbp/sbp'
import type { StoredFileType } from '../model/chat/fileSignatures'
import { ClipReadError } from '../model/chat/mediaFiles'
import { AppCallError, clipNotReadText, imageNotReadText, SaveNotStoredError } from '../model/tools/appBridge'
import { checkSaveSize, savedFileType, type AppInput, type SaveCount } from '../model/tools/appInvoke'
import type { KeptFile } from '../model/tools/programRuns'
import { newGeneratedFile, type GeneratedFile } from './programRuns'

// The work of the two calls of the page of a UI app (the frame bridge,
// model/tools/appBridge.ts): the read of an image or a clip as a Blob, and
// the save of a new one. This module registers no selector. A run of an
// app (appInvoke.ts) and a shown app (`dez.controller/apps/readAsset` and
// `saveAsset`, apps.ts) each have their own rule on which asset a page
// reads and where a save goes; the bytes go the same way for both.
//
// Dez trusts nothing of a page. A save is a file only as a type that Dez
// stores, which the bytes tell, and Dez writes the bytes that it checked.
// A page gets no path and no file name: a Blob has neither, and the text
// of each refused call names an asset by its id only.

/** Writes the checked bytes `bytes` of the type `type` into the generated
 *  folder of their kind, under a new name (`newGeneratedFile`). `appDir`
 *  is the app root. Rejects when the write fails. */
export async function storeCheckedFile(appDir: string, bytes: Uint8Array, type: Pick<KeptFile, 'kind' | 'type' | 'extension'>): Promise<GeneratedFile> {
  const file = newGeneratedFile(appDir, type)
  await sbp('dez.native/saveAppFile', file.target, bytes)
  return file
}

/** The bytes of the image or the clip `input` for a page, also of a
 *  linked file: a Blob of the asset's type, with no file name and no path
 *  (the read gives a `File` that has the name). Throws an `AppCallError`
 *  for an asset that Dez cannot read, and the stop of `signal`, which ends
 *  the download of a clip that is only at its provider's address. */
export async function assetBlob(input: AppInput, signal?: AbortSignal): Promise<Blob> {
  try {
    if (input.kind === 'image') {
      return new Blob([await sbp('dez.controller/images/readFile', input.path) as File], { type: input.type })
    }
    return new Blob([await sbp('dez.controller/media/readClip', input.clip, { signal }) as Blob], { type: input.clip.type })
  } catch (error) {
    if (signal?.aborted) throw error
    // The errors of the two reads hold no path.
    console.error(`Failed to read @${input.id} for an app:`, error)
    const text = input.kind === 'image'
      ? imageNotReadText(input.id)
      : clipNotReadText(input, error instanceof ClipReadError ? error.problem : 'unreadable')
    throw new AppCallError(text, { cause: error })
  }
}

/** A save of a page that Dez stored, with its type. */
export interface StoredSave extends GeneratedFile {
  type: StoredFileType
}

/** Checks the save `blob` of a page and stores it, in this order: the
 *  size (it reads no byte), the count of the run `saves`, the type by the
 *  bytes, then the write. Throws an `AppCallError` that tells the page why
 *  for a save that Dez refuses, and a `SaveNotStoredError`, after a log,
 *  for a write that failed. */
export async function storeSave(blob: Blob, saves: SaveCount): Promise<StoredSave> {
  checkSaveSize(blob.size)
  saves.take()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const type = savedFileType(bytes)
  try {
    return { ...await storeCheckedFile(await sbp('dez.native/getAppDir') as string, bytes, type), type }
  } catch (error) {
    console.error('Failed to store a file that an app saved:', error)
    throw new SaveNotStoredError(error)
  }
}
