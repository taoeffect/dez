import { describe, expect, it } from 'vitest'
import {
  SECTION_SEP,
  docToSections,
  initialSectionModels,
  reconcileSectionModelsToDoc,
  type SectionModel,
} from './cmEditor'
import type { ContentNode, Role, Section } from '../../model/chat/types'

function textNode(text: string): ContentNode {
  return { kind: 'text', text }
}

function section(id: string, role: Role, text: string): Section {
  return { id, role, content: [textNode(text)] }
}

describe('CodeMirror section role reconciliation', () => {
  it('uses fallback section metadata when live metadata is missing', () => {
    const doc = ['hello', 'answer', 'next'].join(`\n${SECTION_SEP}\n`)
    const fallback = initialSectionModels([
      section('s1', 'user', 'hello'),
      section('s2', 'agent', 'answer'),
      section('s3', 'user', 'next'),
    ])

    const reconciled = reconcileSectionModelsToDoc([fallback[0]], doc, fallback)

    expect(reconciled.map((model) => model.role)).toEqual(['user', 'agent', 'user'])
    expect(reconciled.map((model) => model.id)).toEqual(['s1', 's2', 's3'])
  })

  it('replaces generated placeholder models with matching fallback store metadata', () => {
    const doc = ['hello', 'answer'].join(`\n${SECTION_SEP}\n`)
    const fallback = initialSectionModels([
      section('s1', 'user', 'hello'),
      section('s2', 'agent', 'answer'),
    ])
    const generated: SectionModel[] = [
      fallback[0],
      { id: 'generated-agent-slot', role: 'user', generated: true },
    ]

    const sections = docToSections(doc, generated, new Map(), fallback)

    expect(sections.map((candidate) => candidate.role)).toEqual(['user', 'agent'])
    expect(sections.map((candidate) => candidate.id)).toEqual(['s1', 's2'])
  })

  it('preserves explicit role toggles when live model ids match the fallback ids', () => {
    const doc = ['hello', 'answer'].join(`\n${SECTION_SEP}\n`)
    const fallback = initialSectionModels([
      section('s1', 'user', 'hello'),
      section('s2', 'agent', 'answer'),
    ])
    const toggled = [fallback[0], { id: 's2', role: 'user' as const }]

    const reconciled = reconcileSectionModelsToDoc(toggled, doc, fallback)

    expect(reconciled.map((model) => model.role)).toEqual(['user', 'user'])
    expect(reconciled.map((model) => model.id)).toEqual(['s1', 's2'])
  })
})
