import { expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

export const BASE = "http://127.0.0.1:7681";
export const OUT = new URL("../out/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

export async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? {} : { "content-type": "application/json" },
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
  return json;
}

export const SHELL = ["bash", "--norc", "--noprofile", "-i"];
export const SHELL_ENV = { PS1: "$ ", BASH_SILENCE_DEPRECATION_WARNING: "1" };

export async function createTerm(name: string, argv: string[], extra: Record<string, unknown> = {}) {
  await api("DELETE", `/api/terminals/${name}`).catch(() => {});
  return api("POST", "/api/terminals", { name, argv, ...extra });
}

export const deleteTerm = (name: string) => api("DELETE", `/api/terminals/${name}`).catch(() => {});
export const info = (name: string) => api("GET", `/api/terminals/${name}/info`);
export const capture = async (name: string, q = "") =>
  (await api("GET", `/api/terminals/${name}/capture${q ? `?${q}` : ""}`)).text as string;
export const ptys = async () => (await api("GET", "/api/stats")).ptys as number;

export async function openView(page: Page, name: string, q = ""): Promise<void> {
  await page.goto(`/?name=${name}${q}`);
  await page.waitForFunction(() => (window as any).spike?.connected && (window as any).spike.snapshot.ended > 0);
  if (!q.includes("mode=observe")) await page.waitForFunction(() => (window as any).spike.driver);
}

export const viewport = (page: Page) => page.evaluate(() => (window as any).spike.viewportText() as string[]);
export const allText = (page: Page) => page.evaluate(() => (window as any).spike.allText() as string[]);

export async function waitForText(page: Page, needle: string | RegExp, timeout = 15_000): Promise<void> {
  await expect
    .poll(async () => (await viewport(page)).join("\n"), { timeout })
    .toMatch(typeof needle === "string" ? new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : needle);
}

export function save(file: string, data: unknown): void {
  writeFileSync(OUT + file, typeof data === "string" ? data : JSON.stringify(data, null, 1));
}
