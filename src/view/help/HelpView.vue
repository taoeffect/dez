<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import sbp from '@sbp/sbp'
import { useModelState } from '../modelState'
import { IMAGE_FOLDERS } from '../../model/chat/images'
import { MEDIA_TEMP_LIFETIME_MS } from '../../model/chat/mediaFiles'
import { MEDIA_CACHE_FOLDER, MEDIA_FOLDERS } from '../../model/chat/mediaTags'
import { SHOWN_PICTURE_FOLDER } from '../../model/chat/shownPictures'
import { CHAT_IMAGE_SIDE } from '../../model/providers/imageSize'
import { WORK_FOLDER_LIFETIME_MS, WORK_ROOT } from '../../model/tools/workFolders'
import { shortcutKeyText } from '../../model/shortcuts'
import { countText } from '../../utils/countText'
import { DEZ_DISCUSSIONS_URL } from '../../utils/dezLinks'
import bundledFfmpeg from '../../../src-tauri/binaries/manifest.json'

type HelpPage = 'general' | 'tips' | 'assets' | 'support'

const PAGES: { id: HelpPage; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'tips', label: 'Tips' },
  { id: 'assets', label: 'Assets' },
  { id: 'support', label: 'Support' },
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
// the folder of the temp copies of clips, and the folder of the work
// folders, as the Assets page shows them (`~` for the home folder). The
// cache folder differs by system, so the page reads the folders and spells
// none. Null until the read ends, and for a folder that cannot be read: the
// page then names the folder with no path.
const appDir = ref<string | null>(null)
const cacheDir = ref<string | null>(null)
const tempDir = ref<string | null>(null)
const workDir = ref<string | null>(null)

onMounted(async () => {
  const [app, cache] = await Promise.all([
    sbp('dez.controller/displayAppDir') as Promise<string | null>,
    sbp('dez.controller/displayAppDir', 'cache') as Promise<string | null>,
  ])
  appDir.value = app
  cacheDir.value = cache
  tempDir.value = cache === null ? null : `${cache}/${MEDIA_CACHE_FOLDER}`
  workDir.value = cache === null ? null : `${cache}/${WORK_ROOT}`
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
              shows the settings of that model. Add your API keys and your own providers in Settings
              (<kbd>{{ keys.settings }}</kbd>) › Providers. Models can use Dez tools, for example to
              find other models, to ask them for images and clips, and to cut and join clips. Slow
              tool work, such as a request for an image, runs as a job. A stop or a new message does
              not end the jobs of a reply: the next reply of the tab can wait for them and get their
              results. To end a job that you no longer need, ask the model to cancel it. A close of
              the tab ends all its jobs. Dez saves each conversation: History
              (<kbd>{{ keys.history }}</kbd>) opens it again.
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
              the cost too, with a Dez tool. So you can give a model a budget, as in "spend at most
              5 dollars".
            </p>
            <p>
              A long conversation can get too large for one request to the model. Dez then compacts
              it: it asks the model for notes of the work so far, and the notes take the place of
              the earlier messages and replies. The notes keep your first message, your newest
              message, and each message between them that the work still needs, word for word, with
              their images. The model chooses which of the messages between them to keep, and the
              notes tell how many of them Dez left out so far. The bottom bar shows "Compacting…"
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
              Paste or drop images, audio, and video into a message. A model that makes images,
              audio, or video puts them in its reply. The
              <button type="button" class="help-link" @click="page = 'assets'">Assets</button> page
              tells which of them a model sees, and where Dez keeps their files. Type
              <code>/prompt</code> and a space to insert a saved prompt (Settings › Prompts).
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
              a transcription model. Dez sends a chat model only the id of a clip. A model that needs
              an image and can work with one, for example an image editor, takes the newest image
              of the conversation when your message has none.
            </p>
            <p>
              A chat model can ask another model for an image, a clip, a transcription, or an
              answer. It names by id the assets that the other model gets, so that model can also
              get an asset of an older message or of a reply.
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
              made it. It can also check a whole clip for black, frozen, or silent parts, for its
              loudness over time, and for its cuts.
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

            <h3>Intermediate assets</h3>
            <p>
              A chat model that asks another model for an image or a clip, or that joins or changes
              clips with the Dez tool <code>video</code>, can mark what it makes as intermediate: a
              part of its work, for example a clip that it then joins with others, and not the
              result that you asked for. Dez hides such an asset in the reply, and the chip of its
              tool call says "intermediate asset hidden". Click the chip to see the asset.
            </p>
            <p>
              A hidden asset is an asset as any other: it has an id, you can name it with
              <code>@</code> and the id, its trash and Save work in the open chip, and Delete Unused
              Files keeps its file.
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
              asset that a job still uses, or an asset that the notes name. An asset that a message
              of yours names stays too, when the notes keep that message. So to keep an asset
              of an earlier reply, name it in your message with <code>@</code> and its id. A dropped
              asset leaves the conversation. Dez deletes the file of a dropped intermediate asset at
              once. The file of any other dropped asset stays until you click Delete Unused Files.
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
              that time, Delete Unused Files in Settings › General deletes a temporary copy that no
              conversation uses.
            </p>
            <p>
              A Dez tool that cuts, joins, or converts clips stores its new clips and images at
              once, in the folders above. It works on copies of the assets, in a work folder in
              <code v-if="workDir">{{ workDir }}</code><template v-else>the cache folder of the system</template>,
              so the assets that it reads stay as they are. Dez deletes the work folder at the end
              of the work, or {{ WORK_FOLDER_HOURS }} hours later if Dez closed before that. Before
              that time, Delete Unused Files deletes such a work folder.
            </p>
            <!-- The rule is in src-tauri/src/confinement.rs (Landlock on
                 Linux, Seatbelt on macOS), its folders are in
                 `run_bundled_tool` (src-tauri/src/bundled_tools.rs), and the
                 checks of a command line are `argumentProblem` in
                 src/model/tools/videoTool.ts. -->
            <p>
              Such a tool runs ffmpeg or ffprobe, programs that come with Dez. The system lets them
              open only the files in
              <code v-if="cacheDir">{{ cacheDir }}</code><template v-else>the folder of Dez in the cache folder of the system</template>
              and in the <code>assets</code> folder of the Dez folder: not your conversations, your
              API keys, or any other file of yours. In the <code>assets</code> folder, they can
              read, add, and change files, but not delete or move them. Dez also refuses a command
              line that names another file, a web address, or a device such as a camera. A Linux
              system without Landlock (a part of the kernel since Linux 5.13) cannot set this
              limit: there, the checks of Dez are the only guard.
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
                Click Delete Unused Files in Settings › General. Dez finds the stored files that no
                conversation uses, and deletes them after you say yes. In the cache folder, it also
                deletes the temporary copies of clips that no conversation uses, and the work folders
                and downloads that Dez did not finish.
              </li>
            </ul>
            <p>
              An edit of the text and the delete of a conversation leave the files where they are.
              Dez never deletes a linked file: its trash removes it only from the conversation.
            </p>
            <p>
              A compaction is the one exception: it deletes the file of each intermediate asset that
              it drops. It also deletes the picture copies of the text that it replaces, which are
              no assets.
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

            <!-- The version and the link come from the manifest of the
                 programs that this build holds, so they are true for every
                 Dez version, and the link needs no file of the Dez
                 repository. The full notice is src-tauri/binaries/NOTICE.md. -->
            <h3>FFmpeg</h3>
            <p>
              Dez comes with ffmpeg and ffprobe, two programs of the FFmpeg project (version
              {{ bundledFfmpeg.ffmpegVersion }}). They are separate programs with their own license,
              the GNU General Public License, version 3 or later. Dez ships the files of this
              release, and the release lists the versions of their source code:
            </p>
            <p>
              <button type="button" class="help-link help-link--ffmpeg" @click="sbp('dez.controller/openUrl', bundledFfmpeg.source)">
                {{ bundledFfmpeg.source }}
              </button>
            </p>
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
