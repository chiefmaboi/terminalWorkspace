import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface FakeProc {
  pid: number
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  onData: (cb: (data: string) => void) => { dispose: () => void }
  onExit: (cb: (e: { exitCode: number }) => void) => { dispose: () => void }
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
}

const { procs, makeProc } = vi.hoisted(() => {
  const procs: FakeProc[] = []
  function makeProc(): FakeProc {
    let dataCb: (data: string) => void = () => {}
    let exitCb: (e: { exitCode: number }) => void = () => {}
    const proc: FakeProc = {
      pid: 1000 + procs.length,
      write: vi.fn(),
      resize: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      onData: (cb) => {
        dataCb = cb
        return { dispose: () => {} }
      },
      onExit: (cb) => {
        exitCb = cb
        return { dispose: () => {} }
      },
      emitData: (data) => dataCb(data),
      emitExit: (exitCode) => exitCb({ exitCode })
    }
    procs.push(proc)
    return proc
  }
  return { procs, makeProc }
})

vi.mock('node-pty', () => ({ spawn: vi.fn(() => makeProc()) }))
vi.mock('tree-kill', () => ({
  default: vi.fn((_pid: number, _signal: string, cb?: () => void) => cb?.())
}))

import {
  FLOW_HIGH_WATERMARK,
  FLOW_LOW_WATERMARK,
  FLUSH_MS_BACKGROUND,
  FLUSH_MS_PRIORITY,
  MAX_PENDING_CHARS,
  PtyManager
} from '../ptyManager'
import { StatusManager } from '../statusManager'

function setup(): {
  pm: PtyManager
  sm: StatusManager
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
} {
  const sm = new StatusManager()
  const onData = vi.fn()
  const onExit = vi.fn()
  const pm = new PtyManager(sm, onData, onExit, () => 1200)
  return { pm, sm, onData, onExit }
}

describe('PtyManager', () => {
  beforeEach(() => {
    procs.length = 0
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('restart race', () => {
    it("a stopped process exiting late doesn't remove the session that replaced it", async () => {
      const { pm, onExit } = setup()
      pm.start('t', '/p', '')
      const oldProc = procs[0]
      await pm.stop('t')
      pm.start('t', '/p', '')
      expect(procs).toHaveLength(2)

      oldProc.emitExit(1)

      expect(pm.has('t')).toBe(true)
      expect(onExit).not.toHaveBeenCalled()
    })

    it("a stopped process's trailing output never reaches the new session", async () => {
      const { pm, onData } = setup()
      pm.start('t', '/p', '')
      const oldProc = procs[0]
      await pm.stop('t')
      pm.start('t', '/p', '')

      oldProc.emitData('stale')
      procs[1].emitData('fresh')
      vi.advanceTimersByTime(FLUSH_MS_BACKGROUND)

      expect(onData).toHaveBeenCalledTimes(1)
      expect(onData).toHaveBeenCalledWith('t', 'fresh')
    })

    it("a deliberate stop doesn't report an exit", async () => {
      const { pm, onExit } = setup()
      pm.start('t', '/p', '')
      await pm.stop('t')
      procs[0].emitExit(0)
      expect(onExit).not.toHaveBeenCalled()
    })

    it('a natural exit flushes pending output first, then reports the exit', () => {
      const { pm, onData, onExit } = setup()
      pm.start('t', '/p', '')
      procs[0].emitData('bye')
      procs[0].emitExit(3)

      expect(onData).toHaveBeenCalledWith('t', 'bye')
      expect(onExit).toHaveBeenCalledWith('t', 3)
      expect(onData.mock.invocationCallOrder[0]).toBeLessThan(onExit.mock.invocationCallOrder[0])
      expect(pm.has('t')).toBe(false)
    })
  })

  describe('output batching', () => {
    it('coalesces background output and flushes it at the slow rate', () => {
      const { pm, onData } = setup()
      pm.start('t', '/p', '')
      procs[0].emitData('a')
      procs[0].emitData('b')

      vi.advanceTimersByTime(FLUSH_MS_PRIORITY)
      expect(onData).not.toHaveBeenCalled()

      vi.advanceTimersByTime(FLUSH_MS_BACKGROUND - FLUSH_MS_PRIORITY)
      expect(onData).toHaveBeenCalledTimes(1)
      expect(onData).toHaveBeenCalledWith('t', 'ab')
    })

    it('flushes the priority terminal at the fast rate', () => {
      const { pm, onData } = setup()
      pm.start('t', '/p', '')
      pm.setPriority('t')
      procs[0].emitData('a')
      procs[0].emitData('b')

      vi.advanceTimersByTime(FLUSH_MS_PRIORITY)
      expect(onData).toHaveBeenCalledWith('t', 'ab')
    })

    it('flushes pending output immediately when a terminal becomes the priority', () => {
      const { pm, onData } = setup()
      pm.start('t', '/p', '')
      procs[0].emitData('waiting')
      expect(onData).not.toHaveBeenCalled()

      pm.setPriority('t')
      expect(onData).toHaveBeenCalledWith('t', 'waiting')
    })

    it('flushes a large burst without waiting for the timer', () => {
      const { pm, onData } = setup()
      pm.start('t', '/p', '')
      procs[0].emitData('x'.repeat(MAX_PENDING_CHARS))
      expect(onData).toHaveBeenCalledTimes(1)
    })

    it('runs status detection on raw chunks before batching', () => {
      const { pm, sm, onData } = setup()
      pm.start('t', '/p', '')
      procs[0].emitData('\x1b]9;needs input\x07')
      expect(sm.get('t')).toBe('waiting')
      expect(onData).not.toHaveBeenCalled()
    })
  })

  describe('flow control', () => {
    function flood(pm: PtyManager, proc: FakeProc): void {
      // Two max-size bursts put unacked output past the high watermark.
      proc.emitData('x'.repeat(MAX_PENDING_CHARS))
      proc.emitData('x'.repeat(MAX_PENDING_CHARS))
      proc.emitData('x')
      vi.advanceTimersByTime(FLUSH_MS_BACKGROUND)
      expect(pm.has('t')).toBe(true)
    }

    it('pauses the pty past the high watermark and resumes at the low watermark', () => {
      const { pm } = setup()
      pm.start('t', '/p', '')
      const proc = procs[0]
      flood(pm, proc)
      expect(proc.pause).toHaveBeenCalledTimes(1)

      const unacked = 2 * MAX_PENDING_CHARS + 1
      expect(unacked).toBeGreaterThan(FLOW_HIGH_WATERMARK)

      // Acking down to just above the low watermark keeps it paused...
      pm.ack('t', unacked - FLOW_LOW_WATERMARK - 1)
      expect(proc.resume).not.toHaveBeenCalled()
      // ...and crossing it resumes, exactly once.
      pm.ack('t', 1)
      pm.ack('t', FLOW_LOW_WATERMARK)
      expect(proc.resume).toHaveBeenCalledTimes(1)
    })

    it('reattaching to a live session resets flow control', () => {
      const { pm } = setup()
      pm.start('t', '/p', '')
      const proc = procs[0]
      flood(pm, proc)
      expect(proc.pause).toHaveBeenCalledTimes(1)

      pm.start('t', '/p', '')
      expect(procs).toHaveLength(1)
      expect(proc.resume).toHaveBeenCalledTimes(1)
    })

    it('ignores acks for unknown terminals and non-positive counts', () => {
      const { pm } = setup()
      pm.start('t', '/p', '')
      expect(() => pm.ack('nope', 10)).not.toThrow()
      expect(() => pm.ack('t', Number.NaN)).not.toThrow()
      expect(() => pm.ack('t', -5)).not.toThrow()
    })
  })
})
