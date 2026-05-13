import sbp from '@sbp/sbp'

export default sbp('sbp/selectors/register', {
  async 'dez.ui/copyText' (text: string): Promise<void> {
    await navigator.clipboard.writeText(text)
  },
})
