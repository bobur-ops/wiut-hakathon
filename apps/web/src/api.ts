const baseUrl = import.meta.env?.VITE_API_URL ?? "http://localhost:3000";
const tokenKey = "regcheck-session";

export function sessionToken() { return sessionStorage.getItem(tokenKey); }
export function setSessionToken(token: string | null) {
  if (token) sessionStorage.setItem(tokenKey, token);
  else sessionStorage.removeItem(tokenKey);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const token = sessionToken();
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && token === sessionToken() && !["/api/auth/login", "/api/auth/register"].includes(path)) {
    setSessionToken(null);
    window.dispatchEvent(new Event("regcheck-session-expired"));
  }
  if (!response.ok) throw new Error(body.error === "Bad Request" ? body.message ?? "Invalid request. Please check the fields." : body.error ?? body.message ?? `API returned ${response.status}`);
  return body as T;
}

export function jsonBody(value: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) };
}

export interface Identity {
  user_id: string;
  organization_id: string;
  email: string;
  name: string;
  organization_type: string;
  activities: string[];
}
