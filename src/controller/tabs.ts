import sbp from '@sbp/sbp'

export default sbp('sbp/selectors/register', {
  async 'dez.controller/closeTab' (tabId: string): Promise<void> {
    await sbp('dez.stream/stop', tabId)
    sbp('dez.model/tabs/close', tabId)
  },
})
