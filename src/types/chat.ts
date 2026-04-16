export type Role = 'user' | 'agent'

export interface Section {
  id: string
  role: Role
  content: string
}
