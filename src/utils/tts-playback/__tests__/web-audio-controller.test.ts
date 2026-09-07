import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WebAudioPlaybackController } from "../web-audio-controller"

describe("Safari Web Audio playback", () => {
  const source = {
    buffer: null,
    onended: null as null | (() => void),
    connect: vi.fn<(...args: any[]) => any>(),
    disconnect: vi.fn<(...args: any[]) => any>(),
    start: vi.fn<(...args: any[]) => any>(),
    stop: vi.fn<(...args: any[]) => any>(),
  }
  const context = {
    state: "running",
    destination: {},
    resume: vi.fn<(...args: any[]) => any>(),
    decodeAudioData: vi.fn<(...args: any[]) => any>(),
    createBufferSource: vi.fn<(...args: any[]) => any>(() => source),
  }
  const request = { requestId: "one", audioBase64: "AQID", contentType: "audio/mpeg" }

  beforeEach(() => {
    vi.clearAllMocks()
    source.onended = null
    context.resume.mockResolvedValue(undefined)
    context.decodeAudioData.mockResolvedValue({ duration: 2 })
    vi.stubGlobal("AudioContext", function AudioContextMock() {
      return context
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("resumes synchronously, decodes real input bytes and resolves only after playback ends", async () => {
    const player = new WebAudioPlaybackController()
    const ready = player.prepare()
    expect(context.resume).toHaveBeenCalledOnce()
    await ready
    const playing = player.play(request)
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce())
    expect(new Uint8Array(context.decodeAudioData.mock.calls[0]![0])).toEqual(
      new Uint8Array([1, 2, 3]),
    )
    source.onended?.()
    await expect(playing).resolves.toEqual({ ok: true })
    expect(source.disconnect).toHaveBeenCalledOnce()
  })

  it("does not start audio when stopped during decoding", async () => {
    let finishDecode!: (value: unknown) => void
    context.decodeAudioData.mockReturnValue(
      new Promise((resolve) => {
        finishDecode = resolve
      }),
    )
    const player = new WebAudioPlaybackController()
    await player.prepare()
    const playing = player.play(request)
    player.stop({ requestId: "one" })
    finishDecode({ duration: 2 })
    await expect(playing).resolves.toEqual({ ok: false, reason: "stopped" })
    expect(source.start).not.toHaveBeenCalled()
  })

  it("ignores another request's stop and settles its own interrupted playback", async () => {
    const player = new WebAudioPlaybackController()
    await player.prepare()
    const playing = player.play(request)
    await vi.waitFor(() => expect(source.start).toHaveBeenCalledOnce())
    player.stop({ requestId: "other" })
    expect(source.stop).not.toHaveBeenCalled()
    player.stop({ requestId: "one", reason: "interrupted" })
    await expect(playing).resolves.toEqual({ ok: false, reason: "interrupted" })
    expect(source.stop).toHaveBeenCalledOnce()
    expect(source.onended).toBeNull()
  })
})
