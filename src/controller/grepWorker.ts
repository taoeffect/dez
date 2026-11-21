import { grepFiles, type GrepRequest } from '../model/tools/grepMatch'

// The Web Worker of `apps grep` (`grepInWorker`, appsTool.ts). It matches
// the lines of the files on a thread of its own: a regular expression can
// backtrack for minutes on one line, and on the thread of the page that
// would stop the whole window of Dez. In a worker Dez ends it at the time
// limit. The worker gets one request and gives one outcome; Dez ends it
// after that.
//
// The DOM types give `self` the type of a window, whose `postMessage` with
// one argument is that of a worker too.
self.onmessage = (event: MessageEvent<GrepRequest>) => {
  self.postMessage(grepFiles(event.data))
}
