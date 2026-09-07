import { browser } from "#imports"

// The production Chrome callback is registered with the upstream Google client.
// Safari can observe that redirect in its own sign-in tab without navigating an
// embedded web view or changing the Google application identity.
export const DEFAULT_SAFARI_GOOGLE_REDIRECT_URL =
  "https://modkelfkcfjpgbfmnbnllalkiogfofhb.chromiumapp.org/"

export function isOAuthRedirect(url: string, redirectURL: string): boolean {
  try {
    const actual = new URL(url)
    const expected = new URL(redirectURL)
    return actual.origin === expected.origin && actual.pathname === expected.pathname
  } catch {
    return false
  }
}

/** Safari equivalent of the interactive portion of identity.launchWebAuthFlow. */
export async function launchSafariWebAuthFlow(
  authURL: string,
  redirectURL: string,
  timeoutMs = 300_000,
): Promise<string> {
  const redirect = new URL(redirectURL)
  if (
    redirect.protocol !== "https:" ||
    redirect.username ||
    redirect.password ||
    redirect.search ||
    redirect.hash
  ) {
    throw new Error(
      "Google OAuth requires an exact HTTPS redirect URL without credentials, query or fragment.",
    )
  }

  // Create a blank tab first so listeners are installed before OAuth can redirect.
  const tab = await browser.tabs.create({ url: "about:blank", active: true })
  const tabId = tab.id
  if (tabId === undefined) throw new Error("Could not open Google sign-in tab")

  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (result: { url: string } | { error: Error }, closeTab = true) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      browser.tabs.onUpdated.removeListener(onUpdated)
      browser.tabs.onRemoved.removeListener(onRemoved)
      globalThis.removeEventListener?.("pagehide", onPageHide)
      if (closeTab) void browser.tabs.remove(tabId).catch(() => {})
      if ("url" in result) resolve(result.url)
      else reject(result.error)
    }
    const onUpdated: Parameters<typeof browser.tabs.onUpdated.addListener>[0] = (
      id,
      change,
      updatedTab,
    ) => {
      if (id !== tabId) return
      const url = change.url ?? updatedTab.url
      if (url && isOAuthRedirect(url, redirectURL)) finish({ url })
    }
    const onRemoved: Parameters<typeof browser.tabs.onRemoved.addListener>[0] = (id) => {
      if (id === tabId) finish({ error: new Error("Google sign-in was cancelled") }, false)
    }
    const onPageHide = () => finish({ error: new Error("Google sign-in page was closed") })
    const timeout = setTimeout(
      () => finish({ error: new Error("Google sign-in timed out. Please retry.") }),
      timeoutMs,
    )
    browser.tabs.onUpdated.addListener(onUpdated)
    browser.tabs.onRemoved.addListener(onRemoved)
    globalThis.addEventListener?.("pagehide", onPageHide, { once: true })
    void browser.tabs.update(tabId, { url: authURL }).catch(() => {
      finish({ error: new Error("Could not open Google sign-in") })
    })
  })
}
