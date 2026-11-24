#!/usr/bin/env python3
"""
文献脱水脚本：PDF → 结构化 Markdown
- 输入：PDF 路径（建议优先 markitdown 段落化，其次 fitz 全文）
- 输出：带 frontmatter、标题层级、摘要/关键词/参考文献/脚注/英文摘要的结构化 md
- 用法：
    python scripts/literature-textify.py <input.pdf> [-o out.md]
        [--title 标题] [--authors 作者] [--journal 期刊] [--doi DOI] [--zotero KEY]
- 说明：工具承担段落化与脱噪，标题层级/特殊结构由规则恢复；表格/图不自动建 md 表，
  保留原文本块并标注，需要时可手工转。扫描版（无文本层）PDF 需先 OCR，本脚本不处理。
"""

import argparse
import re
from datetime import date
from pathlib import Path


# ---------- 1. 提取 ----------
def convert_with_markitdown(pdf_path: str) -> str:
    """markitdown：保留段落空行（首选，省去坐标断段）"""
    try:
        from markitdown import MarkItDown
    except ImportError:
        raise SystemExit("markitdown 未安装：pip install markitdown") from None
    md = MarkItDown().convert(pdf_path)
    return md.text_content


def convert_with_fitz(pdf_path: str) -> str:
    """fitz 纯文本：无段落空行，需按句号/标点启发式断段（备选）"""
    import fitz

    doc = fitz.open(pdf_path)
    return "\n".join(str(p.get_text()) for p in doc)


# ---------- 2. 杂质与结构 ----------
H1_RE = re.compile(r"^\d+\s+[\u4e00-\u9fffA-Za-z]")  # 一级节标题：1 案例研究...
H2_RE = re.compile(r"^\d+\.\d+")  # 二级节标题：3.1 ...
NOISE_PREFIX = (
    "ISSN ",
    "收稿日期",
    "修回日期",
    "基金项目",
    "作者简介",
    "DOI：",
    "DOI:",
    "引用格式",
    "网络首发时间",
    "网络首发地址",
    "中图分类号",
    "文献标识码",
    "学术支撑",
    "出版管理条例",
)
NOISE_EXACT = {"科学学研究", "Studies in Science of Science"}

FIG_WORDS = (
    "大规模/多来源/跨主体",
    "小规模/单一来源/单一主体",
    "理论/概念模糊",
    "理论/概念清晰",
    "主要方法路径",
    "需要比较分布时",
    "对材料缺乏认识时",
    "已具有理论线索时",
)
FIG_EXACT = {
    "高",
    "低",
    "理",
    "论",
    "成",
    "熟",
    "度",
    "传统扎根法",
    "传统分析法",
    "CALM框架",
    "CGT框架",
    "HITL框架",
}


def is_noise(line: str) -> bool:
    s = line.strip()
    if not s:
        return True
    if s in NOISE_EXACT:
        return True
    if s.startswith(NOISE_PREFIX):
        return True
    if re.match(r"^10\.\d", s):  # 裸 DOI 行
        return True
    if re.fullmatch(r"\d{1,3}", s):  # 孤立页码
        return True
    return len(s) < 150 and ("网络首发" in s or "录用定稿" in s or "出版确认" in s)


def is_fig_text(line: str) -> bool:
    """图内短行（四象限标签等），正文剔除"""
    s = line.strip()
    if len(s) > 45:
        return False
    if s in FIG_EXACT:
        return True
    return any(w in s for w in FIG_WORDS)


def is_stop(line: str) -> bool:
    return bool(re.search(r"[。；]$", line.strip()))


def clean_text(raw: str) -> list:
    """
    返回 token 列表：(kind, text)
    kind: H1/H2(标题) ABS(摘要) KW(关键词) P(段落) FN(脚注) REF(参考文献) ENG(英文摘要)
    """
    lines = list(raw.split("\n"))
    # 正文起点 = 摘要行：封面页与网络首发声明整体截断
    abs_idx = next(
        (
            idx
            for idx, line in enumerate(lines)
            if line.strip().startswith(("摘  要", "摘 要", "摘要"))
        ),
        None,
    )
    if abs_idx is not None:
        lines = lines[abs_idx:]
    tokens = []
    i = 0
    in_abs = False
    in_refs = False
    in_eng = False
    eng_lines = []
    seen_body = False  # 摘要/标题出现前，封面噪声块直接丢弃
    footnotes = []
    n = len(lines)

    while i < n:
        s = lines[i].strip()
        i += 1
        # ---- 状态机 ----
        if in_eng:
            eng_lines.append(s)
            if s.startswith(("Keywords:", "Key words:", "关键词")):
                in_eng = False
                tokens.append(("ENG", "\n".join(eng_lines)))
            continue
        if s.startswith("Computational Grounded") or re.match(r"^English Abstract", s):
            in_eng = True
            eng_lines = [s]
            continue
        if in_refs:
            tokens.append(("REF", s))
            continue
        if s == "参考文献：":
            in_refs = True
            continue
        if in_abs:
            if s.startswith("关键词"):
                tokens.append(("KW", s))
                in_abs = False
                continue
            if is_noise(s):
                continue
            if H1_RE.match(s) or H2_RE.match(s):
                in_abs = False
            else:
                tokens.append(("ABS", s))
                continue
        if s.startswith("摘"):
            in_abs = True
            seen_body = True
            tokens.append(("ABS", s.replace("摘  要：", "")))
            continue
        # ---- 噪声 / 图内文字 ----
        if is_noise(s):
            continue
        if is_fig_text(s):
            continue
        # ---- 标题 ----
        if H1_RE.match(s) or H2_RE.match(s):
            tokens.append(("H", s))
            continue
        # ---- 参考文献条目（引用后即标点的是正文行，真条目在 refs 区）----
        if re.match(r"^\[\d+\]", s) and not re.match(r"^\[\d+\][。；，]", s):
            tokens.append(("REF", s))
            continue
        # ---- 脚注 ----
        if re.match(r"^[①②③④⑤⑥⑦⑧⑨⑩]", s):
            fn = s
            while i < n:
                nxt = lines[i].strip()
                if not nxt or is_noise(nxt) or is_fig_text(nxt):
                    i += 1
                    continue
                if (
                    H1_RE.match(nxt)
                    or H2_RE.match(nxt)
                    or re.match(r"^[①②③④⑤⑥⑦⑧⑨⑩]", nxt)
                    or nxt.startswith(("参考文献", "摘", "关键词"))
                ):
                    break
                fn += nxt
                i += 1
                if is_stop(nxt):
                    break
            footnotes.append(re.sub(r"\s+", "", fn))
            continue
        # ---- 普通段落 ----
        if not seen_body and (
            "网络首发" in s
            or "题目：" in s
            or "引用格式" in s
            or "出版确认" in s
            or s.startswith("刊特定版式")
            or "出版的技术标准" in s
            or "书刊编辑" in s
            or "法定计量单位" in s
            or "地图标注" in s
            or ("。" not in s and len(s) < 120)
        ):
            continue  # 封面页混合块 / 标题作者残块
        seen_body = True
        tokens.append(("P", s))

    # 脚注统一附在 token 列末尾（正文集中输出，脚注移文末）
    for fn in footnotes:
        tokens.append(("FN", fn))
    return tokens


def assemble(tokens: list, meta: dict) -> str:
    """组装 markdown：frontmatter + 摘要 + 正文（段落合并）+ 脚注"""
    # 合并连续 P / ABS
    merged = []
    for kind, text in tokens:
        if kind in ("ABS", "P") and merged and merged[-1][0] == kind:
            merged[-1] = (kind, merged[-1][1] + text)
        else:
            merged.append((kind, text))

    ref_lines = []
    body = []
    eng = ""
    for kind, text in merged:
        if kind == "ABS":
            body.append(text)
        elif kind == "KW":
            body.append(f"**{text}**")
        elif kind == "H":
            t = text.strip()
            body.append(("\n## " if H1_RE.match(t) else "\n### ") + t)
        elif kind == "P":
            body.append(text)
        elif kind == "FN":
            body.append(f"\n> 脚注：{text}")
        elif kind == "REF":
            ref_lines.append(text)
        elif kind == "ENG":
            eng = text

    md = []
    md.append("---")
    md.append(f"title: {meta.get('title', '')}")
    md.append(f"authors: {meta.get('authors', '')}")
    if meta.get("journal"):
        md.append(f"journal: {meta['journal']}")
    if meta.get("doi"):
        md.append(f"doi: {meta['doi']}")
    if meta.get("zotero"):
        md.append(f"zotero: zotero://select/library/items/{meta['zotero']}")
    md.append(f"textified: {date.today().isoformat()}")
    md.append("---")
    md.append("")
    md.append(f"# {meta.get('title', '')}")
    md.append("")
    md.append(
        "> 文本化说明：本文件由 PDF 程序化提取整理，可能含轻微排版误差；正式引用请回原文核对。"
    )
    md.append("")
    md.append("## 摘要")
    md.append("")
    md.extend(body)
    md.append("")
    md.append("## 参考文献")
    md.append("")
    for r in ref_lines:
        md.append(r)
        md.append("")
    if eng:
        md.append("")
        md.append("## English Abstract")
        md.append("")
        md.append("<details><summary>英文摘要原文（点击展开）</summary>")
        md.append("")
        md.append(eng)
        md.append("")
        md.append("</details>")
    return "\n".join(md)


def main():
    ap = argparse.ArgumentParser(description="文献脱水：PDF → 结构化 Markdown")
    ap.add_argument("pdf", help="输入 PDF 路径")
    ap.add_argument("-o", "--out", help="输出 md 路径（默认与 PDF 同名 .md）")
    ap.add_argument("--title")
    ap.add_argument("--authors")
    ap.add_argument("--journal")
    ap.add_argument("--doi")
    ap.add_argument("--zotero")
    ap.add_argument(
        "--fitz", action="store_true", help="用 fitz 全文提取（备选，段落需启发式断段）"
    )
    args = ap.parse_args()

    pdf = Path(args.pdf)
    if not pdf.exists():
        raise SystemExit(f"PDF 不存在：{pdf}")

    raw = (
        convert_with_fitz(str(pdf)) if args.fitz else convert_with_markitdown(str(pdf))
    )
    tokens = clean_text(raw)

    out = Path(args.out) if args.out else pdf.with_suffix(".md")
    meta = {
        "title": args.title or pdf.stem,
        "authors": args.authors or "",
        "journal": args.journal or "",
        "doi": args.doi or "",
        "zotero": args.zotero or "",
    }
    out.write_text(assemble(tokens, meta), encoding="utf-8")
    print(f"产出：{out}")
    # 简易验证
    heads = [k for k, _ in tokens if k in ("H", "ABS", "KW")]
    refn = len([k for k, _ in tokens if k == "REF"])
    print(f"标题节：{len(heads)} | 参考行：{refn}")


if __name__ == "__main__":
    main()
