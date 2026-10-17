import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpenCodeServiceConfig {
  baseUrl: string;
  port: number;
  pid: number;
  password: string;
}

export interface OpenCodeFormFieldOption {
  value: string;
  label: string;
  description?: string;
}

export interface OpenCodeFormField {
  key: string;
  type: "string" | "multiselect" | string;
  title?: string;
  description?: string;
  required?: boolean;
  options?: OpenCodeFormFieldOption[];
  custom?: boolean;
}

export interface OpenCodeFormInfo {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: OpenCodeFormField[];
}

export function opencodeStateDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "opencode");
}

export function readOpenCodeService(stateDir?: string, env: Record<string, string | undefined> = process.env, home = homedir()): OpenCodeServiceConfig | null {
  const dir = stateDir ?? opencodeStateDir(env, home);
  const path = join(dir, "service.json");
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { port, pid, password, url } = parsed as Record<string, unknown>;
    if (typeof pid !== "number" || typeof password !== "string" || !password) return null;

    let baseUrl = "";
    let resolvedPort = 0;

    if (typeof url === "string" && url.trim()) {
      try {
        const u = new URL(url);
        baseUrl = u.origin;
        resolvedPort = u.port ? Number(u.port) : (u.protocol === "https:" ? 443 : 80);
      } catch {
        // invalid URL
      }
    }

    if (typeof port === "number" && port > 0) {
      resolvedPort = port;
      if (!baseUrl) {
        baseUrl = `http://127.0.0.1:${port}`;
      }
    }

    if (!baseUrl || resolvedPort <= 0) return null;
    return { baseUrl, port: resolvedPort, pid, password };
  } catch {
    return null;
  }
}

export function opencodeAuthHeader(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

export async function listPendingQuestionForms(
  config: OpenCodeServiceConfig,
  sessionID: string,
  fetchFn: typeof fetch = fetch,
): Promise<OpenCodeFormInfo[]> {
  try {
    const url = `${config.baseUrl}/api/session/${encodeURIComponent(sessionID)}/form`;
    const response = await fetchFn(url, {
      headers: { Authorization: opencodeAuthHeader(config.password) },
    });
    if (!response.ok) return [];
    const body = (await response.json()) as unknown;
    const items = Array.isArray(body)
      ? body
      : (typeof body === "object" && body !== null && Array.isArray((body as Record<string, unknown>).data)
        ? ((body as Record<string, unknown>).data as unknown[])
        : []);

    return items.filter((item): item is OpenCodeFormInfo => {
      if (typeof item !== "object" || item === null) return false;
      const { id, title, metadata, fields } = item as Record<string, unknown>;
      if (typeof id !== "string" || typeof title !== "string" || !Array.isArray(fields)) return false;
      const meta = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>) : undefined;
      return meta?.kind === "question";
    });
  } catch {
    return [];
  }
}

export async function replyOpenCodeForm(
  config: OpenCodeServiceConfig,
  sessionID: string,
  formID: string,
  answers: Record<string, string | string[]>,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  try {
    const url = `${config.baseUrl}/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`;
    const response = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: opencodeAuthHeader(config.password),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ answer: answers }),
    });
    return { ok: response.status === 200 || response.status === 204, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export async function cancelOpenCodeForm(
  config: OpenCodeServiceConfig,
  sessionID: string,
  formID: string,
  message?: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; status: number }> {
  try {
    const query = message ? `?message=${encodeURIComponent(message)}` : "";
    const url = `${config.baseUrl}/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}${query}`;
    const response = await fetchFn(url, {
      method: "DELETE",
      headers: {
        Authorization: opencodeAuthHeader(config.password),
      },
    });
    return { ok: response.status === 200 || response.status === 204, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
