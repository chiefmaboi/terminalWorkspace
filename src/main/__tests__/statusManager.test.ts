import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_WORKING_SILENCE_MS, StatusManager } from '../statusManager'
import { stateForClaudeHook } from '../hookEvents'

const DEBOUNCE = 1200

describe('StatusManager', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = (): { sm: StatusManager; listener: ReturnType<typeof vi.fn> } => {
    const sm = new StatusManager(() => DEBOUNCE)
    const listener = vi.fn()
    sm.onChange(listener)
    return { sm, listener }
  }

  it('defaults an unknown terminal to idle', () => {
    expect(new StatusManager().get('nope')).toBe('idle')
  })

  it('Enter makes a terminal working; silence past the debounce makes it idle again', () => {
    const { sm } = setup()
    sm.noteInput('t', 'ls')
    expect(sm.get('t')).toBe('idle') // no Enter yet
    sm.noteInput('t', '\r')
    expect(sm.get('t')).toBe('working')
    vi.advanceTimersByTime(DEBOUNCE - 1)
    expect(sm.get('t')).toBe('working')
    vi.advanceTimersByTime(1)
    expect(sm.get('t')).toBe('idle')
    expect(sm.sourceOf('t')).toBe('timeout')
  })

  it('Enter after a long quiet spell still starts a full debounce (not instantly idle)', () => {
    const { sm } = setup()
    vi.advanceTimersByTime(60_000)
    sm.noteInput('t', '\r')
    vi.advanceTimersByTime(DEBOUNCE - 1)
    expect(sm.get('t')).toBe('working')
  })

  it('output keeps a working terminal working', () => {
    const { sm } = setup()
    sm.noteInput('t', '\r')
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(DEBOUNCE - 100)
      sm.noteOutput('t')
    }
    expect(sm.get('t')).toBe('working')
    vi.advanceTimersByTime(DEBOUNCE)
    expect(sm.get('t')).toBe('idle')
  })

  it('an OSC notification makes it waiting, and the timeout never clears waiting', () => {
    const { sm } = setup()
    sm.noteInput('t', '\r')
    sm.signal({ terminalId: 't', state: 'waiting', source: 'osc', message: 'needs you' })
    expect(sm.get('t')).toBe('waiting')
    vi.advanceTimersByTime(AGENT_WORKING_SILENCE_MS * 2)
    expect(sm.get('t')).toBe('waiting')
  })

  it('user input leaves waiting (they answered) and idle (they submitted)', () => {
    const { sm } = setup()
    sm.signal({ terminalId: 't', state: 'waiting', source: 'hook' })
    sm.noteInput('t', '\r')
    expect(sm.get('t')).toBe('working')
    sm.signal({ terminalId: 'u', state: 'idle', source: 'hook' })
    sm.noteInput('u', '\r')
    expect(sm.get('u')).toBe('working')
  })

  it('a hook-reported working survives the normal debounce, but not a long silence', () => {
    const { sm } = setup()
    sm.signal({ terminalId: 't', state: 'working', source: 'hook' })
    vi.advanceTimersByTime(DEBOUNCE * 5)
    expect(sm.get('t')).toBe('working') // thinking quietly is fine
    vi.advanceTimersByTime(AGENT_WORKING_SILENCE_MS)
    // e.g. the user interrupted with Esc: Claude Code's Stop hook doesn't fire for that.
    expect(sm.get('t')).toBe('idle')
  })

  it('Enter does not demote a hook-reported working to the short input debounce', () => {
    const { sm } = setup()
    sm.signal({ terminalId: 't', state: 'working', source: 'hook' })
    sm.noteInput('t', '\r')
    expect(sm.sourceOf('t')).toBe('hook')
    vi.advanceTimersByTime(DEBOUNCE * 3)
    expect(sm.get('t')).toBe('working')
  })

  it('hook idle (Stop) applies immediately and cancels the pending timeout', () => {
    const { sm, listener } = setup()
    sm.noteInput('t', '\r')
    sm.signal({ terminalId: 't', state: 'idle', source: 'hook' })
    expect(sm.get('t')).toBe('idle')
    listener.mockClear()
    vi.advanceTimersByTime(DEBOUNCE * 2)
    expect(listener).not.toHaveBeenCalled()
  })

  it('exit, reset and remove clear state and timers', () => {
    const { sm, listener } = setup()
    sm.noteInput('t', '\r')
    sm.signal({ terminalId: 't', state: 'idle', source: 'exit' })
    expect(sm.get('t')).toBe('idle')

    sm.signal({ terminalId: 'w', state: 'waiting', source: 'osc' })
    sm.reset('w')
    expect(sm.get('w')).toBe('idle')

    sm.noteInput('r', '\r')
    sm.remove('r')
    listener.mockClear()
    vi.advanceTimersByTime(DEBOUNCE * 2)
    expect(listener).not.toHaveBeenCalled()
    expect(sm.get('r')).toBe('idle')
  })

  it('notifies listeners only on real changes, with the previous state, source and message', () => {
    const { sm, listener } = setup()
    sm.signal({ terminalId: 't', state: 'waiting', source: 'osc', message: 'approve edit?' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith('t', 'waiting', {
      previous: 'idle',
      source: 'osc',
      message: 'approve edit?'
    })
    sm.signal({ terminalId: 't', state: 'waiting', source: 'hook' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  describe('a program reporting its own status (OSC 7501)', () => {
    it('maps straight to the status and outranks hooks, notification escapes and input', () => {
      const { sm, listener } = setup()
      sm.program('t', 'working')
      expect(sm.get('t')).toBe('working')
      expect(sm.isProgramReporting('t')).toBe(true)
      sm.signal({ terminalId: 't', state: 'waiting', source: 'hook' }) // e.g. a PermissionRequest routed to a reviewer
      sm.signal({ terminalId: 't', state: 'waiting', source: 'osc' }) // its own OSC 9 notification
      expect(sm.get('t')).toBe('working')
      sm.program('t', 'waiting', 'Waiting for your approval')
      expect(listener).toHaveBeenLastCalledWith('t', 'waiting', {
        previous: 'working',
        source: 'program',
        message: 'Waiting for your approval'
      })
      sm.noteInput('t', '\r') // Enter alone doesn't prove the wait is over
      sm.signal({ terminalId: 't', state: 'idle', source: 'hook' })
      expect(sm.get('t')).toBe('waiting')
      sm.program('t', 'working')
      sm.program('t', 'idle')
      expect(sm.get('t')).toBe('idle')
    })

    it('keeps waiting for as long as it says so, however quiet the terminal is', () => {
      const { sm } = setup()
      sm.program('t', 'waiting')
      vi.advanceTimersByTime(AGENT_WORKING_SILENCE_MS * 10)
      expect(sm.get('t')).toBe('waiting')
      expect(sm.isProgramReporting('t')).toBe(true)
    })

    it('a reported working survives the short debounce; a long silence ends it and its precedence', () => {
      const { sm } = setup()
      sm.program('t', 'working')
      vi.advanceTimersByTime(DEBOUNCE * 5)
      expect(sm.get('t')).toBe('working')
      vi.advanceTimersByTime(AGENT_WORKING_SILENCE_MS)
      expect(sm.get('t')).toBe('idle')
      expect(sm.isProgramReporting('t')).toBe(false) // killed outright: the other sources count again
      sm.signal({ terminalId: 't', state: 'waiting', source: 'hook' })
      expect(sm.get('t')).toBe('waiting')
    })

    it('stops counting on clear (idle), and on exit / reset', () => {
      const { sm } = setup()
      sm.program('t', 'waiting')
      sm.program('t', null)
      expect(sm.get('t')).toBe('idle')
      expect(sm.isProgramReporting('t')).toBe(false)
      sm.noteInput('t', '\r')
      expect(sm.get('t')).toBe('working') // input counts again

      sm.program('u', 'working')
      sm.reset('u')
      expect(sm.isProgramReporting('u')).toBe(false)
      sm.program('v', 'waiting')
      sm.signal({ terminalId: 'v', state: 'idle', source: 'exit' })
      expect(sm.get('v')).toBe('idle')
      expect(sm.isProgramReporting('v')).toBe(false)
    })

    it('a stray clear for a terminal that never reported changes nothing', () => {
      const { sm, listener } = setup()
      sm.noteInput('t', '\r')
      listener.mockClear()
      sm.program('t', null)
      expect(sm.get('t')).toBe('working')
      expect(listener).not.toHaveBeenCalled()
    })
  })

  it('supports unsubscribing', () => {
    const { sm } = setup()
    const other = vi.fn()
    const unsubscribe = sm.onChange(other)
    unsubscribe()
    sm.noteInput('t', '\r')
    expect(other).not.toHaveBeenCalled()
  })
})

describe('stateForClaudeHook', () => {
  it('maps Claude Code lifecycle events to statuses', () => {
    expect(stateForClaudeHook('Notification')).toBe('waiting')
    expect(stateForClaudeHook('UserPromptSubmit')).toBe('working')
    expect(stateForClaudeHook('PreToolUse')).toBe('working')
    expect(stateForClaudeHook('PostToolUse')).toBe('working')
    expect(stateForClaudeHook('Stop')).toBe('idle')
    expect(stateForClaudeHook('SessionEnd')).toBe('idle')
  })

  it('does not mark the terminal idle when only a subagent stops', () => {
    expect(stateForClaudeHook('SubagentStop')).toBeNull()
    expect(stateForClaudeHook('SessionStart')).toBeNull()
    expect(stateForClaudeHook('SomethingNew')).toBeNull()
  })
})
