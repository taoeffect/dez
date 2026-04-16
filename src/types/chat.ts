export type Role = 'user' | 'agent'

export interface Section {
  id: string
  role: Role
  content: string
}

export interface ActiveModel {
  providerId: string
  modelId: string
  modelName: string
}

export interface Tab {
  id: string
  title: string
  sections: Section[]
  activeModel: ActiveModel | null
  createdAt: number
}
