/**
 * EventEngine Test Suite
 *
 * EventEngine is a process-wide singleton, so every test removes the handlers it adds and drains the
 * queue, and asserts on counts relative to what was registered before.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import { eventEngine } from '../core/EventEngine'

const registered: Array<[string, (...args: any[]) => void]> = []

/** Register through the public on() and remember it for cleanup. */
function listen(type: string, handler: (...args: any[]) => void) {
  eventEngine.on(type, handler)
  registered.push([type, handler])
}

const task = (subtype: string) => ({ type: 'task' as const, subtype, taskId: 't1', summary: 's' }) as any

async function emitAndFlush(event: any) {
  eventEngine.emitEvent(event)
  await eventEngine.flushQueue()
}

describe('EventEngine delivery (CSL-5624)', () => {
  afterEach(async () => {
    for (const [type, handler] of registered.splice(0)) eventEngine.off(type, handler)
    await eventEngine.flushQueue()
    vi.restoreAllMocks()
  })

  it('calls a type handler once per event', async () => {
    const handler = vi.fn()
    listen('task', handler)
    await emitAndFlush(task('started'))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0]).toMatchObject({ type: 'task', subtype: 'started' })
  })

  it('calls a type:subtype handler once per event, and not for another subtype', async () => {
    const started = vi.fn()
    const failed = vi.fn()
    listen('task:started', started)
    listen('task:failed', failed)
    await emitAndFlush(task('started'))
    expect(started).toHaveBeenCalledTimes(1)
    expect(failed).not.toHaveBeenCalled()
  })

  it('calls a * handler once per event', async () => {
    const handler = vi.fn()
    listen('*', handler)
    await emitAndFlush(task('started'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('still delivers a direct emit() to its handlers once', () => {
    const handler = vi.fn()
    listen('task:started', handler)
    eventEngine.emit('task:started', { type: 'task' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('once() fires a single time across several events', async () => {
    const handler = vi.fn()
    eventEngine.once('task:started', handler)
    await emitAndFlush(task('started'))
    await emitAndFlush(task('started'))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(eventEngine.listenerCount('task:started')).toBe(0)
  })

  it.each(['task', 'task:started', '*'])('off() removes a %s handler', async type => {
    const handler = vi.fn()
    listen(type, handler)
    eventEngine.off(type, handler)
    await emitAndFlush(task('started'))
    expect(handler).not.toHaveBeenCalled()
    expect(eventEngine.listenerCount(type)).toBe(0)
  })

  it('handlerCount equals the number of registered handlers and returns to its start', () => {
    const before = eventEngine.getStats().handlerCount
    const a = () => {}
    const b = () => {}
    const c = () => {}
    listen('task', a)
    listen('task:started', b)
    listen('*', c)
    expect(eventEngine.getStats().handlerCount).toBe(before + 3)

    eventEngine.off('task', a)
    expect(eventEngine.getStats().handlerCount).toBe(before + 2)
    eventEngine.off('task:started', b)
    eventEngine.off('*', c)
    expect(eventEngine.getStats().handlerCount).toBe(before)
  })

  it('removeAllListeners(type) drops that type from handlerCount too', () => {
    const before = eventEngine.getStats().handlerCount
    listen('task:progress', () => {})
    listen('task:progress', () => {})
    expect(eventEngine.getStats().handlerCount).toBe(before + 2)
    eventEngine.removeAllListeners('task:progress')
    expect(eventEngine.getStats().handlerCount).toBe(before)
  })
})

describe('EventEngine handler failures (CSL-5624 round 2)', () => {
  const unhandled = vi.fn()

  afterEach(async () => {
    process.off('unhandledRejection', unhandled)
    unhandled.mockClear()
    for (const [type, handler] of registered.splice(0)) eventEngine.off(type, handler)
    await eventEngine.flushQueue()
    vi.restoreAllMocks()
  })

  /** Give a rejected promise time to surface as an unhandledRejection (it fires after a macrotask). */
  const settle = () => new Promise(resolve => setTimeout(resolve, 20))

  it('logs and counts a rejecting async handler, with no unhandledRejection, and keeps delivering', async () => {
    process.on('unhandledRejection', unhandled)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = eventEngine.getStats().handlerErrors
    const next = vi.fn()
    listen('task:started', async () => {
      throw new Error('async boom')
    })
    listen('task:started', next)

    await emitAndFlush(task('started'))
    await settle()

    expect(unhandled).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
    expect(eventEngine.getStats().handlerErrors).toBe(before + 1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('task:started')

    // the next event still runs
    await emitAndFlush(task('started'))
    expect(next).toHaveBeenCalledTimes(2)
    await settle() // the second rejection is reported after a tick; let it land before the next test
    expect(eventEngine.getStats().handlerErrors).toBe(before + 2)
  })

  it('handles a synchronous throw the same way, and later events and later emits of the same event still run', async () => {
    process.on('unhandledRejection', unhandled)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const before = eventEngine.getStats().handlerErrors
    const star = vi.fn()
    listen('task:started', () => {
      throw new Error('sync boom')
    })
    listen('*', star)

    await expect(emitAndFlush(task('started'))).resolves.toBeUndefined()
    await settle()

    expect(unhandled).not.toHaveBeenCalled()
    expect(eventEngine.getStats().handlerErrors).toBe(before + 1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('task:started')
    // the throwing handler did not stop the rest of processEvent: the * emit still happened
    expect(star).toHaveBeenCalledTimes(1)

    await emitAndFlush(task('progress'))
    expect(star).toHaveBeenCalledTimes(2)
  })

  it('does not route a failure to an error event', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const onError = vi.fn()
    listen('error', onError)
    listen('task:started', async () => {
      throw new Error('x')
    })
    await emitAndFlush(task('started'))
    await settle()
    expect(onError).not.toHaveBeenCalled()
  })
})
