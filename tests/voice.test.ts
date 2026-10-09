import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { ModelCompleteResult, On, ProcessRunResult, ProcessSpawnChunk, ProcessSpawnResult } from 'claude-code'

// The listener's stdout, one JSON line per event, as the stub feeds it.
const lines = (...events: object[]) => events.map(e => `${JSON.stringify(e)}\n`)

const ANSWER: ModelCompleteResult = {
  isAnswered: true,
  text: 'Hello there.',
  usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}
const NO_ANSWER: ModelCompleteResult = {
  isAnswered: false,
  reason: 'aborted',
  usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
}

const MIC_DOWN = { type: 'down', x: 0, y: 0, button: 'left' } as const

const run = (exitCode: number): ProcessRunResult => ({
  exitCode,
  stdout: '',
  stderr: exitCode === 0 ? '' : 'pip: no network',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

// Wires the stubs beneath the mod: the listener's output, the venv setup
// commands, the cleanup model, and the prompt box, toasts and submits, all
// recorded for the assertions. `setup` says how each setup step exits: the
// probe that asks whether the venv already works, making the venv, and pip.
const rig = (
  on: On,
  script: {
    helper?: () => AsyncGenerator<ProcessSpawnChunk, ProcessSpawnResult>
    model?: ModelCompleteResult
    vocabulary?: string
    setup?: { probe: number; made: number; installed: number }
  },
) => {
  const spawns: string[][] = []
  const runs: string[][] = []
  const fills: string[] = []
  const toasts: string[] = []
  const submits: string[] = []
  const systems: string[] = []
  const setup = script.setup ?? { probe: 0, made: 0, installed: 0 }

  mock.env(on, { HOME: '/home/test' })
  mock.clock(on)

  on('process.run', ($, e) => {
    runs.push([...e.argv])
    const code = e.argv.includes('venv') ? setup.made : e.argv.includes('pip') ? setup.installed : setup.probe
    return { value: run(code) }
  })
  on('process.spawn', async function* ($, e) {
    spawns.push([...e.argv])
    if (script.helper) return { value: yield* script.helper() }
    return { value: { code: 0, signal: null } }
  })
  // What the engine draws beneath the mod, so a mount has a SessionMode to wrap.
  on('ui.render', ($, e) => $.ui.resolve(e).Box({}))
  on('fs.read', () => ({ value: script.vocabulary ?? '' }))
  on('model.complete', ($, e) => {
    systems.push(typeof e.system === 'string' ? e.system : '')
    return { value: script.model ?? ANSWER }
  })
  on('prompt.fill', ($, e) => {
    fills.push(e.text)
    return { isFilled: true, text: e.text }
  })
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    return { drop: 'the voice mod never submits' }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  return { spawns, runs, fills, toasts, submits, systems }
}

const mountMic = (
  $: Engine,
  surface: 'terminal' = 'terminal',
) => $.ui.mount({ plugin: 'voice', surface, component: 'SessionMode', props: { modes: [] } })

describe('voice: dictation into the prompt box', () => {
  test('partials stream into the box, the cleaned final replaces them, nothing is submitted', async ($, on) => {
    const rec = rig(on, {
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'ready', model: 'moonshine/tiny' }).join('') }
        yield { stream: 'stdout', text: lines({ type: 'partial', text: 'hello' }).join('') }
        yield { stream: 'stdout', text: lines({ type: 'partial', text: 'hello um there' }).join('') }
        yield { stream: 'stdout', text: lines({ type: 'final', text: 'hello um there' }).join('') }
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.fills).toEqual(['hello', 'hello um there', 'Hello there.'])
    expect(rec.submits).toEqual([])
  })

  test('a failed cleanup fills the raw transcript and says so in a toast', async ($, on) => {
    const rec = rig(on, {
      model: NO_ANSWER,
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'final', text: 'raw words here' }).join('') }
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.fills.at(-1)).toBe('raw words here')
    expect(rec.toasts.some(t => t.includes('cleanup failed'))).toBe(true)
    expect(rec.submits).toEqual([])
  })

  test('an error line toasts its message and its hint verbatim', async ($, on) => {
    const rec = rig(on, {
      helper: async function* () {
        yield {
          stream: 'stdout',
          text: lines({ type: 'error', code: 'no_microphone', message: 'The microphone did not open.', hint: 'Plug one in.' }).join(''),
        }
        return { code: 1, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.toasts).toContain('The microphone did not open. Plug one in.')
    expect(rec.fills).toEqual([])
  })

  test('silence fills nothing and toasts "heard nothing"', async ($, on) => {
    const rec = rig(on, {
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'ready', model: 'moonshine/tiny' }).join('') }
        yield { stream: 'stdout', text: lines({ type: 'final', text: '   ' }).join('') }
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.toasts).toContain('heard nothing')
    expect(rec.fills).toEqual([])
    expect(rec.spawns.length).toBe(1)
  })

  test('the first click starts one listener; a second click stops it and its final finishes the flow', async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => (release = resolve))
    const rec = rig(on, {
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'ready', model: 'moonshine/tiny' }).join('') }
        await held
        yield { stream: 'stdout', text: lines({ type: 'final', text: 'ship it' }).join('') }
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })
    release()
    await ui.drawn()

    expect(rec.spawns.length).toBe(1)
    expect(rec.fills.at(-1)).toBe('Hello there.')
    expect(rec.submits).toEqual([])
  })

  test('the listener runs the venv Python on the mod\'s own script', async ($, on) => {
    const rec = rig(on, {
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'final', text: '' }).join('') }
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.spawns[0]?.slice(0, 2)).toEqual(['/home/test/.cache/voice-mod/venv/bin/python', '-I'])
    expect(rec.spawns[0]?.[2]).toMatch(/\/voice(-mod)?\/speech\/listen\.py$/)
  })

  test('first use sets up the venv, then listens', async ($, on) => {
    const rec = rig(on, {
      setup: { probe: 1, made: 0, installed: 0 },
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'final', text: '' }).join('') }
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.runs.some(argv => argv.includes('venv'))).toBe(true)
    expect(rec.runs.some(argv => argv.includes('pip') && argv.includes('useful-moonshine-onnx'))).toBe(true)
    expect(rec.spawns.length).toBe(1)
  })

  test('no Python 3 toasts the install hint and does not listen', async ($, on) => {
    const rec = rig(on, { setup: { probe: 1, made: 1, installed: 0 } })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.toasts).toContain('voice needs Python 3: brew install python')
    expect(rec.spawns.length).toBe(0)
  })

  test('a failed pip install toasts its last line and does not listen', async ($, on) => {
    const rec = rig(on, { setup: { probe: 1, made: 0, installed: 1 } })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.toasts).toContain('voice setup failed: pip: no network')
    expect(rec.spawns.length).toBe(0)
  })

  test('the cleanup reads the vocabulary file and the spoken-correction rules, and only runs on the final', async ($, on) => {
    const rec = rig(on, {
      vocabulary: '# team terms\nPROJ-123\n\nvoice-mod\n',
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'partial', text: 'ship it scratch that' }).join('') }
        yield { stream: 'stdout', text: lines({ type: 'final', text: 'ship PROJ-123 scratch that' }).join('') }
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })

    expect(rec.systems.length).toBe(1)
    expect(rec.systems[0]).toContain('PROJ-123, voice-mod')
    expect(rec.systems[0]).toContain('"scratch that"')
    expect(rec.systems[0]).not.toContain('# team terms')
  })

  test('hovering the mic leaves no inverse and no background', async ($, on) => {
    rig(on, {})

    const ui = await mountMic($)
    await ui.pointer({ type: 'enter', x: 0, y: 0, in: 'mic' })
    const tree = JSON.stringify(await ui.drawn({ in: 'mic' }))

    expect(tree).not.toContain('inverse')
    expect(tree).not.toContain('backgroundColor')
  })

  test('the stop glyph is red while listening', async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => (release = resolve))
    rig(on, {
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'ready', model: 'moonshine/tiny' }).join('') }
        await held
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })
    const tree = JSON.stringify(await ui.drawn({ in: 'mic' }))
    release()
    await ui.drawn()

    expect(tree).toContain('"color":"red"')
    expect(tree).toContain('■')
  })

  test('the helper stays up across sessions: two clicks send two starts over one process', async ($, on) => {
    let release: () => void = () => {}
    const held = new Promise<void>(resolve => (release = resolve))
    const rec = rig(on, {
      helper: async function* () {
        yield { stream: 'stdout', text: lines({ type: 'final', text: 'one' }).join('') }
        await held
        yield { stream: 'stdout', text: lines({ type: 'final', text: 'two' }).join('') }
        return { code: 0, signal: null }
      },
    })

    const ui = await mountMic($)
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })
    await ui.pointer({ ...MIC_DOWN, in: 'mic' })
    release()
    await ui.drawn()

    expect(rec.spawns.length).toBe(1)
    expect(rec.runs.filter(argv => argv.includes('start')).length).toBe(2)
    expect(rec.fills.filter(text => text === 'Hello there.').length).toBe(2)
  })

  test('no ctrl+space label is drawn beside the mic', async ($, on) => {
    rig(on, {})

    const ui = await mountMic($)
    const tree = JSON.stringify(await ui.drawn())

    expect(tree).not.toContain('ctrl+space')
  })
})
