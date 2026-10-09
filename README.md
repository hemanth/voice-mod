# voice-mod

Dictate into the Claude Code prompt box with a footer mic that streams on-device Moonshine speech-to-text and cleans up spoken transcripts on stop without ever auto-submitting.

```sh
/plugin marketplace add hemanth/voice-mod
/plugin install voice@voice-mod
```

Or run directly from a local clone:

```sh
git clone https://github.com/hemanth/voice-mod
claude --plugin-dir ./voice-mod
```

## Quick start

Click `🎤︎` in the terminal footer (next to `SessionMode`) and speak.

```
● listening ▮▮▮▮▮▮▯▯▯▯ pause to finish · ■ to stop
```

`partial` transcripts stream live into the prompt box every `0.5s` via `$.prompt.fill({ text, mode: 'replace' })`. Pausing for `1.5s` or clicking `■` finalizes the recording, runs a low-latency Haiku cleanup pass, and leaves the polished text in your prompt box ready to edit or send.

## Resident Moonshine listener

```python
# speech/listen.py
state["model"] = MoonshineOnnxModel(model_name="moonshine/tiny")
state["tokenizer"] = load_tokenizer()
```

`startHelper()` boots a resident Python listener at `session.start` inside an isolated `~/.cache/voice-mod/venv` (`useful-moonshine-onnx` + `sounddevice`) and controls it over `~/.cache/voice-mod/voice.fifo`. The ONNX weights load once in memory while the microphone stays closed until you click `🎤︎`, keeping `0.5s` of pre-roll audio (`PRE_ROLL_BLOCKS = 5`) so the first word is never clipped.

## Spoken self-corrections

```ts
const r = await $.model.complete({
  model: 'haiku',
  system: await cleanupSystem($),
  prompt: raw,
  effort: 'low',
  timeoutMs: 20000,
})
await $.prompt.fill({ text: cleaned ?? raw, mode: 'replace' })
```

`finish()` strips filler words and false starts, adds punctuation, preserves identifiers, file paths, Jira keys, commands, and URLs verbatim, and applies spoken edits inline:

- `"scratch that"` or `"delete that"` drops the preceding phrase or sentence
- `"I mean X"`, `"no, X"`, or `"sorry, X"` replaces the preceding phrase with `X`
- Falls back to the raw Moonshine transcript if offline or if cleanup times out

## Custom vocabulary

```txt
# vocabulary.txt
MoonshineOnnxModel
SessionMode
AbovePrompt
```

Add project identifiers, team names, or domain terms (one per line) to `vocabulary.txt`. `cleanupSystem()` injects those exact spellings into the cleanup pass whenever the raw transcript sounds similar.

## Tests

```sh
claude plugin validate --strict .
claude plugin test .
```

Runs the full engine test suite (`tests/voice.test.ts`) covering live partial streaming, spoken self-corrections, custom vocabulary injection, first-use venv bootstrap, FIFO stop grace timers, and error recovery.

## License

MIT © [Hemanth.HM](https://h3manth.com)
