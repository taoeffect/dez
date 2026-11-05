#!/usr/bin/env node
/**
 * Writes the GitHub release body for a Dez release tag: the text of
 * .github/release-notes-template.md (the only source of that text), then a
 * "## Changes" part that an AI model writes from the commit messages since
 * the previous release, in the style of the hand-written v0.8.0 notes. The
 * release workflow runs it, and it also runs on a local machine (see USAGE).
 *
 * The release workflow keeps the notes of a release that already exists. To
 * write new notes for it, run this script locally, then
 * `gh release edit <tag> --notes-file <file>`.
 *
 * It uses only Node built-ins: the workflow job that holds the API key then
 * needs no `npm ci`, so no third-party package code runs next to the key.
 * So the reply shape is checked by hand, not with Zod.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = join(repoRoot, '.github', 'release-notes-template.md');

// OpenAI-compatible chat completion endpoints, by REVIEW_PROVIDER, and the
// environment variable that holds the API key of each.
const PROVIDERS = {
  'zai-coding-plan': {
    url: 'https://api.z.ai/api/coding/paas/v4/chat/completions',
    keyVariable: 'ZAI_API_KEY',
  },
};

// GLM models spend most completion tokens on hidden reasoning before they
// write the answer, so a small limit cuts the notes off.
const MAX_COMPLETION_TOKENS = 32_768;
const REQUEST_TIMEOUT_MS = 10 * 60_000;
const COMMIT_SEPARATOR = '\n---END COMMIT---\n';

// A squash commit holds the whole log of its branch (the v0.9.0 one has
// 16 kB), so one message can be long. The total is about 25k tokens.
export const COMMIT_BUDGET = {
  maxMessageChars: 40_000,
  maxTotalChars: 100_000,
  separatorChars: COMMIT_SEPARATOR.length,
};

const USAGE = `Usage:
  node scripts/release-notes.js <tag> [--out <file>]

Writes the GitHub release body for the release <tag> (such as v0.9.0) to
--out, or to stdout: .github/release-notes-template.md, then "## Changes"
that an AI model writes from the commit messages since the previous release.

Environment variables:
  REVIEW_MODEL     the model id, such as glm-5.3
  REVIEW_PROVIDER  the endpoint, one of: ${Object.keys(PROVIDERS).join(', ')}
  and the API key of that provider: ${Object.entries(PROVIDERS).map(([name, provider]) => `${provider.keyVariable} for ${name}`).join(', ')}

It needs a clone with the full history and tags, and gh: GH_REPO or the
clone's remote picks the repository. The previous release is the published
GitHub release whose tag is the nearest ancestor of <tag> in history. If gh
cannot list the releases or none fits, it is the nearest v* tag merged into
<tag>; with no such tag, the notes cover the whole history.`;

const SYSTEM_PROMPT = `You write the changes part of the GitHub release notes for Dez, a desktop app for chatting with AI models. You get the git commit messages of one release.

Write for the people who use Dez, not for its developers:
- Use up to three groups, in this order: **NEW** for new features, **ENHANCEMENT** for improvements to features that existed before, and **FIXES** for bugs that users could see. Leave out a group that has no bullets.
- A group is its label alone on a line, a blank line, then one "- " bullet per change.
- A bullet is one short, plain sentence of about 4 to 12 words that says what users can now do or what now works. Do not explain how it works or list its parts. No period at the end. A NEW bullet often starts with "Ability to" or names the new thing; never start a bullet with a verb in the imperative, such as "Add". Name a keyboard shortcut in parentheses when the commits give one, such as (Cmd/Ctrl+S).
- Write one bullet per change that matters to users. Merge the commits about one change into one bullet. Small polish of a new feature is part of the bullet for that feature.
- Never name internal things: task prefixes before a colon (such as "custom-providers:" or "features-and-bugs:"), review rounds (such as "address review issue 2"), files, functions, selectors, components, settings keys, or libraries.
- Leave out what users do not see: tests, CI, release workflows, build scripts, docs, refactors, code cleanup, version bumps, and fixes to changes that the same release adds.
- Use only what the commit messages say. Do not invent changes or details.
- Reply with the groups only: no heading, introduction, summary, or code fence.
- If no change is worth a note, reply with only the word NONE.

An example of the format, not of real changes:

**NEW**

- Ability to export a conversation as a PDF file (Cmd/Ctrl+E)

**ENHANCEMENT**

- The model picker remembers the last model you searched for

**FIXES**

- Pasting text with tabs no longer moves the cursor to the wrong place`;

/**
 * Keeps the newest commit messages (`messages` is newest first) that fit in
 * `budget`. A message longer than `maxMessageChars` is cut and ends with "…".
 */
export function keepNewestThatFit(messages, budget) {
  const kept = [];
  let size = 0;
  for (const message of messages) {
    const bounded = message.length > budget.maxMessageChars
      ? `${message.slice(0, budget.maxMessageChars)}…`
      : message;
    size += bounded.length + budget.separatorChars;
    if (size > budget.maxTotalChars) break;
    kept.push(bounded);
  }
  return { kept, omitted: messages.length - kept.length };
}

/**
 * Returns the notes in a chat completion reply, or '' when the model replied
 * NONE (no change worth a note). Z.ai sends replies that ended early
 * (`length`, `sensitive`, `network_error`) with HTTP 200, and a reply cut off
 * during the hidden reasoning has empty content. So only `finish_reason:
 * "stop"` with text counts as complete: a cut-off reply must fail the run,
 * not look like "no changes".
 */
export function readReleaseNotesReply(body) {
  const choice = body?.choices?.[0];
  if (!choice || typeof choice !== 'object') {
    throw new Error('Unexpected reply: it has no choices');
  }
  if (choice.finish_reason !== 'stop') {
    throw new Error(choice.finish_reason === 'length'
      ? `The model stopped at the ${MAX_COMPLETION_TOKENS}-token limit before the notes were complete`
      : `The model did not complete the notes (finish_reason: ${choice.finish_reason ?? 'none'})`);
  }
  const content = choice.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Unexpected reply: the message has no text content');
  }
  const notes = content
    .replace(/^\s*```[a-z]*[^\S\n]*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim();
  if (!notes) {
    throw new Error('The model sent an empty reply instead of the notes or NONE');
  }
  return notes === 'NONE' ? '' : notes;
}

/**
 * Returns the release body: the template, then "## Changes" with the notes
 * and a line that names the model. With no notes (the model replied NONE, or
 * the release has no commits), it is the template only.
 */
export function formatReleaseBody({ template, notes, model }) {
  const intro = template.trimEnd();
  if (!notes) {
    return `${intro}\n`;
  }
  return `${intro}\n\n## Changes\n\n${notes}\n\nRelease notes generated by ${model}.\n`;
}

/**
 * Returns the tag in `candidates` that is nearest to `tag` in history, or
 * undefined when none is an ancestor of `tag`. `isAncestor(a, b)` says
 * whether tag a is an ancestor of tag b. gh and git list tags by date, and a
 * release made again for an old tag is listed first, so the list order must
 * not pick the tag. It decides only between tags on parallel branches, where
 * neither is nearer.
 */
export function nearestAncestorTag(tag, candidates, isAncestor) {
  let nearest;
  for (const candidate of candidates) {
    if (candidate === tag || !isAncestor(candidate, tag)) {
      continue;
    }
    // A descendant of the current pick is nearer to `tag`.
    if (nearest === undefined || isAncestor(nearest, candidate)) {
      nearest = candidate;
    }
  }
  return nearest;
}

/**
 * Returns the text of an error for the log. Node's fetch reports every
 * network and TLS failure only as "fetch failed", and the reason (such as
 * ECONNREFUSED or a certificate error) is in `error.cause`, so the causes
 * follow in parentheses. When all addresses of a host fail, the cause is an
 * AggregateError with an empty message and one error per address. These
 * causes hold no request headers.
 */
export function describeError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const message = error.message.trim()
    || (error instanceof AggregateError ? error.errors.map(describeError).join('; ') : '')
    || String(error.code ?? error.name);
  return error.cause === undefined ? message : `${message} (${describeError(error.cause)})`;
}

function git(args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasTag(tag) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
  return result.status === 0;
}

// `git merge-base --is-ancestor` exits with 1 for "no" and above 1 on errors.
function isAncestor(ancestorTag, tag) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', `refs/tags/${ancestorTag}`, `refs/tags/${tag}`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status === 0 || result.status === 1) {
    return result.status === 0;
  }
  throw new Error(`git merge-base --is-ancestor ${ancestorTag} ${tag} failed: ${(result.stderr ?? '').trim()}`);
}

/**
 * Returns the tag of the previous release (see USAGE), or undefined when
 * there is none and the notes cover the whole history.
 */
function findPreviousRelease(tag) {
  const list = spawnSync('gh', ['release', 'list', '--exclude-drafts', '--limit', '100', '--json', 'tagName'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (list.status === 0) {
    const releases = JSON.parse(list.stdout);
    if (!Array.isArray(releases)) {
      throw new Error('Unexpected output from gh release list: not an array');
    }
    // isAncestor fails on a tag that this clone does not have.
    const releaseTags = releases
      .map(release => release?.tagName)
      .filter(name => typeof name === 'string' && hasTag(name));
    const previous = nearestAncestorTag(tag, releaseTags, isAncestor);
    if (previous) {
      return previous;
    }
  } else {
    const reason = (list.stderr || list.error?.message || '').trim();
    console.error(`Could not list the GitHub releases; using merged tags instead. ${reason}`);
  }
  const mergedTags = git(['tag', '--merged', `refs/tags/${tag}`, '--sort=-creatordate', '--list', 'v*'])
    .split('\n')
    .filter(Boolean);
  return nearestAncestorTag(tag, mergedTags, isAncestor);
}

function readCommitMessages(tag, previous) {
  const range = previous ? [`refs/tags/${tag}`, `^refs/tags/${previous}`] : [`refs/tags/${tag}`];
  const messages = git(['log', '-z', '--format=%B', ...range, '--'])
    .split('\0')
    .map(message => message.trim())
    .filter(Boolean);
  return keepNewestThatFit(messages, COMMIT_BUDGET);
}

function buildUserPrompt({ tag, previous, commits }) {
  const omitted = commits.omitted > 0
    ? `\n\n(${commits.omitted} older commit ${commits.omitted === 1 ? 'message is' : 'messages are'} left out.)`
    : '';
  return `Write the release notes for Dez ${tag}. They cover the commits since ${previous ?? 'the start of the repository'}.

Commit messages, newest first, separated by "---END COMMIT---" lines:

${commits.kept.join(COMMIT_SEPARATOR)}${omitted}`;
}

/**
 * Returns the API key of a known provider from env, without whitespace at
 * the ends. fetch puts an invalid header value, so the whole key, in its
 * error message, and main prints that message. So a key that holds a line
 * break or NUL is refused here, before any request, with an error that
 * does not hold the key.
 */
export function readApiKey(env, providerName) {
  const { keyVariable } = PROVIDERS[providerName];
  const apiKey = env[keyVariable]?.trim();
  if (!apiKey) {
    throw new Error(`${keyVariable} (the API key for ${providerName}) is not set`);
  }
  if (/[\0\r\n]/.test(apiKey)) {
    throw new Error(`${keyVariable} holds a line break or NUL, so it is not a valid API key`);
  }
  return apiKey;
}

// Never log the key or the request headers.
async function requestReleaseNotes({ url, apiKey, model, user }) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: MAX_COMPLETION_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = (await response.text()).slice(0, 2000);
    throw new Error(`The release notes request failed with HTTP ${response.status}: ${text}`);
  }
  return readReleaseNotesReply(await response.json());
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length !== 1) {
    throw new Error(`Expected exactly one <tag> argument.\n\n${USAGE}`);
  }
  const [tag] = positionals;
  const model = process.env.REVIEW_MODEL;
  const providerName = process.env.REVIEW_PROVIDER;
  if (!model) {
    throw new Error('REVIEW_MODEL is not set');
  }
  if (!providerName) {
    throw new Error('REVIEW_PROVIDER is not set');
  }
  if (!Object.hasOwn(PROVIDERS, providerName)) {
    throw new Error(`Unknown REVIEW_PROVIDER "${providerName}"; known providers: ${Object.keys(PROVIDERS).join(', ')}`);
  }
  const provider = PROVIDERS[providerName];
  const apiKey = readApiKey(process.env, providerName);
  if (!hasTag(tag)) {
    throw new Error(`This clone has no tag ${tag}`);
  }

  const template = readFileSync(templatePath, 'utf8');
  const previous = findPreviousRelease(tag);
  const commits = readCommitMessages(tag, previous);
  const commitCount = commits.kept.length + commits.omitted;
  console.error(`Release notes for ${tag} cover ${commitCount} commit${commitCount === 1 ? '' : 's'} since ${previous ?? 'the start of the repository'}`);
  if (commits.omitted > 0) {
    console.error(`Left out the ${commits.omitted} oldest commit ${commits.omitted === 1 ? 'message' : 'messages'} to bound the request size`);
  }
  // With no commits, a request could only invent changes.
  const notes = commits.kept.length > 0
    ? await requestReleaseNotes({ url: provider.url, apiKey, model, user: buildUserPrompt({ tag, previous, commits }) })
    : '';
  const body = formatReleaseBody({ template, notes, model });
  if (values.out) {
    writeFileSync(values.out, body);
    console.error(`Wrote ${values.out}`);
  } else {
    process.stdout.write(body);
  }
}

// Run only when Node runs this file, not when a test imports it.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch(error => {
    console.error(`release-notes: ${describeError(error)}`);
    process.exit(1);
  });
}
