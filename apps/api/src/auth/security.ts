import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password: string, encoded: string) {
  const [salt, hex] = encoded.split(":");
  if (!salt || !hex || !/^[0-9a-f]{128}$/.test(hex)) return false;
  const key = await scrypt(password, salt, 64) as Buffer;
  return timingSafeEqual(key, Buffer.from(hex, "hex"));
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionTokenFromHeaders(authorization?: string, cookie?: string) {
  const bearer=authorization?.match(/^Bearer ([a-f0-9]{64})$/i)?.[1];
  if(bearer)return bearer;
  const value=cookie?.split(";").map(part=>part.trim()).find(part=>part.startsWith("regcheck_session="))?.slice("regcheck_session=".length);
  return value && /^[a-f0-9]{64}$/i.test(value) ? value : null;
}

export function sessionCookie(token: string | null) {
  const secure=process.env.NODE_ENV === "production" ? "; Secure" : "";
  return token
    ? `regcheck_session=${token}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax${secure}`
    : `regcheck_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}

export function newSessionToken() {
  return randomBytes(32).toString("hex");
}
