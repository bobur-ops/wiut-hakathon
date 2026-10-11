const baseUrl = import.meta.env?.VITE_API_URL ?? "http://localhost:3000";
// Authentication is held in an HttpOnly cookie shared by same-site tabs.
// Clear the old tab-local bearer token left by previous versions.
const legacyTokenKey = "regcheck-session";
export function sessionToken() { return null; }
export function setSessionToken(_token: string | null) { sessionStorage.removeItem(legacyTokenKey); }

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, credentials: "include" });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && !["/api/auth/login", "/api/auth/register"].includes(path)) {
    setSessionToken(null);
    window.dispatchEvent(new Event("regcheck-session-expired"));
  }
  if (!response.ok) {
    const error=new Error(body.error === "Bad Request" ? body.message ?? "Invalid request. Please check the fields." : body.error ?? body.message ?? `API returned ${response.status}`);
    Object.assign(error,{status:response.status});
    throw error;
  }
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
