import * as crypto from 'crypto';

/**
 * OAuth flow for Claude subscription accounts — the same authorization-code +
 * PKCE flow Claude Code uses. Each account signs in through the browser; we
 * store the access/refresh token pair and refresh automatically.
 */

/** Required on every request authenticated with an OAuth bearer token. */
export const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Subscription OAuth tokens are scoped to Claude Code usage; the first system
 * block must be this identity string for inference to be accepted.
 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
/** Claude Code's public OAuth client id. */
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

export interface OAuthTokens {
  type: 'oauth';
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl(pkce: PkcePair): string {
  const params = new URLSearchParams({
    code: 'true',
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    state: pkce.verifier,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OAuth token request failed (HTTP ${res.status}): ${detail}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Exchange the pasted authorization code for tokens. The callback page shows
 * the code as "code#state" — accept either that or the bare code.
 */
export async function exchangeCode(pasted: string, pkce: PkcePair): Promise<OAuthTokens> {
  const [code, state] = pasted.trim().split('#');
  if (!code) {
    throw new Error('Empty authorization code.');
  }
  const data = await postToken({
    grant_type: 'authorization_code',
    code,
    state: state ?? pkce.verifier,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });
  if (!data.refresh_token) {
    throw new Error('OAuth response did not include a refresh token.');
  }
  return {
    type: 'oauth',
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshTokens(tokens: OAuthTokens): Promise<OAuthTokens> {
  const data = await postToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
  });
  return {
    type: 'oauth',
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}
