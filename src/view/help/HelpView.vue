<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { DATA_FILE_EXTENSIONS, MAX_DATA_FILE_BYTES, dataFileText, nextDataFileName } from '../../model/chat/dataFiles'
import { IMAGE_FOLDERS } from '../../model/chat/images'
import { MEDIA_TEMP_LIFETIME_MS } from '../../model/chat/mediaFiles'
import { MEDIA_CACHE_FOLDER, MEDIA_FOLDERS } from '../../model/chat/mediaTags'
import { SHOWN_PICTURE_FOLDER } from '../../model/chat/shownPictures'
import { UNUSED_FILE_MIN_AGE_MS } from '../../model/chat/unusedFiles'
import { CHAT_IMAGE_SIDE } from '../../model/providers/imageSize'
import { DEFAULT_MEDIA_REQUESTS_AT_ONCE } from '../../model/providers/mediaTurns'
import { AUDIO_ALIASES, VIDEO_ALIASES, aliasCallText } from '../../model/tools/appAliases'
import { APP_RUN_FRAME_SIZE } from '../../model/tools/appBridge'
import { BUILT_IN_APP_PREFIX, MANIFEST_FILE } from '../../model/tools/appManifest'
import { APP_RUN_DEFAULT_SECONDS, APP_RUN_MAX_DECODED_BYTES, APP_RUN_MAX_FRAMES, APP_RUN_MAX_OUTPUT_BYTES, APP_RUN_MAX_OUTPUT_FILES, APP_RUN_MAX_TOOL_CALLS, APPS_MAX_BYTES, APPS_MAX_ENTRIES, APPS_ROOT, APPS_VIRTUAL_ROOT, FRAMES_MAX_FPS, FRAMES_MAX_SIDE, FRAMES_MIN_FPS, LIBS_VIRTUAL_ROOT, SHIPPED_LIBRARIES } from '../../model/tools/appsTool'
import { SCRIPT_MAIN_FILE, UI_INDEX_FILE } from '../../model/tools/appTemplates'
import { CONVERSATION_WORK_ROOT, WORK_VIRTUAL_ROOT } from '../../model/tools/conversationWork'
import { JS_EVAL_DEFAULT_SECONDS, JS_EVAL_MAX_SECONDS, JS_EVAL_MAX_TOOL_CALLS, JS_EVAL_OUTPUT_BYTES } from '../../model/tools/jsEval'
import { MAX_SAVED_WORK_FILES } from '../../model/tools/videoTool'
import { WORK_FOLDER_LIFETIME_MS, WORK_ROOT } from '../../model/tools/workFolders'
import { shortcutKeyText } from '../../model/shortcuts'
import { byteSizeText } from '../../utils/byteSize'
import { countText } from '../../utils/countText'
import { DEZ_DISCUSSIONS_URL } from '../../utils/dezLinks'
import bundledPrograms from '../../../src-tauri/binaries/manifest.json'
import bundledFonts from '../../../src-tauri/fonts/manifest.json'
import { libraries as shippedLibraries } from '../../../src-tauri/libs/manifest.json'

type HelpPage = 'general' | 'tips' | 'assets' | 'apps' | 'support' | 'thanks'

const PAGES: { id: HelpPage; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'tips', label: 'Tips' },
  { id: 'assets', label: 'Assets' },
  { id: 'apps', label: 'Apps' },
  { id: 'support', label: 'Support' },
  { id: 'thanks', label: 'Thank You' },
]

// The rows of the folder list of the Assets page: the folders of the stored
// files, relative to the Dez folder, and what Dez puts into them. The names
// come from the constants of the file code, so the page names no folder
// that Dez does not write.
const STORED_FOLDERS: { folders: readonly string[]; holds: string }[] = [
  { folders: [IMAGE_FOLDERS.pasted], holds: 'Pasted images, and dropped images that Dez copies.' },
  { folders: Object.values(MEDIA_FOLDERS.pasted), holds: 'Pasted clips, and dropped clips that Dez copies.' },
  { folders: [IMAGE_FOLDERS.generated], holds: 'Images that models and Dez tools make.' },
  { folders: Object.values(MEDIA_FOLDERS.generated), holds: 'Clips that you save, and clips that Dez tools make.' },
  { folders: [SHOWN_PICTURE_FOLDER], holds: 'Copies of the pictures that Dez showed a model: the pictures of the asset_view tool, which the requests of the conversation send to the model until its next compaction and the panel of the tool call shows, and the pictures of the clips that a compaction keeps in view of the model.' },
]

const HOUR_MS = 60 * 60 * 1000
const TEMP_COPY_HOURS = MEDIA_TEMP_LIFETIME_MS / HOUR_MS
const WORK_FOLDER_HOURS = WORK_FOLDER_LIFETIME_MS / HOUR_MS

// The side over which a chat request sends a smaller copy of an image, as
// the text writes a number (`1,568`).
const CHAT_IMAGE_SIDE_TEXT = countText(CHAT_IMAGE_SIDE)

// The data files of the Assets page: the endings that a paste or a drop
// copies (".csv, .tsv, .json, or .txt"), the largest size, and the name of
// the first copy in a work folder.
const DATA_FILE_DOT_ENDINGS = DATA_FILE_EXTENSIONS.map((extension) => `.${extension}`)
const DATA_FILE_ENDINGS = `${DATA_FILE_DOT_ENDINGS.slice(0, -1).join(', ')}, or ${DATA_FILE_DOT_ENDINGS.at(-1)}`
const MAX_DATA_FILE_SIZE = byteSizeText(MAX_DATA_FILE_BYTES)
const FIRST_DATA_FILE = nextDataFileName(DATA_FILE_EXTENSIONS[0], [], [])
const MAX_SAVED_WORK_FILES_TEXT = countText(MAX_SAVED_WORK_FILES)

// The limits of the apps and of the code that a model runs, as the Apps
// page writes them. They come from the constants of the code, so the page
// tells no limit that Dez does not keep.
const MINUTE_SECONDS = 60
const APP_LIMITS = {
  entries: countText(APPS_MAX_ENTRIES),
  size: byteSizeText(APPS_MAX_BYTES),
  savedFiles: APP_RUN_MAX_OUTPUT_FILES,
  savedFileSize: byteSizeText(APP_RUN_MAX_OUTPUT_BYTES),
  runMinutes: APP_RUN_DEFAULT_SECONDS / MINUTE_SECONDS,
  toolCalls: APP_RUN_MAX_TOOL_CALLS,
  unusedMinutes: UNUSED_FILE_MIN_AGE_MS / (MINUTE_SECONDS * 1000),
  decodedSize: byteSizeText(APP_RUN_MAX_DECODED_BYTES),
  frames: countText(APP_RUN_MAX_FRAMES),
}
const CODE_LIMITS = {
  seconds: JS_EVAL_DEFAULT_SECONDS,
  mostMinutes: JS_EVAL_MAX_SECONDS / MINUTE_SECONDS,
  toolCalls: JS_EVAL_MAX_TOOL_CALLS,
  output: byteSizeText(JS_EVAL_OUTPUT_BYTES),
}

// The sources of the fonts that Dez ships, for the Thank You page:
// each repository once, in the order of the manifest, with the families of
// its fonts.
const FONT_SOURCES: { repository: string; families: string[] }[] = []
for (const { repository, family } of Object.values(bundledFonts.fonts)) {
  const source = FONT_SOURCES.find((known) => known.repository === repository)
  if (!source) FONT_SOURCES.push({ repository, families: [family] })
  else if (!source.families.includes(family)) source.families.push(family)
}

// The libraries that Dez ships, for the Thank You page: each package with
// its version, license, and project. Only the `libraries` part of the
// manifest is imported, so its long list of files stays out of the bundle.
const LIBRARY_SOURCES = Object.values(shippedLibraries)

// The built-in apps (src-tauri/builtin-apps/), as the Apps page lists
// them: the name, the call that runs it, and what it does. The list is
// written here, as the frontend has no list of the folders of the bundle;
// help.e2e.ts checks it against the folder. An app with no subcommand of
// its own runs with `apps invoke`.
const ALIAS_CALLS = new Map([...AUDIO_ALIASES, ...VIDEO_ALIASES].map((alias) => [alias.app, aliasCallText(alias)]))
const BUILT_IN_APPS = [
  { name: 'dez-beats', does: 'the tempo, the beats, the downbeats, the loudness, and the strong hits of a song.' },
  { name: 'dez-onsets', does: 'the start of a sound, its loudest moment, and each hit.' },
  { name: 'dez-align', does: 'where one clip starts in another, for example a recording in a song.' },
  { name: 'dez-cuts', does: 'the cuts of a video, where one shot changes to the next.' },
  { name: 'dez-sync', does: 'whether the cuts of an edit are on the beats of its music.' },
  { name: 'dez-title', does: 'an animated title, as a clip with a transparent background.' },
  { name: 'dez-chart', does: 'a chart (line, bar, scatter, pie, doughnut, or radar) of a data table of the work folder, as a PNG image.' },
].map((app) => ({ ...app, call: ALIAS_CALLS.get(app.name) ?? 'apps invoke' }))

const { shortcuts } = useModelState()

// A local ref, not a store field: the panel opens on General each time.
const page = ref<HelpPage>('general')

// The keys that the text names, as they are now, so that the text follows
// a change in Settings › Shortcuts.
const keys = computed(() => ({
  submit: shortcutKeyText(shortcuts.value, 'submit'),
  stop: shortcutKeyText(shortcuts.value, 'stop'),
  newMessage: shortcutKeyText(shortcuts.value, 'newMessage'),
  settings: shortcutKeyText(shortcuts.value, 'settings'),
  history: shortcutKeyText(shortcuts.value, 'history'),
}))

// The Dez folder, Dez's cache folder (which the bundled programs can open),
// the folder of the temp copies of clips, the folder of the run folders of
// the bundled programs, the folder of the apps, and the folder of the work
// folders of the conversations, as the Assets page and the Apps page show
// them (`~` for the home folder). The cache folder differs by system, so
// the page reads the folders and spells none. Null until the read ends,
// and for a folder that cannot be read: the page then names the folder
// with no path.
const appDir = ref<string | null>(null)
const cacheDir = ref<string | null>(null)
const tempDir = ref<string | null>(null)
const runFoldersDir = ref<string | null>(null)
const appsDir = ref<string | null>(null)
const workFoldersDir = ref<string | null>(null)

onMounted(async () => {
  const [app, cache] = await Promise.all([
    sbp('dez.controller/displayAppDir') as Promise<string | null>,
    sbp('dez.controller/displayAppDir', 'cache') as Promise<string | null>,
  ])
  appDir.value = app
  cacheDir.value = cache
  tempDir.value = cache === null ? null : `${cache}/${MEDIA_CACHE_FOLDER}`
  runFoldersDir.value = cache === null ? null : `${cache}/${WORK_ROOT}`
  appsDir.value = app === null ? null : `${app}/${APPS_ROOT.file}`
  workFoldersDir.value = app === null ? null : `${app}/${CONVERSATION_WORK_ROOT}`
})

function onClose() {
  sbp('dez.model/settings/helpClose')
}

// Whether the last press started on the overlay itself. A drag that starts
// in the modal (a text selection) and ends outside it also gives the
// overlay a click; only a press that started outside closes the panel.
let pressOnOverlay = false

function onOverlayMouseDown(event: MouseEvent) {
  pressOnOverlay = event.target === event.currentTarget
}

function onOverlayClick(event: MouseEvent) {
  if (pressOnOverlay && event.target === event.currentTarget) onClose()
  pressOnOverlay = false
}
</script>

<template>
  <div class="help-overlay" @mousedown="onOverlayMouseDown" @click="onOverlayClick">
    <div class="help-modal">
      <div class="help-header">
        <h2>Dez Help</h2>
        <button class="help-close" title="Close (Esc)" @click="onClose">×</button>
      </div>

      <div class="help-body">
        <nav class="help-nav">
          <button
            v-for="p in PAGES"
            :key="p.id"
            class="help-nav-btn"
            :class="{ 'help-nav-btn--active': page === p.id }"
            @click="page = p.id"
          >
            {{ p.label }}
          </button>
        </nav>

        <!-- The key gives each page a new scroller, so a page always opens
             at its top, also after a scroll in the page before it. -->
        <div :key="page" class="help-content">
          <section v-if="page === 'general'" class="help-page help-page--general">
            <p>
              Each tab is one conversation, written as one text document. Write your message, then
              press <kbd>{{ keys.submit }}</kbd> or click Submit: Dez sends the conversation to the
              model, and the reply comes in below your message. <kbd>{{ keys.stop }}</kbd> stops a
              reply, and <kbd>{{ keys.newMessage }}</kbd> starts a new message. You can edit all of
              the text, the replies too, before you send it again.
            </p>
            <p>
              The model picker at the lower left sets the model of the tab, and the gear next to it
              shows the settings of that model. The picker's button shows the provider first, in a
              small box, then the name of the model: a router such as TrustedRouter or OpenRouter
              can give a model a name that starts with the name of the company that made it. To
              make the open picker larger, drag its top edge, its right edge, or its top right
              corner; Dez keeps that size. Add your API keys and your own providers in Settings
              (<kbd>{{ keys.settings }}</kbd>) › Providers. Models
              can use Dez tools, for example to
              find other models, to ask them for images and clips, to cut and join clips, to run
              code, and to write small apps. Slow
              tool work, such as a request for an image, runs as a job. Dez sends one provider at
              most {{ DEFAULT_MEDIA_REQUESTS_AT_ONCE }} requests to its media models (images, clips,
              speech, transcriptions) at one time, from all tabs together, unless the settings of a
              custom provider set another number: the others wait for their turn. A stop or a new
              message does
              not end the jobs of a reply: the next reply of the tab can wait for them and get their
              results. To end a job that you no longer need, ask the model to cancel it. A close of
              the tab ends all its jobs. Dez saves each conversation: History
              (<kbd>{{ keys.history }}</kbd>) opens it again.
            </p>
            <p>
              The Agent pill of a reply counts the seconds while the reply comes in, then shows how
              long the reply took. Each tool call of a reply shows as a chip: click it to see the
              call and its result. The chip of a call that runs longer than a second counts its time
              too, and then keeps the time that the call took. Dez tells the model how long such a
              call took.
            </p>
            <p>
              The two numbers in the middle of the bottom bar are the size and the cost of the
              conversation. The first one is the size in tokens (<code>k</code>: thousand,
              <code>M</code>: million): about how much your next message sends to the model, which
              is the conversation with the system prompt and the tools that go with it. A
              <code>~</code> before it marks an estimate of Dez. With no <code>~</code>, it is the
              count of the provider in the newest reply. Point at the number to see how much of the
              context window of the model the conversation fills, and at which size Dez compacts
              the conversation.
            </p>
            <p>
              The amount after it is about what the conversation cost: the price of each request of
              its replies, also of the requests that a model sends to other models with a Dez tool.
              A <code>+</code> after it means that Dez knows no price for some requests, so the cost
              is higher. <code>(?)</code> means that you changed or deleted a reply: its cost stays
              in the amount. Point at the amount to see the details. A model can read the size and
              the cost too, with a Dez tool. To start again in the same tab, select all the text and
              delete it. The amount then starts again from $0, as in a new tab, and the money limit
              counts again from $0. Undo brings back the text and the amount.
            </p>
            <p>
              The coin after the amount is the money limit of the tab. Click it to set the most that
              the requests of the tab can cost, in USD. Dez then sends no request that would go over
              the limit, also none that a model sends with a Dez tool, and tells you why. A request
              to a media model that runs counts with the price that Dez expects for it, so
              that requests that run at the same time cannot go over the limit together. The price
              of a chat request is known only after it: Dez sends one while the cost is under the
              limit, so the cost can end a little over it. Dez also sends no request whose price it
              does not know, unless you check "Allow unknown prices": such a request is then in the
              count only when its provider tells its cost. No model can change the limit. A saved
              conversation keeps its limit.
            </p>
            <p>
              A long conversation can get too large for one request to the model. Dez then compacts
              it: it asks the model for notes of the work so far, and the notes take the place of
              the earlier messages and replies. The notes keep your first message, your newest
              message, and each message between them that the work still needs, word for word, with
              their images. The model chooses which of the messages between them to keep, and the
              notes tell how many of them Dez left out so far. The notes also keep the reply right
              before your newest message, so that an answer such as "yes, but…" still makes sense.
              The bottom bar shows "Compacting…"
              while the model writes the notes. A compacted
              conversation starts with one Agent message: first two chips, then the reply, which
              goes on under the chips. Click the summary chip to read the notes and the messages of
              yours that they keep, and the assets chip to see the assets that the compaction kept.
              You cannot edit the notes, and Backspace and the other delete keys do not delete them.
              A compaction cannot be undone: Undo does not bring the earlier text back. After a
              compaction, the bottom bar
              shows two sizes and two amounts, as in <code>~81.2k (1.2M) · $0.42 ($7.80)</code>:
              first the size and the cost of the conversation since its last compaction, and after
              each of them, in parentheses, the one of the whole conversation.
            </p>
            <p>
              Paste or drop images, audio, video, and data files such as a CSV table into a message.
              A model that makes images, audio, or video puts them in its reply. The
              <button type="button" class="help-link" @click="page = 'assets'">Assets</button> page
              tells which of them a model sees, and where Dez keeps their files. The
              <button type="button" class="help-link" @click="page = 'apps'">Apps</button> page
              tells what an app is, and what the code that a model runs can open on your computer.
              Type <code>/prompt</code> and a space to insert a saved prompt (Settings › Prompts).
            </p>
          </section>

          <section v-if="page === 'tips'" class="help-page help-page--tips">
            <p>
              Shift+Click a role pill (User or Agent) to change its message from User to Agent, or
              from Agent to User: for example, to write a reply yourself. The first message does not
              change: it is User, or the Agent message with the notes of a compacted conversation.
              The pill of a reply that is coming in does not change, and a message that links
              dropped files stays User.
            </p>
          </section>

          <!-- This page tells the user the asset rules of the code: what a
               model sees, ids, intermediate assets, compaction, the folders,
               the bundled programs, copy or link, and delete. A change to one
               of those rules must change this text too. -->
          <section v-if="page === 'assets'" class="help-page help-page--assets">
            <h3>What a model sees</h3>
            <p>
              The images, audio clips, and video clips of a conversation are its assets. A chat
              model sees the images of your messages: the ones that are in a message, and the ones
              that a message names by id (<code>@a</code>). Dez sends them with each request of the
              conversation, so the model keeps them in view. Of the images of replies, a chat model
              gets only their ids. So when a chat model must see an image of a reply, name it in a
              message, for example: <code>Is @a too dark?</code>
            </p>
            <p>
              Code is only text. An image, a clip, or an <code>@a</code> in code (between
              <code>```</code> lines, in <code>`backticks`</code>, or on lines with four spaces in
              front) shows as its text, and Dez sends no image or clip for it.
            </p>
            <p>
              Dez sends a chat model an image with a side of more than {{ CHAT_IMAGE_SIDE_TEXT }}
              pixels as a smaller copy, which keeps the request small; the file of the image does
              not change. A model takes a limited number of images in one request, and some models
              a smaller number in one message. When the conversation or a message holds more, Dez
              leaves out the ones over the limit, and tells you.
            </p>
            <p>
              A model that makes images or clips, for example an image editor or a video model,
              gets only your newest message: the assets that are in it, and the ones that it names
              by id. So when such a model must get an older asset, name it in your new message, for
              example: <code>Make @a brighter</code>.
            </p>
            <p>
              A clip goes only to a model that takes audio or video, for example a video model or
              a transcription model. In the conversation, Dez sends a chat model only the id of a
              clip. A model that needs an image and can work with one, for example an image editor,
              takes the newest image of the conversation when your message has none.
            </p>
            <p>
              A chat model can ask another model for an image, a clip, a transcription, or an
              answer, with the Dez tool <code>model_invoke</code>. It names by id the assets that
              the other model gets, so that model can also get an asset of an older message or of a
              reply. A chat model that hears or sees clips, for example a Gemini model, gets the
              clips that such a call names too, when its provider takes clips in a chat request.
              Dez sends it a copy of each clip, with no metadata (such as the place or the device of
              a recording), in a type that the provider takes. Such a model can tell what a clip
              shows and how it sounds, but not its exact times: for those, a model uses the
              measurements below.
            </p>
            <p>
              When a chat model asks a transcription model for the text of a clip, Dez also asks for
              the time of each word. When the transcription model gives times, Dez writes them with
              the text into a file of the work folder of the conversation (see below), named after
              the clip, the provider, and the model.
            </p>
            <p>
              A chat model can also look at any asset of the conversation itself, with the Dez tool
              <code>asset_view</code>: an image or a part of it, frames of a video clip (at equal
              steps, at given times, or one for each shot), and the wave or the spectrogram of the
              sound of a clip, with the loudness of a clip with sound. It can also put several images
              and video clips into one grid picture. The pictures stay in its view in the later
              replies too, until Dez compacts the conversation. They share one picture budget with
              the images of your messages, so it sees a limited number of pictures; a compaction
              makes room for new ones. Click the chip of the tool call to see the pictures that the model saw. A
              model that reads no images gets only the facts of the asset (for example its size,
              length, and format), and the loudness of a clip with sound.
            </p>
            <p>
              With the Dez tool <code>asset_info</code>, a model reads the facts of an asset, and who
              made it. It can also check a whole clip for black, frozen, or silent parts, and for its
              loudness over time.
            </p>
            <p>
              The Dez tools <code>audio</code> and <code>video</code> measure the times of clips, as a
              model cannot hear or see them exactly: the beats of a song, where a sound starts and
              each of its hits, where one clip starts in another, the cuts of a video clip, and
              whether the cuts of an edit are on the beats of its song. Each measurement is a run of
              a built-in app of Dez (see the
              <button type="button" class="help-link" @click="page = 'apps'">Apps</button> page),
              which writes all its numbers into a file of the work folder of the conversation. With
              <code>video title</code>, a model makes an animated title as a clip with a transparent
              background, which it then puts over a video clip. The built-in app
              <code>dez-chart</code> draws a chart of a data table of the work folder as an image.
            </p>

            <h3>Ids</h3>
            <p>
              Each image and each clip has a short id: <code>a</code>, <code>b</code>, and so on.
              Point at an image or a player to see its id. A model gets this id, and never the path
              of the file. Write <code>@</code> and the id in a message to name the asset. A message
              can name its own assets and the assets of the messages before it. Dez shows a name as
              a small chip when an asset has that id; a name with no chip names no asset. Click a
              chip to go to its asset, which flashes. When a chip of a tool call or of a compaction
              hides the asset, Dez opens that chip first.
            </p>
            <p>
              When you point at an image or a player, Dez also shows the name of the model that made
              it: an image or a clip of a reply, or one that a model made for a
              <code>model_invoke</code> call. Point at the name to see the model, its provider, and
              its full id. An asset that you pasted or dropped, or that a Dez tool made (for example
              <code>video</code>), names no model.
            </p>
            <p>
              To see an image large, point at it and click the magnifier: the image shows as large as
              it fits in the conversation view. Press Escape, click the X at the top right, or click
              next to the image to close it.
            </p>
            <p>
              Copy text that names assets in one conversation and paste it into another, and Dez
              asks whether to bring the assets along. With Yes, a name of an asset that this
              conversation has in the message of the paste, or in a message before it, changes to the
              id of that asset here. Each other asset goes in at the top of the paste, with the id of
              the same asset elsewhere in this conversation, else with an id that is free here, and
              its names change to that id. Dez copies no file: the asset uses the same file in both
              conversations, so a trash that deletes the file deletes it for both. A linked file goes
              only into a user message. With No, Dez pastes the text as it is.
            </p>

            <h3>Intermediate assets</h3>
            <p>
              A chat model that asks another model for an image or a clip, that joins or changes
              clips with the Dez tool <code>video</code>, or that runs an app (see the
              <button type="button" class="help-link" @click="page = 'apps'">Apps</button> page)
              can mark what it makes as intermediate: a
              part of its work, for example a clip that it then joins with others, and not the
              result that you asked for. Dez hides such an asset in the reply, and the chip of its
              tool call says "intermediate asset hidden". Click the chip to see the asset.
            </p>
            <p>
              A hidden asset is an asset as any other: it has an id, you can name it with
              <code>@</code> and the id, its trash and Save work in the open chip, and Delete
              Unreferenced Files keeps its file.
            </p>

            <h3>Compaction</h3>
            <p>
              When Dez compacts a conversation (see the
              <button type="button" class="help-link" @click="page = 'general'">General</button>
              page), your assets and the assets that the work still needs stay assets of the
              conversation, with their ids, so you and the model can still name them. A file that
              your message links stays linked. The model still sees some of the assets, a clip as a
              picture of its frames or its sound. For the
              others, it has only what the notes tell. Click the assets chip at the top of the
              conversation to see them all, what the notes tell about each, and the pictures that
              the model has in view. The chip also tells how many assets the compaction kept and how
              many it dropped.
            </p>
            <p>
              Of the assets that a model or a Dez tool made, the model keeps only the ones that the
              work at hand needs, and the compaction drops the others: the parts of finished work,
              the versions that a newer one replaced, the versions that you rejected, and the assets
              of earlier replies that the work does not use. Dez never drops an asset of yours, an
              asset that a job still uses, an asset that the notes name, or an asset that a file of
              an app of the conversation or of its work folder names with <code>@</code> and its
              id. An asset that a message
              of yours names stays too, when the notes keep that message. So to keep an asset
              of an earlier reply, name it in your message with <code>@</code> and its id. A dropped
              asset leaves the conversation. Dez deletes the file of a dropped intermediate asset at
              once. The file of any other dropped asset stays until you click Delete Unreferenced
              Files.
            </p>

            <h3>Where the files are</h3>
            <p>
              Dez stores the files of assets in these folders of the Dez
              folder<template v-if="appDir"> (<code>{{ appDir }}</code>)</template>:
            </p>
            <dl class="help-folders">
              <template v-for="row in STORED_FOLDERS" :key="row.holds">
                <dt><code v-for="folder in row.folders" :key="folder">{{ folder }}</code></dt>
                <dd>{{ row.holds }}</dd>
              </template>
            </dl>
            <p>
              A clip that a model makes is not stored at first. It plays from the web address that
              the provider gave, or from a temporary copy in
              <code v-if="tempDir">{{ tempDir }}</code><template v-else>the cache folder of the system</template>,
              which Dez deletes after {{ TEMP_COPY_HOURS }} hours. The clock on its player tells
              until when the clip is available. Click Save on the player to keep the clip. Before
              that time, Delete Unreferenced Files in Settings › General deletes a temporary copy
              that no conversation uses.
            </p>
            <!-- The menu: `dez.controller/menu/popupAsset`
                 (src/controller/menu.ts); the Export:
                 `dez.controller/exportAsset`
                 (src/controller/exportAsset.ts). -->
            <p>
              A context click on an image or a player shows Reveal in File Manager, which shows the
              file of the asset in the file manager of the system, and Export…, which copies the
              asset to a file that you pick. A clip that plays from its web address downloads
              before the copy. The copy is your file: Dez does not track it, and a delete in Dez
              leaves it. Reveal in File Manager is not available for a clip that has no file on
              this computer, and neither item is available for an asset whose file is gone.
            </p>
            <p>
              A Dez tool that cuts, joins, or converts clips stores its new clips and images at
              once, in the folders above. It works on copies of the assets and of the files of the
              work folder that it reads, in a run folder in
              <code v-if="runFoldersDir">{{ runFoldersDir }}</code><template v-else>the cache folder of the system</template>,
              so the files that it reads stay as they are. When the tool draws text, the run
              folder also holds copies of the fonts that it uses (fonts that come with Dez, see
              <button type="button" class="help-link" @click="page = 'thanks'">Thank You</button>),
              and the text files that the model writes for it, for example subtitles or a title.
              Dez does not store these files as assets. Dez deletes the run folder at the end
              of the work, or {{ WORK_FOLDER_HOURS }} hours later if Dez closed before that. Before
              that time, Delete Unreferenced Files deletes such a run folder.
            </p>
            <!-- The rule is in src-tauri/src/confinement.rs (Landlock on
                 Linux, Seatbelt on macOS), its folders are in
                 `FFMPEG_RULES` and `resolved_run`
                 (src-tauri/src/bundled_tools.rs), and the checks of a
                 command line are `argumentProblem` in
                 src/model/tools/videoTool.ts. The programs have no network
                 code: their build has `--disable-network` (see
                 `dez-ffmpeg -buildconf`). -->
            <p>
              Such a tool runs ffmpeg or ffprobe, programs that come with Dez. They have no
              network code, so they cannot connect to the internet. The system lets them
              open only the files in
              <code v-if="cacheDir">{{ cacheDir }}</code><template v-else>the folder of Dez in the cache folder of the system</template>
              and in the <code>assets</code> folder of the Dez folder: not your conversations, your
              API keys, or any other file of yours. In the <code>assets</code> folder, they can
              read, add, and change files, but not delete or move them. Dez also refuses a command
              line that names another file (but a file of the work folder, of which the program gets
              a copy), a web address, or a device such as a camera. A Linux
              system without Landlock (a part of the kernel since Linux 5.13) cannot set this
              limit: there, the checks of Dez are the only guard of your files.
            </p>

            <!-- The work folder of a conversation:
                 src/model/tools/conversationWork.ts; data files:
                 src/model/chat/dataFiles.ts; the `/work` inputs and
                 `save_to` of `video`: src/model/tools/videoTool.ts; its
                 delete: `dez.controller/closeTab` and
                 `dez.controller/deleteConversation`
                 (src/controller/tabs.ts), and the cleanup:
                 `goneConversationWorkFolders`
                 (src/model/chat/unusedFiles.ts). -->
            <h3>The work folder</h3>
            <p>
              Each conversation has a work folder, for the files of its work that are no assets: the
              numbers of a measurement, the times of a transcription, the frames or the parts of a
              long work, a data table. A model names it <code>{{ WORK_VIRTUAL_ROOT }}/</code>. It is
              a folder in
              <code v-if="workFoldersDir">{{ workFoldersDir }}</code><template v-else>the <code>{{ CONVERSATION_WORK_ROOT }}</code> folder of the Dez folder</template>,
              with the id of the conversation as its name. A file of the work folder has no id, and
              the conversation does not show it. The code that a model runs (see the
              <button type="button" class="help-link" @click="page = 'apps'">Apps</button> page) and
              the <code>apps</code> tool read and write it. The <code>video</code> tool reads a copy
              of a file of it, and it can put the new files of a run there in place of the reply, at
              most {{ MAX_SAVED_WORK_FILES_TEXT }} in one call.
            </p>
            <p>
              Paste or drop a data file ({{ DATA_FILE_ENDINGS }}, at most
              {{ MAX_DATA_FILE_SIZE }}) into a message, and Dez copies it into the work folder as
              <code>{{ FIRST_DATA_FILE }}</code> (with a new number each time). The message gets the
              path of the copy, as <code>{{ dataFileText(FIRST_DATA_FILE) }}</code>, on a line of its
              own, so a model can read the table or draw a chart of it. The name and the path of
              your file go to no model. Dez always copies a data file, from any folder, and leaves
              out a larger file, with a message. An incognito tab takes no data file, as it has no
              Dez tools.
            </p>
            <p>
              The work folder goes with its conversation: the delete of the conversation in History
              deletes it, and so does the close of a tab whose conversation has no text. A
              compaction keeps it. Delete Unreferenced Files deletes the work folder of a
              conversation that is gone, for example when you deleted the file of a conversation
              yourself. Nothing limits how much a work folder holds.
            </p>

            <h3>Copy or link</h3>
            <p>
              A paste stores a copy of the file. A file that you drop into a user message stays
              where it is: the message links to it, and Dez stores no copy. Do not move, rename, or
              delete a linked file, or the conversation loses it.
            </p>
            <p>Dez copies a dropped file in these cases:</p>
            <ul>
              <li>The file is in a temp folder or in a folder of Dez.</li>
              <li>You drop it into an agent message.</li>
              <li>It is an image of a type that Dez converts to PNG, for example BMP.</li>
              <li>It is a data file: its copy goes into the work folder.</li>
            </ul>

            <h3>How files are deleted</h3>
            <p>Dez deletes a stored file of an asset only when you tell it to:</p>
            <ul>
              <li>Point at an image and click its trash. This deletes the image and its file.</li>
              <li>
                Point at the Saved button of a player, which then shows a trash, and click it. This
                deletes the stored file of the clip.
              </li>
              <li>
                Click Delete Unreferenced Files in Settings › General. Dez finds the stored files
                that no conversation uses, and deletes them after you say yes. It also deletes the
                work folders of the conversations that are gone, and in the cache folder, the
                temporary copies of clips that no conversation uses, and the run folders and
                downloads that Dez did not finish. It never deletes an app: Delete Unreferenced Apps
                does that (see the
                <button type="button" class="help-link" @click="page = 'apps'">Apps</button>
                page).
              </li>
            </ul>
            <p>
              An edit of the text leaves the files where they are, and the delete of a conversation
              deletes only its work folder. Dez never deletes a linked file: its trash removes it
              only from the conversation.
            </p>
            <p>
              A compaction is the one exception: it deletes the file of each intermediate asset that
              it drops. It also deletes the picture copies of the text that it replaces, which are
              no assets.
            </p>
          </section>

          <!-- This page tells the user the rules of the apps and of the code
               that a model runs. A change to one of those rules must change
               this text too. The rules are in:
               - what an app is, its limits, and a run of it:
                 src/model/tools/appsTool.ts, appManifest.ts, appInvoke.ts,
                 appBridge.ts;
               - the card, the bar, the keys, and the saves of a shown app:
                 src/view/editor/apps.ts, src/view/apps/appFrameHost.ts,
                 appFrame.ts;
               - what a page can reach: src-tauri/src/app_frames.rs;
               - the code of a `js_eval` call: src/model/tools/jsEval.ts,
                 toolBridge.ts;
               - the sandbox of Deno, and what it does not stop: `DENO_RULES`
                 in src-tauri/src/bundled_tools.rs (the two memory limits of
                 the text are numbers of that file), and the header of
                 src-tauri/src/confinement.rs;
               - the deletes and a compaction: src/model/chat/unusedFiles.ts,
                 appNames.ts, src/model/streams/compactionApps.ts;
               - the libraries: src-tauri/libs/, `SHIPPED_LIBRARIES` and
                 `PAGE_LIBRARIES` in src/model/tools/appsTool.ts;
               - the built-in apps: src-tauri/builtin-apps/ (help.e2e.ts
                 checks the list of the page against it), and their
                 subcommands, src/model/tools/appAliases.ts;
               - the decode of the input clips and the frame sequences of a
                 script app: src/model/tools/inputDecode.ts,
                 frameSequences.ts. -->
          <section v-if="page === 'apps'" class="help-page help-page--apps">
            <h3>What an app is</h3>
            <p>
              An app is a small program that a model writes for you with the Dez tool
              <code>apps</code>: for example a calculator, a chart, a small game, or a tool for work
              that you do again and again on your images and clips. Dez keeps each app in a folder
              of its own in
              <code v-if="appsDir">{{ appsDir }}</code><template v-else>the <code>{{ APPS_ROOT.file }}</code> folder of the Dez folder</template>.
              So an app stays from one conversation to the next, and each model can run and change
              the apps that are there. A model gets no path of your computer: it names the folder of
              an app as <code>{{ APPS_VIRTUAL_ROOT }}/</code> and the name of the app. With the same
              tool, a model reads the libraries that come with Dez in
              <code>{{ LIBS_VIRTUAL_ROOT }}/</code>, and reads and writes the files of the work folder
              of the conversation (see the
              <button type="button" class="help-link" @click="page = 'assets'">Assets</button> page)
              in <code>{{ WORK_VIRTUAL_ROOT }}/</code>.
            </p>
            <p>
              There are two kinds of app. A UI app is a web page
              (<code>{{ UI_INDEX_FILE }}</code>): a model shows it in its reply, and you work with it
              there. A script app is code with no page (<code>{{ SCRIPT_MAIN_FILE }}</code>): a model
              runs it, and gets its result. The file <code>{{ MANIFEST_FILE }}</code> of an app holds
              its name, its kind, and a description, which tells you and a later model what the app
              does. An app holds at most {{ APP_LIMITS.entries }} files and folders, and
              {{ APP_LIMITS.size }}: the tool writes nothing that takes an app over these limits.
            </p>

            <h3>Built-in apps</h3>
            <p>
              Dez comes with these script apps, whose names start with
              <code>{{ BUILT_IN_APP_PREFIX }}</code>. They are a part of Dez, in the folder of its
              program and not in the folder of the apps: no one can change or delete them. A model
              sees them in <code>{{ APPS_VIRTUAL_ROOT }}/</code> with the mark "built-in", and it can
              read their code as a start for an app of its own. A model runs each one with the
              subcommand after its name.
            </p>
            <ul class="help-builtins">
              <li v-for="app in BUILT_IN_APPS" :key="app.name">
                <code class="help-builtin-name">{{ app.name }}</code> (<code>{{ app.call }}</code>):
                {{ app.does }}
              </li>
            </ul>

            <h3>Apps in a conversation</h3>
            <p>
              A model puts a UI app into its reply as a card, with the name of the app, its
              description, and the size of its files. The app does not start by itself: click Run.
              Its page then shows in the card, under a bar with the name and the size of the app.
              More than one app can run at the same time. A switch to another tab stops the apps of
              the tab.
            </p>
            <p>The bar has these buttons:</p>
            <ul>
              <li>
                Expand: the app covers the conversation. While it does, Find and the keys of the
                editor are off. Click the button again to close the expanded view.
              </li>
              <li>Fullscreen: the app fills the screen.</li>
              <li>
                Stop: the app ends, and the card shows Run again. An app keeps nothing from one run
                to the next, so Run starts it from its beginning.
              </li>
              <li>
                The trash, which the card has too: after you say yes, Dez deletes the folder of the
                app with all its files. No conversation can run the app after that, and Undo does
                not bring it back. When the app is gone already, the trash removes only the card.
              </li>
            </ul>
            <p>
              Escape takes you one step out of an app each time: out of fullscreen, then out of the
              expanded view, then the keyboard goes back to the conversation. A panel or a prompt of
              Dez that is open closes first. An app can keep Escape for itself, for example to close
              a dialog of its own. On Linux, an app in fullscreen gets no Escape, <code>f</code>, or
              <code>F</code> key: there, these three keys leave fullscreen.
            </p>
            <p>
              A context click on the card, on the bar, or in the app shows Reveal in File Manager,
              which shows the folder of the app in the file manager of the system. An app can show
              a menu of its own in place of it, and a text field or selected text of an app keeps
              the menu of the system.
            </p>
            <p>
              An app is one page. Dez stops an app that goes to another page or that loads its page
              again, and tells you: start it again with Run. An app that is out of view runs slowly.
              An app with a light and a dark look follows the setting of your system, not the theme
              of Dez.
            </p>

            <h3>What a UI app can open</h3>
            <p>A UI app runs in a closed frame in the window of Dez. It can use only these:</p>
            <ul>
              <li>Its own files. It can read them, and it cannot change them.</li>
              <li>
                The libraries that come with Dez (see Libraries below), but not skia-canvas and the
                parts of dez-media that need it or write files. It can read them, and it cannot
                change them.
              </li>
              <li>
                The images and the clips of the conversation that shows it, also a file that a
                message links. The app gets their bytes, and never a path or a file name.
              </li>
              <li>
                A save of a new image or clip, which goes into the message that you write. Dez takes
                a save only while you work in the app (the app has the keyboard, or the pointer is
                over it) and while no reply runs. An app can save at most
                {{ APP_LIMITS.savedFiles }} files from Run to Stop, each of at most
                {{ APP_LIMITS.savedFileSize }}. Dez reads the type of a file from its first bytes,
                and stores only an image or a clip.
              </li>
            </ul>
            <p>
              A UI app cannot connect to the internet or to any server, also not for a font, a
              library, or an image. It has no storage, no cookies, and no download, and its code
              cannot read the clipboard. It opens no window and no other page. It gets no text of a
              conversation, no API key, no other app, no Dez tool, and no other file of your
              computer.
            </p>
            <p>
              One limit: the page of an app runs in the window of Dez itself. While the code of a
              page is busy, the window of Dez does not answer. A page whose code never ends (an
              endless loop) stops the window for good. Stop cannot work then: you must quit Dez and
              start it again. Ask a model to correct such an app before you run it again.
            </p>

            <h3>Code that a model runs</h3>
            <p>
              A model can run code on your computer in two ways. Both use Deno, a program that comes
              with Dez (see
              <button type="button" class="help-link" @click="page = 'thanks'">Thank You</button>).
              Deno runs the code in a sandbox: the next part tells what the code can open.
            </p>
            <p>
              With the Dez tool <code>js_eval</code>, a model runs a short piece of JavaScript or
              TypeScript and gets its result: for example for exact arithmetic, a date, or a sort.
              The code has no network and no environment variables, and it can start no program. It
              can read and write the files of the work folder of the conversation, and import the
              libraries that come with Dez (see Libraries below), and it opens no other file. It can
              call the other Dez tools (but not <code>apps invoke</code>), at most
              {{ CODE_LIMITS.toolCalls }} times in one run, so one piece of code can do a chain of
              tool calls. With the <code>apps</code> tool, the code can also read and change the
              files of the apps. It works on your images and clips only through those tools, by
              their ids: it gets no file of them. Dez stops code that
              runs longer than {{ CODE_LIMITS.seconds }} seconds (a model can ask for up to
              {{ CODE_LIMITS.mostMinutes }} minutes), and code that writes more than
              {{ CODE_LIMITS.output }} of output. Click the chip of the call to see the code, its
              result, and each tool call that the code made.
            </p>
            <p>
              With <code>apps invoke</code>, a model runs an app as a job, with parameters and with
              the assets of the conversation that it names by id. A script app runs in Deno. A UI
              app runs in a page of {{ APP_RUN_FRAME_SIZE.width }} by
              {{ APP_RUN_FRAME_SIZE.height }} pixels that you do not see, and that Dez removes at
              the end of the run. A file that you dropped or linked reaches the code only as a copy
              (a script app) or as bytes (a UI app): the code learns no path and no file name, and
              nothing that it writes reaches your file. The run gives the model a text, and the
              files that the app made. Dez keeps at most {{ APP_LIMITS.savedFiles }} files of one
              run, each of at most {{ APP_LIMITS.savedFileSize }}. It reads the type of each file
              from its first bytes, and stores a copy of each image and clip as an asset of the
              conversation. A run that fails keeps none of these files. Dez stops a run after
              {{ APP_LIMITS.runMinutes }} minutes, unless the model sets another time limit.
            </p>
            <p>
              The code of a script app also reads and writes the work folder of the conversation.
              Before the run, Dez can decode the clips of the call into the samples of their sound
              and the pixels of their frames, at most {{ APP_LIMITS.decodedSize }} in one run, so
              that the code can measure them. The code can also write the frames of a video one by
              one, and after the run Dez makes one clip of them, which counts as one file of the
              run: at most {{ APP_LIMITS.frames }} frames, of at most {{ FRAMES_MAX_SIDE }} by
              {{ FRAMES_MAX_SIDE }} pixels, at {{ FRAMES_MIN_FPS }} to {{ FRAMES_MAX_FPS }} frames
              each second. A clip of frames with a transparent background is a MOV file, which
              keeps the transparency.
            </p>
            <p>
              The code of a script app can also call the Dez tools, as the code of
              <code>js_eval</code> does (but not <code>js_eval</code>, <code>apps invoke</code>, or
              <code>apps show</code>), at most {{ APP_LIMITS.toolCalls }} times in one run. An image
              or a clip that such a call makes is a part of the result of the job, also when the
              code fails after the call. When Dez stops the run, it keeps none of them.
            </p>

            <!-- The libraries and their uses come from `SHIPPED_LIBRARIES`
                 (src/model/tools/appsTool.ts), the list of the tool texts. -->
            <h3>Libraries</h3>
            <p>
              Dez comes with libraries for this code, which a model reads in
              <code>{{ LIBS_VIRTUAL_ROOT }}/</code> and cannot change:
            </p>
            <ul>
              <li v-for="library in SHIPPED_LIBRARIES" :key="library.name">
                <code>{{ library.name }}</code>: {{ library.use }}
              </li>
            </ul>
            <p>
              The code of <code>js_eval</code> and of a script app, and the page of a UI app, import
              them by their names. A page cannot import skia-canvas, or the parts of dez-media that
              draw with it or write files. Only a script app imports skia-canvas, and only when its
              <code>{{ MANIFEST_FILE }}</code> asks for it. It draws text with the fonts that come
              with Dez: the run sees no font of your computer. No code loads a library from the
              internet. The
              <button type="button" class="help-link" @click="page = 'thanks'">Thank You</button>
              page names the projects of the libraries.
            </p>

            <h3>The sandbox</h3>
            <p>
              The code of <code>js_eval</code> and of a script app is code that a model wrote, so it
              runs behind two guards. The first is a rule of the system (Landlock and a filter of
              system calls on Linux, Seatbelt on macOS), which holds also when the second fails. The
              second is the permissions of Deno. Behind them:
            </p>
            <ul>
              <li>
                The rule of the system lets the code of <code>js_eval</code> open only the run
                folder of its call, in
                <code v-if="runFoldersDir">{{ runFoldersDir }}</code><template v-else>the cache folder of the system</template>,
                and the work folder of its conversation, and read the libraries of Dez. The
                permissions of Deno let it read and write only the work folder (only the rule of the
                system stops an <code>import</code> of a file). Dez deletes the run folder at the
                end of the run.
              </li>
              <li>
                The code of a script app can open only its run folder, the folder of its own app,
                and the work folder of its conversation, and read the libraries and the fonts of
                Dez. So a script app can keep data in its folder from one run to the next. A
                built-in app cannot change its own folder. Dez deletes the run folder at the end of
                the run.
              </li>
              <li>
                No code can open your conversations, your API keys, the <code>assets</code> folder,
                another app, another run folder, the work folder of another conversation, or any
                other file of yours.
              </li>
              <li>
                No code can connect to the internet or to another program, and none can load a
                package or other code from the internet.
              </li>
            </ul>
            <p>
              A Linux system without Landlock (a part of the kernel since Linux 5.13) cannot set the
              rule of the system. There, Dez does not run Deno at all: <code>js_eval</code> and a
              run of a script app give the model an error, and Help › Developer Console shows why.
            </p>
            <p>No sandbox is perfect. These are the limits of this one that Dez knows:</p>
            <ul>
              <li>
                Memory: on Linux, a run can take about 2 GB at the most. On macOS, only the
                JavaScript memory of a run has a limit (512 MB), so a run can take more there.
              </li>
              <li>
                Disk space: nothing limits how much a run writes into its folders, so a script app
                can fill the folder of its app, and code can fill the work folder.
              </li>
              <li>
                skia-canvas is native code, which Deno does not check: for its file opens, the rule
                of the system is the only guard. Only a script app that asks for skia-canvas loads
                it.
              </li>
              <li>
                Code that gets past Deno through a fault of Deno has only the rule of the system
                against it. It still cannot read a file of yours. But it can learn the facts of a
                file whose path it knows (that the file is there, its size, and its time), and it
                can start more programs, which are under the same rule.
              </li>
              <li>
                On macOS, the rule of the system guards the files and the network, but it has no
                filter of system calls: such code can reach other programs of yours there, for
                example with a signal. There, only the guards of the files and the network were
                tested with attack code.
              </li>
            </ul>

            <h3>How apps are deleted</h3>
            <p>An app stays until one of these deletes it:</p>
            <ul>
              <li>You click the trash of the app, and say yes.</li>
              <li>
                You click Delete Unreferenced Apps in Settings › General, and say yes. Dez then
                deletes each app that no conversation and no saved prompt names: the question names
                each of these apps. A text names an app by its path
                (<code>{{ APPS_VIRTUAL_ROOT }}/</code> and its name), by its card, or by a call of
                the <code>apps</code> tool with its name. Dez keeps an app that changed in the last
                {{ APP_LIMITS.unusedMinutes }} minutes, and an app with more than
                {{ APP_LIMITS.entries }} files and folders. Delete Unreferenced Files never deletes
                an app.
              </li>
              <li>
                A model deletes the app, or files of it, with the <code>apps</code> tool. Dez does
                not ask you first.
              </li>
            </ul>
            <p>
              The delete of a conversation leaves its apps. A compaction keeps them too: its notes
              list each app of the conversation with its kind and its description. But the card of
              a shown app goes with the reply that held it: ask the model to show the app again.
            </p>
          </section>

          <section v-if="page === 'support'" class="help-page help-page--support">
            <p>Ask questions, share ideas, and report problems in the Dez discussions on GitHub:</p>
            <p>
              <!-- A button, not an <a href>: a link would load the page in
                   the app window. The system browser opens it. -->
              <button type="button" class="help-link" @click="sbp('dez.controller/openUrl', DEZ_DISCUSSIONS_URL)">
                {{ DEZ_DISCUSSIONS_URL }}
              </button>
            </p>
          </section>

          <section v-if="page === 'thanks'" class="help-page help-page--thanks">
            <!-- The version and the link come from the manifest of the
                 programs that this build holds, so they are true for every
                 Dez version, and the link needs no file of the Dez
                 repository. `bundle.resources` ships the notice and the
                 license texts (src-tauri/binaries/NOTICE.md, LICENSES.txt)
                 in the ffmpeg folder of the resources. -->
            <h3>FFmpeg</h3>
            <p>
              Dez comes with ffmpeg and ffprobe, two programs of the FFmpeg project (version
              {{ bundledPrograms.ffmpegVersion }}). They are separate programs with their own license,
              the GNU General Public License, version 3 or later. Dez ships the files of this
              release, with the license texts of FFmpeg and of the libraries in the programs, and the
              release lists the versions of their source code:
            </p>
            <p>
              <button type="button" class="help-link help-link--ffmpeg" @click="sbp('dez.controller/openUrl', bundledPrograms.source)">
                {{ bundledPrograms.source }}
              </button>
            </p>

            <!-- As for FFmpeg, from the same manifest: scripts/update-deno.js
                 writes its `deno` part. The notice and the license texts
                 (src-tauri/binaries/deno/) are in the deno folder of the
                 resources. -->
            <h3>Deno</h3>
            <p>
              Dez comes with Deno (version {{ bundledPrograms.deno.version }}), a program of the
              Deno project that runs JavaScript and TypeScript. It is a separate program with its own
              license, the MIT License. Dez ships the program of this release, with the license
              texts of Deno and of the code of other projects in the program, such as the V8 engine:
            </p>
            <p>
              <button type="button" class="help-link help-link--deno" @click="sbp('dez.controller/openUrl', bundledPrograms.deno.source)">
                {{ bundledPrograms.deno.source }}
              </button>
            </p>

            <!-- The libraries come from the manifest of the libraries that
                 this build holds (src-tauri/libs/manifest.json), which
                 scripts/update-libs.js writes. The bundle holds the whole
                 folder: the license file of each library is in its folder,
                 and the license texts of the native file of skia-canvas are
                 skia-canvas/NATIVE-LICENSES.txt. dez-media is code of Dez,
                 so the manifest does not list it. -->
            <h3>Libraries</h3>
            <p>
              Dez comes with these libraries for the code that a model runs and for the pages of
              apps (see the
              <button type="button" class="help-link" @click="page = 'apps'">Apps</button> page).
              Each one is the code of its own project, with its own license, and Dez ships the
              license text with it:
            </p>
            <ul>
              <li v-for="library in LIBRARY_SOURCES" :key="library.package">
                {{ library.package }} {{ library.version }} ({{ library.license }} License):
                <button type="button" class="help-link help-link--library" @click="sbp('dez.controller/openUrl', library.repository)">
                  {{ library.repository }}
                </button>
              </li>
            </ul>
            <p>
              The native part of skia-canvas holds Skia, the 2D graphics library of the Skia project
              (BSD 3-Clause License), with the libraries that Skia uses, and the Rust code of
              skia-canvas. Dez ships their license texts with skia-canvas.
            </p>

            <!-- The fonts and their sources come from the manifest of the
                 fonts that this build holds. scripts/update-fonts.js, its one
                 writer, takes only fonts of the SIL Open Font License 1.1, and
                 the bundle holds the whole folder: the license file of each
                 source is next to its fonts. -->
            <h3>Fonts</h3>
            <p>
              Dez comes with fonts for the text that the Dez tool <code>video</code> and the script
              apps draw on images and clips, as these programs can use no font of your system. The
              fonts have their
              own license, the SIL Open Font License, version 1.1, and Dez ships the license with
              them. They come from these projects:
            </p>
            <ul>
              <li v-for="source in FONT_SOURCES" :key="source.repository">
                {{ source.families.join(', ') }}:
                <button type="button" class="help-link help-link--font" @click="sbp('dez.controller/openUrl', source.repository)">
                  {{ source.repository }}
                </button>
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* The overlay, modal, header, and nav of SettingsView.vue, in a smaller
   modal: most pages are short, and a long one scrolls. One size for every
   page, so the modal does not move when the user switches pages. */
.help-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}

.help-modal {
  width: min(720px, calc(100vw - 48px));
  height: min(80vh, 440px);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.25);
}

.help-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.help-header h2 {
  font-size: 15px;
  font-weight: 600;
}

.help-close {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0.5;
  transition: opacity 0.15s;
}

.help-close:hover {
  opacity: 1;
}

.help-body {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.help-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px;
  width: 140px;
  flex-shrink: 0;
  border-right: 1px solid var(--color-border);
}

.help-nav-btn {
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity 0.15s, background 0.15s;
}

.help-nav-btn:hover {
  opacity: 0.9;
  background: var(--color-border);
}

.help-nav-btn--active {
  opacity: 1;
  background: var(--color-border);
  font-weight: 500;
}

/* A stable gutter, as `.settings-scroller` has: a classic scrollbar that
   comes or goes then never changes the width of the text. */
.help-content {
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 16px 20px;
  min-height: 0;
}

.help-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: 13px;
  line-height: 1.6;
  user-select: text;
  -webkit-user-select: text;
}

.help-page kbd,
.help-page code {
  padding: 1px 5px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-family: inherit;
  font-size: 12px;
  white-space: nowrap;
}

.help-page code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

/* A heading of a page with more than one topic. It stands closer to its
   own text than to the text before it. */
.help-page h3 {
  margin-top: 8px;
  margin-bottom: -6px;
  font-size: 13px;
  font-weight: 600;
}

.help-page h3:first-child {
  margin-top: 0;
}

/* The global reset takes the padding of a list, so its bullets would be
   outside the page. */
.help-page ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 18px;
}

/* The folder list of the Assets page: the folders of a row at the left, one
   to a line, and what they hold at the right, on the text line of the
   first folder. */
.help-folders {
  display: grid;
  grid-template-columns: max-content 1fr;
  align-items: baseline;
  gap: 6px 20px;
}

/* A folder name of the list has no box: a column of boxes would look like
   a stack of buttons. */
.help-folders code {
  display: block;
  padding: 0;
  border: none;
}

.help-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-link);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.help-link:hover {
  text-decoration: underline;
}
</style>
