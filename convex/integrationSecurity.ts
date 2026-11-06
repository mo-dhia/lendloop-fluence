export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
export async function verifySignedRequest(
  req: Request,
  path: string,
  body: unknown,
  nowMs = Date.now(),
) {
  const secret = process.env.INTEGRATION_HMAC_SECRET;
  if (!secret) throw new Error("Integration signing is not configured");
  const ts = req.headers.get("x-lendloop-timestamp") ?? "";
  const nonce = req.headers.get("x-lendloop-nonce") ?? "";
  const signature = req.headers.get("x-lendloop-signature") ?? "";
  const seconds = Number(ts);
  if (
    req.method !== "POST" ||
    !Number.isSafeInteger(seconds) ||
    Math.abs(nowMs / 1000 - seconds) > 300 ||
    !/^[a-zA-Z0-9-]{16,100}$/.test(nonce)
  )
    throw new Error("Expired or invalid request metadata");
  const message = `POST\n${path}\n${ts}\n${nonce}\n${canonicalJson(body)}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
  );
  const expected = [...mac]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (
    !/^[a-f0-9]{64}$/i.test(signature) ||
    expected.length !== signature.length
  )
    throw new Error("Invalid signature");
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |=
      expected.charCodeAt(i) ^ signature.toLowerCase().charCodeAt(i);
  if (difference !== 0) throw new Error("Invalid signature");
}
export async function signPayload(
  path: string,
  body: unknown,
  timestamp: string,
  nonce: string,
  secret: string,
) {
  const encoder = new TextEncoder();
  const message = `POST\n${path}\n${timestamp}\n${nonce}\n${canonicalJson(body)}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(message)),
  );
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
