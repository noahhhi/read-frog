import { z } from "zod"
import { browser, storage } from "#imports"
import { env } from "@/env"
import { GOOGLE_DRIVE_TOKEN_STORAGE_KEY } from "../constants/config"
import { logger } from "../logger"
import {
  DEFAULT_SAFARI_GOOGLE_REDIRECT_URL,
  isOAuthRedirect,
  launchSafariWebAuthFlow,
} from "./safari-auth"

const GOOGLE_CLIENT_ID = env.WXT_GOOGLE_CLIENT_ID ?? "YOUR_CLIENT_ID"
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/drive.appdata",
  "https://www.googleapis.com/auth/userinfo.email",
]
const TOKEN_EXPIRY_BUFFER_MS = 60000

const googleAuthTokenSchema = z.object({
  access_token: z.string(),
  expires_at: z.number(),
  token_type: z.string().default("Bearer"),
})

const googleUserInfoSchema = z.object({
  id: z.string(),
  email: z.email(),
  verified_email: z.boolean(),
  picture: z.url().optional(),
})

export type GoogleAuthToken = z.infer<typeof googleAuthTokenSchema>
export type GoogleUserInfo = z.infer<typeof googleUserInfoSchema>

/**
 * Get token from storage with validation
 */
async function getTokenFromStorage(): Promise<GoogleAuthToken | null> {
  try {
    const tokenData = await storage.getItem<GoogleAuthToken>(
      `local:${GOOGLE_DRIVE_TOKEN_STORAGE_KEY}`,
    )
    if (!tokenData) {
      return null
    }

    const parsed = googleAuthTokenSchema.safeParse(tokenData)
    if (!parsed.success) {
      logger.warn("Invalid token data in storage", parsed.error)
      return null
    }

    return parsed.data
  } catch (error) {
    logger.error("Failed to get token from storage", error)
    return null
  }
}

/**
 * Authenticate with Google Drive using OAuth 2.0
 */
export async function authenticateGoogleDriveAndSaveTokenToStorage(): Promise<string> {
  try {
    const isSafari = import.meta.env.BROWSER === "safari"
    if (!isSafari && (!browser.identity?.getRedirectURL || !browser.identity?.launchWebAuthFlow)) {
      throw new Error("Google Drive sign-in is not supported by this browser build.")
    }
    if (GOOGLE_CLIENT_ID === "YOUR_CLIENT_ID")
      throw new Error("This build needs WXT_GOOGLE_CLIENT_ID to sign in to Google Drive.")
    const redirectURL = isSafari
      ? (env.WXT_GOOGLE_REDIRECT_URL ?? DEFAULT_SAFARI_GOOGLE_REDIRECT_URL)
      : browser.identity.getRedirectURL()
    const state = crypto.randomUUID()
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth")
    authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID)
    authUrl.searchParams.set("response_type", "token")
    authUrl.searchParams.set("redirect_uri", redirectURL)
    authUrl.searchParams.set("scope", GOOGLE_SCOPES.join(" "))
    authUrl.searchParams.set("prompt", "select_account")
    authUrl.searchParams.set("state", state)

    const responseUrl = isSafari
      ? await launchSafariWebAuthFlow(authUrl.toString(), redirectURL)
      : await browser.identity.launchWebAuthFlow({ url: authUrl.toString(), interactive: true })

    if (!responseUrl) {
      throw new Error("No response URL from Google OAuth")
    }

    const url = new URL(responseUrl)
    const params = new URLSearchParams(url.hash.slice(1))
    if (
      !isOAuthRedirect(responseUrl, redirectURL) ||
      params.getAll("state").length !== 1 ||
      params.get("state") !== state
    ) {
      throw new Error("Google sign-in response did not match this login attempt")
    }
    if (params.has("error")) throw new Error("Google sign-in was cancelled or denied")
    const accessToken = params.get("access_token")
    const expiresIn = params.get("expires_in")

    if (!accessToken || params.getAll("access_token").length !== 1) {
      throw new Error("No access token in OAuth response")
    }

    const lifetime = expiresIn === null ? 3600 : Number(expiresIn)
    if (!Number.isFinite(lifetime) || lifetime <= 0) throw new Error("Invalid Google token expiry")
    const expiresAt = Date.now() + lifetime * 1000

    const tokenData: GoogleAuthToken = {
      access_token: accessToken,
      expires_at: expiresAt,
      token_type: "Bearer",
    }

    // Validate before storing
    const validatedToken = googleAuthTokenSchema.parse(tokenData)
    await storage.setItem(`local:${GOOGLE_DRIVE_TOKEN_STORAGE_KEY}`, validatedToken)

    return accessToken
  } catch (error) {
    logger.error("Google OAuth authentication failed", error)
    throw error
  }
}

/**
 * Get valid access token, re-authenticate if expired
 */
export async function getValidAccessToken(): Promise<string> {
  try {
    const tokenData = await getTokenFromStorage()

    // Re-authenticate if token not found or expiring soon (within 1 minute)
    if (!tokenData || Date.now() >= tokenData.expires_at - TOKEN_EXPIRY_BUFFER_MS) {
      return await authenticateGoogleDriveAndSaveTokenToStorage()
    }

    // Trust local expiry check - validate only on API 401 errors
    return tokenData.access_token
  } catch (error) {
    logger.error("Failed to get valid access token", error)
    throw error
  }
}

export async function clearAccessToken(): Promise<void> {
  try {
    await storage.removeItem(`local:${GOOGLE_DRIVE_TOKEN_STORAGE_KEY}`)
  } catch (error) {
    logger.error("Failed to clear access token", error)
    throw error
  }
}

/**
 * Check if user is authenticated with valid token
 */
export async function getIsAuthenticated(): Promise<boolean> {
  try {
    const tokenData = await getTokenFromStorage()

    if (!tokenData) {
      return false
    }

    return Date.now() < tokenData.expires_at - TOKEN_EXPIRY_BUFFER_MS
  } catch (error) {
    logger.error("Failed to check authentication status", error)
    return false
  }
}

/**
 * Fetch Google user info using access token
 */
export async function getGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!res.ok) {
    throw new Error(`Failed to fetch user info: ${res.status}`)
  }

  const data = await res.json()
  const parsed = googleUserInfoSchema.safeParse(data)

  if (!parsed.success) {
    logger.error("Invalid user info response", parsed.error)
    throw new Error("Invalid user info response")
  }

  return parsed.data
}
