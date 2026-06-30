/**
 * cosense CLI (@helpfeel/cosense-cli) の薄いラッパー。
 * 子プロセスとして cosense を呼び出す。
 */

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

async function runCosense(
  args: string[],
  stdin?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["cosense", ...args], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { ok: code === 0, stdout, stderr, code };
}

/** "key: value" 形式のヘッダー行から指定keyの値を取り出す */
function parseHeaderValue(text: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const m = text.match(re);
  return m ? m[1]!.trim() : undefined;
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

/** "page (after apply):" セクションを抽出し、マーカー(> / *)と末尾の # <lineId> を除去 */
function extractBodyPreview(text: string): string | undefined {
  const idx = text.indexOf("page (after apply):");
  if (idx === -1) return undefined;
  const section = text.slice(idx + "page (after apply):".length);
  const lines = section
    .split("\n")
    .map((l) =>
      l
        // 行頭マーカー (> 新規 / * 更新) を除去
        .replace(/^[>*]\s?/, "")
        // 末尾の " # <lineId>" を除去
        .replace(/\s+#\s+[0-9a-f]{24}\s*$/, ""),
    );
  // 前後の空行を整理
  while (lines.length && lines[0]!.trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  return lines.length ? lines.join("\n") : undefined;
}

/** projectUrl と title から page URL を組み立てる */
function buildPageUrl(projectUrl: string, title: string): string {
  return `${projectUrl.replace(/\/+$/, "")}/${encodeURIComponent(title)}`;
}

/** 新規ページとして previewEdit (dry-run) */
export async function previewNewPage(
  projectUrl: string,
  fullText: string,
): Promise<PreviewResult> {
  const res = await runCosense(
    ["previewEdit", "--new", projectUrl],
    fullText.endsWith("\n") ? fullText : fullText + "\n",
  );
  if (!res.ok) {
    throw new Error(
      `previewEdit failed (exit ${res.code}): ${res.stderr || res.stdout}`,
    );
  }
  const out = res.stdout;
  const previewId = parseHeaderValue(out, "previewId");
  if (!previewId) {
    throw new Error(`previewEdit: previewId が取得できません:\n${out}`);
  }
  const title = parseHeaderValue(out, "title") ?? "";
  const status = parseHeaderValue(out, "status");
  return {
    previewId,
    title,
    pageUrl: buildPageUrl(projectUrl, title),
    willCreate: status === "create",
    bodyPreview: extractBodyPreview(out),
  };
}

/** previewId を確定 */
export async function submitEdit(
  projectUrl: string,
  previewId: string,
): Promise<SubmitResult> {
  const res = await runCosense(["submitEdit", projectUrl, previewId]);
  if (!res.ok) {
    throw new Error(
      `submitEdit failed (exit ${res.code}): ${res.stderr || res.stdout}`,
    );
  }
  const out = res.stdout;
  const title = parseHeaderValue(out, "title") ?? "";
  return {
    commitId: parseHeaderValue(out, "commitId") ?? "",
    title,
    pageUrl: parseHeaderValue(out, "url") ?? buildPageUrl(projectUrl, title),
  };
}

/** ログイン状態を確認 */
export async function isLoggedIn(origin: string): Promise<boolean> {
  const res = await runCosense(["whoami", origin]);
  if (!res.ok) return false;
  try {
    // ログイン済みなら user 情報JSONが返る (id があり、guestではない)
    const json = JSON.parse(res.stdout) as { id?: string; isGuest?: boolean };
    return typeof json.id === "string" && json.isGuest !== true;
  } catch {
    return false;
  }
}

/** projectUrl から origin (https://scrapbox.io) を取り出す */
export function originOf(projectUrl: string): string {
  const m = projectUrl.match(/^(https?:\/\/[^/]+)/);
  return m ? m[1]! : "https://scrapbox.io";
}
