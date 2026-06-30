/**
 * Markdown を Cosense (Scrapbox) 記法へ変換する。
 *
 * プロトタイプ用の簡易変換。完全なMarkdown仕様は網羅しない。
 * よく使う記法だけをCosenseのUI記法にマッピングする。
 */

export type ConvertResult = {
  /** Cosenseページのタイトル (1行目になる) */
  title: string;
  /** タイトルを除いた本文 (Cosense記法) */
  body: string;
  /** タイトル+本文を結合したフルテキスト (previewEdit --new にそのまま渡せる) */
  fullText: string;
};

/**
 * 見出しレベル(1-6)をCosenseの強調記法へ。
 * Cosenseは [* ] が一番大きく、アスタリスクが多いほど大きい。
 * Markdownは # が少ないほど大きいので逆向きにマップする。
 */
function headingToCosense(level: number, text: string): string {
  // h1->***(3), h2->**(2), h3 以降 ->*(1)
  const stars = level === 1 ? 3 : level === 2 ? 2 : 1;
  return `[${"*".repeat(stars)} ${text}]`;
}

/** インライン記法の変換 (1行に対して適用) */
function convertInline(line: string): string {
  let s = line;

  // リンク [text](url) -> [url text]  (画像も同様に扱う)
  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, text, url) => {
    if (!text) return `[${url}]`;
    return `[${url} ${text}]`;
  });

  // 太字 **text** / __text__ -> [* text]
  s = s.replace(/\*\*([^*]+)\*\*/g, "[* $1]");
  s = s.replace(/__([^_]+)__/g, "[* $1]");

  // 斜体 *text* / _text_ -> [/ text]
  s = s.replace(/(?<![*\w])\*([^*\n]+)\*(?![*\w])/g, "[/ $1]");
  s = s.replace(/(?<![_\w])_([^_\n]+)_(?![_\w])/g, "[/ $1]");

  // 取り消し線 ~~text~~ -> [- text]
  s = s.replace(/~~([^~]+)~~/g, "[- $1]");

  // インラインコード `code` はCosenseでも `code` なのでそのまま

  return s;
}

export function markdownToCosense(
  markdown: string,
  fallbackTitle: string,
): ConvertResult {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");

  let title: string | null = null;
  const out: string[] = [];

  let inFence = false;
  let fenceLang = "";

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;

    // コードフェンス ``` の開始/終了
    const fenceMatch = raw.match(/^\s*```(.*)$/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceLang = fenceMatch[1]!.trim();
        // Cosenseのコードブロックは `code:filename.ext` で開始し、以降はインデント
        out.push(`code:${fenceLang || "code"}`);
      } else {
        inFence = false;
        fenceLang = "";
      }
      continue;
    }

    if (inFence) {
      // コードブロック内はそのまま、1段インデント
      out.push(` ${raw}`);
      continue;
    }

    // 見出し
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const text = convertInline(heading[2]!.trim());
      // 最初のh1はページタイトルに昇格させる
      if (level === 1 && title === null) {
        title = heading[2]!.trim();
        continue;
      }
      out.push(headingToCosense(level, text));
      continue;
    }

    // 水平線 --- *** ___ は無視 (Cosenseに相当記法なし)
    if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      continue;
    }

    // リスト (- * + / 番号)。インデント階層を維持しつつマーカーを除去
    const listMatch = raw.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const indentStr = listMatch[1]!;
      // 2スペース or タブを1階層とみなす
      const depth = Math.floor(indentStr.replace(/\t/g, "  ").length / 2);
      const content = convertInline(listMatch[3]!);
      out.push(`${" ".repeat(depth + 1)}${content}`);
      continue;
    }

    // 引用 > はCosenseも > なので維持しつつインライン変換
    const quote = raw.match(/^(\s*>\s?)(.*)$/);
    if (quote) {
      out.push(`> ${convertInline(quote[2]!)}`);
      continue;
    }

    // 通常行
    out.push(convertInline(raw));
  }

  const finalTitle = (title ?? fallbackTitle).trim() || fallbackTitle;

  // 先頭・末尾の空行を整理
  while (out.length && out[0]!.trim() === "") out.shift();
  while (out.length && out[out.length - 1]!.trim() === "") out.pop();

  const body = out.join("\n");
  const fullText = body ? `${finalTitle}\n${body}` : finalTitle;

  return { title: finalTitle, body, fullText };
}
