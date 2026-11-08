import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { AdminActionButton } from "../../services/admin-response-worker";

export const widgetHtml = readFileSync(new URL("./desk.html", import.meta.url), "utf8");
export const widgetTemplate = createHash("sha256").update(widgetHtml).digest("hex").slice(0, 16);
export const widgetCaption = "Shitpost Desk · If the widget does not open, send /manage classic.";

export const checkWidgetBudget = (): void => {
  if (Buffer.byteLength(widgetHtml) > 32_768 || deflateSync(widgetHtml, { level: 9 }).length > 3_800) {
    throw new Error("Desk widget exceeds its HTML budget");
  }
};

export type DeskRoute =
  | { name: "desk" | "more" | "system" | "prompt" | "authors" }
  | { name: "queue" | "attention" | "schedule" | "sources"; offset: number }
  | { name: "item" | "item_actions"; itemId: number; offset: number; attention?: boolean }
  | { name: "result"; updateId: number }
  | { name: "admin"; button: AdminActionButton };

export type DeskAction = {
  label: string;
  route: DeskRoute;
  style?: "row" | "primary";
};

export type DeskScreen = {
  title: string;
  hero?: string;
  body?: string;
  link?: string;
  actions: DeskAction[];
  refresh?: DeskRoute;
  back?: DeskRoute;
  page?: number;
};

export type DeskSnapshot = {
  data: string;
  actions: DeskRoute[];
};

const encodedSize = (text: string): number => Buffer.byteLength(JSON.stringify(text)) - 2;

const clip = (text: string, bytes: number): string => {
  if (encodedSize(text) <= bytes) return text;
  let result = "";
  for (const character of text) {
    if (encodedSize(result + character + "…") > bytes) break;
    result += character;
  }
  return result + "…";
};

const splitBody = (body: string): string[] => {
  const parts: string[] = [];
  let current = "";
  for (const character of body) {
    if (encodedSize(current + character) > 280) {
      parts.push(current);
      current = "";
    }
    current += character;
  }
  if (current) parts.push(current);
  return parts;
};

const ACTIONS_PER_PAGE = 8;

export const snapshotDesk = (screen: DeskScreen, revision: number, note?: string): DeskSnapshot => {
  const bodies = splitBody(screen.body ?? "");
  const actionPages = Math.ceil(screen.actions.length / ACTIONS_PER_PAGE);
  const pages = Math.max(1, bodies.length) + Math.max(0, actionPages - 1);
  const page = Math.min(screen.page ?? 0, pages - 1);
  const actionPage = page - Math.max(0, bodies.length - 1);
  const visible = actionPage < 0 ? [] : screen.actions.slice(actionPage * ACTIONS_PER_PAGE, (actionPage + 1) * ACTIONS_PER_PAGE);
  const actions: DeskRoute[] = visible.map((action) => action.route);
  const controls: [string, string, string?][] = visible.map((action, index) => action.style
    ? [String(index), clip(action.label, 72), action.style]
    : [String(index), clip(action.label, 72)]);
  if (page > 0) controls.push(["p", "‹ Previous"]);
  if (page + 1 < pages) controls.push(["n", "Next ›"]);
  if (screen.back) controls.push(["b", "‹ Back"]);
  const title = clip(screen.title, 66) + (pages > 1 ? ` · ${page + 1}/${pages}` : "");
  const payload = { v: 1, r: revision, t: title, h: screen.hero && clip(screen.hero, 90), b: bodies[page],
    a: controls, l: page === 0 ? screen.link : undefined, n: note };
  let data = JSON.stringify(payload);
  if (Buffer.byteLength(data) > 900) {
    // Keep every control and every evidence page. Shorten only the labels and decorative hero.
    for (const control of controls) control[1] = clip(control[1], 39);
    data = JSON.stringify({ ...payload, h: undefined });
  }
  if (Buffer.byteLength(data) > 1_024) throw new Error("Desk snapshot exceeds its state budget");
  return { data, actions };
};
