import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Codex device-code OAuth flow.
 *
 * Why this exists: relying on the upstream `codex login` CLI works but
 * requires the user to install another tool. Implementing the device-code
 * flow ourselves means contextberg can authenticate against ChatGPT directly.
 *
 * Storage strategy: we save the resulting tokens to
 *   ~/.agent-history/codex-auth.json
 * NOT to ~/.codex/auth.json. Refresh tokens are single-use, so sharing
 * storage with the upstream CLI causes refresh_token_reused failures. We
 * do not read or write the upstream CLI auth file.
 */

const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
const CODEX_OAUTH_TOKEN_URL = `${CODEX_OAUTH_ISSUER}/oauth/token`;
const CODEX_BACKEND = 'https://chatgpt.com/backend-api/codex';

export const CONTEXTBERG_CODEX_AUTH_PATH = path.join(os.homedir(), '.agent-history', 'codex-auth.json');

interface DeviceAuthResponse {
  user_code?: string;
  device_auth_id?: string;
  interval?: number | string;
}

interface PolledCode {
  authorization_code?: string;
  code_verifier?: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface CodexCredentials {
  tokens: {
    access_token: string;
    refresh_token?: string;
  };
  base_url: string;
  obtained_at: string;
}

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data?: T; text?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.ok) {
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { status: res.status, text };
    }
  }
  return { status: res.status, text };
}

async function postForm<T>(url: string, body: Record<string, string>): Promise<{ status: number; data?: T; text?: string }> {
  const formBody = new URLSearchParams(body).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: formBody,
  });
  const text = await res.text();
  if (res.ok) {
    try {
      return { status: res.status, data: JSON.parse(text) as T };
    } catch {
      return { status: res.status, text };
    }
  }
  return { status: res.status, text };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run the device-code flow end-to-end. Prints the URL + code, waits for the
 * user to complete sign-in in their browser, then exchanges for tokens.
 * Throws on any failure with a human-readable message.
 */
export async function runCodexDeviceCodeLogin(): Promise<CodexCredentials> {
  // Step 1: request a device code.
  const init = await postJson<DeviceAuthResponse>(
    `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CODEX_OAUTH_CLIENT_ID },
  );
  if (init.status !== 200 || !init.data) {
    throw new Error(`Codex device-code request failed (status ${init.status}): ${init.text ?? '(no body)'}`);
  }
  const { user_code, device_auth_id, interval } = init.data;
  if (!user_code || !device_auth_id) {
    throw new Error('Codex device-code response missing user_code or device_auth_id.');
  }
  const pollInterval = Math.max(3, Number(interval) || 5) * 1000;

  // Step 2: show the user the URL + code. NO browser auto-open; match
  // Hermes UX (the user pastes the code where they want it).
  console.log('');
  console.log('To sign in to Codex (ChatGPT), do this in another window:');
  console.log('');
  console.log('  1. Open this URL in your browser:');
  console.log(`       ${CODEX_OAUTH_ISSUER}/codex/device`);
  console.log('');
  console.log('  2. Enter this code when prompted:');
  console.log(`       ${user_code}`);
  console.log('');
  console.log('Waiting for sign-in... (press Ctrl+C to cancel)');

  // Step 3: poll until the user signs in (or 15 min timeout).
  const maxWaitMs = 15 * 60 * 1000;
  const startedAt = Date.now();
  let codeResp: PolledCode | undefined;
  while (Date.now() - startedAt < maxWaitMs) {
    await sleep(pollInterval);
    const poll = await postJson<PolledCode>(
      `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`,
      { device_auth_id, user_code },
    );
    if (poll.status === 200 && poll.data) {
      codeResp = poll.data;
      break;
    }
    // 403/404 just mean "not yet"; keep polling. Anything else is fatal.
    if (poll.status !== 403 && poll.status !== 404) {
      throw new Error(`Codex device-code polling returned status ${poll.status}: ${poll.text ?? '(no body)'}`);
    }
  }
  if (!codeResp) {
    throw new Error('Codex login timed out after 15 minutes.');
  }
  const { authorization_code, code_verifier } = codeResp;
  if (!authorization_code || !code_verifier) {
    throw new Error('Codex device-code response missing authorization_code or code_verifier.');
  }

  // Step 4: exchange the authorization code for tokens.
  const redirectUri = `${CODEX_OAUTH_ISSUER}/deviceauth/callback`;
  const tokenResp = await postForm<TokenResponse>(CODEX_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    code: authorization_code,
    redirect_uri: redirectUri,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier,
  });
  if (tokenResp.status !== 200 || !tokenResp.data) {
    throw new Error(`Codex token exchange failed (status ${tokenResp.status}): ${tokenResp.text ?? '(no body)'}`);
  }
  const access = tokenResp.data.access_token;
  if (!access) {
    throw new Error('Codex token exchange returned no access_token.');
  }

  const creds: CodexCredentials = {
    tokens: {
      access_token: access,
      ...(tokenResp.data.refresh_token ? { refresh_token: tokenResp.data.refresh_token } : {}),
    },
    base_url: CODEX_BACKEND,
    obtained_at: new Date().toISOString(),
  };
  await saveCodexCredentials(creds);
  return creds;
}

export async function saveCodexCredentials(creds: CodexCredentials): Promise<void> {
  await fs.mkdir(path.dirname(CONTEXTBERG_CODEX_AUTH_PATH), { recursive: true });
  await fs.writeFile(
    CONTEXTBERG_CODEX_AUTH_PATH,
    JSON.stringify(creds, null, 2) + '\n',
    { mode: 0o600 },
  );
}

export async function loadCodexCredentials(): Promise<CodexCredentials | null> {
  try {
    const raw = await fs.readFile(CONTEXTBERG_CODEX_AUTH_PATH, 'utf-8');
    return JSON.parse(raw) as CodexCredentials;
  } catch {
    return null;
  }
}
