/*
 * Credential masking matches by structure, never ordinary words: a false positive is worse than
 * a rare miss. These synthetic examples cover diagnostic and readable text masking.
 * Ways they can fail, each covered by a row below:
 * 1. A word after a scheme, credential key or header is masked: "Basic information", "Bearer of
 *    bad news", `password: required`, "The new password is incorrect", `authorization: missing`,
 *    `cookie: invalid format`, `cookie=accepted`, "password is case-sensitive".
 * 2. A loose key (`token`, `secret`, `pin`) masks its value, or an identifier is masked: an `sk-`
 *    slug, `PWD=/path`, `hasPassword: true`, `token_type: bearer`.
 * 3. Any part of a URL changes, including userinfo and query values named like secrets.
 * 4. Prose makes an authority decision refuse, or a publication fail, over a loose match.
 * 5. A real credential survives in one of its forms: header, JSON, assignment, `util.inspect`
 *    quotes, free-text token-shaped Bearer or Basic, provider key, JWT, AWS key, PEM key, database
 *    password, cookie pair, or (readable copies only) password, PIN and TOTP prose.
 */

type Surface = "diagnostic" | "readable";
const both: readonly Surface[] = ["diagnostic", "readable"];
const readableOnly: readonly Surface[] = ["readable"];
const diagnosticOnly: readonly Surface[] = ["diagnostic"];

export const credentials: readonly (readonly [string, string, readonly Surface[]])[] = [
  ["Authorization: Bearer FAKEbearer0a1b2c3 rejected", "FAKEbearer0a1b2c3", both],
  ["authorization=Bearer TOK2-fake-9x rejected", "TOK2-fake-9x", both],
  ["Authorization: Token fake-t0ken-4 rejected", "fake-t0ken-4", both],
  ["Authorization: 3f9fake2c7d1e8a4b rejected", "3f9fake2c7d1e8a4b", both],
  [
    "Authorization: AWS4-HMAC-SHA256 Credential=FAKEAKID/20260927/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=fa4e0sig0123",
    "fa4e0sig0123",
    both,
  ],
  ['{"authorization":"Bearer FAKEjson0token1"}', "FAKEjson0token1", both],
  ["headers: { authorization: 'Bearer FAKEinspect0token1' }", "FAKEinspect0token1", both],
  ["upstream said bearer FAKE0free1text2token3 rejected", "FAKE0free1text2token3", both],
  ["retry with BASIC ZmFrZTpub3QtYS1wYXNzd29yZA== rejected", "ZmFrZTpub3QtYS1wYXNzd29yZA", both],
  ["Basic dTpw rejected", "dTpw", both],
  ["request Cookie: sid=fake-one; csrf=fake-two", "fake-two", both],
  ["Set-Cookie: __Host-x=fake-three; Path=/; HttpOnly", "fake-three", both],
  ['{"cookie":"__Host-opengpt-auth=sealed-fake"}', "sealed-fake", both],
  ["headers: { cookie: 'sid=fake-inspect' }", "fake-inspect", both],
  ["session cookie=fake4c00kie9 dropped", "fake4c00kie9", both],
  ["login failed for password=hunter2-fake", "hunter2-fake", both],
  ["password=hunter", "hunter", both],
  ['{"password":"required"}', "required", both],
  ["client_secret: cs-fake-123", "cs-fake-123", both],
  ["PGPASSWORD=pg-fake-v22 psql", "pg-fake-v22", both],
  ["MY_API_KEY=fake-api-66 set", "fake-api-66", both],
  ["userAccessToken=fake-uat-77 set", "fake-uat-77", both],
  ["AWS_SECRET_ACCESS_KEY=FAKEawsSecret0123abcd", "FAKEawsSecret0123abcd", both],
  ["totp_seed: JBSWY3DPEHPK3PXP", "JBSWY3DPEHPK3PXP", both],
  ["key sk-FAKE0123456789abcdefghij", "FAKE0123456789abcdefghij", both],
  ["key sk-proj-FAKEabc123def456ghi789", "FAKEabc123def456ghi789", both],
  ["token ghp_FAKEabcdefghijklmnopqrstuvwxyz0123", "FAKEabcdefghij", both],
  ["stripe sk_live_FAKEabcdefghijkl", "FAKEabcdefghijkl", both],
  ["key id AKIAFAKEFAKEFAKE1234", "AKIAFAKEFAKEFAKE1234", both],
  ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ", "ZmFrZXNpZ25hdHVyZQ", both],
  [
    "-----BEGIN PRIVATE KEY-----\nMIIfakeKeyMaterial0123456789abcdefABCDEF==\n-----END PRIVATE KEY-----",
    "MIIfakeKeyMaterial",
    both,
  ],
  // Cookie shapes, Azure account keys, Digest params and bracketed values.
  ['Cookie: sid="FAKEq0t3dCookie123"; theme=dark', "FAKEq0t3dCookie123", both],
  [
    "upstream set-cookie: theme=dark; Path=/, session=FAKEsess0123abc; HttpOnly",
    "FAKEsess0123abc",
    both,
  ],
  [
    "Set-Cookie: a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, session=FAKEsess0456def; Path=/",
    "FAKEsess0456def",
    both,
  ],
  ["Cookie: FAKEopaquecookie0123456789", "FAKEopaquecookie0123456789", both],
  // A comma inside a cookie value continues it (consent-manager cookies).
  ["Cookie: consent=analytics,ads; sid=SEKRETcomma02; theme=dark", "SEKRETcomma02", both],
  [
    "Cookie: cookieyes-consent=consentid:abc,consent:yes,action:yes; __Host-sid=SEKRETcy01",
    "SEKRETcy01",
    both,
  ],
  [
    "Set-Cookie: sid=FAKEsetc0okie9; Path=/\nCookie: consent=a,b; sid=SEKRETcomma03",
    "SEKRETcomma03",
    both,
  ],
  ["account_key=SEKRET0123456789abcdef", "SEKRET0123456789abcdef", diagnosticOnly],
  ["storage accountKey=SEKRETzZ9xQ2wL7vN4kP1r", "SEKRETzZ9xQ2wL7vN4kP1r", diagnosticOnly],
  [
    'Authorization: Digest username = "ada", response = "SEKRETdigest0123456789abcdef"',
    "SEKRETdigest0123456789abcdef",
    both,
  ],
  [
    "AZURE_STORAGE_ACCOUNT_KEY=FAKEqqqqqqqqqqZm9vYmFy0123456789abcdefABCDEF+/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx==",
    "FAKEqqqqqqqqqqZm9vYmFy0123456789abcdefABCDEF+/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    diagnosticOnly,
  ],
  [
    'storage account_key: "FAKEqqqqqqqqqqZm9vYmFy0123456789abcdefABCDEF+/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=="',
    "FAKEqqqqqqqqqqZm9vYmFy0123456789abcdefABCDEF+/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    diagnosticOnly,
  ],
  [
    'Authorization: Digest username="ada", realm="x", nonce="n1", response="6629fae49393a05397450978507c4ef1"',
    "6629fae49393a05397450978507c4ef1",
    both,
  ],
  ["login password={FAKEbrace0123} rejected", "FAKEbrace0123", both],
  ["login password=[FAKEbracket0123] rejected", "FAKEbracket0123", both],
  ["My password is FAKEpw4x.", "FAKEpw4x", readableOnly],
  ["Your PIN is 482913", "482913", readableOnly],
  ["Your TOTP secret key: FAKETOTPSEED2345", "FAKETOTPSEED2345", readableOnly],
  ["The confidential recovery password is Maple!1000Fake.", "Maple!1000Fake", readableOnly],
];

/** Prose and identifiers: unchanged everywhere, and never a reason to refuse or withhold. */
export const prose = [
  "missing Basic information for the form",
  "missing basic information for the form",
  "basic validation failed",
  "Bearer of bad news arrived",
  "the bearer credential expired",
  "Basic authentication-required for this route",
  "Basic Open settings page",
  "the token expired",
  "password reset link sent",
  "enter your password",
  "Your password is incorrect.",
  "The password is case-sensitive.",
  "The new password is incorrect.",
  "password: required",
  "Password: Required.",
  "api_key: missing",
  "token: expired",
  "secret: none",
  "pin: required",
  "token=visible-fake-9 secret=shown-fake-8",
  '{"hasPassword": true, "passwordless": false}',
  "hasPassword: true",
  "authorization: missing for this route",
  "Authorization: failed because the token expired",
  "Authorization: required",
  "Missing Authorization: Bearer token",
  "authorization: 401 Unauthorized",
  "cookie: invalid format",
  "Failed to parse cookie: expected a name",
  "form body cookie=accepted&next=/checkout rejected",
  '{"cookie":"accepted"}',
  "PWD=/Users/ada/project OLDPWD=/tmp",
  "sk-hynix-ddr5-memory-kit-2026 is in stock",
  "step sk-onboarding-step-2026 done",
  "spin=3 mapping=kept",
  "token_type: bearer",
  "valid_token: abc123def",
  "rapid_token=abc123def",
  "accountKey: ACME-123",
  "Cookie: is not valid, then retry",
  "cookie count = 3",
  "cookie size = 4096 bytes",
  "the cookie name = sessionid",
  "The token bucket has capacity.",
  // Loose names are not credentials by themselves.
  '{"token":"visible-4821","secret":"shown-77","pass":"3/5","pin":"required"}',
  "Thank you, this is a token of appreciation from the team.",
  "Visit the password reset page to choose a new password.",
];
/** URLs: byte-exact in every readable copy and diagnostic. */
export const urls = [
  "connect postgres://app@db:5432/app?sslmode=require&password=db-query-fake",
  "connect postgres://app:db-pass-fake@db:5432/app",
  "GET https://shop.example.com/orders?access_token=abc123&code=xyz#frag failed",
  "see https://ada@portal.example.test/path?password=visible&secret=shown",
  "GET https://example.com/basic/abc123def456ghi789jk failed",
  "docs at https://docs.example.com/auth/bearer-tokens?cookie=accepted",
];
