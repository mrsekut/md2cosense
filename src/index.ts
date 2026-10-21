#!/usr/bin/env bun
/**
 * md2cosense - ローカルのMarkdownをCosense(Scrapbox)プロジェクトに展開するCLI
 *
 * 使い方:
 *   md2cosense <path> --project <projectName|projectUrl> [options]
 *
 *   <path>           .md ファイル、または .md を含むディレクトリ
 *
 * options:
 *   --project, -p    展開先のCosenseプロジェクト (名前 or URL) [必須]
 *   --dry-run        previewまでで止め、実際には書き込まない
 *   --yes, -y        各ページの確認プロンプトをスキップして一括展開
 *   --help, -h       このヘルプを表示
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  collectLocalImages,
  markdownToCosense,
  toFullText,
} from "./markdown-to-cosense.ts";
import {
  isLoggedIn,
  isUploadableImage,
  normalizeProjectUrl,
  originOf,
  previewNewPage,
  submitEdit,
  uploadImage,
} from "./cosense.ts";

/** コマンドラインの解釈結果。実行に必要な値が揃っているのは run だけ */
type Command =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run"; path: string; project: string; mode: PublishMode };

const OPTIONS = {
  project: { type: "string", short: "p" },
  "dry-run": { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  help: { type: "boolean", short: "h" },
} as const;

/** parseArgs は未知のオプションで例外を投げるので、メッセージに変換して返す */
function tryParseArgs(args: string[]) {
  try {
    return parseArgs({ args, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function parseCommand(argv: string[]): Command {
  const parsed = tryParseArgs(argv);
  if ("error" in parsed) return { kind: "error", message: parsed.error };

  const { values, positionals } = parsed;
  if (values.help) return { kind: "help" };

  const [path] = positionals;
  if (path === undefined) return { kind: "error", message: "<path> is required" };
  if (values.project === undefined) {
    return { kind: "error", message: "--project is required" };
  }

  return {
    kind: "run",
    path,
    project: values.project,
    mode: values["dry-run"]
      ? "dry-run"
      : values.yes
        ? "yes-to-all"
        : "interactive",
  };
}

const HELP = `md2cosense - A CLI to publish local Markdown to Cosense (Scrapbox)

Usage:
  md2cosense <path> --project <projectName|projectUrl> [options]

Arguments:
  <path>            A .md file, or a directory containing .md files

Options:
  -p, --project     Target Cosense project (name or URL) [required]
      --dry-run     Stop at preview; do not write anything
  -y, --yes         Skip confirmation prompts and publish all at once
  -h, --help        Show this help

Examples:
  md2cosense ./notes --project myproject
  md2cosense ./README.md -p https://scrapbox.io/myproject --dry-run
`;

/** 指定パス配下の .md ファイルを再帰的に収集する。パスが存在しなければ null */
async function collectMarkdownFiles(path: string): Promise<string[] | null> {
  const stats = await stat(path).catch(() => null);
  if (!stats) return null;

  if (stats.isFile()) {
    return extname(path).toLowerCase() === ".md" ? [path] : [];
  }

  // scan は隠しディレクトリを既に除外するので、node_modules だけ落とせばよい
  const found = new Bun.Glob("**/*.md").scan({ cwd: path, absolute: true });
  return (await Array.fromAsync(found))
    .filter((file) => !relative(path, file).split("/").includes("node_modules"))
    .sort();
}

const SEPARATOR = "──────────────────────────────────────────";

/** 各ページを書き込むかどうかの決め方 */
type PublishMode = "dry-run" | "interactive" | "yes-to-all";

/** 1ページ分の処理結果。aborted はユーザーが中断したことを表す */
type Outcome = "succeeded" | "skipped" | "failed" | "aborted";

/** 確認プロンプトへの回答 */
type Decision = "yes" | "yes-to-all" | "no" | "quit";

function parseDecision(input: string): Decision {
  switch (input) {
    case "y":
      return "yes";
    case "a":
      return "yes-to-all";
    case "q":
      return "quit";
    default:
      return "no";
  }
}

/** Bunのグローバル prompt は1行読んで返す (EOFなら null) */
function decide(mode: PublishMode): Decision {
  if (mode === "yes-to-all") return "yes";
  const answer = prompt("   Publish? [y/N/a(yes to all)/q(quit)]") ?? "";
  return parseDecision(answer.trim());
}

/**
 * md が参照しているローカル画像を project にアップロードし、src → URL の対応を返す。
 * src は md ファイルのあるディレクトリを基準に解決する。
 * dry-run ではアップロードせず、対象を表示するだけにする (存在と種類は確かめる)。
 */
async function uploadLocalImages(
  md: string,
  file: string,
  projectUrl: string,
  mode: PublishMode,
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    collectLocalImages(md).map(async (src) => {
      const path = resolve(dirname(file), decodeURI(src));
      if (!isUploadableImage(path)) {
        throw new Error(`Unsupported image type: ${src}`);
      }
      if (!(await stat(path).catch(() => null))?.isFile()) {
        throw new Error(`Image not found: ${src}`);
      }
      if (mode === "dry-run") {
        console.log(`   🖼  ${src} (will be uploaded)`);
        return [src, src] as const;
      }
      const url = await uploadImage(projectUrl, path);
      console.log(`   🖼  ${src} → ${url}`);
      return [src, url] as const;
    }),
  );
  return new Map(entries);
}

/**
 * 1ファイルを変換して書き込む。
 * "a" が選ばれるとそれ以降は確認を挟まないので、次に使う mode も一緒に返す。
 */
async function publishOne(
  file: string,
  projectUrl: string,
  mode: PublishMode,
): Promise<{ outcome: Outcome; mode: PublishMode }> {
  const md = await readFile(file, "utf8");
  const fallbackTitle = basename(file, extname(file));

  console.log(`\n${SEPARATOR}`);
  console.log(`📄 ${relative(process.cwd(), file)}`);
  console.log(`   → page title: "${markdownToCosense(md, fallbackTitle).title}"`);

  try {
    // 確認プロンプトより前にアップロードする。プレビューに最終的なURLを出すため。
    // 同じ内容は既存のURLが返るので、スキップされたページの画像が残っても実害はない
    const imageUrls = await uploadLocalImages(md, file, projectUrl, mode);
    const page = markdownToCosense(md, fallbackTitle, { imageUrls });
    const preview = await previewNewPage(projectUrl, toFullText(page));

    if (mode === "dry-run") {
      console.log(`   [dry-run] ${preview.pageUrl}`);
      console.log(
        preview.bodyPreview
          ? indent(preview.bodyPreview, "   | ")
          : "   (no body preview)",
      );
      return { outcome: "succeeded", mode };
    }

    const decision = decide(mode);
    if (decision === "quit") {
      console.log("Aborted.");
      return { outcome: "aborted", mode };
    }
    if (decision === "no") {
      console.log("   Skipped.");
      return { outcome: "skipped", mode };
    }

    const next = decision === "yes-to-all" ? "yes-to-all" : mode;
    const result = await submitEdit(projectUrl, preview.previewId);
    console.log(`   ✅ Published: ${result.pageUrl}`);
    return { outcome: "succeeded", mode: next };
  } catch (err) {
    console.error(`   ❌ Failed: ${(err as Error).message}`);
    return { outcome: "failed", mode };
  }
}

/** 中断されるまで順に処理し、各ファイルの結果を集める */
async function publishAll(
  files: string[],
  projectUrl: string,
  mode: PublishMode,
): Promise<Outcome[]> {
  const [head, ...tail] = files;
  if (head === undefined) return [];

  const { outcome, mode: next } = await publishOne(head, projectUrl, mode);
  if (outcome === "aborted") return [outcome];
  return [outcome, ...(await publishAll(tail, projectUrl, next))];
}

/** 認証されていなければ案内を出して false を返す */
async function ensureLoggedIn(origin: string): Promise<boolean> {
  if (await isLoggedIn(origin)) return true;
  console.error(
    `\nNot authenticated for ${origin}.\n` +
      `Log in with cosense-cli so the token is saved to ~/.cosense/settings.json:\n` +
      `  cosense login ${origin}\n` +
      `(Alternatively, set the COSENSE_PAT environment variable.)\n` +
      `Then run this command again.`,
  );
  return false;
}

async function run(command: Extract<Command, { kind: "run" }>): Promise<number> {
  const projectUrl = normalizeProjectUrl(command.project);

  const files = await collectMarkdownFiles(command.path);
  if (files === null) {
    console.error(`No such path: ${command.path}`);
    return 1;
  }
  if (files.length === 0) {
    console.error(`No Markdown files found: ${command.path}`);
    return 1;
  }

  console.log(`Target: ${projectUrl}`);
  console.log(`Files: ${files.length}`);
  console.log(
    command.mode === "dry-run" ? "(dry-run: nothing will be written)\n" : "",
  );

  // 書き込むときだけ、事前に認証を確かめる
  if (command.mode !== "dry-run") {
    if (!(await ensureLoggedIn(originOf(projectUrl)))) return 1;
  }

  const outcomes = await publishAll(files, projectUrl, command.mode);
  const count = (target: Outcome) => outcomes.filter((o) => o === target).length;

  console.log(`\n${SEPARATOR}`);
  console.log(
    `Done: ${count("succeeded")} succeeded / ${count("skipped")} skipped / ` +
      `${count("failed")} failed (of ${files.length})`,
  );
  return count("failed") > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const command = parseCommand(Bun.argv.slice(2));

  switch (command.kind) {
    case "help":
      process.stdout.write(HELP);
      return 0;
    case "error":
      console.error(`Error: ${command.message}\n`);
      process.stdout.write(HELP);
      return 1;
    case "run":
      return run(command);
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

process.exit(
  await main().catch((err) => {
    console.error(err);
    return 1;
  }),
);
