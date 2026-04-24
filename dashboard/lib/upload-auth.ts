export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; message: string };

export function checkUploadAuth(request: Request): AuthResult {
  const expected = process.env.DASHBOARD_UPLOAD_TOKEN;
  if (!expected) {
    return {
      ok: false,
      status: 500,
      message: "DASHBOARD_UPLOAD_TOKEN is not configured on the server",
    };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const provided = match?.[1];

  if (!provided || !timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, message: "Invalid or missing bearer token" };
  }

  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
