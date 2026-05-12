export interface LatestRelease {
  version: string
  url: string
}

export interface CopilotDeviceFlowResponse {
  user_code: string
  verification_uri: string
  device_code: string
}

export interface CopilotChatToken {
  token: string
  expires_at: number
}
