# -*- coding: utf-8 -*-
"""从 docx 题库解析题目，生成 js/data.js

数据源：
  1. 新生手册考试题库.docx —— 455 道选择题（单选157/多选94/判断202/不定项2）
  2. 学生手册选择模拟(谢依成）.docx —— 42 道填空/背诵题（脚本仅提取原文，答案变体在 FILLIN_ANSWERS 中人工维护）

用法：python tools/parse_docx.py
输出：js/data.js（UTF-8）
"""
import io
import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCX_CHOICE = Path(r"C:\Users\Lenovo\Downloads\新生手册考试题库.docx")
DOCX_FILLIN = Path(r"C:\Users\Lenovo\Downloads\学生手册选择模拟(谢依成）.docx")
OUT = ROOT / "js" / "data.js"

# ---------------------------------------------------------------- docx 文本提取

def docx_paragraphs(path):
    """按段落返回 docx 纯文本列表（只读，不写盘）。"""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml").decode("utf-8")
    paras = []
    # 段落分隔：w:p 标签；段内 w:t 为文本；w:br/w:cr 视作换行
    for p in re.findall(r"<w:p[ >].*?</w:p>|<w:p/>", xml, re.S):
        texts = re.findall(r"<w:t[^>]*>(.*?)</w:t>", p, re.S)
        line = "".join(texts)
        line = (line.replace("&lt;", "<").replace("&gt;", ">")
                    .replace("&amp;", "&").replace("&quot;", '"')
                    .replace("&apos;", "'"))
        paras.append(line.strip())
    return paras


def clean(s):
    s = s.strip()
    s = re.sub(r"[\s\u3000]+$", "", s)
    s = re.sub(r"^[、，,。\s]+", "", s)
    return s.strip()


def fix_source(s):
    """清理出处字段的杂字符。"""
    s = re.sub(r"[、，,。\s]+$", "", s.strip())
    # 书名号未闭合的补全（《XXX 缺尾巴）
    if s.startswith("《") and not s.endswith("》"):
        s += "》"
    return s

# ---------------------------------------------------------------- 选择题解析

SECTION_HEADS = {
    "多选题": "multi",
    "判断题": "judge",
    "不定项选择": "multi",   # 不定项并入多选
}

def parse_choice_bank(paras):
    questions = []
    cur_type = "single"
    cur = None
    head_re = re.compile(r"^(\d+)、\[2分\]")
    opt_re = re.compile(r"^([A-F])[.、．]\s*(.+)$")
    ans_re = re.compile(r"^正确答案[:：]\s*(.+)$")
    exp_re = re.compile(r"^答案解析[:：]?\s*(.*)$")

    def flush():
        nonlocal cur
        if cur:
            questions.append(cur)
            cur = None

    for raw in paras:
        line = raw.strip()
        if not line:
            continue
        # 节标题
        is_head = False
        for key, t in SECTION_HEADS.items():
            if line.startswith(key):
                flush()
                cur_type = t
                is_head = True
                break
        if is_head:
            continue
        m = head_re.match(line)
        if m:
            flush()
            stem_part = head_re.sub("", line).strip()
            cur = {
                "type": cur_type,
                "stem": stem_part,          # 可能为空（题干在下一行）
                "options": [],
                "answer": [],
                "source": "",
            }
            continue
        if cur is None:
            continue
        m = ans_re.match(line)
        if m and not cur["answer"]:
            letters = re.findall(r"[A-F]", m.group(1).upper())
            cur["answer"] = sorted(set(letters))
            continue
        m = exp_re.match(line)
        if m:
            # 解析行本身可能带出处，也可能出处在后几行 → 由后续段落补
            rest = m.group(1).strip()
            if rest:
                cur["source"] = fix_source(rest)
            cur["_in_exp"] = True
            continue
        m = opt_re.match(line)
        if m:
            cur["options"].append([m.group(1), clean(m.group(2))])
            continue
        # 普通文本行
        if cur.get("_in_exp") and not cur["source"]:
            # 解析之后的行 = 出处
            if line:
                cur["source"] = fix_source(line)
        elif not cur["options"]:
            # 选项出现之前 = 题干续行
            if cur["stem"]:
                cur["stem"] += line
            else:
                cur["stem"] = line
        # 选项之后的非答案非解析文本（极少见）追加到出处
        elif cur.get("_in_exp"):
            cur["source"] = fix_source(cur["source"] + line)
    flush()

    # 判断题选项归一为 对/错
    for q in questions:
        if q["type"] == "judge":
            q["options"] = [["A", "对"], ["B", "错"]]
    return questions

# ---------------------------------------------------------------- 章节分类

CATEGORY_RULES = [
    ("学生纪律处分", ["纪律处分"]),
    ("学籍管理", ["学籍管理规定", "学士学位授予", "试读", "入学资格"]),
    ("考试管理", ["考试工作管理规定"]),
    ("实验教学与实习", ["实验教学管理办法", "实习教学管理办法"]),
    ("创新创业", ["创新创业", "创业实践", "创业基金", "创业基地", "创业实践管理办法", "大创"]),
    ("双学位与辅修", ["双学位", "辅修"]),
    ("奖学金与资助", ["奖学金", "助学金", "助学贷款", "勤工助学", "资助"]),
    ("综合素质测评", ["综合素质测评"]),
    ("自主发展计划", ["自主发展计划", "第二课堂"]),
    ("学科竞赛", ["学科竞赛", "创新成果奖励"]),
    ("优良学风班", ["优良学风班", "先进班集体"]),
    ("学生公寓", ["公寓管理"]),
    ("图书馆", ["图书馆"]),
    ("学生社团", ["社团管理"]),
    ("心理咨询", ["心理咨询", "心理健康"]),
    ("申诉处理", ["申诉"]),
    ("学分制收费", ["学分制收费", "收费管理"]),
    ("三进提升计划", ["三进"]),
    ("学校概况", ["学校概况", "校史"]),
    ("文体与场馆", ["体育", "场馆", "运动会"]),
]

def categorize(source):
    for cat, keys in CATEGORY_RULES:
        for k in keys:
            if k in source:
                return cat
    return "其他"

# ---------------------------------------------------------------- 填空题答案（人工维护）

# 逐题答案：每题为 [空1, 空2, ...]，每个空是可接受写法列表。
# 题干原文按顺序对应；仅为说明/注释的行不入库。
FILLIN = [
    {
        "stem": "学校于（　）年建校，时称北京石油学院，（　）年迁校山东，改称华东石油学院。（　）年，学校更名为石油大学。（　）年1月，学校更名为中国石油大学。",
        "answers": [["1953"], ["1969"], ["1988"], ["2005"]],
        "source": "《学校概况》校史",
        "note": "",
    },
    {
        "stem": "除开除学籍处分以外，给予学生处分设置一定期限：警告处分期限为（　）个月，严重警告处分期限为（　）个月，记过处分期限为（　）个月，留校察看处分期限为（　）个月。",
        "answers": [["6", "六"], ["8", "八"], ["10", "十"], ["12", "十二"]],
        "source": "《中国石油大学（华东）学生纪律处分规定》",
        "note": "",
    },
    {
        "stem": "修读双学位的学生，获得主修专业学位但达不到双学位专业和教学培养方案要求的，低于（　）学分者，其所修双学位课程作为通识教育选修课记入《中国石油大学（华东）学生成绩记载表》。",
        "answers": [["30", "30学分"]],
        "source": "《中国石油大学（华东）本科生双学位培养管理办法》",
        "note": "",
    },
    {
        "stem": "修读双学位的学生，获得主修专业学位但达不到双学位专业和教学培养方案要求的，若所修双学位课程的总学分（　）学分者，颁发辅修专业证书。",
        "answers": [["≥25", "25", "达到25", "不少于25"]],
        "source": "《中国石油大学（华东）本科生双学位培养管理办法》",
        "note": "题库单选第25题：总学分≥25学分者颁发辅修专业证书。",
    },
    {
        "stem": "辅修专业培养方案由辅修专业开设院部制定，所设课程应是本专业基础课程和专业课，总学分一般为（　）左右。",
        "answers": [["30", "30学分"]],
        "source": "《中国石油大学（华东）本科生辅修培养管理办法》",
        "note": "（原整理标注答案为30）",
    },
    {
        "stem": "对于可以优先推荐免试攻读硕士研究生的优异生的数量约占本年级在校生总数的（　）左右。",
        "answers": [["3%", "0.03", "3％", "百分之三"]],
        "source": "《本科生优异生培养实施办法》",
        "note": "",
    },
    {
        "stem": "独立设置的实验（上机）课程，缺做实验（　）或缺交实验报告（　）及以上者，成绩以零分记载。",
        "answers": [["1/3", "三分之一", "1／3"], ["1/3", "三分之一", "1／3"]],
        "source": "《中国石油大学（华东）本科实验教学管理办法》",
        "note": "记住关键数据 1/3 以上，成绩以 0 分记载。",
    },
    {
        "stem": "建校近70年来，学校形成了鲜明的办学特色。在新的历史时期，学校坚持特色发展、内涵发展、高质量发展，正向着“（　）”的办学目标奋力迈进。",
        "answers": [["中国特色石油领域中国一流大学"]],
        "source": "《学校概况》",
        "note": "别写少字了。",
    },
    {
        "stem": "学分学费按学生修读学分计收，学分收费标准为每学分（　）元。",
        "answers": [["100", "100元", "一百"]],
        "source": "《中国石油大学（华东）学分制收费管理暂行办法》",
        "note": "",
    },
    {
        "stem": "我校现有在校本科生近（　）人，研究生7000余人，留学生1100余人。",
        "answers": [["19000", "19000人", "1.9万", "近19000"]],
        "source": "《学校概况》",
        "note": "",
    },
    {
        "stem": "在中国国际“互联网+”大学生创新创业大赛获得金奖、银奖、铜奖，分别获得奖金（　）。",
        "answers": [["5万、3万、1万", "50000、30000、10000", "5万/3万/1万", "50000/30000/10000", "5万，3万，1万"]],
        "source": "《中国石油大学（华东）本科生创新成果奖励办法》",
        "note": "金奖5万、银奖3万、铜奖1万。",
    },
    {
        "stem": "学生免修课程应向所在院部提出书面申请，院部主管领导批准，经过考核，成绩达到（　）分以上，取得该课程学分。",
        "answers": [["70", "70分", "七十分"]],
        "source": "《中国石油大学（华东）本科生学籍管理规定》",
        "note": "判断题如果说“及格及以上取得该学分”就是错的，必须要70分以上。",
    },
    {
        "stem": "学生申请学分认定，应于每学期初（　）向所在院（部）提出申请，并提供能体现创新创业实践过程及成果的支撑材料，经院（部）创新创业教育领导小组认定、学校创新创业教育工作领导小组办公室审定后，报学校备案。",
        "answers": [["3周内", "三周内", "3周", "前三周"]],
        "source": "《中国石油大学（华东）本科生创新创业学籍管理办法（试行）》",
        "note": "",
    },
    {
        "stem": "学生对学校的处分决定有异议的，应在接到学校处分决定书之日起（　）日内，向学校学生申诉处理委员会提出书面申诉。",
        "answers": [["10", "10日", "十日"]],
        "source": "《中国石油大学（华东）学生申诉处理办法》",
        "note": "",
    },
    {
        "stem": "国家助学贷款本专科生每人每年最高不超过（　）元。",
        "answers": [["8000", "8000元", "八千"]],
        "source": "《国家助学贷款管理规定》",
        "note": "",
    },
    {
        "stem": "凡结课（含免修）考核不及格的课程，可通过重新选课修读或补考取得该课程的学分。考核成绩合格但成绩不理想的课程，也可重新选课修读。在学校规定的最长学习年限内，重新选课修读（　）。",
        "answers": [["不限制次数", "不限次数", "不限制"]],
        "source": "《中国石油大学（华东）本科生学籍管理规定》",
        "note": "",
    },
    {
        "stem": "学校本科专业标准学制四年（建筑学专业学制五年），实行学分制管理和弹性学习年限，学生可在标准学制的基础上（　）或（　）毕业。",
        "answers": [["提前1年", "提前一年", "提前", "提前1-2年"], ["延长2年", "延长两年", "延长", "推迟2年", "推迟"]],
        "source": "《中国石油大学（华东）本科生学籍管理规定》",
        "note": "原整理答案为“1、2”（提前1年/延长2年）。建筑学专业可延长至…以学籍管理规定为准。",
    },
    {
        "stem": "受资助项目如有盈利，根据项目收益情况，将项目净利润的（　）%上交学校大学生创业基金，用以滚动支持更多创业项目。",
        "answers": [["5", "5%", "百分之五"]],
        "source": "《中国石油大学（华东）大学生创业实践管理办法》",
        "note": "",
    },
    {
        "stem": "学生结业后（　）之内回校完成相关课程修读，达到本科培养方案规定的学分要求的，学校准予毕业，符合学士学位授予标准的，授予学士学位。",
        "answers": [["1年", "一年", "1"]],
        "source": "《中国石油大学（华东）本科生学籍管理规定》",
        "note": "",
    },
    {
        "stem": "专业注册学费是指以不同专业的（　）为基础，对不同专业收取的年度学费。",
        "answers": [["生均培养成本"]],
        "source": "《中国石油大学（华东）学分制收费管理暂行办法》",
        "note": "",
    },
    {
        "stem": "已知英语（4-2）3学分，数学（2-2）5学分，军事理论1学分，小李同学英语、数学、军理的成绩分别是85、98、91，那么小李同学的这三门功课的专业学习测评成绩绩点为（　）。",
        "answers": [["4.29", "约4.29"]],
        "source": "《中国石油大学（华东）学生综合素质测评办法》",
        "note": "计算方法：85/10-5=3.5，98/10-5=4.8，91/10-5=4.1，（3.5×3+4.8×5+4.1×1）/（3+5+1）≈4.29。",
    },
    {
        "stem": "凡我校本科生在取得本专业培养计划规定学分的同时，还需至少取得（　）个自主发展计划学分。",
        "answers": [["10", "10个", "十"]],
        "source": "《中国石油大学（华东）本科生自主发展计划》",
        "note": "",
    },
    {
        "stem": "创业基金初期拨付资助金额的（　）。",
        "answers": [["50%", "0.5", "50％", "一半", "百分之五十"]],
        "source": "《中国石油大学（华东）大学生创业实践管理办法》",
        "note": "",
    },
    {
        "stem": "优良学风班分为优良学风班、优良学风标兵班，奖励标准分别为（　）元/班。",
        "answers": [["1000、3000", "1000/3000", "1000，3000", "1000和3000"]],
        "source": "《中国石油大学（华东）优良学风班评选办法》",
        "note": "优良学风班1000元/班，优良学风标兵班3000元/班。",
    },
    {
        "stem": "评选优良学风班需具备的条件之一是：全班学生学习效果显著，各门必修课程考试及格率达（　）。",
        "answers": [["95%", "0.95", "95％", "百分之九十五"]],
        "source": "《中国石油大学（华东）优良学风班评选办法》",
        "note": "",
    },
    {
        "stem": "组织能力奖学金、文艺特长及体育优胜奖学金的评选比例不超过（　）。",
        "answers": [["10%", "0.1", "10％", "百分之十"]],
        "source": "《中国石油大学（华东）学生奖学金管理细则》",
        "note": "",
    },
    {
        "stem": "学生毕业时，按照多退少补原则结算学费，学生实际修读学分超过所属专业毕业要求总学分（　），应补交超出的学分学费。",
        "answers": [["5学分（不含）以上", ">5学分", "＞5学分", "超过5学分", "5学分以上"]],
        "source": "《中国石油大学（华东）学分制收费管理暂行办法》",
        "note": "超过毕业要求总学分5学分（不含）以上。",
    },
    {
        "stem": "国家励志奖学金申请学生当学年基础性素质测评等级至少为（　）。",
        "answers": [["B", "B级", "b"]],
        "source": "《中国石油大学（华东）学生奖学金管理细则》",
        "note": "",
    },
    {
        "stem": "“三进”计划原则上面向（　）年级本科生，秋季学期组织，每年选拔300~500名。",
        "answers": [["二", "2", "大二"]],
        "source": "《优秀本科生“三进”提升计划实施办法》",
        "note": "",
    },
    {
        "stem": "“三进”提升计划优秀生培养周期为（　）年。",
        "answers": [["2", "二", "两年", "2年"]],
        "source": "《优秀本科生“三进”提升计划实施办法》",
        "note": "",
    },
    {
        "stem": "学生综合素质测评工作分（　）、班级测评、（　）、院部复核和学校审批五个步骤进行。",
        "answers": [["个人自评"], ["年级测评"]],
        "source": "《中国石油大学（华东）学生综合素质测评办法》",
        "note": "",
    },
    {
        "stem": "创业基金资助期原则上为（　）年。",
        "answers": [["一", "1", "一年", "1年"]],
        "source": "《中国石油大学（华东）大学生创业实践管理办法》",
        "note": "",
    },
    {
        "stem": "对提供器械供人打架斗殴，未造成伤害后果者，给予（　）处分。",
        "answers": [["警告"]],
        "source": "《中国石油大学（华东）学生纪律处分规定》",
        "note": "",
    },
    {
        "stem": "1980年后出版的中文图书直接赔款是按照原价的（　）赔偿。",
        "answers": [["3-5倍", "3~5倍", "3—5倍", "3倍至5倍"]],
        "source": "《中国石油大学（华东）图书馆借阅规定》",
        "note": "",
    },
    {
        "stem": "学生费用清缴次序为（　）。①代收费；②专业注册学费；③住宿费；④学分学费。",
        "answers": [["①③②④", "1324", "1-3-2-4", "代收费、住宿费、专业注册学费、学分学费"]],
        "source": "《中国石油大学（华东）学分制收费管理暂行办法》",
        "note": "",
    },
    {
        "stem": "学习进步奖学金奖励标准是800元/人，奖励专业学习测评成绩排名较上学年进步达到（　）%的学生。",
        "answers": [["30", "30%", "百分之三十"]],
        "source": "《中国石油大学（华东）学生奖学金管理细则》",
        "note": "",
    },
    {
        "stem": "按照每生每（　）元的标准，给予科研团队优秀生培养经费资助，主要用于优秀生培养。",
        "answers": [["3000-5000", "3000~5000", "3000—5000", "3000至5000"]],
        "source": "《优秀本科生“三进”提升计划实施办法》",
        "note": "",
    },
    {
        "stem": "保留入学资格由新生本人提出书面申请，并附相关证明材料（因病需提交校医院或校医院指定的二级甲等以上医院诊断证明），经学校批准，可保留入学资格（　）。保留入学资格期间不具有学籍。",
        "answers": [["1年", "一年", "1"]],
        "source": "《中国石油大学（华东）本科生学籍管理规定》",
        "note": "",
    },
    {
        "stem": "学生参加勤工助学不应当影响学业，原则上每周不超过（　）小时，每月不超过（　）小时。",
        "answers": [["8", "八"], ["40", "四十"]],
        "source": "《学生勤工助学管理办法》",
        "note": "",
    },
    {
        "stem": "各院部选拔优异生要全面考虑，好中选优，选拔的数量约占本年级在校生总数的（　）左右。",
        "answers": [["3%", "0.03", "3％", "百分之三"]],
        "source": "《本科生优异生培养实施办法》",
        "note": "",
    },
    {
        "stem": "服务时间累计60小时以上者，计（　）学分。",
        "answers": [["2", "二", "2学分"]],
        "source": "《中国石油大学（华东）本科生自主发展计划》",
        "note": "",
    },
    {
        "stem": "心理咨询服务的时间为每周一至周五的（　）。",
        "answers": [["上午8:00-12:00，下午14:00-17:30", "上午8：00-12：00，下午14：00-17：30", "8:00-12:00和14:00-17:30", "上午8:00—12:00、下午14:00—17:30"]],
        "source": "《心理咨询来访者须知》",
        "note": "",
    },
]

# ---------------------------------------------------------------- 主流程

def main():
    paras = docx_paragraphs(DOCX_CHOICE)
    choice_qs = parse_choice_bank(paras)

    errors = []
    # 校验
    counts = {}
    for q in choice_qs:
        counts[q["type"]] = counts.get(q["type"], 0) + 1
        if not q["stem"]:
            errors.append(f"空题干: {q}")
        if q["type"] != "judge" and not q["options"]:
            errors.append(f"无选项: {q['stem'][:30]}")
        if not q["answer"]:
            errors.append(f"无答案: {q['stem'][:30]}")
        for a in q["answer"]:
            letters = [o[0] for o in q["options"]]
            if q["type"] == "judge":
                letters = ["A", "B"]
            if a not in letters:
                errors.append(f"答案{a}超出选项范围: {q['stem'][:30]}")

    print("选择题各题型数量:", counts, "总计:", len(choice_qs))
    if errors:
        print("!! 发现 %d 个问题:" % len(errors))
        for e in errors[:30]:
            print("  -", e)

    # 生成最终数据
    all_qs = []
    for i, q in enumerate(choice_qs):
        all_qs.append({
            "id": i + 1,
            "type": q["type"],  # single / multi / judge
            "stem": q["stem"],
            "options": q["options"],
            "answer": q["answer"],
            "source": q["source"] or "学生手册",
            "category": categorize(q["source"]),
        })
    base = len(all_qs)
    for j, f in enumerate(FILLIN):
        all_qs.append({
            "id": base + j + 1,
            "type": "fillin",
            "stem": f["stem"],
            "options": [],
            "answer": f["answers"],
            "source": f["source"],
            "note": f["note"],
            "category": categorize(f["source"]),
        })

    # 统计
    stat = {}
    for q in all_qs:
        stat[q["type"]] = stat.get(q["type"], 0) + 1
    print("最终题库:", stat, "总计:", len(all_qs))
    cats = {}
    for q in all_qs:
        cats[q["category"]] = cats.get(q["category"], 0) + 1
    print("章节分布:", json.dumps(cats, ensure_ascii=False, indent=1))

    payload = "var QUESTIONS = " + json.dumps(all_qs, ensure_ascii=False, separators=(",", ":")) + ";\n"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(payload, encoding="utf-8")
    print("已写入:", OUT, f"({OUT.stat().st_size/1024:.1f} KB)")

    if errors:
        sys.exit(1)

if __name__ == "__main__":
    main()
