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
import { markdownToCosense } from "./markdown-to-cosense.ts";
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

const HELP = `md2cosense - ローカルのMarkdownをCosense(Scrapbox)に展開するCLI

使い方:
  md2cosense <path> --project <projectName|projectUrl> [options]

引数:
  <path>            .md ファイル、または .md を含むディレクトリ

オプション:
  -p, --project     展開先のCosenseプロジェクト (名前 or URL) [必須]
      --dry-run     previewまでで止め、実際には書き込まない
  -y, --yes         確認プロンプトをスキップして一括展開
  -h, --help        このヘルプを表示

例:
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

async function main() {
  const args = parseArgs(Bun.argv.slice(2));

  if (args.help || !args.path) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 1);
  }
  if (!args.project) {
    console.error("エラー: --project が必要です\n");
    process.stdout.write(HELP);
    process.exit(1);
  }

  const projectUrl = normalizeProjectUrl(args.project);
  const origin = originOf(projectUrl);

  // ファイル収集
  const files = await collectMarkdownFiles(args.path);
  if (files.length === 0) {
    console.error(`Markdownファイルが見つかりません: ${args.path}`);
    process.exit(1);
  }

  console.log(`展開先: ${projectUrl}`);
  console.log(`対象ファイル: ${files.length}件`);
  console.log(args.dryRun ? "(dry-run: 書き込みません)\n" : "");

  // ログイン確認 (書き込み時のみ)
  if (!args.dryRun) {
    const loggedIn = await isLoggedIn(origin);
    if (!loggedIn) {
      console.error(
        `\n未ログインです。別ターミナルで以下を実行してログインしてください:\n` +
          `  cosense login ${origin}\n` +
          `完了後にもう一度実行してください。（--dry-run はログイン不要です）`,
      );
      process.exit(1);
    }
  }

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const md = await readFile(file, "utf8");
    const fallbackTitle = basename(file, extname(file));
    const { title, fullText } = markdownToCosense(md, fallbackTitle);
    const rel = relative(process.cwd(), file);

    console.log(`\n──────────────────────────────────────────`);
    console.log(`📄 ${rel}`);
    console.log(`   → ページタイトル: "${title}"`);

    try {
      const preview = await previewNewPage(projectUrl, fullText);

      if (args.dryRun) {
        console.log(`   [dry-run] ${preview.pageUrl}`);
        console.log(
          preview.bodyPreview
            ? indent(preview.bodyPreview, "   | ")
            : "   (本文プレビューなし)",
        );
        success++;
        continue;
      }

      if (!args.yes) {
        const ans = await prompt(`   展開しますか? [y/N/a(全部yes)/q(中断)] `);
        if (ans === "q") {
          console.log("中断しました。");
          break;
        }
        if (ans === "a") {
          args.yes = true;
        } else if (ans !== "y") {
          console.log("   スキップしました。");
          skipped++;
          continue;
        }
      }

      const result = await submitEdit(projectUrl, preview.previewId);
      console.log(`   ✅ 展開しました: ${result.pageUrl}`);
      success++;
    } catch (err) {
      console.error(`   ❌ 失敗: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(`\n──────────────────────────────────────────`);
  console.log(
    `完了: 成功 ${success} / スキップ ${skipped} / 失敗 ${failed} (全${files.length}件)`,
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
