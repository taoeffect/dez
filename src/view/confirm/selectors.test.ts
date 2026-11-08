import sbp from '@sbp/sbp'
import { afterEach, describe, expect, it } from 'vitest'
import { answerConfirm, confirmRequest, type ConfirmOptions } from './selectors'

function confirm(options: ConfirmOptions): Promise<boolean> {
  return sbp('dez.ui/confirm', options) as Promise<boolean>
}

afterEach(() => {
  answerConfirm(false)
})

describe('dez.ui/confirm', () => {
  it('shows the message with Yes and No, and resolves with the answer', async () => {
    const yes = confirm({ message: 'Are you sure you want to delete this image?' })
    expect(confirmRequest.value).toMatchObject({
      message: 'Are you sure you want to delete this image?',
      confirmLabel: 'Yes',
      cancelLabel: 'No',
    })
    answerConfirm(true)
    expect(confirmRequest.value).toBeNull()
    await expect(yes).resolves.toBe(true)

    const no = confirm({ message: 'Close?', confirmLabel: 'Close', cancelLabel: 'Keep' })
    expect(confirmRequest.value).toMatchObject({ confirmLabel: 'Close', cancelLabel: 'Keep' })
    answerConfirm(false)
    expect(confirmRequest.value).toBeNull()
    await expect(no).resolves.toBe(false)
  })

  it('answers an open prompt No when a new prompt takes its place', async () => {
    const first = confirm({ message: 'First?' })
    const second = confirm({ message: 'Second?' })
    await expect(first).resolves.toBe(false)
    expect(confirmRequest.value?.message).toBe('Second?')

    answerConfirm(true)
    await expect(second).resolves.toBe(true)
  })

  it('takes only the first answer to a prompt', async () => {
    const answer = confirm({ message: 'Delete?' })
    answerConfirm(false)
    answerConfirm(true)
    await expect(answer).resolves.toBe(false)
  })
})
