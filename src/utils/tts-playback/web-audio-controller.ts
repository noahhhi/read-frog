import type {
  TTSPlaybackStartRequest,
  TTSPlaybackStartResponse,
  TTSPlaybackStopRequest,
} from "@/types/tts-playback"

/** Safari must resume audio in the page's click handler, before synthesis awaits. */
export class WebAudioPlaybackController {
  private context: AudioContext | null = null
  private generation = 0
  private active: {
    requestId: string
    source: AudioBufferSourceNode
    resolve: (result: TTSPlaybackStartResponse) => void
  } | null = null
  private pendingRequestId: string | null = null

  prepare(): Promise<void> {
    this.context ??= new AudioContext()
    return this.context.resume()
  }

  async play(request: TTSPlaybackStartRequest): Promise<TTSPlaybackStartResponse> {
    this.stop({ reason: "interrupted" })
    const generation = this.generation
    this.pendingRequestId = request.requestId
    const context = this.context
    if (context?.state !== "running") {
      throw new Error("Click Speak again to enable Safari audio playback.")
    }
    const bytes = Uint8Array.from(atob(request.audioBase64), (char) => char.charCodeAt(0))
    const buffer = await context.decodeAudioData(bytes.buffer)
    if (generation !== this.generation) return { ok: false, reason: "stopped" }

    return new Promise((resolve, reject) => {
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      this.active = { requestId: request.requestId, source, resolve }
      source.onended = () => {
        source.disconnect()
        this.active = null
        this.pendingRequestId = null
        resolve({ ok: true })
      }
      try {
        source.start()
      } catch (error) {
        source.onended = null
        source.disconnect()
        this.active = null
        this.pendingRequestId = null
        reject(error)
      }
    })
  }

  stop(request: TTSPlaybackStopRequest = {}): void {
    if (request.requestId && request.requestId !== this.pendingRequestId) return
    this.generation++
    this.pendingRequestId = null
    const active = this.active
    this.active = null
    if (!active) return
    active.source.onended = null
    active.source.stop()
    active.source.disconnect()
    active.resolve({ ok: false, reason: request.reason ?? "stopped" })
  }
}
