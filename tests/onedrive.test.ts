import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthUrl,
  chunkRanges,
  ensureFolders,
  graphItemPath,
  isExpired,
  parseJwtClaims,
  pkceChallenge,
  randomToken,
  tokensFromResponse,
  uploadToFolder,
  GRAPH_ROOT,
  ONEDRIVE_SCOPES,
  SIMPLE_UPLOAD_MAX,
  STATE_PREFIX,
  UPLOAD_CHUNK,
} from "../src/onedrive/core.ts";

// The pure half of the OneDrive layer: PKCE math, URL building, token
// mapping, and the Graph upload calls against a scripted fetch.

test("pkceChallenge matches the RFC 7636 appendix-B vector", async () => {
  const challenge = await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("randomToken is URL-safe and unique", () => {
  const a = randomToken();
  const b = randomToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 43); // 32 bytes ≥ 43 base64url chars
});

test("buildAuthUrl carries the full PKCE + SPA parameter set", () => {
  const url = new URL(
    buildAuthUrl({
      tenant: "common",
      clientId: "client-123",
      redirectUri: "https://app.example/",
      state: `${STATE_PREFIX}abc`,
      challenge: "chal",
    }),
  );
  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
  const q = url.searchParams;
  assert.equal(q.get("client_id"), "client-123");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("response_mode"), "query");
  assert.equal(q.get("redirect_uri"), "https://app.example/");
  assert.equal(q.get("code_challenge"), "chal");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("state"), `${STATE_PREFIX}abc`);
  assert.equal(q.get("scope"), ONEDRIVE_SCOPES.join(" "));
});

function fakeJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown): string =>
    Buffer.from(JSON.stringify(o), "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${enc({ alg: "none" })}.${enc(claims)}.sig`;
}

test("parseJwtClaims decodes base64url payloads, unicode included", () => {
  const claims = parseJwtClaims(
    fakeJwt({ name: "Ada Lovelace 🧮", preferred_username: "ada@example.com" }),
  );
  assert.equal(claims?.name, "Ada Lovelace 🧮");
  assert.equal(claims?.preferred_username, "ada@example.com");
  assert.equal(parseJwtClaims("not-a-jwt"), null);
});

test("tokensFromResponse maps the auth-code response", () => {
  const t = tokensFromResponse(
    {
      access_token: "at",
      refresh_token: "rt",
      expires_in: 3600,
      id_token: fakeJwt({ name: "Ada", preferred_username: "ada@example.com" }),
    },
    1_000_000,
  );
  assert.equal(t.accessToken, "at");
  assert.equal(t.refreshToken, "rt");
  assert.equal(t.expiresAt, 1_000_000 + 3_600_000);
  assert.deepEqual(t.account, { name: "Ada", email: "ada@example.com" });
});

test("a refresh response keeps the previous refresh token and account", () => {
  const prev = tokensFromResponse(
    {
      access_token: "old",
      refresh_token: "rt-1",
      expires_in: 10,
      id_token: fakeJwt({ name: "Ada", preferred_username: "ada@example.com" }),
    },
    0,
  );
  const next = tokensFromResponse({ access_token: "new", expires_in: 3600 }, 5, prev);
  assert.equal(next.accessToken, "new");
  assert.equal(next.refreshToken, "rt-1");
  assert.deepEqual(next.account, prev.account);
});

test("tokensFromResponse surfaces the endpoint's error text", () => {
  assert.throws(
    () =>
      tokensFromResponse(
        { error: "invalid_grant", error_description: "AADSTS70000: expired" },
        0,
      ),
    /AADSTS70000/,
  );
});

test("isExpired applies the refresh skew", () => {
  assert.equal(isExpired(100_000, 20_000), false);
  assert.equal(isExpired(100_000, 50_000), true); // inside the 60s skew
  assert.equal(isExpired(100_000, 200_000), true);
});

test("chunkRanges covers the file exactly", () => {
  assert.deepEqual(chunkRanges(0, 10), []);
  assert.deepEqual(chunkRanges(10, 10), [{ start: 0, end: 9 }]);
  assert.deepEqual(chunkRanges(25, 10), [
    { start: 0, end: 9 },
    { start: 10, end: 19 },
    { start: 20, end: 24 },
  ]);
  assert.equal(UPLOAD_CHUNK % (320 * 1024), 0, "chunk is a multiple of 320 KiB");
});

test("graphItemPath percent-encodes each segment", () => {
  assert.equal(
    graphItemPath(["Apps", "DueBack"], "Reimbursements Ada #1.xlsx"),
    "/me/drive/root:/Apps/DueBack/Reimbursements%20Ada%20%231.xlsx:",
  );
});

// ── Upload calls against a scripted fetch ────────────────────────────────────

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function scriptedFetch(
  respond: (call: Call, index: number) => Response,
): { fetchFn: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: init?.body,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchFn, calls };
}

const json = (o: unknown, status = 200): Response =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("small files go up in one authorized PUT", async () => {
  const { fetchFn, calls } = scriptedFetch(() =>
    json({ name: "r.xlsx", webUrl: "https://1drv.ms/x" }),
  );
  const item = await uploadToFolder(fetchFn, "tok", "r.xlsx", new Blob(["hi"]));
  assert.equal(item.webUrl, "https://1drv.ms/x");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "PUT");
  assert.equal(calls[0]!.url, `${GRAPH_ROOT}/me/drive/root:/Apps/DueBack/r.xlsx:/content`);
  assert.equal(calls[0]!.headers.Authorization, "Bearer tok");
});

test("large files use an upload session; chunk PUTs carry no auth header", async () => {
  const size = UPLOAD_CHUNK + 5; // two chunks: one full + a 5-byte tail
  assert.ok(size > SIMPLE_UPLOAD_MAX, "test premise: past the simple-PUT limit");
  const blob = new Blob([new Uint8Array(size)]);
  const { fetchFn, calls } = scriptedFetch((call, i) => {
    if (i === 0) return json({ uploadUrl: "https://up.example/session" });
    // Non-final chunks answer 202; the final chunk returns the drive item.
    const isFinal = call.headers["Content-Range"]?.endsWith(`-${size - 1}/${size}`);
    return isFinal
      ? json({ name: "big.xlsx", webUrl: "https://1drv.ms/big" }, 201)
      : json({ nextExpectedRanges: [] }, 202);
  });
  const item = await uploadToFolder(fetchFn, "tok", "big.xlsx", blob);
  assert.equal(item.webUrl, "https://1drv.ms/big");

  const [session, ...chunks] = calls;
  assert.equal(session!.method, "POST");
  assert.ok(session!.url.endsWith(":/createUploadSession"));
  assert.equal(session!.headers.Authorization, "Bearer tok");
  assert.equal(chunks.length, chunkRanges(size).length);
  for (const c of chunks) {
    assert.equal(c.url, "https://up.example/session");
    assert.equal(c.headers.Authorization, undefined, "session PUTs are pre-authorized");
    assert.match(c.headers["Content-Range"] ?? "", /^bytes \d+-\d+\/\d+$/);
  }
  // Ranges tile the file: first starts at 0, last ends at size-1.
  assert.ok(chunks[0]!.headers["Content-Range"]!.startsWith("bytes 0-"));
  assert.ok(chunks.at(-1)!.headers["Content-Range"]!.includes(`-${size - 1}/${size}`));
});

test("ensureFolders creates the chain and tolerates 409 already-exists", async () => {
  const { fetchFn, calls } = scriptedFetch((_call, i) =>
    i === 0
      ? json({ error: { code: "nameAlreadyExists" } }, 409)
      : json({ name: "DueBack" }, 201),
  );
  await ensureFolders(fetchFn, "tok");
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, `${GRAPH_ROOT}/me/drive/root/children`);
  assert.equal(calls[1]!.url, `${GRAPH_ROOT}/me/drive/root:/Apps:/children`);
  assert.equal(JSON.parse(String(calls[1]!.body)).name, "DueBack");
});

test("ensureFolders surfaces real Graph errors", async () => {
  const { fetchFn } = scriptedFetch(() =>
    json({ error: { code: "accessDenied", message: "Access denied" } }, 403),
  );
  await assert.rejects(() => ensureFolders(fetchFn, "tok"), /403.*Access denied/);
});

test("upload failures produce a readable message", async () => {
  const { fetchFn } = scriptedFetch(() =>
    json({ error: { code: "quotaLimitReached", message: "Insufficient quota" } }, 507),
  );
  await assert.rejects(
    () => uploadToFolder(fetchFn, "tok", "r.xlsx", new Blob(["x"])),
    /507.*Insufficient quota/,
  );
});
