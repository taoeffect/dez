import { describe, expect, it } from 'vitest'
import { jsonWithoutLocalPaths, withoutLocalPaths } from './localPaths'

describe('withoutLocalPaths', () => {
  it.each([
    // Home folders: the next folder is a user name.
    ['/home/alice/models/llama-3.gguf', '/home/…'],
    ['/Users/alice/Library/Caches/llama.cpp/gemma.gguf', '/Users/…'],
    ['/root/acme-bot/weights', '/root/…'],
    ['~/models/llama-3.gguf', '~/…'],
    ['C:\\Users\\alice\\models\\llama-3.gguf', 'C:\\Users\\…'],
    ['c:/Users/alice/models', 'c:/Users/…'],
    // Other places for the user's files.
    ['/mnt/c/Users/alice/models', '/mnt/…'],
    ['/media/alice/disk/models', '/media/…'],
    ['/run/media/alice/disk/models', '/run/media/…'],
    ['/Volumes/Work/acme-bot/model.gguf', '/Volumes/…'],
    ['/srv/acme-bot/model', '/srv/…'],
    ['/opt/acme-bot/model', '/opt/…'],
    ['/var/home/alice/models', '/var/…'],
    ['/tmp/alice-run/model', '/tmp/…'],
    ['/private/var/folders/zz/T/model', '/private/var/…'],
    ['/data/acme-bot/model', '/data/…'],
    ['/workspace/acme-bot/model', '/workspace/…'],
    ['/workspaces/acme-bot/model', '/workspaces/…'],
    ['/scratch/alice/model', '/scratch/…'],
    ['D:\\acme-bot\\model.gguf', 'D:\\…'],
    ['\\\\nas\\share\\acme-bot\\model.gguf', '\\\\…'],
    ['\\\\?\\C:\\Users\\alice\\model.gguf', '\\\\…'],
    // A home folder under folders that are not in the list.
    ['/cluster/home/alice/models', '/…'],
    ['/net/fileserver/home/alice/models', '/…'],
    ['/System/Volumes/Data/Users/alice/models', '/…'],
    // `file:` URLs of them.
    ['file:///home/alice/models/llama-3.gguf', 'file:///home/…'],
    ['file:/tmp/alice-run/model', 'file:/tmp/…'],
    ['file://localhost/Users/alice/model', 'file://localhost/Users/…'],
    ['file:///C:/Users/alice/model.gguf', 'file:///C:/Users/…'],
    ['file:///cluster/home/alice/model', 'file:///…'],
    // A path with spaces is hidden whole.
    ['/Users/alice/My Models/Acme Bot/model.gguf', '/Users/…'],
  ])('hides the rest of %j', (path, standIn) => {
    expect(withoutLocalPaths(path)).toBe(standIn)
    // A stand-in is no path with more to hide.
    expect(withoutLocalPaths(standIn)).toBe(standIn)
  })

  it.each([
    // API routes.
    '/chat/completions',
    '/v1/messages',
    '/v1/images/generations',
    '/api/v1/models/openai/gpt-5/endpoints',
    '/v1/data/sets',
    // URLs: a folder name after a host or after another folder.
    'https://example.com/home/alice/model',
    'https://openrouter.ai/data/models?order=newest',
    'http://localhost:8000/v1',
    'https://people.example.edu/~alice/paper.pdf',
    's3://bucket/home/alice/model',
    // Relative paths and model ids.
    'meta-llama/Llama-3-8B',
    '~openai/gpt-mini-latest',
    'lmstudio-community/Llama-3-GGUF/llama-3.gguf',
    'models/home/alice',
    './data/model.gguf',
    '../tmp/model.gguf',
    // A start with nothing after it shows no name.
    '/home',
    '/home/',
    '/tmp/',
    '~',
    '~/',
    'C:\\',
    // System folders.
    '/usr/bin/llama-server',
    '/etc/llama/config.json',
    '/Library/Application Support/llama',
    // Prose.
    'About ~3/4 of the context, 24/7, for input/output at ~GPT-4/Claude level.',
    'A line break in LaTeX is \\\\ and a column is c:d.',
  ])('keeps %j', (text) => {
    expect(withoutLocalPaths(text)).toBe(text)
  })

  it('hides a path inside a longer text, from its start to the end of the line', () => {
    expect(withoutLocalPaths('llama-server -m /home/alice/llama-3.gguf --port 8080')).toBe('llama-server -m /home/…')
    expect(withoutLocalPaths('--model=/data/acme-bot/model --alias "C:\\acme\\x"')).toBe('--model=/data/…')
    expect(withoutLocalPaths('Loaded from "~/models/acme".')).toBe('Loaded from "~/…')
    expect(withoutLocalPaths('PATH=/usr/bin:/opt/acme-bot/bin')).toBe('PATH=/usr/bin:/opt/…')
    // A local path in the query of a URL.
    expect(withoutLocalPaths('http://127.0.0.1:7860/file=/home/alice/out.png')).toBe('http://127.0.0.1:7860/file=/home/…')
  })

  it('hides the paths of each line, and keeps the other lines and the line ends', () => {
    expect(withoutLocalPaths('FROM /Users/alice/llama-3.gguf\r\nPARAMETER temperature 0.7\nADAPTER ~/lora/acme\n'))
      .toBe('FROM /Users/…\r\nPARAMETER temperature 0.7\nADAPTER ~/…\n')
  })
})

describe('jsonWithoutLocalPaths', () => {
  it('hides the paths in the string values and the keys at any depth, and keeps all else', () => {
    const value = {
      id: 'llama-3',
      created: 1715000000,
      parent: null,
      loaded: true,
      root: '/home/alice/models/llama-3',
      status: { args: ['/usr/bin/llama-server', '--model', '/home/alice/models/llama-3.gguf'], pid: 4242 },
      files: { '/data/acme-bot/llama-3.gguf': { size: 1024 } },
    }
    const copy = structuredClone(value)

    expect(jsonWithoutLocalPaths(value)).toStrictEqual({
      id: 'llama-3',
      created: 1715000000,
      parent: null,
      loaded: true,
      root: '/home/…',
      status: { args: ['/usr/bin/llama-server', '--model', '/home/…'], pid: 4242 },
      files: { '/data/…': { size: 1024 } },
    })
    // The caller's value is not changed.
    expect(value).toStrictEqual(copy)
  })

  it('takes a value that is not an object', () => {
    expect(jsonWithoutLocalPaths('/home/alice/model')).toBe('/home/…')
    expect(jsonWithoutLocalPaths(['/v1/messages', 3, null])).toStrictEqual(['/v1/messages', 3, null])
    expect(jsonWithoutLocalPaths(null)).toBeNull()
  })
})
