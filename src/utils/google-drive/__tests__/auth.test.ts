import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  browser: {
    identity: undefined as
      | undefined
      | {
          getRedirectURL: () => string
          launchWebAuthFlow: (options: { url: string; interactive: boolean }) => Promise<string>
        },
  },
  storage: {
    getItem: vi.fn<(...args: any[]) => any>(),
    setItem: vi.fn<(...args: any[]) => any>(),
    removeItem: vi.fn<(...args: any[]) => any>(),
  },
  safariFlow: vi.fn<(...args: any[]) => any>(),
}))
vi.mock("#imports", () => ({ browser: state.browser, storage: state.storage }))
vi.mock("wxt/browser", () => ({ browser: state.browser }))
vi.mock("wxt/utils/storage", () => ({ storage: state.storage }))
vi.mock("@/env", () => ({ env: { WXT_GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com" } }))
vi.mock("../safari-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../safari-auth")>()),
  launchSafariWebAuthFlow: state.safariFlow,
}))

const redirect = "https://modkelfkcfjpgbfmnbnllalkiogfofhb.chromiumapp.org/"
const callback = (authURL: string, suffix = "") => {
  const params = new URLSearchParams({
    access_token: "test-access",
    expires_in: "3600",
    state: new URL(authURL).searchParams.get("state")!,
  })
  return redirect + "#" + params + suffix
}

describe("Google Drive authentication", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    state.browser.identity = undefined
    state.safariFlow.mockImplementation(async (url: string) => callback(url))
    vi.stubEnv("BROWSER", "safari")
  })
  afterEach(() => vi.unstubAllEnvs())

  it("loads without identity and uses the existing Google client and callback on Safari", async () => {
    const auth = await import("../auth")
    expect(state.safariFlow).not.toHaveBeenCalled()
    await expect(auth.authenticateGoogleDriveAndSaveTokenToStorage()).resolves.toBe("test-access")
    const url = new URL(state.safariFlow.mock.calls[0]![0])
    expect(url.searchParams.get("client_id")).toBe("test.apps.googleusercontent.com")
    expect(url.searchParams.get("redirect_uri")).toBe(redirect)
    expect(url.searchParams.get("response_type")).toBe("token")
    expect(url.searchParams.get("state")).toBeTruthy()
    expect(state.storage.setItem).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ access_token: "test-access" }),
    )
  })

  it("keeps the Chrome identity flow and creates the redirect only on sign-in", async () => {
    vi.stubEnv("BROWSER", "chrome")
    const getRedirectURL = vi.fn<(...args: any[]) => any>(() => redirect)
    state.browser.identity = {
      getRedirectURL,
      launchWebAuthFlow: vi.fn<(...args: any[]) => any>(async ({ url }) => callback(url)),
    }
    const auth = await import("../auth")
    expect(getRedirectURL).not.toHaveBeenCalled()
    await expect(auth.authenticateGoogleDriveAndSaveTokenToStorage()).resolves.toBe("test-access")
    expect(state.safariFlow).not.toHaveBeenCalled()
  })

  it("rejects a mismatched state or callback origin without saving a token", async () => {
    const auth = await import("../auth")
    for (const response of [
      redirect + "#access_token=bad&state=wrong",
      "https://attacker.example/#access_token=bad&state=wrong",
    ]) {
      state.safariFlow.mockResolvedValueOnce(response)
      await expect(auth.authenticateGoogleDriveAndSaveTokenToStorage()).rejects.toThrow(
        "did not match",
      )
    }
    expect(state.storage.setItem).not.toHaveBeenCalled()
  })

  it("rejects duplicate token/state parameters and invalid expiration", async () => {
    const auth = await import("../auth")
    for (const suffix of ["&state=other", "&access_token=other"]) {
      state.safariFlow.mockImplementationOnce(async (url: string) => callback(url, suffix))
      await expect(auth.authenticateGoogleDriveAndSaveTokenToStorage()).rejects.toThrow(
        /match|access token/,
      )
    }
    state.safariFlow.mockImplementationOnce(async (url: string) =>
      callback(url).replace("expires_in=3600", "expires_in=-1"),
    )
    await expect(auth.authenticateGoogleDriveAndSaveTokenToStorage()).rejects.toThrow("expiry")
    expect(state.storage.setItem).not.toHaveBeenCalled()
  })

  it("handles consent denial and preserves the existing token on cancellation", async () => {
    const auth = await import("../auth")
    state.safariFlow.mockImplementationOnce(async (url: string) => {
      const stateValue = new URL(url).searchParams.get("state")!
      return redirect + "#error=access_denied&state=" + stateValue
    })
    await expect(auth.authenticateGoogleDriveAndSaveTokenToStorage()).rejects.toThrow("denied")
    state.safariFlow.mockRejectedValueOnce(new Error("Google sign-in was cancelled"))
    await expect(auth.authenticateGoogleDriveAndSaveTokenToStorage()).rejects.toThrow("cancelled")
    expect(state.storage.setItem).not.toHaveBeenCalled()
    expect(state.storage.removeItem).not.toHaveBeenCalled()
  })
})
