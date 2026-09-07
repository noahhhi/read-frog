import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => {
  const updated = new Set<(...args: any[]) => void>()
  const removed = new Set<(...args: any[]) => void>()
  return {
    updated,
    removed,
    browser: {
      tabs: {
        create: vi.fn<(...args: any[]) => any>(),
        update: vi.fn<(...args: any[]) => any>(),
        remove: vi.fn<(...args: any[]) => any>(),
        onUpdated: {
          addListener: vi.fn<(...args: any[]) => any>((f) => updated.add(f)),
          removeListener: vi.fn<(...args: any[]) => any>((f) => updated.delete(f)),
        },
        onRemoved: {
          addListener: vi.fn<(...args: any[]) => any>((f) => removed.add(f)),
          removeListener: vi.fn<(...args: any[]) => any>((f) => removed.delete(f)),
        },
      },
    },
  }
})
vi.mock("#imports", () => ({ browser: state.browser }))
vi.mock("wxt/browser", () => ({ browser: state.browser }))

import { isOAuthRedirect, launchSafariWebAuthFlow } from "../safari-auth"

const redirect = "https://extension.chromiumapp.org/"
const authURL = "https://accounts.google.com/o/oauth2/v2/auth?state=test"
const resultURL = redirect + "#access_token=test&state=test"

describe("Safari OAuth tab lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.updated.clear()
    state.removed.clear()
    state.browser.tabs.create.mockResolvedValue({ id: 42 })
    state.browser.tabs.update.mockResolvedValue({ id: 42 })
    state.browser.tabs.remove.mockResolvedValue(undefined)
  })
  afterEach(() => vi.useRealTimers())

  const emit = (id: number, url: string) =>
    state.updated.forEach((f) => f(id, { url }, { id, url }))
  const ready = () => vi.waitFor(() => expect(state.browser.tabs.update).toHaveBeenCalled())
  const cleaned = () => {
    expect(state.updated.size).toBe(0)
    expect(state.removed.size).toBe(0)
  }

  it("accepts only the exact callback in the tab it created", async () => {
    const pending = launchSafariWebAuthFlow(authURL, redirect)
    await ready()
    emit(99, resultURL)
    emit(42, "https://extension.chromiumapp.org.attacker.example/#access_token=bad")
    emit(42, "https://extension.chromiumapp.org/other#access_token=bad")
    expect(state.browser.tabs.remove).not.toHaveBeenCalled()
    emit(42, resultURL)
    await expect(pending).resolves.toBe(resultURL)
    expect(state.browser.tabs.remove).toHaveBeenCalledWith(42)
    cleaned()
  })

  it("installs listeners before navigating, including an immediate redirect", async () => {
    state.browser.tabs.update.mockImplementation(async () => {
      emit(42, resultURL)
      return { id: 42 }
    })
    await expect(launchSafariWebAuthFlow(authURL, redirect)).resolves.toBe(resultURL)
    cleaned()
  })

  it("rejects cancellation and ignores unrelated tab closures", async () => {
    const pending = launchSafariWebAuthFlow(authURL, redirect)
    await ready()
    state.removed.forEach((f) => f(99))
    expect(state.updated.size).toBe(1)
    state.removed.forEach((f) => f(42))
    await expect(pending).rejects.toThrow("cancelled")
    expect(state.browser.tabs.remove).not.toHaveBeenCalled()
    cleaned()
  })

  it("closes only its own tab and removes listeners on timeout", async () => {
    vi.useFakeTimers()
    const pending = launchSafariWebAuthFlow(authURL, redirect, 100)
    const outcome = pending.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(101)
    await expect(outcome).resolves.toBe("Google sign-in timed out. Please retry.")
    expect(state.browser.tabs.remove).toHaveBeenCalledWith(42)
    cleaned()
  })

  it("cleans up when navigation fails", async () => {
    state.browser.tabs.update.mockRejectedValue(new Error("navigation failed"))
    await expect(launchSafariWebAuthFlow(authURL, redirect)).rejects.toThrow("Could not open")
    expect(state.browser.tabs.remove).toHaveBeenCalledWith(42)
    cleaned()
  })

  it("validates callbacks before creating any tab", async () => {
    for (const url of [
      "http://extension.chromiumapp.org/",
      "https://user:password@example.com/",
      redirect + "?query=1",
      redirect + "#fragment",
    ]) {
      await expect(launchSafariWebAuthFlow(authURL, url)).rejects.toThrow("HTTPS redirect")
    }
    expect(state.browser.tabs.create).not.toHaveBeenCalled()
    expect(isOAuthRedirect("invalid", redirect)).toBe(false)
  })
})
