# -*- coding: utf-8 -*-
"""从学生手册 PDF 中为每道题截取原文条款作为"解析"（excerpt 字段）。

一次性离线脚本：读 PDF + 现有 js/data.js → 重建 js/data.js（每题加 excerpt 字段）。

用法：
    python tools/extract_excerpts.py

PDF 结构（已探明）：
  - 274 页全文本层；44 篇制度文件按「页首校名行+标题行+文号行」起始
  - 字形噪声：暋→空格、暠→后引号、暡暢→[]；全文半角标点
  - 印刷页码≠PDF页码（偏移 +10~+13），必须按标题文本定位，不能算术换算

匹配策略：
  1. 规范化（暋/暠/半角→全角、去空白）后按制度标题分节
  2. 节内按「第X条 / 一、二、」切条款段
  3. 题干与条款做 2-gram 重叠打分，答案文本命中加分
  4. 得分低于阈值 → excerpt 留空（前端回退只显示文件名），进未匹配报告
"""
import json
import re
import sys
from pathlib import Path

import fitz  # PyMuPDF

ROOT = Path(__file__).resolve().parent.parent
PDF_PATH = Path(r"C:\Users\Lenovo\Downloads\学生手册正稿260623.pdf")
DATA_JS = ROOT / "js" / "data.js"
REPORT = ROOT / "tools" / "excerpt_report.txt"

SCHOOL_LINE = "中国石油大学"
MAX_EXCERPT = 180       # 摘录最大字符数
MIN_SCORE = 5           # 低于此 2-gram 命中数的条款视为不匹配（5≈题干与条款有实质重叠）

# ---------------------------------------------------------------- 规范化

def normalize(s):
    """题干与 PDF 文本统一到可比较形态：去字形噪声、半角→全角、去空白、小写。"""
    s = s.replace("暋", "").replace("暠", "”").replace("暡", "[").replace("暢", "]")
    s = s.replace("曫", "〇")
    # 半角标点 → 全角
    for a, b in [(",", "，"), ("(", "（"), (")", "）"), (";", "；"), (":", "："),
                ("?", "？"), ("!", "！"), ("[", "［"), ("]", "］")]:
        s = s.replace(a, b)
    s = re.sub(r"[\s\u3000]+", "", s)
    return s.lower()


def clean_pdf_line(line):
    line = line.strip()
    if not line:
        return None
    if re.fullmatch(r"[\d\s]+", line):      # 纯数字行 = 印刷页码
        return None
    if re.fullmatch(r"[暋\s]+", line):      # 纯装饰行
        return None
    return line


def bigrams(s):
    s = normalize(s)
    return set(s[i:i+2] for i in range(len(s) - 1)) - {"，", "。", "的"}

# ---------------------------------------------------------------- PDF 分节

def extract_sections():
    """返回 {规范化标题: [条款文本, ...]}。按「页首6行内校名行」切制度起始。"""
    doc = fitz.open(PDF_PATH)
    pages = []
    for page in doc:
        lines = [clean_pdf_line(l) for l in page.get_text().splitlines()]
        pages.append([l for l in lines if l])
    doc.close()

    sections = {}          # 规范化标题 → {"raw_title": str, "lines": [跨页合并的行]}
    cur_title = None
    cur_lines = []

    def flush():
        nonlocal cur_title, cur_lines
        if cur_title:
            sections[cur_title] = {"raw_title": cur_title, "lines": cur_lines}
        cur_title, cur_lines = None, []

    for page in pages:
        head = " ".join(page[:6])
        if SCHOOL_LINE in head and len(page) >= 2:
            # 制度起始页：校名行后第一行 = 标题行
            # 标题约束：3~30字、不以句末标点/冒号结尾、不含逗号分句（排除正文首行误判）
            cand = None
            for l in page[:6]:
                if SCHOOL_LINE in l or re.match(r"^[（(【第]", l):
                    continue
                if "号" in l and re.search(r"\d{4}", l):
                    continue
                cand = l
                break
            if (cand and 3 <= len(cand) <= 30
                    and not re.search(r"[。；：，！？”]$", cand)
                    and "，" not in cand and len(re.findall(r"。|；", cand)) == 0):
                flush()
                cur_title = cand
                cur_lines = list(page)
                continue
        if cur_title:
            cur_lines.extend(page)
    flush()
    return sections


ARTICLE_RE = re.compile(r"^(第[一二三四五六七八九十百零\d]+条)")
CLAUSE_RE = re.compile(r"^[一二三四五六七八九十]、")

def split_articles(lines):
    """节内行合并为条款文本列表：跨页断句合并 + 按第X条切段。"""
    # 合并：上一行不以句末标点结尾 → 与下一行拼接
    merged = []
    for l in lines:
        if merged and not re.search(r"[。；：！？”]$", merged[-1]):
            merged[-1] += l
        else:
            merged.append(l)
    # 按「第X条」切段；无条款结构（如须知类）按「一、」或整篇
    arts, buf = [], []
    for l in merged:
        if ARTICLE_RE.match(l):
            if buf:
                arts.append("".join(buf))
            buf = [l]
        else:
            buf.append(l)
    if buf:
        arts.append("".join(buf))
    if len(arts) == 1:
        arts2, buf = [], []
        for l in merged:
            if CLAUSE_RE.match(l):
                if buf:
                    arts2.append("".join(buf))
                buf = [l]
            else:
                buf.append(l)
        if buf:
            arts2.append("".join(buf))
        if len(arts2) > 1:
            return arts2
    return arts

# ---------------------------------------------------------------- 出处 → 手册标题 别名映射

# 题库 source 中的关键词 → 手册中的规范化标题（normalize 后完全匹配）
# "图书馆借阅规定" 映射到两篇之一，靠 fallback 全文检索兜底
ALIAS = {
    "学分制收费管理暂行办法": "本科生学分制收费管理办法",
    "图书馆借阅规定": "图书馆图书借阅注意事项",
    "第二课堂成绩单实施细则": "本科生“第二课堂成绩单”实施细则(2024年修订)",
    "学生纪律处分规定": "学生纪律处分规定(修订)",
    "学生申诉处理办法": "学生申诉处理办法(修订)",
}

def map_source_to_section(source, sections):
    """题库出处 → 节标题（规范化）。返回 (节标题 or None, 是否全文兜底)。"""
    s = source.strip().strip("《").rstrip("》")
    # 先查别名表（按 source 中出现的关键词）
    for key, target in ALIAS.items():
        if key in s:
            t = normalize(target)
            if t in sections:
                return t, False
    # 直接匹配：source 或其主干与某节标题互相包含
    ns = normalize(s)
    for title in sections:
        if ns and (ns in title or title in ns):
            return title, False
    # 主干再试（去掉校名前缀、书名号等）
    core = re.sub(r"^中国石油大学[（(华东[）)]?", "", s)
    nc = normalize(core)
    for title in sections:
        if nc and (nc in title or title in nc):
            return title, False
    return None, True   # 全文兜底

# ---------------------------------------------------------------- 主流程

def pretty(s):
    """excerpt 存储前的展示清洗：字形噪声 → 正常标点，半角标点 → 全角。"""
    s = s.replace("暋", " ").replace("暠", "”")
    s = re.sub(r"\s+", "", s)          # PDF 行间空隙去除后重排
    for a, b in [(",", "，"), ("(", "（"), (")", "）"), (";", "；"), (":", "："),
                ("?", "？"), ("!", "！")]:
        s = s.replace(a, b)
    return s


def main():
    data_text = DATA_JS.read_text(encoding="utf-8")
    questions = json.loads(data_text[data_text.index("["): data_text.rindex("]") + 1])

    sections = extract_sections()
    print("分节得到 %d 个制度文件:" % len(sections))
    for t, v in sections.items():
        print("   ", v["raw_title"])

    # 各节条款缓存
    articles_cache = {}   # 节标题 → [(条款文本, 条款bigram集合)]
    for title, sec in sections.items():
        arts = split_articles(sec["lines"])
        articles_cache[title] = [(a, bigrams(a)) for a in arts if len(a) >= 15]

    excerpts = {}
    unmatched = []
    fallback_pool = []    # 全部条款，给无节可依的题做全文检索
    for title, arts in articles_cache.items():
        fallback_pool.extend(arts)

    for q in questions:
        stem_bg = bigrams(q["stem"])
        # 答案文本加分项
        ans_bg = set()
        for letter, text in q.get("options", []):
            if letter in q.get("answer", []):
                ans_bg |= bigrams(text)
        title, need_fallback = map_source_to_section(q.get("source", ""), sections)
        pool = fallback_pool if need_fallback or title is None else articles_cache[title]
        best, best_score = "", 0
        for art, bg in pool:
            score = int(len(stem_bg & bg))
            if ans_bg:
                score += int(len(ans_bg & bg)) * 2
            if score > best_score:
                best, best_score = art, score
        if best_score >= MIN_SCORE and best:
            e = pretty(best)[:MAX_EXCERPT]
            if len(best) > MAX_EXCERPT:
                e += "……"
            excerpts[q["id"]] = e
        else:
            unmatched.append((q["id"], q["type"], q.get("source", ""), best_score, q["stem"][:40]))

    # 重建 data.js
    for q in questions:
        q["excerpt"] = excerpts.get(q["id"], "")
    payload = "var QUESTIONS = " + json.dumps(questions, ensure_ascii=False, separators=(",", ":")) + ";\n"
    DATA_JS.write_text(payload, encoding="utf-8")

    total = len(questions)
    matched = total - len(unmatched)
    print("\n匹配结果: %d/%d (%.0f%%) 题获得原文摘录" % (matched, total, matched / total * 100))
    REPORT.write_text(
        "未匹配题目 %d 个（excerpt 留空，前端只显示文件名）:\n\n" % len(unmatched) +
        "\n".join("id=%s type=%s src=%s score=%s stem=%s" % u for u in unmatched),
        encoding="utf-8")
    print("未匹配清单:", REPORT)

if __name__ == "__main__":
    main()
