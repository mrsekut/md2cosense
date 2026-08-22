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

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { markdownToCosense, toFullText } from "./markdown-to-cosense.ts";
import {
  isLoggedIn,
  normalizeProjectUrl,
  originOf,
  previewNewPage,
  submitEdit,
} from "./cosense.ts";

type Args = {
  path: string | null;
  project: string | null;
  dryRun: boolean;
  yes: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    path: null,
    project: null,
    dryRun: false,
    yes: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case "--project":
      case "-p":
        args.project = argv[++i] ?? null;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--yes":
      case "-y":
        args.yes = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        if (!a.startsWith("-") && args.path === null) {
          args.path = a;
        } else if (a.startsWith("--project=")) {
          args.project = a.slice("--project=".length);
        }
    }
  }
  return args;
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

/** 指定パス配下の .md ファイルを再帰的に収集 */
async function collectMarkdownFiles(path: string): Promise<string[]> {
  const s = await stat(path);
  if (s.isFile()) {
    return extname(path).toLowerCase() === ".md" ? [path] : [];
  }
  const results: string[] = [];
  async function walk(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        await walk(full);
      } else if (e.isFile() && extname(e.name).toLowerCase() === ".md") {
        results.push(full);
      }
    }
  }
  await walk(path);
  return results.sort();
}

/** stdin から1行読む (確認プロンプト用) */
async function prompt(question: string): Promise<string> {
  process.stdout.write(question);
  for await (const line of console) {
    return line.trim();
  }
  return "";
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

async function decide(mode: PublishMode): Promise<Decision> {
  if (mode === "yes-to-all") return "yes";
  return parseDecision(await prompt(`   Publish? [y/N/a(yes to all)/q(quit)] `));
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
  const page = markdownToCosense(md, basename(file, extname(file)));

  console.log(`\n${SEPARATOR}`);
  console.log(`📄 ${relative(process.cwd(), file)}`);
  console.log(`   → page title: "${page.title}"`);

  try {
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

    const decision = await decide(mode);
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

async function main() {
  const args = parseArgs(Bun.argv.slice(2));

  if (args.help || !args.path) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 1);
  }
  if (!args.project) {
    console.error("Error: --project is required\n");
    process.stdout.write(HELP);
    process.exit(1);
  }

  const projectUrl = normalizeProjectUrl(args.project);
  const origin = originOf(projectUrl);

  // ファイル収集
  const files = await collectMarkdownFiles(args.path);
  if (files.length === 0) {
    console.error(`No Markdown files found: ${args.path}`);
    process.exit(1);
  }

  console.log(`Target: ${projectUrl}`);
  console.log(`Files: ${files.length}`);
  console.log(args.dryRun ? "(dry-run: nothing will be written)\n" : "");

  // ログイン確認 (書き込み時のみ)
  if (!args.dryRun) {
    const loggedIn = await isLoggedIn(origin);
    if (!loggedIn) {
      console.error(
        `\nNot authenticated for ${origin}.\n` +
          `Log in with cosense-cli so the token is saved to ~/.cosense/settings.json:\n` +
          `  cosense login ${origin}\n` +
          `(Alternatively, set the COSENSE_PAT environment variable.)\n` +
          `Then run this command again.`,
      );
      process.exit(1);
    }
  }

  const mode: PublishMode = args.dryRun
    ? "dry-run"
    : args.yes
      ? "yes-to-all"
      : "interactive";

  const outcomes = await publishAll(files, projectUrl, mode);
  const count = (target: Outcome) => outcomes.filter((o) => o === target).length;

  console.log(`\n${SEPARATOR}`);
  console.log(
    `Done: ${count("succeeded")} succeeded / ${count("skipped")} skipped / ` +
      `${count("failed")} failed (of ${files.length})`,
  );
}

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((l) => prefix + l)
    .join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
