/**
 * Cosense (Scrapbox) の page-edit API を直接叩く薄いクライアント。
 *
 * 以前は @helpfeel/cosense-cli を子プロセス (Bun.spawn) として呼んでいたが、
 * 同CLI (MIT) の src/lib/request.ts と src/commands/{previewEdit,submitEdit,whoami}.ts
 * のロジックを内包し、fetch で直接APIを叩くように置き換えた。
 *
 * 認証は Personal Access Token (PAT) を x-personal-access-token ヘッダーに載せる。
 * トークンの解決順は cosense-cli と同じく:
 *   1. 環境変数 COSENSE_PAT (override 用)
 *   2. ~/.cosense/settings.json の users[] (cosense login で保存されたもの)
 */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type PreviewResult = {
  previewId: string;
  pageUrl: string;
  title: string;
  willCreate: boolean;
  bodyPreview?: string;
};

export type SubmitResult = {
  commitId: string;
  pageUrl: string;
  title: string;
};

/** origin を正規化する (cosense-cli の normalizeOrigin 相当) */
function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.replace(/\/+$/, "");
  }
}

/** JSONファイルを読む。存在しない・壊れている場合は undefined */
function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** ~/.cosense/settings.json の users[] の1件 */
type StoredUser = { url: string; token: string };

function isStoredUser(value: unknown): value is StoredUser {
  if (!value || typeof value !== "object") return false;
  const { url, token } = value as Partial<StoredUser>;
  return typeof url === "string" && typeof token === "string";
}

/** ~/.cosense/settings.json から指定 origin の PAT を取り出す (cosense login で保存される) */
function readPatFromSettings(origin: string): string | undefined {
  const settings = readJsonFile(join(homedir(), ".cosense", "settings.json"));
  const users = (settings as { users?: unknown } | undefined)?.users;
  if (!Array.isArray(users)) return undefined;

  const target = normalizeOrigin(origin);
  const token = users
    .filter(isStoredUser)
    .find((user) => normalizeOrigin(user.url) === target)
    ?.token.trim();

  return token || undefined;
}

/**
 * 指定 origin の Personal Access Token を解決する (見つからなければ undefined)。
 * 環境変数 COSENSE_PAT があればそれを優先し、無ければ ~/.cosense/settings.json を見る。
 */
function readPat(origin: string): string | undefined {
  const env = process.env.COSENSE_PAT;
  if (typeof env === "string" && env.trim() !== "") return env.trim();
  return readPatFromSettings(origin);
}

/** 認証エラーのときだけ、設定方法を案内する一文を添える */
function authHint(status: number): string {
  if (status !== 401 && status !== 403) return "";
  return `\n\nRun \`cosense login\` to store a valid Personal Access Token for this origin (or set COSENSE_PAT).`;
}

/** HTTPエラー。401/403 のときは認証設定を案内する */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string, url: string, body: string) {
    super(
      `HTTP ${status} ${statusText}\n${url}\n${body.slice(0, 500)}` +
        authHint(status),
    );
    this.name = "HttpError";
    this.status = status;
  }
}

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  /** false のとき PAT 未設定でもエラーにせず素通しする (ログイン判定用) */
  requirePat?: boolean;
};

/** PAT ヘッダー付きで JSON API を叩く */
async function requestJson(
  url: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const { method = "GET", body, requirePat = true } = options;
  const origin = new URL(url).origin;
  const token = readPat(origin);
  if (!token && requirePat) {
    throw new Error(
      `No Personal Access Token found for ${origin}. ` +
        `Run \`cosense login ${origin}\` to store one in ~/.cosense/settings.json (or set COSENSE_PAT).`,
    );
  }

  const headers: Record<string, string> = {};
  if (token) headers["x-personal-access-token"] = token;

  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new HttpError(res.status, res.statusText, url, text);
  }
  return res.json();
}

/** 行ID (24桁hex)。cosense-cli の newLineId 相当 */
function newLineId(): string {
  return randomBytes(12).toString("hex");
}

/** projectName または URL を projectUrl (https://scrapbox.io/<project>) に正規化 */
export function normalizeProjectUrl(input: string): string {
  if (/^https?:\/\//.test(input)) {
    // .../<project>/<page> が来ても project 部分までに切り詰める
    const m = input.match(/^(https?:\/\/[^/]+\/[^/]+)/);
    return m ? m[1]! : input.replace(/\/+$/, "");
  }
  return `https://scrapbox.io/${input}`;
}

/** projectUrl から origin (https://scrapbox.io) を取り出す */
export function originOf(projectUrl: string): string {
  const m = projectUrl.match(/^(https?:\/\/[^/]+)/);
  return m ? m[1]! : "https://scrapbox.io";
}

/** projectUrl を origin と projectName に分解する */
function parseProject(projectUrl: string): {
  origin: string;
  projectName: string;
} {
  const u = new URL(projectUrl);
  const projectName = u.pathname.split("/").filter(Boolean)[0];
  if (!projectName) {
    throw new Error(
      `Project URL must be https://<host>/<project>, got: ${projectUrl}`,
    );
  }
  return { origin: u.origin, projectName };
}

/**
 * 人が読めるページURLを組み立てる。
 * cosense-cli の encodeTitleForUrl 相当 (space は _、URL予約文字は percent-encode)。
 */
function buildPageUrl(
  origin: string,
  projectName: string,
  title: string,
): string {
  const encoded = title
    .replace(/%/g, "%25")
    .replace(/\//g, "%2F")
    .replace(/\?/g, "%3F")
    .replace(/#/g, "%23")
    .replace(/ /g, "_");
  return `${origin}/${projectName}/${encoded}`;
}

type PreviewResponse = {
  previewId: string;
  expireAt: string;
  pagePreview: {
    title?: string;
    persistent?: boolean;
    lines?: { id: string; text: string }[];
  } | null;
};

/**
 * 新規ページとして previewEdit (dry-run) する。
 * cosense-cli の `previewEdit --new` 相当: プレーンテキスト本文を
 * 1行ずつ _end への _insert に変換して送る。
 */
export async function previewNewPage(
  projectUrl: string,
  fullText: string,
): Promise<PreviewResult> {
  const { origin, projectName } = parseProject(projectUrl);

  // 末尾の単一改行だけ落とし (意図的な空行は残す)、各行を _end への _insert に変換
  const body = fullText.replace(/\r?\n$/, "");
  const changes = body
    .split(/\r?\n/)
    .map((text) => ({ _insert: "_end", lines: { id: newLineId(), text } }));

  const url = `${origin}/api/pages/v2/${projectName}/page-edit-for-ai/preview`;
  const res = (await requestJson(url, {
    method: "POST",
    body: { changes },
  })) as PreviewResponse;

  const pagePreview = res.pagePreview;
  const title = pagePreview?.title ?? "";
  const lines = pagePreview?.lines ?? [];
  // 1行目はタイトルなので、本文プレビューはそれを除いた残り
  const bodyPreview = lines
    .slice(1)
    .map((l) => l.text)
    .join("\n");

  return {
    previewId: res.previewId,
    title,
    pageUrl: buildPageUrl(origin, projectName, title),
    willCreate: pagePreview?.persistent === false,
    bodyPreview: bodyPreview || undefined,
  };
}

type SubmitResponse = {
  commitId: string;
  page: { title?: string } | null;
};

/** previewId を確定する。cosense-cli の submitEdit 相当 */
export async function submitEdit(
  projectUrl: string,
  previewId: string,
): Promise<SubmitResult> {
  const { origin, projectName } = parseProject(projectUrl);
  const url = `${origin}/api/pages/v2/${projectName}/page-edit-for-ai/submit`;
  const res = (await requestJson(url, {
    method: "POST",
    body: { previewId },
  })) as SubmitResponse;

  const title = res.page?.title;
  if (typeof title !== "string") {
    throw new Error(
      `submit response missing page field (commitId: ${res.commitId})`,
    );
  }
  return {
    commitId: res.commitId,
    title,
    pageUrl: buildPageUrl(origin, projectName, title),
  };
}

/** ログイン状態を確認する。origin の PAT が有効なら true */
export async function isLoggedIn(origin: string): Promise<boolean> {
  if (!readPat(origin)) return false;
  try {
    const data = (await requestJson(`${origin}/api/users/me`, {
      requirePat: false,
    })) as { id?: string; isGuest?: boolean };
    return typeof data.id === "string" && data.isGuest !== true;
  } catch {
    return false;
  }
}
