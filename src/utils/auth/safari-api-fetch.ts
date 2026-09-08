import { AUTH_BASE_PATH, AUTH_COOKIE_PATTERNS, ORPC_PREFIX } from "@read-frog/definitions"
import { browser } from "#imports"
import { env } from "@/env"

type Port = Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0]
type ApiMessage =
  | { type: "headers"; status: number; statusText: string; headers: [string, string][] }
  | { type: "chunk"; bytes: number[] }
  | { type: "end" }
  | { type: "error"; message: string }

export function isAccountApiURL(url: string): boolean {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  return (
    target.origin === new URL(env.WXT_API_URL).origin &&
    !target.username &&
    !target.password &&
    [AUTH_BASE_PATH, ORPC_PREFIX].some(
      (prefix) => target.pathname === prefix || target.pathname.startsWith(`${prefix}/`),
    )
  )
}

function isOfficialTab(url: string | undefined): boolean {
  if (!url) return false
  try {
    return env.WXT_OFFICIAL_SITE_ORIGINS.includes(new URL(url).origin)
  } catch {
    return false
  }
}

let openingTab: Promise<number | undefined> | undefined

async function findAccountTab(): Promise<number | undefined> {
  const tabs = await browser.tabs.query({})
  const official = tabs.filter(
    (tab) => tab.incognito === browser.extension.inIncognitoContext && isOfficialTab(tab.url),
  )
  const existing = official.find((tab) => tab.active) ?? official[0]
  if (existing?.id !== undefined) return existing.id

  // Guests do not need an extra tab. After sign-in, Safari needs a first-party
  // website context: extension fetch omits even readable SameSite=Lax cookies.
  const cookies = await browser.cookies.getAll({ url: env.WXT_API_URL })
  if (!cookies.some((cookie) => AUTH_COOKIE_PATTERNS.some((name) => cookie.name.includes(name)))) {
    return undefined
  }

  openingTab ??= (async () => {
    const tab = await browser.tabs.create({ url: `${env.WXT_WEBSITE_URL}/home`, active: false })
    if (tab.id === undefined) throw new Error("Could not open the account website")
    const tabId = tab.id
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        browser.tabs.onUpdated.removeListener(onUpdated)
        browser.tabs.onRemoved.removeListener(onRemoved)
        if (error) reject(error)
        else resolve()
      }
      const onUpdated: Parameters<typeof browser.tabs.onUpdated.addListener>[0] = (id, change) => {
        if (id === tabId && change.status === "complete") finish()
      }
      const onRemoved = (id: number) => {
        if (id === tabId) finish(new Error("The account website was closed"))
      }
      const timeout = setTimeout(() => finish(new Error("The account website timed out")), 20_000)
      browser.tabs.onUpdated.addListener(onUpdated)
      browser.tabs.onRemoved.addListener(onRemoved)
      void browser.tabs.get(tabId).then(
        (current) => {
          if (current.status === "complete") finish()
        },
        () => finish(new Error("The account website was closed")),
      )
    })
    return tabId
  })().finally(() => {
    openingTab = undefined
  })
  return openingTab
}

/**
 * Run only Read Frog account APIs in an isolated script on the official site.
 * Cookies stay in Safari's website store. A private runtime port preserves
 * streaming and cancellation without exposing requests to page scripts.
 */
export async function safariApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input)
  if (import.meta.env.BROWSER !== "safari" || !isAccountApiURL(url)) return fetch(input, init)

  // Preserve the original body if a guest request falls back to native fetch.
  const request = new Request(input instanceof Request ? input.clone() : input, init)
  if (request.credentials === "omit") return fetch(input, init)
  request.signal.throwIfAborted()
  const tabId = await findAccountTab()
  if (tabId === undefined) return fetch(input, init)
  request.signal.throwIfAborted()

  const name = `read-frog-account-${crypto.randomUUID()}`
  const payload = {
    url: request.url,
    method: request.method,
    headers: [...request.headers.entries()],
    body: request.body ? Array.from(new Uint8Array(await request.arrayBuffer())) : undefined,
  }
  request.signal.throwIfAborted()

  return new Promise<Response>((resolve, reject) => {
    let port: Port | undefined
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    let finished = false
    const cleanup = () => {
      clearTimeout(timeout)
      browser.runtime.onConnect.removeListener(onConnect)
      request.signal.removeEventListener("abort", onAbort)
      port?.onDisconnect.removeListener(onDisconnect)
      port?.onMessage.removeListener(onMessage)
      port?.disconnect()
    }
    const fail = (error: Error) => {
      if (finished) return
      finished = true
      controller?.error(error)
      reject(error)
      cleanup()
    }
    const onAbort = () => fail(new DOMException("The request was aborted", "AbortError"))
    const onDisconnect = () => fail(new Error("The account website disconnected"))
    const onMessage = (message: ApiMessage) => {
      if (finished) return
      if (message.type === "headers") {
        if (controller) return
        clearTimeout(timeout)
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController
          },
          cancel() {
            finished = true
            cleanup()
          },
        })
        resolve(new Response([204, 205, 304].includes(message.status) ? null : body, message))
      } else if (message.type === "chunk") {
        controller?.enqueue(new Uint8Array(message.bytes))
      } else if (message.type === "end") {
        finished = true
        controller?.close()
        cleanup()
      } else if (message.type === "error") {
        fail(new Error(message.message))
      }
    }
    const onConnect = (candidate: Port) => {
      if (
        candidate.name !== name ||
        candidate.sender?.tab?.id !== tabId ||
        !isOfficialTab(candidate.sender.url)
      )
        return
      port = candidate
      browser.runtime.onConnect.removeListener(onConnect)
      port.onMessage.addListener(onMessage)
      port.onDisconnect.addListener(onDisconnect)
    }
    const timeout = setTimeout(() => fail(new Error("The account request timed out")), 60_000)
    browser.runtime.onConnect.addListener(onConnect)
    request.signal.addEventListener("abort", onAbort, { once: true })
    if (request.signal.aborted) return onAbort()

    // This function must be self-contained: Safari serializes it into the
    // isolated content-script world, never the website's JavaScript world.
    void browser.scripting
      .executeScript({
        target: { tabId },
        func: async (
          portName: string,
          origins: string[],
          apiOrigin: string,
          prefixes: string[],
          data: {
            url: string
            method: string
            headers: string[][]
            body?: number[]
          },
        ) => {
          if (!origins.includes(location.origin)) throw new Error("The account website changed")
          const webExtension = (globalThis as unknown as { browser: typeof browser }).browser
          const connection = webExtension.runtime.connect({ name: portName })
          const abort = new AbortController()
          connection.onDisconnect.addListener(() => abort.abort())
          try {
            const target = new URL(data.url)
            if (
              !origins.includes(location.origin) ||
              target.origin !== apiOrigin ||
              target.username ||
              target.password ||
              !prefixes.some(
                (prefix) => target.pathname === prefix || target.pathname.startsWith(`${prefix}/`),
              )
            )
              throw new Error("Invalid account request destination")
            const response = await fetch(data.url, {
              method: data.method,
              headers: data.headers as [string, string][],
              body: data.body ? new Uint8Array(data.body) : undefined,
              credentials: "include",
              cache: "no-store",
              // Account APIs do not redirect to third parties. Never forward
              // a request body or headers to a redirect destination.
              redirect: "error",
              signal: abort.signal,
            })
            connection.postMessage({
              type: "headers",
              status: response.status,
              statusText: response.statusText,
              headers: [...response.headers.entries()],
            })
            const reader = response.body?.getReader()
            if (reader) {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                connection.postMessage({ type: "chunk", bytes: Array.from(value) })
              }
            }
            connection.postMessage({ type: "end" })
          } catch (error) {
            if (!abort.signal.aborted)
              connection.postMessage({
                type: "error",
                message: error instanceof Error ? error.message : "Account request failed",
              })
          }
        },
        args: [
          name,
          env.WXT_OFFICIAL_SITE_ORIGINS,
          new URL(env.WXT_API_URL).origin,
          [AUTH_BASE_PATH, ORPC_PREFIX],
          payload,
        ],
      })
      .catch((error: unknown) =>
        fail(error instanceof Error ? error : new Error("Could not reach the account website")),
      )
  })
}
