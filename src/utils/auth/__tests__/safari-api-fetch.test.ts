import { TextEncoder } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  function event() {
    const listeners = new Set<(...args: any[]) => void>()
    return {
      addListener: vi.fn<(...args: any[]) => any>((listener: (...args: any[]) => void) =>
        listeners.add(listener),
      ),
      removeListener: vi.fn<(...args: any[]) => any>((listener: (...args: any[]) => void) =>
        listeners.delete(listener),
      ),
      emit: (...args: any[]) => [...listeners].forEach((listener) => listener(...args)),
      clear: () => listeners.clear(),
      listeners,
    }
  }
  const onConnect = event()
  const onMessage = event()
  const onDisconnect = event()
  const port = {
    name: "",
    sender: { tab: { id: 5 }, url: "https://www.readfrog.app/en/home" },
    onMessage,
    onDisconnect,
    disconnect: vi.fn<(...args: any[]) => any>(),
  }
  const browser = {
    tabs: {
      query: vi.fn<(...args: any[]) => any>(),
      create: vi.fn<(...args: any[]) => any>(),
      onUpdated: event(),
      onRemoved: event(),
      get: vi.fn<(...args: any[]) => any>(),
    },
    extension: { inIncognitoContext: false },
    cookies: { getAll: vi.fn<(...args: any[]) => any>() },
    runtime: { onConnect },
    scripting: { executeScript: vi.fn<(...args: any[]) => any>() },
  }
  return { browser, port, onConnect, onMessage, onDisconnect }
})

vi.mock("#imports", () => ({ browser: mocks.browser }))
vi.mock("wxt/browser", () => ({ browser: mocks.browser }))
vi.mock("@/env", () => ({
  env: {
    WXT_API_URL: "https://api.readfrog.app",
    WXT_WEBSITE_URL: "https://www.readfrog.app",
    WXT_OFFICIAL_SITE_ORIGINS: ["https://www.readfrog.app", "https://readfrog.app"],
  },
}))

import { isAccountApiURL, safariApiFetch } from "../safari-api-fetch"

const sessionURL = "https://api.readfrog.app/api/identity/get-session"
const options = { credentials: "include" } as const

async function startRequest(init: RequestInit = options) {
  const result = safariApiFetch(sessionURL, init)
  await vi.waitFor(() => expect(mocks.browser.scripting.executeScript).toHaveBeenCalled())
  mocks.port.name = mocks.browser.scripting.executeScript.mock.calls[0]![0].args[0]
  mocks.onConnect.emit(mocks.port)
  return { result }
}

function headers(status = 200) {
  mocks.onMessage.emit({ type: "headers", status, statusText: "OK", headers: [] })
}

describe("Safari authenticated API transport", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv("BROWSER", "safari")
    // The shared DOM test shim truncates non-ASCII text; use real UTF-8 here.
    vi.stubGlobal("TextEncoder", TextEncoder)
    vi.stubGlobal("fetch", vi.fn<(...args: any[]) => any>().mockResolvedValue(new Response("null")))
    mocks.onConnect.clear()
    mocks.onMessage.clear()
    mocks.onDisconnect.clear()
    mocks.browser.tabs.query.mockResolvedValue([
      { id: 5, url: "https://www.readfrog.app/en/home", incognito: false, active: true },
    ])
    mocks.browser.cookies.getAll.mockResolvedValue([])
    mocks.browser.scripting.executeScript.mockResolvedValue([])
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it("restricts the transport to exact account API origins and route boundaries", () => {
    expect(isAccountApiURL(sessionURL)).toBe(true)
    expect(isAccountApiURL("https://api.readfrog.app/api/rpc/billing/status")).toBe(true)
    for (const url of [
      "https://api.readfrog.app.evil.test/api/identity/get-session",
      "https://api.readfrog.app/api/identity-other/get-session",
      "https://api.readfrog.app/anything",
      "https://user@api.readfrog.app/api/identity/get-session",
      "/api/identity/get-session",
    ])
      expect(isAccountApiURL(url)).toBe(false)
  })

  it("keeps Chrome, external providers and credential-free requests on native fetch", async () => {
    vi.stubEnv("BROWSER", "chrome")
    await safariApiFetch(sessionURL, options)
    vi.stubEnv("BROWSER", "safari")
    await safariApiFetch("https://provider.example/v1/chat/completions", options)
    await safariApiFetch(sessionURL, { credentials: "omit" })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(mocks.browser.tabs.query).not.toHaveBeenCalled()
  })

  it("does not open a website for guests or use a private or lookalike tab", async () => {
    mocks.browser.tabs.query.mockResolvedValue([
      { id: 6, url: "https://www.readfrog.app/en/home", incognito: true },
      { id: 7, url: "https://www.readfrog.app.evil.test/", incognito: false },
    ])
    await safariApiFetch(sessionURL, options)
    expect(mocks.browser.scripting.executeScript).not.toHaveBeenCalled()
    expect(mocks.browser.tabs.create).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("preserves a guest POST body when falling back to native fetch", async () => {
    mocks.browser.tabs.query.mockResolvedValue([])
    vi.mocked(fetch).mockImplementation(
      async (input) => new Response(await (input as Request).text()),
    )
    const response = await safariApiFetch(
      new Request(sessionURL, { ...options, method: "POST", body: "original-body" }),
    )
    expect(await response.text()).toBe("original-body")
  })

  it("never opens the homepage for concurrent background reads, even with a login cookie", async () => {
    mocks.browser.tabs.query.mockResolvedValue([])
    mocks.browser.cookies.getAll.mockResolvedValue([
      { name: "better-auth.session_token", value: "test-session" },
    ])
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        safariApiFetch(
          index % 2 ? sessionURL : "https://api.readfrog.app/api/rpc/hostedAi/status",
          options,
        ),
      ),
    )
    expect(fetch).toHaveBeenCalledTimes(12)
    expect(mocks.browser.tabs.create).not.toHaveBeenCalled()
    expect(mocks.browser.scripting.executeScript).not.toHaveBeenCalled()
  })

  it("uses a manually opened Chinese homepage and does not reopen it after closure", async () => {
    mocks.browser.tabs.query.mockResolvedValue([
      { id: 5, url: "https://www.readfrog.app/zh/home", incognito: false, active: true },
    ])
    const { result } = await startRequest()
    headers()
    mocks.onMessage.emit({ type: "chunk", bytes: Array.from(new TextEncoder().encode("{}")) })
    mocks.onMessage.emit({ type: "end" })
    expect(await (await result).json()).toEqual({})

    mocks.browser.tabs.query.mockResolvedValue([])
    mocks.browser.cookies.getAll.mockResolvedValue([
      { name: "better-auth.session_token", value: "test-session" },
    ])
    await safariApiFetch(sessionURL, options)
    expect(mocks.browser.tabs.create).not.toHaveBeenCalled()
    expect(mocks.browser.scripting.executeScript).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("forwards request bytes and yields stream chunks before completion", async () => {
    const { result } = await startRequest({ ...options, method: "POST", body: "你好" })
    const injection = mocks.browser.scripting.executeScript.mock.calls[0]![0]
    expect(new TextDecoder().decode(new Uint8Array(injection.args[4].body))).toBe("你好")
    expect(injection.args[4].method).toBe("POST")
    headers()
    const response = await result
    const reader = response.body!.getReader()
    const chunk = reader.read()
    mocks.onMessage.emit({ type: "chunk", bytes: [65, 66] })
    expect(await chunk).toEqual({ done: false, value: new Uint8Array([65, 66]) })
    expect(mocks.port.disconnect).not.toHaveBeenCalled()
    mocks.onMessage.emit({ type: "end" })
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(mocks.port.disconnect).toHaveBeenCalledOnce()
    expect(mocks.onMessage.listeners.size).toBe(0)
  })

  it("cancels an active stream and disconnects its website port", async () => {
    const abort = new AbortController()
    const { result } = await startRequest({ ...options, signal: abort.signal })
    headers()
    const response = await result
    abort.abort()
    await expect(response.text()).rejects.toMatchObject({ name: "AbortError" })
    expect(mocks.port.disconnect).toHaveBeenCalledOnce()
  })

  it("rejects a closed website without retrying a mutation", async () => {
    const { result } = await startRequest({ ...options, method: "POST", body: "{}" })
    const failed = result.catch((error: Error) => error)
    mocks.onDisconnect.emit()
    expect(await failed).toMatchObject({ message: "The account website disconnected" })
    expect(mocks.browser.scripting.executeScript).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it("does not accept a matching port name from a different page", async () => {
    const result = safariApiFetch(sessionURL, options)
    await vi.waitFor(() => expect(mocks.browser.scripting.executeScript).toHaveBeenCalled())
    mocks.port.name = mocks.browser.scripting.executeScript.mock.calls[0]![0].args[0]
    mocks.onConnect.emit({ ...mocks.port, sender: { tab: { id: 5 }, url: "https://evil.test" } })
    expect(mocks.onMessage.listeners.size).toBe(0)
    mocks.onConnect.emit(mocks.port)
    headers(204)
    mocks.onMessage.emit({ type: "end" })
    expect((await result).body).toBeNull()
  })

  it("checks the live website origin again before sending any request", async () => {
    const { result } = await startRequest()
    const injection = mocks.browser.scripting.executeScript.mock.calls[0]![0]
    vi.stubGlobal("location", { origin: "https://evil.test" })
    await expect(injection.func(...injection.args)).rejects.toThrow("website changed")
    expect(fetch).not.toHaveBeenCalled()
    const failed = result.catch((error: Error) => error)
    mocks.onDisconnect.emit()
    expect(await failed).toMatchObject({ message: "The account website disconnected" })
  })
})
