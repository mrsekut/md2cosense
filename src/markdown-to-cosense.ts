/**
 * Markdown を Cosense (Scrapbox) 記法へ変換する。
 *
 * プロトタイプ用の簡易変換。完全なMarkdown仕様は網羅しない。
 * よく使う記法だけをCosenseのUI記法にマッピングする。
 *
 * 設計: 「1つの記法につき1つの変換関数」に分割し、pipeline の順に適用する。
 * コードブロックの中身はどの変換にも触らせたくないので、先に fence で
 * テキスト領域とコード領域へ切り分け、テキスト領域にだけ pipeline を通す。
 */

export type ConvertResult = {
  /** Cosenseページのタイトル (1行目になる) */
  title: string;
  /** タイトルを除いた本文 (Cosense記法) */
  body: string;
};

/**
 * タイトルと本文を1つのテキストへ結合する (previewEdit --new にそのまま渡せる)。
 * ConvertResult から一意に決まる派生値なので、フィールドではなく関数として持つ。
 */
export function toFullText({ title, body }: ConvertResult): string {
  return body ? `${title}\n${body}` : title;
}

/** 行の配列を受け取り行の配列を返す変換。行数が変わってもよい (水平線の削除など) */
type Transform = (lines: string[]) => string[];

/** 行単位で閉じる変換を Transform に持ち上げる */
function perLine(convert: (line: string) => string): Transform {
  return (lines) => lines.map(convert);
}

/** インラインコード `...` と、変換済みの数式 [$ ...] */
const PROTECTED = /(`[^`]*`|\[\$[^\]]*\])/;

/**
 * 保護区間の外側にだけ変換を適用する Transform を作る。
 * `` `$HOME` `` の $ を数式にしたり、`` `**a**` `` の ** を落としたりしないため。
 * split はキャプチャ付き正規表現の区切りも結果に残すので、奇数番目が保護区間になる。
 */
function perLineOutsideProtected(convert: (text: string) => string): Transform {
  return (lines) =>
    lines.map((line) =>
      line
        .split(PROTECTED)
        .map((part, i) => (i % 2 === 1 ? part : convert(part)))
        .join(""),
    );
}

// ---------------------------------------------------------------------------
// インライン記法
// ---------------------------------------------------------------------------

const IMAGE = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** http(s) や data: でない、ローカルファイルを指す画像の参照か */
function isLocalSource(src: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(src);
}

/**
 * 画像 ![alt](src) を [url] に変換する。
 * Cosenseの画像記法は alt を取らない。[url alt] と書くと alt を文字にしたリンクになり、
 * 画像として表示されない。そのため alt は捨てる。
 * ローカルの src は imageUrls でアップロード先のURLに差し替える (無ければそのまま)。
 */
function convertImages(imageUrls: ReadonlyMap<string, string>) {
  return (line: string): string =>
    line.replace(IMAGE, (_m, src: string) => `[${imageUrls.get(src) ?? src}]`);
}

/** リンク [text](url) を [url text] に変換する */
function convertLinks(line: string): string {
  return line.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
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


// ---------------------------------------------------------------------------
// 数式 (TeX)
// ---------------------------------------------------------------------------

/**
 * インライン数式 \(...\) と $...$ を [$ ...] に変換する。
 *
 * $...$ は通貨表記 ($100 と $200 など) を誤って数式にしないよう、
 * MathJax等と同じ条件を課す: 開き $ の直後と閉じ $ の直前が非空白で、
 * 閉じ $ の直後が数字でないこと。
 */
function convertInlineTex(text: string): string {
  return text
    .replace(/\\\((.+?)\\\)/g, (_m, formula: string) => `[$ ${formula.trim()}]`)
    .replace(
      /\$(?![\s$])((?:[^$\n\\]|\\.)+?)(?<!\s)\$(?!\d)/g,
      (_m, formula: string) => `[$ ${formula.trim()}]`,
    );
}

const BLOCK_TEX_OPEN = /^(\s*)(?:\$\$|\\\[)(.*)$/;
const BLOCK_TEX_CLOSE = /^(.*?)(?:\$\$|\\\])\s*$/;

/**
 * ブロック数式 $$...$$ と \[...\] を1行の [$ ...] にまとめる。
 *
 * Cosenseは行ごとに記法を解釈するため、開始と終了を別々の行に置くやり方では
 * 数式として認識されない。複数行の数式は空白で連結して1行にする。
 * 閉じられていない場合は数式とみなさず、そのまま残す。
 */
const convertBlockTex: Transform = (lines) => {
  const start = lines.findIndex((line) => BLOCK_TEX_OPEN.test(line));
  if (start === -1) return lines;

  const [, indent = "", head = ""] = lines[start]!.match(BLOCK_TEX_OPEN)!;
  const render = (parts: string[], tail: string[]) => [
    ...lines.slice(0, start),
    `${indent}[$ ${parts.map((p) => p.trim()).filter(Boolean).join(" ")}]`,
    ...convertBlockTex(tail),
  ];

  // 開始行の中で閉じている場合 ($$ x $$ のような書き方)
  const sameLine = head.match(BLOCK_TEX_CLOSE);
  if (sameLine) return render([sameLine[1]!], lines.slice(start + 1));

  const rest = lines.slice(start + 1);
  const close = rest.findIndex((line) => BLOCK_TEX_CLOSE.test(line));
  if (close === -1) return lines;

  const last = rest[close]!.match(BLOCK_TEX_CLOSE)![1]!;
  return render(
    [head, ...rest.slice(0, close), last],
    rest.slice(close + 1),
  );
};


const TABLE_ROW = /^(\s*)\|(.+)\|\s*$/;

/** `| a | b |` の1行をセルに分解する */
function splitCells(line: string): string[] {
  const m = line.match(TABLE_ROW);
  if (!m) return [];
  return m[2]!.split("|").map((cell) => cell.trim());
}

function isTableRow(line: string): boolean {
  return TABLE_ROW.test(line);
}

/** ヘッダ直下の `|---|:--:|` 行。Cosenseに相当する概念がないので落とす */
function isDelimiterRow(line: string): boolean {
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/**
 * Cosenseの表は `table:<name>` で始め、以降の行を1段インデントしてタブ区切りで並べる。
 * <name> は一意である必要がない単なるラベルなので、固定で `table` を使う。
 */
function renderTable(rows: string[], indent: string): string[] {
  return [
    `${indent}table:table`,
    ...rows.map((row) => `${indent} ${splitCells(row).join("\t")}`),
  ];
}

/** 連続する `|...|` 行をCosenseの表へ変換する */
const convertTables: Transform = (lines) => {
  const start = lines.findIndex(isTableRow);
  if (start === -1) return lines;

  const offset = lines.slice(start).findIndex((line) => !isTableRow(line));
  const end = offset === -1 ? lines.length : start + offset;

  const block = lines.slice(start, end);
  const indent = " ".repeat(
    Math.floor(block[0]!.match(TABLE_ROW)![1]!.replace(/\t/g, "  ").length / 2),
  );
  const rows = block.filter((line) => !isDelimiterRow(line));

  return [
    ...lines.slice(0, start),
    ...renderTable(rows, indent),
    ...convertTables(lines.slice(end)),
  ];
};

/**
 * 適用順には依存関係がある:
 * - 数式が最初。数式の中身をMarkdownの変換に晒さないため。変換後の [$ ...] は
 *   PROTECTED として以降の変換から守られる。
 * - 水平線はその次。`***` や `___` を強調記法・リストマーカーとして拾わせないため。
 * - インライン系がブロック系より先。ブロック系は行を記法で「包む」ので、
 *   先に包んでしまうと包んだ記号と本文中の記号がペアと誤認される。
 *   例: `## **bold**` を先に包むと `[** **bold**]` となり、太字除去が `**` を跨いで壊れる。
 * - 見出しはリストより先。`- ` を含む見出しをリスト扱いさせないため。
 * - 画像はリンクより先。![alt](src) の [alt](src) 部分をリンクとして拾わせないため。
 * - 表は行をまたいで集約するので、行数が変わる他の変換より後にまとめて置く。
 */
function pipeline(imageUrls: ReadonlyMap<string, string>): Transform[] {
  return [
    convertBlockTex,
    perLineOutsideProtected(convertInlineTex),
    removeHorizontalRules,
    perLineOutsideProtected(convertImages(imageUrls)),
    perLineOutsideProtected(convertLinks),
    perLineOutsideProtected(removeStrong),
    perLineOutsideProtected(removeEmphasis),
    perLineOutsideProtected(convertStrike),
    perLine(convertHeadings),
    perLine(convertLists),
    perLine(convertQuotes),
    convertTables,
  ];
}

function applyPipeline(lines: string[], transforms: Transform[]): string[] {
  return transforms.reduce((acc, transform) => transform(acc), lines);
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

function toSegments(markdown: string): Segment[] {
  return splitByFence(markdown.replace(/\r\n?/g, "\n").split("\n"));
}

/**
 * 本文が参照しているローカル画像の src を、出現順・重複なしで返す。
 * コードブロックとインラインコードの中は対象外 (変換時と同じ範囲だけを見る)。
 */
export function collectLocalImages(markdown: string): string[] {
  const sources = toSegments(markdown)
    .filter((segment) => segment.kind === "text")
    .flatMap((segment) => segment.lines)
    .flatMap((line) => line.split(PROTECTED).filter((_, i) => i % 2 === 0))
    .flatMap((text) => [...text.matchAll(IMAGE)].map((m) => m[1]!))
    .filter(isLocalSource);
  return [...new Set(sources)];
}

export type ConvertOptions = {
  /** ローカル画像の src → アップロード先URL。ここに無い src はそのまま残す */
  imageUrls?: ReadonlyMap<string, string>;
};

export function markdownToCosense(
  markdown: string,
  fallbackTitle: string,
  { imageUrls = new Map() }: ConvertOptions = {},
): ConvertResult {
  const { title, rest } = extractTitle(toSegments(markdown));
  const transforms = pipeline(imageUrls);

  const converted = rest.flatMap((segment) =>
    segment.kind === "code"
      ? renderCode(segment.lang, segment.lines)
      : applyPipeline(segment.lines, transforms),
  );

  return {
    title: (title ?? fallbackTitle).trim() || fallbackTitle,
    body: trimBlankEdges(converted).join("\n"),
  };
}
