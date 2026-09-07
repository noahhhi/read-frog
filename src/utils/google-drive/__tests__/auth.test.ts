import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  browser: {
    identity: undefined as
      | undefined
      | { getRedirectURL: () => string; launchWebAuthFlow: () => Promise<string> },
  },
}))
vi.mock("#imports", () => ({ browser: state.browser, storage: {} }))
vi.mock("wxt/browser", () => ({ browser: state.browser }))

describe("Google Drive auth capability detection", () => {
  beforeEach(() => {
    vi.resetModules()
    state.browser.identity = undefined
  })

  it("loads settings on Safari without evaluating the unavailable identity API", async () => {
    const auth = await import("../auth")
    await expect(auth.authenticateGoogleDriveAndSaveTokenToStorage()).rejects.toThrow(
      "local file backup",
    )
  })

  it("does not construct a redirect URL until sign-in is requested", async () => {
    const getRedirectURL = vi.fn<() => string>(() => "https://example.chromiumapp.org/")
    state.browser.identity = { getRedirectURL, launchWebAuthFlow: vi.fn<() => Promise<string>>() }
    await import("../auth")
    expect(getRedirectURL).not.toHaveBeenCalled()
  })
})
