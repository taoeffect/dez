export type Role = 'user' | 'agent'

export interface Message {
  id: string
  role: Role
  content: string
  timestamp: number
}
