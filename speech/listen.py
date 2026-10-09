"""Resident Moonshine listener: loads the model once, then records on command.

Run as `python -I listen.py FIFO`. The model loads at once and stays in memory,
with the mic closed. A line `start` written to FIFO opens the mic for one
session; a line `stop` ends it. Each session prints JSON lines on stdout:
  downloading {model}   first use only, the weights are fetched
  ready {model}         the mic is open; the model may still be loading
  level {rms}           throttled mic level
  partial {text}        roughly every 0.5 s while speaking
  final {text}          after 1.5 s of silence, 60 s, 8 s with no speech, or `stop`
  error {code, message, hint}   the session failed; the helper goes back to idle
"""

import collections
import json
import queue
import sys
import threading
import time

import numpy as np

RATE = 16_000
BLOCK = 1_600  # 0.1 s
MODEL = "moonshine/tiny"
PRE_ROLL_BLOCKS = 5  # 0.5 s kept before the first loud block, so no first word is lost
PARTIAL_EVERY = 0.5
SILENCE_END = 1.5
MAX_SECONDS = 60  # Moonshine takes 0.1 to 64 s per call
NO_SPEECH_END = 8
SPEECH_RMS = 0.01
LEVEL_EVERY = 0.1

HF_REPO = "UsefulSensors/moonshine"
HF_FILE = "onnx/merged/tiny/float/encoder_model.onnx"


class Failed(Exception):
    """A session failed; its error line is out, and the helper goes back to idle."""


def emit(obj):
    print(json.dumps(obj), flush=True)


def fail(code, message, hint):
    emit({"type": "error", "code": code, "message": message, "hint": hint})
    raise Failed()


def is_cached():
    from huggingface_hub import try_to_load_from_cache

    path = try_to_load_from_cache(HF_REPO, HF_FILE)
    return isinstance(path, str)


def load_model(state):
    try:
        if not is_cached():
            emit({"type": "downloading", "model": MODEL})
        from moonshine_onnx import MoonshineOnnxModel, load_tokenizer

        state["model"] = MoonshineOnnxModel(model_name=MODEL)
        state["tokenizer"] = load_tokenizer()
    except Exception as err:  # noqa: BLE001 - reported per session, not a crash
        state["error"] = str(err)
    finally:
        state["ready"].set()


def transcribe(state, audio):
    state["ready"].wait()
    if state.get("error"):
        fail("model_failed", f"Moonshine did not load: {state['error']}",
             "Restart Claude Code; check the network for the first model download.")
    # A speaker says a few words a second; the cap stops noise from looping.
    max_len = max(16, int(len(audio) / RATE * 8))
    tokens = state["model"].generate(audio[None, :], max_len=max_len)
    return state["tokenizer"].decode_batch(tokens)[0].strip()


def read_commands(fifo, commands):
    # Reopens after each writer closes; a writer blocks only until this is open.
    while True:
        with open(fifo) as pipe:
            for line in pipe:
                commands.put(line.strip())


def stop_requested(commands):
    requested = False
    while True:
        try:
            command = commands.get_nowait()
        except queue.Empty:
            return requested
        if command == "stop":
            requested = True


def run_session(sd, state, commands):
    blocks = queue.Queue()

    def on_block(indata, frames, clock, status):
        blocks.put(indata[:, 0].copy())

    try:
        stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32",
                                blocksize=BLOCK, callback=on_block)
        stream.start()
    except Exception as err:  # noqa: BLE001
        fail("no_microphone", f"The microphone did not open: {err}",
             "Plug in a microphone, pick it in System Settings → Sound, and allow the "
             "terminal in System Settings → Privacy & Security → Microphone.")

    try:
        emit({"type": "ready", "model": MODEL})
        return listen(stream, blocks, state, commands)
    finally:
        # Every exit path closes the mic, a failed transcription included.
        stream.stop()
        stream.close()


def listen(stream, blocks, state, commands):
    started = time.monotonic()
    pre_roll = collections.deque(maxlen=PRE_ROLL_BLOCKS)
    utterance = []
    is_speaking = False
    last_speech = started
    last_partial = 0.0
    last_level = 0.0
    last_text = ""

    def finish():
        text = transcribe(state, np.concatenate(utterance)) if utterance else ""
        emit({"type": "final", "text": text})

    while True:
        try:
            block = blocks.get(timeout=0.1)
        except queue.Empty:
            block = None

        now = time.monotonic()
        if stop_requested(commands):
            return finish()

        if block is not None:
            rms = float(np.sqrt(np.mean(block * block)))
            if now - last_level >= LEVEL_EVERY:
                last_level = now
                emit({"type": "level", "rms": rms})

            if rms > SPEECH_RMS:
                if not is_speaking:
                    is_speaking = True
                    utterance.extend(pre_roll)
                last_speech = now
            if is_speaking:
                utterance.append(block)
            else:
                pre_roll.append(block)

            if is_speaking and now - last_partial >= PARTIAL_EVERY:
                last_partial = now
                text = transcribe(state, np.concatenate(utterance))
                if text != last_text:
                    last_text = text
                    emit({"type": "partial", "text": text})

        if is_speaking and now - last_speech >= SILENCE_END:
            return finish()
        if is_speaking and sum(len(b) for b in utterance) >= MAX_SECONDS * RATE:
            return finish()
        if not is_speaking and now - started >= NO_SPEECH_END:
            return finish()


def main():
    fifo = sys.argv[1]

    try:
        import sounddevice as sd
    except Exception as err:  # noqa: BLE001
        emit({"type": "error", "code": "audio_missing",
              "message": f"The audio library did not load: {err}",
              "hint": "Run the voice setup again."})
        sys.exit(1)

    state = {"ready": threading.Event()}
    threading.Thread(target=load_model, args=(state,), daemon=True).start()

    commands = queue.Queue()
    threading.Thread(target=read_commands, args=(fifo, commands), daemon=True).start()

    while True:
        if commands.get() != "start":
            continue  # a stop with no session to end is dropped
        try:
            run_session(sd, state, commands)
        except Failed:
            pass


if __name__ == "__main__":
    main()
