import { describe, expect, it } from "vitest";
import { markdownToCosense, toFullText } from "./markdown-to-cosense.ts";

/** body だけを取り出すヘルパ (title は別途アサートする) */
function body(markdown: string, fallbackTitle = "fallback"): string {
  return markdownToCosense(markdown, fallbackTitle).body;
}

describe("title", () => {
  it("最初のh1をタイトルに昇格させ、本文からは除去する", () => {
    const r = markdownToCosense("# Page Title\n\nhello", "fallback");
    expect(r.title).toBe("Page Title");
    expect(r.body).toBe("hello");
  });

  it("h1が無ければfallbackTitleを使う", () => {
    const r = markdownToCosense("## Section\n\nhello", "fallback");
    expect(r.title).toBe("fallback");
  });

  it("h1のテキストが空ならfallbackTitleを使う", () => {
    const r = markdownToCosense("# \n\nhello", "fallback");
    expect(r.title).toBe("fallback");
    expect(r.body).toBe("hello");
  });

  it("h1の前後の空白をトリムする", () => {
    const r = markdownToCosense("#    Padded Title   \n", "fallback");
    expect(r.title).toBe("Padded Title");
  });

  it("2つ目以降のh1はタイトルにせず見出しとして扱う", () => {
    const r = markdownToCosense("# First\n\n# Second", "fallback");
    expect(r.title).toBe("First");
    expect(r.body).toBe("[*** Second]");
  });

  it("タイトル行のインライン記法は変換せずそのまま使う", () => {
    const r = markdownToCosense("# **Bold** Title", "fallback");
    expect(r.title).toBe("**Bold** Title");
  });
});

describe("見出し", () => {
  it("h1は[***]、h2は[**]、h3以降は[*]にマップする", () => {
    // 先頭のh1はタイトルになるので、ダミーのタイトルを置いてから並べる
    const md = [
      "# Title",
      "# H1",
      "## H2",
      "### H3",
      "#### H4",
      "##### H5",
      "###### H6",
    ].join("\n");
    expect(body(md)).toBe(
      ["[*** H1]", "[** H2]", "[* H3]", "[* H4]", "[* H5]", "[* H6]"].join("\n"),
    );
  });

  it("見出し内のインライン記法も変換する", () => {
    expect(body("## ~~old~~ heading")).toBe("[** [- old] heading]");
  });

  it("見出しの太字・斜体は落とすが、見出し自体の強調は維持する", () => {
    expect(body("## **bold** and *italic* heading")).toBe(
      "[** bold and italic heading]",
    );
  });

  it("#が7個以上の行は見出しとして扱わない", () => {
    expect(body("####### not a heading")).toBe("####### not a heading");
  });

  it("#の直後に空白が無い行は見出しとして扱わない", () => {
    expect(body("#nothashheading")).toBe("#nothashheading");
  });
});

describe("インライン記法", () => {
  it("リンク [text](url) を [url text] に変換する", () => {
    expect(body("see [Example](https://example.com) here")).toBe(
      "see [https://example.com Example] here",
    );
  });

  it("リンクのtitle属性は捨てる", () => {
    expect(body('[Example](https://example.com "The Title")')).toBe(
      "[https://example.com Example]",
    );
  });

  it("テキストが空のリンクはURLのみにする", () => {
    expect(body("[](https://example.com)")).toBe("[https://example.com]");
  });

  it("画像もリンクと同じ形式に変換する", () => {
    expect(body("![alt text](https://example.com/a.png)")).toBe(
      "[https://example.com/a.png alt text]",
    );
  });

  it("1行に複数のリンクがあってもすべて変換する", () => {
    expect(body("[a](http://a.com) と [b](http://b.com)")).toBe(
      "[http://a.com a] と [http://b.com b]",
    );
  });

  it("太字 **text** は記法を落として通常のテキストにする", () => {
    expect(body("これは **太字** です")).toBe("これは 太字 です");
  });

  it("太字 __text__ は記法を落として通常のテキストにする", () => {
    expect(body("これは __太字__ です")).toBe("これは 太字 です");
  });

  it("斜体 *text* は記法を落として通常のテキストにする", () => {
    expect(body("これは *斜体* です")).toBe("これは 斜体 です");
  });

  it("斜体 _text_ は記法を落として通常のテキストにする", () => {
    expect(body("これは _斜体_ です")).toBe("これは 斜体 です");
  });

  it("snake_case の下線を斜体と誤認しない", () => {
    expect(body("some_variable_name を使う")).toBe("some_variable_name を使う");
  });

  it("太字を斜体として二重変換しない", () => {
    expect(body("**bold**")).toBe("bold");
  });

  it("太字斜体 ***text*** も通常のテキストにする", () => {
    expect(body("***both***")).toBe("both");
  });

  it("取り消し線 ~~text~~ を [- text] に変換する", () => {
    expect(body("これは ~~取り消し~~ です")).toBe("これは [- 取り消し] です");
  });

  it("インラインコードはそのまま残す", () => {
    expect(body("`const a = 1` を実行")).toBe("`const a = 1` を実行");
  });

  it("インラインコード内のMarkdown記法は変換しない", () => {
    expect(body("`**bold**` と `[a](b)`")).toBe("`**bold**` と `[a](b)`");
  });
});

describe("リスト", () => {
  it("マーカーを除去してインデント1段に変換する", () => {
    expect(body("- a\n- b")).toBe(" a\n b");
  });

  it("*, + もリストマーカーとして扱う", () => {
    expect(body("* a\n+ b")).toBe(" a\n b");
  });

  it("番号付きリストもマーカーを除去する", () => {
    expect(body("1. one\n2. two")).toBe(" one\n two");
  });

  it("2スペースを1階層としてネストを維持する", () => {
    expect(body("- a\n  - b\n    - c")).toBe(" a\n  b\n   c");
  });

  it("タブインデントは2スペース相当として扱う", () => {
    expect(body("- a\n\t- b")).toBe(" a\n  b");
  });

  it("リスト項目内のインライン記法も変換する", () => {
    expect(body("- [Example](https://example.com) と ~~取り消し~~")).toBe(
      " [https://example.com Example] と [- 取り消し]",
    );
  });
});

describe("引用", () => {
  it("> をそのまま維持しつつインライン変換する", () => {
    expect(body("> ~~削除~~ された引用")).toBe("> [- 削除] された引用");
  });

  it(">の直後に空白が無くても正規化する", () => {
    expect(body(">quote")).toBe("> quote");
  });
});

describe("コードブロック", () => {
  it("言語付きフェンスを code:<lang> + インデントに変換する", () => {
    const md = ["```ts", "const a = 1;", "```"].join("\n");
    expect(body(md)).toBe(["code:ts", " const a = 1;"].join("\n"));
  });

  it("言語指定が無い場合は code:code にする", () => {
    const md = ["```", "plain text", "```"].join("\n");
    expect(body(md)).toBe(["code:code", " plain text"].join("\n"));
  });

  it("コードブロック内はインライン変換しない", () => {
    const md = ["```md", "**bold** and [a](http://a.com)", "```"].join("\n");
    expect(body(md)).toBe(
      ["code:md", " **bold** and [a](http://a.com)"].join("\n"),
    );
  });

  it("コードブロック内の見出し・リストも変換せずそのまま残す", () => {
    const md = ["```sh", "# comment", "- not a list", "```"].join("\n");
    expect(body(md)).toBe(["code:sh", " # comment", " - not a list"].join("\n"));
  });

  it("コードブロックが複数あってもそれぞれ変換する", () => {
    const md = ["```ts", "a", "```", "text", "```js", "b", "```"].join("\n");
    expect(body(md)).toBe(
      ["code:ts", " a", "text", "code:js", " b"].join("\n"),
    );
  });
});

describe("数式", () => {
  it("インライン $...$ を [$ ...] に変換する", () => {
    expect(body("これは $x = 1$ です")).toBe("これは [$ x = 1] です");
  });

  it(String.raw`インライン \(...\) を [$ ...] に変換する`, () => {
    expect(body(String.raw`これは \(x = 1\) です`)).toBe("これは [$ x = 1] です");
  });

  it("1行に複数の数式があってもすべて変換する", () => {
    expect(body("$a$ と $b$")).toBe("[$ a] と [$ b]");
  });

  it("$ に接して空白がある場合は数式として扱わない", () => {
    // MathJax等と同じ判定。$ 100 $ のような書き方を数式にしないため
    expect(body("$  x  $")).toBe("$  x  $");
  });

  it(String.raw`\(...\) は前後の空白をトリムする`, () => {
    expect(body(String.raw`\(  x  \)`)).toBe("[$ x]");
  });

  it("通貨表記を数式として扱わない", () => {
    expect(body("$100 と $200")).toBe("$100 と $200");
    expect(body("価格は $100 です")).toBe("価格は $100 です");
  });

  it("閉じていない $ は変換しない", () => {
    expect(body("コストは $5")).toBe("コストは $5");
  });

  it("インラインコード内の $ は変換しない", () => {
    expect(body("`echo $HOME` を実行")).toBe("`echo $HOME` を実行");
  });

  it("数式の中身はMarkdownとして変換しない", () => {
    expect(body("$a**b**c$")).toBe("[$ a**b**c]");
    expect(body("$[a](b)$")).toBe("[$ [a](b)]");
  });

  it("ブロック $$...$$ を1行の [$ ...] にまとめる", () => {
    expect(body(["$$", "x = 1", "$$"].join("\n"))).toBe("[$ x = 1]");
  });

  it(String.raw`ブロック \[...\] を1行の [$ ...] にまとめる`, () => {
    expect(body([String.raw`\[`, "x = 1", String.raw`\]`].join("\n"))).toBe(
      "[$ x = 1]",
    );
  });

  it("複数行のブロック数式は空白で連結する", () => {
    expect(body(["$$", "a = 1", "b = 2", "$$"].join("\n"))).toBe(
      "[$ a = 1 b = 2]",
    );
  });

  it("同一行で閉じるブロック数式も変換する", () => {
    expect(body("$$ x = 1 $$")).toBe("[$ x = 1]");
  });

  it("閉じていないブロック数式はそのまま残す", () => {
    expect(body(["$$", "x = 1"].join("\n"))).toBe("$$\nx = 1");
  });

  it("ブロック数式が複数あってもそれぞれ変換する", () => {
    expect(body(["$$", "a", "$$", "text", "$$", "b", "$$"].join("\n"))).toBe(
      ["[$ a]", "text", "[$ b]"].join("\n"),
    );
  });

  it("コードブロック内の数式は変換しない", () => {
    const md = ["```tex", "$x = 1$", "```"].join("\n");
    expect(body(md)).toBe(["code:tex", " $x = 1$"].join("\n"));
  });

  it("見出しやリストの中の数式も変換する", () => {
    expect(body("## $x$ について")).toBe("[** [$ x] について]");
    expect(body("- $x$")).toBe(" [$ x]");
  });
});

describe("表", () => {
  it("パイプ表を table:table + タブ区切りに変換する", () => {
    const md = ["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");
    expect(body(md)).toBe(["table:table", " a\tb", " 1\t2"].join("\n"));
  });

  it("alignment指定の区切り行も落とす", () => {
    const md = ["| a | b | c |", "|:--|:-:|--:|", "| 1 | 2 | 3 |"].join("\n");
    expect(body(md)).toBe(["table:table", " a\tb\tc", " 1\t2\t3"].join("\n"));
  });

  it("セル前後の空白を除去する", () => {
    expect(body("|a|b|")).toBe(["table:table", " a\tb"].join("\n"));
    expect(body("|   a   |   b   |")).toBe(["table:table", " a\tb"].join("\n"));
  });

  it("区切り行が無くても表として扱う", () => {
    expect(body(["| a | b |", "| 1 | 2 |"].join("\n"))).toBe(
      ["table:table", " a\tb", " 1\t2"].join("\n"),
    );
  });

  it("表が本文の途中で終わっても後続行はそのまま残す", () => {
    const md = ["before", "| a |", "| 1 |", "after"].join("\n");
    expect(body(md)).toBe(
      ["before", "table:table", " a", " 1", "after"].join("\n"),
    );
  });

  it("表が複数あってもそれぞれ変換する", () => {
    const md = ["| a |", "", "| b |"].join("\n");
    expect(body(md)).toBe(
      ["table:table", " a", "", "table:table", " b"].join("\n"),
    );
  });

  it("セル内のインライン記法も変換する", () => {
    const md = ["| [x](http://x.com) | **b** |"].join("\n");
    expect(body(md)).toBe(["table:table", " [http://x.com x]\tb"].join("\n"));
  });

  it("インデントされた表は階層を維持する", () => {
    const md = ["- item", "  | a | b |"].join("\n");
    expect(body(md)).toBe([" item", " table:table", "  a\tb"].join("\n"));
  });

  it("コードブロック内の表は変換しない", () => {
    const md = ["```md", "| a | b |", "```"].join("\n");
    expect(body(md)).toBe(["code:md", " | a | b |"].join("\n"));
  });

  it("パイプを含まない行は表として扱わない", () => {
    expect(body("a | b")).toBe("a | b");
  });

  it("水平線とセル区切りを取り違えない", () => {
    expect(body("---")).toBe("");
  });
});

describe("水平線", () => {
  it("---, ***, ___ の行を丸ごと削除する", () => {
    expect(body("before\n---\n***\n___\nafter")).toBe("before\nafter");
  });

  it("3文字未満の --- 相当は水平線として扱わない", () => {
    expect(body("--")).toBe("--");
  });
});

describe("整形", () => {
  it("CRLF / CR を LF として扱う", () => {
    const r = markdownToCosense("# Title\r\n\r\n- a\r- b", "fallback");
    expect(r.title).toBe("Title");
    expect(r.body).toBe(" a\n b");
  });

  it("先頭・末尾の空行を除去する", () => {
    expect(body("\n\n\nhello\n\n\n")).toBe("hello");
  });

  it("本文中の空行は維持する", () => {
    expect(body("a\n\nb")).toBe("a\n\nb");
  });
});

describe("toFullText", () => {
  it("タイトルと本文を改行で結合する", () => {
    const r = markdownToCosense("# Title\n\nbody", "fallback");
    expect(toFullText(r)).toBe("Title\nbody");
  });

  it("本文が空ならタイトルのみを返す", () => {
    const r = markdownToCosense("# Only Title", "fallback");
    expect(r.body).toBe("");
    expect(toFullText(r)).toBe("Only Title");
  });

  it("入力が空文字ならfallbackTitleのみを返す", () => {
    const r = markdownToCosense("", "fallback");
    expect(r).toEqual({ title: "fallback", body: "" });
    expect(toFullText(r)).toBe("fallback");
  });
});

describe("複合ケース", () => {
  it("典型的なドキュメント全体を変換する", () => {
    const md = [
      "# My Page",
      "",
      "これは **導入** です。詳細は [docs](https://example.com/docs) を参照。",
      "",
      "## セクション",
      "",
      "- 項目1",
      "  - 項目1-1",
      "- 項目2",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "> 引用文",
      "",
      "---",
      "",
    ].join("\n");

    const r = markdownToCosense(md, "fallback");
    expect(r.title).toBe("My Page");
    expect(r.body).toBe(
      [
        "これは 導入 です。詳細は [https://example.com/docs docs] を参照。",
        "",
        "[** セクション]",
        "",
        " 項目1",
        "  項目1-1",
        " 項目2",
        "",
        "code:ts",
        " const x = 1;",
        "",
        "> 引用文",
      ].join("\n"),
    );
    expect(toFullText(r)).toBe(`${r.title}\n${r.body}`);
  });
});
