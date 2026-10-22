# -*- coding: utf-8 -*-
"""从学生手册 PDF 中为每道题截取原文条款作为"解析"（excerpt 字段）。v2

v1 的问题（量化诊断过）：整条款 2-gram 打分 + 从头截 180 字 →
  1) 答案句在条款中后段被截掉（49% 缺失）
  2) 出处无独立篇章时全文自由兜底 → 整类目塌缩到无关条款（20% 缺失）
v2 方案：
  - 句子级打分 + 答案句硬定位（正确选项文本必须出现在摘录里）
  - 以答案句为中心的窗口截取（上限 400 字，答案句宁全勿缺）
  - 取消跨文档自由兜底：找不到含答案句的条款就留空（宁缺毋错）
  - 前言/学校概况伪节（封面到第一个制度页之间，剔除目录）

用法：
    python tools/extract_excerpts.py
"""
import json
import re
from pathlib import Path

import fitz  # PyMuPDF

ROOT = Path(__file__).resolve().parent.parent
PDF_PATH = Path(r"C:\Users\Lenovo\Downloads\学生手册正稿260623.pdf")
DATA_JS = ROOT / "js" / "data.js"
REPORT = ROOT / "tools" / "excerpt_report.txt"

SCHOOL_LINE = "中国石油大学"
MAX_EXCERPT = 400       # 摘录基准长度
MAX_HARD = 700          # 多目标句（多选题）时的硬上限：答案宁全勿缺
MIN_ARTICLE_SCORE = 4   # 判断题条款入选最低题干 2-gram 重叠
JUDGE_MIN_COVER = 0.20  # 判断题摘录最低题干 bigram 覆盖率

# ---------------------------------------------------------------- 规范化

def normalize(s):
    s = s.replace("暋", "").replace("暠", "”").replace("暡", "[").replace("暢", "]")
    s = s.replace("曫", "〇")
    for a, b in [(",", "，"), ("(", "（"), (")", "）"), (";", "；"), (":", "："),
                ("?", "？"), ("!", "！"), ("[", "［"), ("]", "］")]:
        s = s.replace(a, b)
    s = re.sub(r"[\s\u3000]+", "", s)
    return s.lower()

def pretty(s):
    """excerpt 存储前的展示清洗。"""
    s = s.replace("暋", " ").replace("暠", "”")
    s = re.sub(r"\s+", "", s)
    for a, b in [(",", "，"), ("(", "（"), (")", "）"), (";", "；"), (":", "："),
                ("?", "？"), ("!", "！")]:
        s = s.replace(a, b)
    return s

def bigrams(s):
    s = normalize(s)
    return set(s[i:i+2] for i in range(len(s) - 1)) - {"，", "。", "的"}

# 答案文本命中判定（用于句子定位与条款加分两处语义不同，见调用点）
def ans_hit(sentence_norm, ans_norm):
    if ans_norm in sentence_norm:
        return True
    if not ans_norm:
        return False
    # 剥离比较符/约数词后比较："＞5学分" → "5学分"；"约30%" → "30%"
    a = re.sub(r"[＞≥＜≤>≤=≈约左右]", "", ans_norm)
    frags = [f for f in re.split(r"\d+", a) if f]
    nums = re.findall(r"\d+", a)
    if not nums:
        return False
    if frags and not all(f in sentence_norm for f in frags):
        return False
    return all(n in sentence_norm for n in nums)

# 条款加分专用：纯数字答案（无汉字片段，如"30"/"100"）不给条款加分——
# 数字太常见，会把匹配带偏到无关表格条款；但含汉字的（"30学分""120天"）仍加分
def ans_strong_hit(sentence_norm, ans_norm):
    a = re.sub(r"[＞≥＜≤>≤=≈约左右]", "", ans_norm)
    frags = [f for f in re.split(r"\d+", a) if f]
    if not frags:
        return False   # 纯数字：不加条款分（句子定位仍可用 ans_hit）
    return ans_hit(sentence_norm, ans_norm)

# 全书检索的准入条件：答案必须有足够具体的文字证据（汉字片段合计 ≥3 字），
# 否则 "30"/"3%" 这类会在无关公文里到处撞车（实测把双学位题配到处分扣分条）
def ans_specific(ans_norm):
    a = re.sub(r"[＞≥＜≤>≤=≈约左右]", "", ans_norm)
    frags = [f for f in re.split(r"\d+", a) if f]
    frags = [f for f in frags if re.search(r"[\u4e00-\u9fff]", f)]
    return sum(len(f) for f in frags) >= 3

# 数字单位池：纯数字答案必须与题干空位附近的单位一起出现在原文里，
# 否则 "2门" 会撞上 "2周"、"30%" 会撞上 "30学分"（实测过的假阳性）
UNITS = ["%", "％", "元", "天", "月", "年", "门", "次", "分", "周", "小时", "学分", "万元", "人", "岁", "倍"]

def is_numeric_answer(t):
    a = re.sub(r"[＞≥＜≤>≤=≈约左右]", "", normalize(t))
    return bool(re.fullmatch(r"[\d./，%％]+", a))

def numeric_verify(q, e):
    """纯数字答案：要求数字 + 单位（若题干空位后带单位）在摘录中邻接出现。"""
    e_norm = normalize(e)
    stem = q["stem"]
    # 空位附近（后 6 字/前 6 字）的单位
    units = set()
    for m in re.finditer(r"[（(]\s*[）)]", stem):
        tail = stem[m.end():m.end() + 6]
        head = stem[max(0, m.start() - 6):m.start()]
        for u in UNITS:
            if tail.startswith(u) or u in tail[:3] or head.endswith(u) or u in head[-3:]:
                units.add(u)
    ans_texts = [t for t in ([t for l, t in q.get("options", []) if l in q.get("answer", [])]
                             if q["type"] in ("single", "multi") else [a[0] for a in q["answer"]]) if t]
    stem_bg = bigrams(stem)
    for t in ans_texts:
        tn = re.sub(r"[＞≥＜≤>≤=≈约左右]", "", normalize(t))
        nums = re.findall(r"\d+(?:\.\d+)?", tn)
        for n in nums:
            alts = [n]
            if n.startswith("0."):
                # 0.95 ↔ 95% 写法
                try:
                    alts.append(str(round(float(n) * 100)))
                except ValueError:
                    pass
            check = False
            for cand in alts:
                if units:
                    for u in units:
                        if re.search(re.escape(cand) + r"[个多余至约]?" + re.escape(u), e_norm):
                            check = True
                            break
                else:
                    # 无单位线索：数字所在句必须与题干有足够重叠
                    for s in re.split(r"(?<=[。；])", e):
                        if cand in normalize(s) and len(stem_bg & bigrams(s)) >= 2:
                            check = True
                            break
                if check:
                    break
            if not check:
                return False
    return True

# ---------------------------------------------------------------- PDF 提取与分节

def clean_pdf_line(line):
    line = line.strip()
    if not line:
        return None
    if re.fullmatch(r"[\d\s]+", line):
        return None
    if re.fullmatch(r"[暋\s]+", line):
        return None
    return line

def extract_sections():
    """返回 {规范化标题: {"raw_title", "lines"}}。按「页首6行内校名行+标题行」切制度起始。
    另建「前言」伪节：第一个制度页之前的全部页面（含封面/学校概况，剔除目录页）。"""
    doc = fitz.open(PDF_PATH)
    pages = []
    for page in doc:
        lines = [clean_pdf_line(l) for l in page.get_text().splitlines()]
        pages.append([l for l in lines if l])
    doc.close()

    sections = {}
    cur_title = None
    cur_lines = []
    first_section_page = None

    def flush():
        nonlocal cur_title, cur_lines
        if cur_title:
            sections[normalize(cur_title)] = {"raw_title": cur_title, "lines": cur_lines}
        cur_title, cur_lines = None, []

    for pi, page in enumerate(pages):
        head = " ".join(page[:6])
        # 制度起始页模式1：页首校名行 + 标题行
        if SCHOOL_LINE in head and len(page) >= 2:
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
                    and "，" not in cand):
                if first_section_page is None:
                    first_section_page = pi
                flush()
                cur_title = cand
                cur_lines = list(page)
                continue
        # 制度起始页模式2：页面首行本身是文件标题（无校名行，如"心理咨询来访者须知"）
        if cur_title and page:
            first = page[0]
            if (3 <= len(first) <= 25
                    and re.search(r"(规定|办法|细则|须知|指南|条例|说明)$", first)
                    and not re.search(r"[。；，：！？]$", first)):
                flush()
                cur_title = first
                cur_lines = list(page)
                continue
        if cur_title:
            cur_lines.extend(page)
    flush()

    # 前言伪节（学校概况/校史/校训）：第一个制度页之前，剔除目录页（含"目录"或罗马页码特征）
    if first_section_page:
        pre = []
        for pi in range(first_section_page):
            joined = "".join(pages[pi])
            if pi <= 1 or "目录" in joined[:30] or re.search(r"^[ⅠⅡⅢ\s]", joined):
                continue
            pre.extend(pages[pi])
        if pre:
            sections[normalize("__前言__")] = {"raw_title": "前言（学校概况）", "lines": pre}
    return sections

ARTICLE_RE = re.compile(r"^(第[一二三四五六七八九十百零\d]+条)")
CLAUSE_RE = re.compile(r"^[一二三四五六七八九十]、")
SUBCLAUSE_RE = re.compile(r"^[（(][一二三四五六七八九十][)）]")

def merge_lines(lines):
    """跨页断句合并：上一行不以句末标点结尾 → 拼接。"""
    merged = []
    for l in lines:
        if merged and not re.search(r"[。；：！？”]$", merged[-1]):
            merged[-1] += l
        else:
            merged.append(l)
    return merged

def split_articles(lines):
    merged = merge_lines(lines)
    arts, buf = [], []
    for l in merged:
        if ARTICLE_RE.match(l) or CLAUSE_RE.match(l):
            if buf:
                arts.append("".join(buf))
            buf = [l]
        else:
            buf.append(l)
    if buf:
        arts.append("".join(buf))
    if len(arts) <= 1:
        # 无条款结构的（须知/指南/前言）：整段就是一个单元，不切
        return merged if merged else arts
    return arts

def split_sentences(art):
    """条款 → 句子列表（保留子列举项边界），供答案句定位。"""
    parts = re.split(r"(?<=[。；])", art)
    parts = [p for p in parts if p.strip()]
    # 子列举项 (一)(二) 与 1.2.3. 单独成句
    out = []
    for p in parts:
        m = re.split(r"(?=[（(][一二三四五六七八九十][)）])|(?=\d+[.、])", p)
        out.extend([x for x in m if x.strip()])
    return out

# ---------------------------------------------------------------- 出处映射

# 题库 source 关键词 → 手册标题（v2 补全：无独立篇章的内容按关键词检索定位）
ALIAS = {
    "学分制收费管理暂行办法": "本科生学分制收费管理办法",
    "图书馆借阅规定": "图书借阅注意事项",
    "图书馆开架书库借阅管理规定": "图书借阅注意事项",
    "读者文明规范": "图书馆读者文明规范",
    "第二课堂成绩单实施细则": "本科生“第二课堂成绩单”实施细则",
    "纪律处分规定": "学生纪律处分规定(修订)",
    "学生申诉处理办法": "学生申诉处理办法(修订)",
    "学校概况": "__前言__",
    "校史": "__前言__",
    # 新版手册已合并/改名的文件 → 内容实际所在节
    "学士学位授予": "学士学位授予工作细则",
    # 心理咨询来访者须知：独立成节后直接映射
    "心理咨询来访者须知": "心理咨询来访者须知",
    "国家奖学金": "本科生国家奖学金、国家励志奖学金、",
    "国家励志奖学金": "国家励志奖学金、国家助学金实施细则》",
    "本科毕业设计": "本科毕业设计(论文)管理规定(修订)",
    "优良学风班评选办法": "优良学风班评选办法",
    "国家助学贷款": "国家助学贷款实施办法",
    "勤工助学": "学生勤工助学管理实施细则",
    "学费减免": "学生学费减免管理办法",
    "困难补助": "学生困难补助管理办法",
    "国家学生体质健康标准": "实施《国家学生体质健康标准》细则",
    "学生档案管理": "本科生档案管理办法",
}

# 2026 版手册已删除/不存在的制度：正常路径不映射，只允许答案文本硬约束的跨节检索
ABSENT_SOURCES = [
    "双学位培养管理办法", "辅修培养管理办法", "学生社团管理办法",
    "本科生自主发展计划", "创新成果奖励办法", "优异生培养",
]

# 无独立篇章出处 → 在这些节内按答案句硬约束检索（键为 normalize 后的标题）
FALLBACK_SECTIONS = [
    "关于本科生学籍管理", "本科生跨学科学习指南", "本科生转专业管理规定",
    "本科生“第二课堂成绩单”实施细则", "优秀本科生“三进”提升计划实施办法",
    "本科生学科竞赛管理办法", "大学生创业实践管理办法", "大学生创新创业训练计划项目",
    "本科生创新创业学籍管理办法", "学生综合素质测评办法", "学生奖学金管理细则",
    "__前言__",
]
FALLBACK_KEYS = None   # 惰性计算：normalize 后与 sections 键对齐

def map_source_to_section(source, sections):
    s = source.strip().strip("《").rstrip("》")
    for key, target in ALIAS.items():
        if key in s:
            t = normalize(target)
            if t in sections:
                return t, False
            # 目标节不存在 → 也走受控兜底
            return None, True
    ns = normalize(s)
    for title in sections:
        if ns and (ns in title or title in ns):
            return title, False
    core = re.sub(r"^中国石油大学[（(]?华东[）)]?", "", s)
    nc = normalize(core)
    for title in sections:
        if nc and (nc in title or title in nc):
            return title, False
    return None, True

# ---------------------------------------------------------------- 摘录合成

def build_excerpt(q, article, stem_bg):
    """从条款合成摘录：答案句必须在窗口内。返回 (excerpt or None)。"""
    art_pretty = pretty(article)
    if len(art_pretty) <= MAX_EXCERPT:
        return art_pretty
    sentences = split_sentences(article)
    if len(sentences) <= 1:
        return art_pretty[:MAX_HARD] + "……"

    # 每句打分
    ans_texts = []
    if q["type"] in ("single", "multi"):
        ans_texts = [t for l, t in q.get("options", []) if l in q.get("answer", [])]
    elif q["type"] == "fillin":
        ans_texts = [a[0] for a in q["answer"]]

    scored = []
    for i, s in enumerate(sentences):
        sn = normalize(s)
        bg = bigrams(s)
        score = len(stem_bg & bg)
        hit = any(ans_hit(sn, normalize(t)) for t in ans_texts if t)
        if hit:
            score += 30      # 答案句强加分
        scored.append((score, i, s))
    if not scored:
        return None

    # 目标句集合：全部答案句（若存在）+ 最高分句
    ans_idx = [i for sc, i, s in scored if sc >= 30]
    best_idx = max(scored, key=lambda x: x[0])[1]
    targets = sorted(set(ans_idx + [best_idx]))

    # 上限：含多个答案句（多选）时用硬上限，宁全勿缺
    limit = MAX_HARD if len(ans_idx) > 1 else MAX_EXCERPT

    # 窗口合成：从最靠前的目标句起，向后扩展覆盖所有目标句
    start = targets[0]
    end = targets[-1]
    window = sentences[start:end + 1]
    text = pretty("".join(window))
    if len(text) <= limit:
        out = text
    else:
        # 仍超长：截到上限但保证每个答案句完整（逐句累积，跳过过长非答案句）
        pieces, total = [], 0
        for i in range(start, end + 1):
            s = sentences[i]
            is_ans = i in ans_idx
            pl = len(pretty(s))
            if is_ans or total + pl <= limit:
                pieces.append(s)
                total += pl
            # 非答案句且放不下 → 跳过（用 …… 标注省略）
        out = "……".join(pretty(p) for p in pieces if p)
    # 前缀：条款编号（窗口没从条款头开始时）
    m = ARTICLE_RE.match(article) or CLAUSE_RE.match(article)
    prefix = ""
    if m and not out.startswith(pretty(m.group(0))):
        prefix = pretty(m.group(0))
    ell = "……" if start > 0 else ""
    result = (ell + prefix + out) if (prefix or ell) else out
    if len(result) > MAX_HARD:
        result = result[:MAX_HARD] + "……"
    return result

# ---------------------------------------------------------------- 主流程

def main():
    data_text = DATA_JS.read_text(encoding="utf-8")
    questions = json.loads(data_text[data_text.index("["): data_text.rindex("]") + 1])

    sections = extract_sections()
    print("分节得到 %d 个单元" % len(sections))

    # 条款缓存：节标题 → [(条款文本, bigram集合, 规范化文本)]
    articles_cache = {}
    fallback_pool = []
    for title, sec in sections.items():
        arts = split_articles(sec["lines"])
        cache = [(a, bigrams(a), normalize(a)) for a in arts if len(a) >= 15]
        articles_cache[title] = cache
        fallback_pool.extend(cache)   # 全书池：仅用于答案硬约束二次检索

    def wants(q):
        """该题需要出现在摘录里的答案文本。"""
        if q["type"] in ("single", "multi"):
            return [t for l, t in q.get("options", []) if l in q.get("answer", []) and t]
        if q["type"] == "fillin":
            return [a[0] for a in q["answer"] if a]
        return []

    def verify(q, e):
        """摘录必须能让做题人核对答案：选择/填空要求答案文本可查；判断题要求题干覆盖度。"""
        en = normalize(e)
        if q["type"] in ("single", "multi", "fillin"):
            ans_texts = wants(q)
            if not ans_texts:
                return False
            if all(is_numeric_answer(t) for t in ans_texts):
                return numeric_verify(q, e)
            return all(ans_hit(en, normalize(t)) for t in ans_texts)
        sb = bigrams(q["stem"])
        return bool(sb) and len(sb & bigrams(e)) / len(sb) >= JUDGE_MIN_COVER

    def try_articles(q, articles, stem_bg, ans_texts):
        """按题干重叠+答案强命中排序，逐个构建并验证，返回通过验证的摘录。"""
        scored = []
        for art, bg, an in articles:
            score = len(stem_bg & bg)
            if ans_texts and any(ans_strong_hit(an, normalize(t)) for t in ans_texts):
                score += 25
            scored.append((score, art))
        scored.sort(key=lambda x: -x[0])
        for score, art in scored[:6]:
            if q["type"] == "judge" and score < MIN_ARTICLE_SCORE:
                continue
            e = build_excerpt(q, art, stem_bg)
            if e and verify(q, e):
                return e
        return None

    excerpts = {}
    dropped = []
    for q in questions:
        stem_bg = bigrams(q["stem"])
        ans_texts = wants(q)
        source = q.get("source", "")
        absent = any(k in source for k in ABSENT_SOURCES)
        title, need_fallback = map_source_to_section(source, sections)

        e = None
        # 1) 正常路径：出处映射到的节（按题干+答案打分，验证通过才算）
        if not absent and title and not need_fallback:
            e = try_articles(q, articles_cache[title], stem_bg, ans_texts)
            # 1b) 本书内答案硬约束检索（只在本书，绝不跨文档）
            if not e and q["type"] != "judge" and ans_texts:
                cands = []
                for art, bg, an in articles_cache[title]:
                    hits = sum(1 for t in ans_texts if ans_hit(an, normalize(t)))
                    if hits:
                        cands.append((hits, len(stem_bg & bg), art))
                cands.sort(key=lambda x: (-x[0], -x[1]))
                for _, _, art in cands[:6]:
                    e2 = build_excerpt(q, art, stem_bg)
                    if e2 and verify(q, e2):
                        e = e2
                        break
        # 2) 出处无对应篇章（手册已删/改名）：全书检索，但要求答案足够具体 + 题干最低重叠，防误配
        if (not e and (absent or need_fallback or not title) and q["type"] != "judge"
                and ans_texts and any(ans_specific(normalize(t)) for t in ans_texts)):
            cands = []
            for art, bg, an in fallback_pool:
                hits = sum(1 for t in ans_texts
                           if ans_specific(normalize(t)) and ans_hit(an, normalize(t)))
                overlap = len(stem_bg & bg)
                if hits and overlap >= 3:
                    cands.append((hits, overlap, art))
            cands.sort(key=lambda x: (-x[0], -x[1]))
            for _, _, art in cands[:6]:
                e2 = build_excerpt(q, art, stem_bg)
                if e2 and verify(q, e2):
                    e = e2
                    break
        # 3) 防误配：验证不过一律留空（宁缺毋错）
        excerpts[q["id"]] = e or ""
        if not e:
            dropped.append(q["id"])

    # 重建 data.js（保留其他字段原样）
    for q in questions:
        q["excerpt"] = excerpts.get(q["id"], "")
    payload = "var QUESTIONS = " + json.dumps(questions, ensure_ascii=False, separators=(",", ":")) + ";\n"
    DATA_JS.write_text(payload, encoding="utf-8")

    # -------- 质量门禁：精准率（有摘录的题，答案必须可查）+ 覆盖率 --------
    report = []
    for typ in ("single", "multi", "fillin", "judge"):
        tot = kept = hit = 0
        for q in questions:
            if q["type"] != typ:
                continue
            tot += 1
            if not q["excerpt"]:
                continue
            kept += 1
            if verify(q, q["excerpt"]):
                hit += 1
        pct_prec = hit / kept * 100 if kept else 0
        pct_cov = kept / tot * 100 if tot else 0
        report.append("%s: 精准 %d/%d (%.0f%%) | 覆盖 %d/%d (%.0f%%)" % (
            typ, hit, kept, pct_prec, kept, tot, pct_cov))
    print("\n===== 质量门禁 =====")
    for line in report:
        print(line)
    print("无摘录题数:", len(dropped), "（宁缺毋错：验证不过一律留空）")
    print("无摘录清单:", dropped[:40])

    REPORT.write_text(
        "质量门禁（精准=有摘录的题答案可查；覆盖=出摘录的题占比）:\n" + "\n".join(report) +
        "\n\n无摘录题 %d 个:\n%s\n" % (len(dropped), ", ".join(map(str, dropped))),
        encoding="utf-8")
    print("报告:", REPORT)

if __name__ == "__main__":
    main()
