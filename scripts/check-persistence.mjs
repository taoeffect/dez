import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'vite'

const root = process.cwd()
const tempDir = await mkdtemp(join(tmpdir(), 'dez-persistence-'))
const bundlePath = join(tempDir, 'persistence-check.mjs')

async function bundlePersistenceModules() {
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      lib: {
        entry: join(root, 'src/model/persistence/conversationFormat.ts'),
        formats: ['es'],
        fileName: () => 'persistence-check.mjs',
      },
      rollupOptions: {
        external: [],
        input: join(root, 'src/model/persistence/conversationFormat.ts'),
        output: {
          dir: tempDir,
          entryFileNames: 'persistence-check.mjs',
        },
      },
      outDir: tempDir,
      emptyOutDir: false,
    },
  })
}

async function bundleAllModules() {
  const entry = join(tempDir, 'entry.ts')
  await writeFile(entry, `
    export * from ${JSON.stringify(join(root, 'src/model/persistence/conversationFormat.ts'))}
    export * from ${JSON.stringify(join(root, 'src/model/persistence/summaries.ts'))}
    export * from ${JSON.stringify(join(root, 'src/model/persistence/appState.ts'))}
    export * from ${JSON.stringify(join(root, 'src/model/persistence/prompts.ts'))}
  `)
  await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      lib: {
        entry,
        formats: ['es'],
        fileName: () => 'persistence-check.mjs',
      },
      rollupOptions: {
        external: [],
        output: {
          dir: tempDir,
          entryFileNames: 'persistence-check.mjs',
        },
      },
      outDir: tempDir,
      emptyOutDir: false,
    },
  })
}

function textNode(text) {
  return { kind: 'text', text }
}

function section(role, nodes) {
  return { role, nodes }
}

function textContent(node) {
  assert.equal(node.kind, 'text')
  return node.text
}

function promptContent(node) {
  assert.equal(node.kind, 'prompt')
  return node
}

await bundlePersistenceModules()
await bundleAllModules()

try {
  const {
    conversationPreview,
    defaultAppState,
    messageCount,
    parseAppStateJson,
    parseConversation,
    parsePromptsJson,
    serializeAppStateJson,
    serializeConversation,
    serializePromptsJson,
  } = await import(pathToFileURL(bundlePath).href)

  {
    const content = `<!-- title: Duplicate pills | model: provider/model | created: 123 -->

<dez:pill type="user"/>


<dez:pill type="user"/>


<dez:pill type="user"/>


what's your name?
<dez:pill type="agent"/>
Hi there!
`
    const parsed = parseConversation('conversation', content)
    assert.equal(parsed.sections.length, 2)
    assert.equal(parsed.sections[0].role, 'user')
    assert.equal(parsed.sections[1].role, 'agent')
    assert.equal(parsed.sections[0].nodes.length, 1)
    assert.equal(textContent(parsed.sections[0].nodes[0]), "what's your name?")
    assert.equal(textContent(parsed.sections[1].nodes[0]), 'Hi there!')
  }

  {
    const content = `<!-- title: Duplicate pills | model:  | created: 456 -->

<dez:pill type="user"/>

<dez:pill type="user"/>

hello
<dez:pill type="agent"/>
world
`
    const parsed = parseConversation('conversation', content)
    const serialized = serializeConversation(parsed)
    const reparsed = parseConversation('conversation', serialized)
    assert.equal(serialized.match(/<dez:pill type="user"\/>/g)?.length, 1)
    assert.equal(reparsed.sections.length, 2)
    assert.equal(reparsed.sections[0].role, 'user')
    assert.equal(reparsed.sections[1].role, 'agent')
    assert.equal(textContent(reparsed.sections[0].nodes[0]), 'hello')
    assert.equal(textContent(reparsed.sections[1].nodes[0]), 'world')
  }

  {
    const data = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode('hello')]),
        section('agent', [textNode('world')]),
        section('user', []),
      ],
      activeModel: null,
      created_at: 789,
    }
    const parsed = parseConversation('conversation', serializeConversation(data))
    assert.equal(parsed.sections.length, 3)
    assert.equal(parsed.sections[0].role, 'user')
    assert.equal(parsed.sections[1].role, 'agent')
    assert.equal(parsed.sections[2].role, 'user')
    assert.deepEqual(parsed.sections[2].nodes, [])
  }

  {
    const data = {
      id: 'conversation',
      title: 'Chat',
      sections: [
        section('user', [textNode('hello')]),
        section('agent', [textNode('\nworld')]),
      ],
      activeModel: null,
      created_at: 789,
    }
    const parsed = parseConversation('conversation', serializeConversation(data))
    assert.equal(parsed.sections.length, 2)
    assert.equal(parsed.sections[1].role, 'agent')
    assert.equal(textContent(parsed.sections[1].nodes[0]), '\nworld')
  }

  {
    const content = '<!-- title: t | model:  | created: 1 -->\n\n<dez:pill type="agent"/>\n\nHi there! today?\n<dez:prompt name="code-review">\nthis is a multi-line\n\nbody of many things\n</dez:prompt>\n\nrest of text\n'
    const parsed = parseConversation('c', content)
    assert.equal(parsed.sections.length, 1)
    assert.equal(parsed.sections[0].role, 'agent')
    assert.equal(parsed.sections[0].nodes.length, 3)
    assert.equal(textContent(parsed.sections[0].nodes[0]), '\nHi there! today?\n')
    const prompt = promptContent(parsed.sections[0].nodes[1])
    assert.equal(prompt.name, 'code-review')
    assert.equal(prompt.body, 'this is a multi-line\n\nbody of many things')
    assert.equal(prompt.promptId, null)
    assert.equal(prompt.expanded, false)
    assert.equal(textContent(parsed.sections[0].nodes[2]), '\nrest of text')
    const reparsed = parseConversation('c', serializeConversation(parsed))
    assert.equal(textContent(reparsed.sections[0].nodes[0]), '\nHi there! today?\n')
  }

  {
    const data = {
      id: 'conversation',
      title: 'Title | with\nspaces\r',
      sections: [
        section('user', [
          textNode('before\n'),
          { kind: 'prompt', id: 'p1', promptId: 'saved', name: 'prompt', body: 'literal </dez:prompt> marker', expanded: true },
        ]),
      ],
      activeModel: { providerId: 'openrouter', modelId: 'model/id', modelName: 'Display' },
      created_at: 1000,
    }
    const serialized = serializeConversation(data)
    assert(serialized.startsWith('<!-- title: Title / with spaces  | model: openrouter/model/id | created: 1000 -->'))
    assert(serialized.includes('literal <\\/dez:prompt> marker'))
    const parsed = parseConversation('conversation', serialized)
    assert.equal(parsed.title, 'Title / with spaces')
    assert.deepEqual(parsed.activeModel, {
      providerId: 'openrouter',
      modelId: 'model/id',
      modelName: 'model/id',
    })
    assert.equal(promptContent(parsed.sections[0].nodes[1]).body, 'literal </dez:prompt> marker')
  }

  {
    const parsed = parseConversation('empty', '')
    assert.deepEqual(parsed, {
      id: 'empty',
      title: '',
      sections: [{ role: 'user', nodes: [] }],
      activeModel: null,
      created_at: 0,
    })
  }

  {
    const sections = [
      section('user', [textNode('   ')]),
      section('user', [textNode('Hello\nthere')]),
      section('agent', [{ kind: 'prompt', id: 'p1', promptId: null, name: 'summary', body: 'Prompt body\nwith spacing', expanded: false }]),
    ]
    assert.equal(messageCount(sections), 2)
    assert.equal(conversationPreview(sections), 'Hello there Prompt body with spacing')
  }

  {
    assert.deepEqual(parseAppStateJson('{'), defaultAppState())
    const state = parseAppStateJson(JSON.stringify({
      tabs: [
        {
          id: 'tab',
          title: 'Existing Tab',
          conversationId: 'conversation',
          activeModel: { providerId: 'openrouter', modelId: 'model', modelName: 'Model' },
          createdAt: 34,
        },
        { id: 'missing fields' },
        null,
      ],
      activeTabId: 'tab',
      showPillSeparators: false,
      theme: 'dark',
      defaultModels: { openrouter: 'model' },
      defaultNewTabModel: { providerId: 'openrouter', modelId: 'model' },
      lastUsedModel: { providerId: 'zai', modelId: 'chat' },
      favorites: [{ providerId: 'venice', modelId: 'llm' }, null],
      checkForUpdates: false,
      lastUpdateCheckAt: 12,
    }))
    assert.deepEqual(state.tabs, [{
      id: 'tab',
      title: 'Existing Tab',
      conversationId: 'conversation',
      activeModel: { providerId: 'openrouter', modelId: 'model', modelName: 'Model' },
      createdAt: 34,
    }])
    assert.deepEqual(parseAppStateJson('{ "tabs": [null], "activeTabId": null }').tabs, [])
    assert.equal(state.activeTabId, 'tab')
    assert.equal(state.showPillSeparators, false)
    assert.equal(state.theme, 'dark')
    assert.deepEqual(state.defaultModels, { openrouter: 'model' })
    assert.deepEqual(state.defaultNewTabModel, { providerId: 'openrouter', modelId: 'model' })
    assert.deepEqual(state.lastUsedModel, { providerId: 'zai', modelId: 'chat' })
    assert.deepEqual(state.favorites, [{ providerId: 'venice', modelId: 'llm' }])
    assert.equal(state.checkForUpdates, false)
    assert.equal(state.lastUpdateCheckAt, 12)
    assert.equal(serializeAppStateJson(state), JSON.stringify(state, null, 2))
  }

  {
    assert.deepEqual(parsePromptsJson('{'), [])
    const prompts = parsePromptsJson(JSON.stringify([
      { id: '1', name: 'a', content: 'body' },
      { id: '2', name: 'missing content' },
      null,
    ]))
    assert.deepEqual(prompts, [{ id: '1', name: 'a', content: 'body' }])
    assert.equal(serializePromptsJson(prompts), JSON.stringify(prompts, null, 2))
  }

  console.log('Persistence fixture checks passed')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
