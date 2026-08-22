/**
 * Markdown を Cosense (Scrapbox) 記法へ変換する。
 *
 * プロトタイプ用の簡易変換。完全なMarkdown仕様は網羅しない。
 * よく使う記法だけをCosenseのUI記法にマッピングする。
 *
 * 設計: 「1つの記法につき1つの変換関数」に分割し、PIPELINE の順に適用する。
 * コードブロックの中身はどの変換にも触らせたくないので、先に fence で
 * テキスト領域とコード領域へ切り分け、テキスト領域にだけ PIPELINE を通す。
 */

export type ConvertResult = {
  /** Cosenseページのタイトル (1行目になる) */
  title: string;
  /** タイトルを除いた本文 (Cosense記法) */
  body: string;
  /** タイトル+本文を結合したフルテキスト (previewEdit --new にそのまま渡せる) */
  fullText: string;
};

/** 行の配列を受け取り行の配列を返す変換。行数が変わってもよい (水平線の削除など) */
type Transform = (lines: string[]) => string[];

/** 行単位で閉じる変換を Transform に持ち上げる */
function perLine(convert: (line: string) => string): Transform {
  return (lines) => lines.map(convert);
}

// ---------------------------------------------------------------------------
// インライン記法
// ---------------------------------------------------------------------------

/** リンク [text](url) と画像 ![alt](url) を [url text] に変換する */
function convertLinks(line: string): string {
  return line.replace(
    /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, text: string, url: string) => (text ? `[${url} ${text}]` : `[${url}]`),
  );
}

/**
 * 太字 **text** / __text__ を素のテキストにする。
 * Cosenseでは太字を多用する文化がないため、記法を落とす。
 */
function removeStrong(line: string): string {
  return line.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
}

/** 斜体 *text* / _text_ を素のテキストにする (太字と同じ理由) */
function removeEmphasis(line: string): string {
  return line
    .replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "$1")
    .replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, "$1");
}

/** 取り消し線 ~~text~~ を [- text] に変換する */
function convertStrike(line: string): string {
  return line.replace(/~~([^~]+)~~/g, "[- $1]");
}

// インラインコード `code` はCosenseでも `code` なので変換関数を持たない。

// ---------------------------------------------------------------------------
// ブロック記法
// ---------------------------------------------------------------------------

const HEADING = /^(#{1,6})\s+(.*)$/;

/**
 * 見出しをCosenseの強調記法へ。
 * Cosenseは [* ] が一番小さく、アスタリスクが多いほど大きい。
 * Markdownは # が少ないほど大きいので逆向きにマップする (h1->***, h2->**, h3以降->*)。
 */
function convertHeadings(line: string): string {
  const m = line.match(HEADING);
  if (!m) return line;
  const level = m[1]!.length;
  const stars = level === 1 ? 3 : level === 2 ? 2 : 1;
  return `[${"*".repeat(stars)} ${m[2]!.trim()}]`;
}

/** 水平線 --- *** ___ を落とす (Cosenseに相当記法がない) */
const removeHorizontalRules: Transform = (lines) =>
  lines.filter((line) => !/^\s*([-*_])\1{2,}\s*$/.test(line));

/**
 * リストのマーカーを外し、インデントを詰め直す。
 * Cosenseは行頭スペース1個が1階層なので、Markdownの2スペース(またはタブ)を1階層に換算する。
 */
function convertLists(line: string): string {
  const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
  if (!m) return line;
  const depth = Math.floor(m[1]!.replace(/\t/g, "  ").length / 2);
  return `${" ".repeat(depth + 1)}${m[3]!}`;
}

/** 引用。Cosenseも > なので維持しつつ `> ` に正規化する */
function convertQuotes(line: string): string {
  const m = line.match(/^(\s*>\s?)(.*)$/);
  return m ? `> ${m[2]!}` : line;
}

/**
 * 適用順には依存関係がある:
 * - 水平線が最初。`***` や `___` を強調記法・リストマーカーとして拾わせないため。
 * - インライン系がブロック系より先。ブロック系は行を記法で「包む」ので、
 *   先に包んでしまうと包んだ記号と本文中の記号がペアと誤認される。
 *   例: `## **bold**` を先に包むと `[** **bold**]` となり、太字除去が `**` を跨いで壊れる。
 * - 見出しはリストより先。`- ` を含む見出しをリスト扱いさせないため。
 */
const PIPELINE: Transform[] = [
  removeHorizontalRules,
  perLine(convertLinks),
  perLine(removeStrong),
  perLine(removeEmphasis),
  perLine(convertStrike),
  perLine(convertHeadings),
  perLine(convertLists),
  perLine(convertQuotes),
];

function applyPipeline(lines: string[]): string[] {
  return PIPELINE.reduce((acc, transform) => transform(acc), lines);
}

// ---------------------------------------------------------------------------
// コードブロックの保護
// ---------------------------------------------------------------------------

const FENCE = /^\s*```(.*)$/;

type Segment =
  | { kind: "text"; lines: string[] }
  | { kind: "code"; lang: string; lines: string[] };

/**
 * fence を境にテキスト領域とコード領域へ切り分ける。
 * これにより、コードブロックの中身をどの変換にも通さずに済む。
 * 閉じられていないfenceは、以降すべてをコードとして扱う。
 */
function splitByFence(lines: string[]): Segment[] {
  const open = lines.findIndex((line) => FENCE.test(line));
  if (open === -1) return lines.length ? [{ kind: "text", lines }] : [];

  const head = lines.slice(0, open);
  const lang = lines[open]!.match(FENCE)![1]!.trim();
  const rest = lines.slice(open + 1);
  const close = rest.findIndex((line) => FENCE.test(line));
  const inside = close === -1 ? rest : rest.slice(0, close);
  const tail = close === -1 ? [] : rest.slice(close + 1);

  return [
    ...(head.length ? ([{ kind: "text", lines: head }] as Segment[]) : []),
    { kind: "code", lang, lines: inside },
    ...splitByFence(tail),
  ];
}

/** Cosenseのコードブロックは `code:<name>` で始め、以降の行を1段インデントする */
function renderCode(lang: string, lines: string[]): string[] {
  return [`code:${lang || "code"}`, ...lines.map((line) => ` ${line}`)];
}

// ---------------------------------------------------------------------------
// タイトル
// ---------------------------------------------------------------------------

const H1 = /^#\s+(.*)$/;

/**
 * 最初のh1をページタイトルへ昇格させ、本文からは取り除く。
 * コードブロック内の `# ...` を拾わないよう、切り分け済みのセグメントに対して探す。
 */
function extractTitle(segments: Segment[]): {
  title: string | null;
  rest: Segment[];
} {
  const at = segments.findIndex(
    (s) => s.kind === "text" && s.lines.some((line) => H1.test(line)),
  );
  if (at === -1) return { title: null, rest: segments };

  const target = segments[at] as { kind: "text"; lines: string[] };
  const lineAt = target.lines.findIndex((line) => H1.test(line));
  const title = target.lines[lineAt]!.match(H1)![1]!.trim();

  return {
    title,
    rest: segments.with(at, {
      kind: "text",
      lines: target.lines.toSpliced(lineAt, 1),
    }),
  };
}

// ---------------------------------------------------------------------------

/** 先頭・末尾の空行を落とす (本文中の空行は維持する) */
function trimBlankEdges(lines: string[]): string[] {
  const start = lines.findIndex((line) => line.trim() !== "");
  if (start === -1) return [];
  return lines.slice(start, lines.findLastIndex((line) => line.trim() !== "") + 1);
}

export function markdownToCosense(
  markdown: string,
  fallbackTitle: string,
): ConvertResult {
  const segments = splitByFence(markdown.replace(/\r\n?/g, "\n").split("\n"));
  const { title, rest } = extractTitle(segments);

  const converted = rest.flatMap((segment) =>
    segment.kind === "code"
      ? renderCode(segment.lang, segment.lines)
      : applyPipeline(segment.lines),
  );

  const finalTitle = (title ?? fallbackTitle).trim() || fallbackTitle;
  const body = trimBlankEdges(converted).join("\n");
  const fullText = body ? `${finalTitle}\n${body}` : finalTitle;

  return { title: finalTitle, body, fullText };
}
