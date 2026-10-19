/* 新生手册刷题 - 主应用 */
(function () {
  "use strict";

  /* ---------------- 基础工具 ---------------- */
  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var $$ = function (sel, el) { return Array.prototype.slice.call((el || document).querySelectorAll(sel)); };

  var LS_KEY = {
    wrong: "xscs_wrong_v1",
    stats: "xscs_stats_v1",
    session: "xscs_session_v1",
    filters: "xscs_filters_v1"
  };
  var QUIZ_SIZE = 20;
  var SCORE_PER_Q = 2;

  function lsGet(key, def) {
    try {
      var v = localStorage.getItem(key);
      return v === null ? def : JSON.parse(v);
    } catch (e) { return def; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 存储满等情况静默失败 */ }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
  }
  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.hidden = true; }, 1800);
  }
  function confirmDialog(title, text, okLabel, onOk) {
    var mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML =
      '<div class="modal"><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
      '<div class="btn-row"><button class="btn-cancel">取消</button>' +
      '<button class="btn-danger">' + esc(okLabel || "确定") + "</button></div></div>";
    document.body.appendChild(mask);
    $(".btn-cancel", mask).onclick = function () { mask.remove(); };
    $(".btn-danger", mask).onclick = function () { mask.remove(); onOk(); };
    mask.onclick = function (e) { if (e.target === mask) mask.remove(); };
  }

  /* ---------------- 题库 ---------------- */
  var QUESTIONS = window.QUESTIONS || [];
  var QMAP = {};
  QUESTIONS.forEach(function (q) { QMAP[q.id] = q; });

  var TYPE_NAME = { single: "单选题", multi: "多选题", judge: "判断题", fillin: "填空题" };
  var CATEGORIES = (function () {
    var seen = {}, list = [];
    QUESTIONS.forEach(function (q) {
      if (!seen[q.category]) { seen[q.category] = 0; list.push(q.category); }
      seen[q.category]++;
    });
    return list.map(function (c) { return { name: c, count: seen[c] }; }).sort(function (a, b) { return b.count - a.count; });
  })();

  /* 填空题空位数：题干中的（　）数量，兜底用答案数组长度 */
  function fillCount(q) {
    var m = q.stem.match(/（\s*）/g);
    if (m && m.length) return m.length;
    return q.answer.length;
  }

  /* ---------------- 填空判分：归一化比较 ---------------- */
  function normalizeText(s) {
    s = String(s == null ? "" : s);
    s = s.replace(/[\s\u3000\u00a0]+/g, "");               // 去空白
    s = s.replace(/[\uff01-\uff5e]/g, function (ch) {      // 全角可见字符 → 半角
      return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
    });
    s = s.replace(/\u3000/g, "");
    s = s.toLowerCase();
    s = s.replace(/[。，、；：?!“”"‘’'（）()]+$/g, "");      // 去尾部标点
    s = s.replace(/^[。，、；：?!“”"‘’'（）()]+/g, "");
    s = s.replace(/[·•]/g, "");
    return s;
  }
  function fillBlankOk(q, blankIdx, input) {
    var accepts = q.answer[blankIdx] || [];
    var norm = normalizeText(input);
    if (!norm) return false;
    for (var i = 0; i < accepts.length; i++) {
      if (normalizeText(accepts[i]) === norm) return true;
    }
    return false;
  }

  /* ---------------- 判分 ---------------- */
  function gradeAnswer(q, ans) {
    // 返回 true/false；ans: 单选/判断为字母，多选为字母数组，填空为字符串数组
    if (ans === undefined || ans === null) return false;
    if (q.type === "single" || q.type === "judge") return ans === q.answer[0];
    if (q.type === "multi") {
      if (!Array.isArray(ans) || !ans.length) return false;
      var a = ans.slice().sort().join(",");
      return a === q.answer.slice().sort().join(",");
    }
    if (q.type === "fillin") {
      if (!Array.isArray(ans)) return false;
      for (var i = 0; i < q.answer.length; i++) {
        if (!fillBlankOk(q, i, ans[i])) return false;
      }
      return true;
    }
    return false;
  }
  function isAnswered(q, ans) {
    if (ans === undefined || ans === null) return false;
    if (q.type === "single" || q.type === "judge") return !!ans;
    if (q.type === "multi") return Array.isArray(ans) && ans.length > 0;
    if (q.type === "fillin") {
      return Array.isArray(ans) && ans.some(function (s) { return String(s || "").trim() !== ""; });
    }
    return false;
  }

  /* 答案展示文本 */
  function answerText(q, ans) {
    if (ans === undefined || ans === null) return "未作答";
    if (q.type === "single" || q.type === "judge") {
      var opt = optionOf(q, ans);
      return ans + (opt ? ". " + opt : "");
    }
    if (q.type === "multi") {
      if (!Array.isArray(ans) || !ans.length) return "未作答";
      return ans.slice().sort().map(function (l) {
        var o = optionOf(q, l);
        return l + (o ? ". " + o : "");
      }).join("　");
    }
    if (q.type === "fillin") {
      if (!Array.isArray(ans)) return "未作答";
      return ans.map(function (s, i) {
        return "空" + (i + 1) + "：" + (String(s || "").trim() || "（空）");
      }).join("；");
    }
    return String(ans);
  }
  function correctText(q) {
    if (q.type === "single" || q.type === "judge") {
      var opt = optionOf(q, q.answer[0]);
      return q.answer[0] + (opt ? ". " + opt : "");
    }
    if (q.type === "multi") {
      return q.answer.map(function (l) {
        var o = optionOf(q, l);
        return l + (o ? ". " + o : "");
      }).join("　");
    }
    if (q.type === "fillin") {
      return q.answer.map(function (accepts, i) {
        return "空" + (i + 1) + "：" + accepts[0];
      }).join("；");
    }
    return "";
  }
  function optionOf(q, letter) {
    for (var i = 0; i < q.options.length; i++) {
      if (q.options[i][0] === letter) return q.options[i][1];
    }
    return "";
  }

  /* ---------------- 持久化状态 ---------------- */
  function getWrong() { return lsGet(LS_KEY.wrong, {}); }
  function setWrong(w) { lsSet(LS_KEY.wrong, w); }
  function getStats() { return lsGet(LS_KEY.stats, { quizzes: 0, answered: 0, correct: 0 }); }
  function addStats(answered, correct) {
    var s = getStats();
    s.quizzes += 1; s.answered += answered; s.correct += correct;
    lsSet(LS_KEY.stats, s);
  }

  /* 错题入册 */
  function recordWrong(qids, answers) {
    var w = getWrong();
    qids.forEach(function (qid) {
      var item = w[qid] || { count: 0, lastAnswer: null, time: 0 };
      item.count += 1;
      item.lastAnswer = answers[qid];
      item.time = Date.now();
      w[qid] = item;
    });
    setWrong(w);
  }
  /* 答对移出错题集 */
  function removeWrong(qid) {
    var w = getWrong();
    if (w[qid]) { delete w[qid]; setWrong(w); }
  }

  /* ---------------- 会话 ---------------- */
  var session = null;   // {mode, qids, idx, answers, start, filters, submitted, wpFeedback}
  var timerHandle = null;

  function saveSession() { if (session) lsSet(LS_KEY.session, session); else localStorage.removeItem(LS_KEY.session); }
  function loadSession() {
    var s = lsGet(LS_KEY.session, null);
    if (s && s.qids && s.qids.length && !s.submitted) {
      // 校验题目仍存在
      var ok = s.qids.every(function (id) { return !!QMAP[id]; });
      if (ok) return s;
    }
    return null;
  }

  /* ---------------- 视图框架 ---------------- */
  var app = $("#app");

  function renderTopbar(title, backFn, rightHtml) {
    return '<div class="topbar">' +
      (backFn ? '<button class="btn-ghost" data-act="back">‹ 返回</button>' : "") +
      '<div class="title">' + esc(title) + "</div>" +
      (rightHtml || "") + "</div>";
  }

  /* ================= 首页 ================= */
  function renderHome() {
    stopTimer();
    session = null; saveSession();

    var stats = getStats();
    var wrong = getWrong();
    var rate = stats.answered ? Math.round(stats.correct / stats.answered * 100) : 0;
    var filters = lsGet(LS_KEY.filters, { types: ["single", "multi", "judge", "fillin"], cats: [] });
    if (!filters.types || !filters.types.length) filters.types = ["single", "multi", "judge", "fillin"];

    var typeCounts = {};
    QUESTIONS.forEach(function (q) { typeCounts[q.type] = (typeCounts[q.type] || 0) + 1; });

    var typeChips = ["single", "multi", "judge", "fillin"].map(function (t) {
      var on = filters.types.indexOf(t) >= 0;
      return '<button class="chip ' + (on ? "on" : "") + '" data-type="' + t + '">' +
        "<b>" + (typeCounts[t] || 0) + "</b>" + TYPE_NAME[t] + "</button>";
    }).join("");

    var catChips = '<button class="chip mini ' + (filters.cats.length === 0 ? "on" : "") + '" data-cat="__all">全部章节</button>' +
      CATEGORIES.map(function (c) {
        var on = filters.cats.indexOf(c.name) >= 0;
        return '<button class="chip mini ' + (on ? "on" : "") + '" data-cat="' + esc(c.name) + '">' +
          esc(c.name) + " " + c.count + "</button>";
      }).join("");

    app.innerHTML =
      '<div class="page">' +
      '<div class="hero"><h1>新生手册刷题</h1>' +
      "<p>中国石油大学（华东）· 共 " + QUESTIONS.length + " 道题 · 每次随机 20 题</p>" +
      '<div class="total"><b>' + QUESTIONS.length + "</b><span>道题目收录题库</span></div></div>" +

      '<button class="wrong-entry" data-act="wrongbook">' +
      '<div class="icon">✕</div><div class="info"><b>我的错题集</b>' +
      "<span>" + (Object.keys(wrong).length ? "共 " + Object.keys(wrong).length + " 道错题，点击进入重练" : "暂无错题，练习后错题会自动加入") + "</span></div>" +
      '<div class="arrow">›</div></button>' +

      '<div class="stat-grid">' +
      '<div class="stat-cell"><b>' + stats.quizzes + "</b><span>完成练习</span></div>" +
      '<div class="stat-cell"><b>' + stats.answered + "</b><span>累计做题</span></div>" +
      '<div class="stat-cell"><b>' + rate + '%</b><span>总正确率</span></div>' +
      "</div>" +

      '<div class="card"><div class="section-title">题型 <span class="hint">点击切换</span></div>' +
      '<div class="chip-grid type-grid">' + typeChips + "</div></div>" +

      '<div class="card"><div class="section-title">章节 <span class="hint" data-act="cat-toggle">' +
      (filters.cats.length ? "已选 " + filters.cats.length + " 章" : "默认全部") +
      '</span></div><div class="chip-grid">' + catChips + "</div></div>" +

      '<button class="btn-main" data-act="start">开始练习（随机 20 题）</button>' +
      '<p style="text-align:center;color:var(--text-sub);font-size:12px;margin-top:10px">错题会自动加入错题集 · 答题进度本地保存，刷新不丢失</p>' +
      "</div>";

    // 题型切换
    $$("[data-type]", app).forEach(function (btn) {
      btn.onclick = function () {
        var t = btn.getAttribute("data-type");
        var idx = filters.types.indexOf(t);
        if (idx >= 0) {
          if (filters.types.length === 1) { toast("至少保留一种题型"); return; }
          filters.types.splice(idx, 1);
        } else filters.types.push(t);
        lsSet(LS_KEY.filters, filters);
        renderHome();
      };
    });
    // 章节切换
    $$("[data-cat]", app).forEach(function (btn) {
      btn.onclick = function () {
        var c = btn.getAttribute("data-cat");
        if (c === "__all") filters.cats = [];
        else {
          var idx = filters.cats.indexOf(c);
          if (idx >= 0) filters.cats.splice(idx, 1);
          else filters.cats.push(c);
        }
        lsSet(LS_KEY.filters, filters);
        renderHome();
      };
    });
    $("[data-act=start]", app).onclick = startExam;
    $("[data-act=wrongbook]", app).onclick = renderWrongbook;
  }

  function poolFromFilters() {
    var filters = lsGet(LS_KEY.filters, { types: ["single", "multi", "judge", "fillin"], cats: [] });
    return QUESTIONS.filter(function (q) {
      if (filters.types.indexOf(q.type) < 0) return false;
      if (filters.cats.length && filters.cats.indexOf(q.category) < 0) return false;
      return true;
    });
  }

  /* ================= 开始练习 ================= */
  function startExam() {
    var pool = poolFromFilters();
    if (!pool.length) { toast("筛选条件下没有题目，请调整筛选"); return; }
    var picks = shuffle(pool).slice(0, QUIZ_SIZE);
    session = {
      mode: "exam",
      qids: picks.map(function (q) { return q.id; }),
      idx: 0,
      answers: {},
      start: Date.now(),
      submitted: false,
      wpFeedback: null
    };
    saveSession();
    renderQuiz();
  }

  /* ================= 答题页 ================= */
  function renderQuiz() {
    var s = session;
    var q = QMAP[s.qids[s.idx]];
    var total = s.qids.length;
    var answeredCount = s.qids.filter(function (id) { return isAnswered(QMAP[id], s.answers[id]); }).length;

    // 答题卡
    var cardHtml = s.qids.map(function (id, i) {
      var cls = ["anscard-btn"];
      if (isAnswered(QMAP[id], s.answers[id])) cls.push("answered");
      if (i === s.idx) cls.push("current");
      return '<button class="' + cls.join(" ") + '" data-jump="' + i + '">' + (i + 1) + "</button>";
    }).join("");

    app.innerHTML =
      '<div class="topbar quiz-top">' +
      '<div class="meta"><div class="no">第 <b>' + (s.idx + 1) + "</b>/" + total + " 题</div>" +
      '<div class="timer" data-timer>00:00</div></div>' +
      '<button class="quit" data-act="quit">退出</button>' +
      "</div>" +
      '<div class="anscard">' + cardHtml + "</div>" +
      '<div class="page"><div class="card qcard" data-qcard></div>' +
      '<div class="quiz-nav">' +
      '<button data-nav="prev"' + (s.idx === 0 ? " disabled" : "") + ">上一题</button>" +
      (s.idx === total - 1
        ? '<button class="primary" data-nav="submit">交卷</button>'
        : '<button class="primary" data-nav="next">下一题</button>') +
      "</div>" +
      '<p style="text-align:center;color:var(--text-sub);font-size:12px;margin-top:8px">已答 ' + answeredCount + "/" + total + "</p>" +
      "</div>";

    renderQuestionCard(q, s.answers[q.id], false);

    $$("[data-jump]", app).forEach(function (b) {
      b.onclick = function () { session.idx = +b.getAttribute("data-jump"); saveSession(); renderQuiz(); };
    });
    $("[data-nav=prev]", app).onclick = function () { session.idx--; saveSession(); renderQuiz(); };
    var nextBtn = $("[data-nav=next]", app);
    if (nextBtn) nextBtn.onclick = function () { session.idx++; saveSession(); renderQuiz(); };
    var subBtn = $("[data-nav=submit]", app);
    if (subBtn) subBtn.onclick = trySubmitExam;
    $("[data-act=quit]", app).onclick = function () {
      confirmDialog("退出练习", "退出后本次答题记录将不作数，确定退出吗？", "退出", function () {
        renderHome();
      });
    };

    startTimer();
  }

  /* 渲染单题卡片。review=true 时为错题重练的已批改状态展示 */
  function renderQuestionCard(q, ans, locked) {
    var box = $("[data-qcard]", app);
    var html = '<div class="qhead">' +
      '<span class="badge type">' + TYPE_NAME[q.type] + "</span>" +
      '<span class="badge cat">' + esc(q.category) + "</span></div>" +
      '<div class="stem">' + esc(q.stem) + "</div>";

    if (q.note) html += '<div class="note">📌 ' + esc(q.note) + "</div>";

    if (q.type === "judge") {
      html += '<div class="judge-btns">' +
        '<button class="opt' + (ans === "A" ? " on" : "") + '" data-pick="A">对</button>' +
        '<button class="opt' + (ans === "B" ? " on" : "") + '" data-pick="B">错</button>' +
        "</div>";
    } else if (q.type === "fillin") {
      var n = fillCount(q);
      var vals = Array.isArray(ans) ? ans : [];
      html += '<div class="fills">';
      for (var i = 0; i < n; i++) {
        html += '<div class="fill-item"><label>第' + (i + 1) + '空</label>' +
          '<input type="text" data-fill="' + i + '" value="' + esc(vals[i] || "") + '" placeholder="输入答案" autocomplete="off"></div>';
      }
      html += "</div>";
    } else {
      html += '<div class="opts">';
      q.options.forEach(function (opt) {
        var letter = opt[0];
        var on = q.type === "multi"
          ? (Array.isArray(ans) && ans.indexOf(letter) >= 0)
          : ans === letter;
        html += '<button class="opt' + (on ? " on" : "") + '" data-pick="' + letter + '">' +
          '<span class="letter">' + letter + "</span><span>" + esc(opt[1]) + "</span></button>";
      });
      html += "</div>";
      if (q.type === "multi") html += '<p style="margin-top:8px;font-size:12px;color:var(--text-sub)">多选题：选出所有你认为正确的选项</p>';
    }

    box.innerHTML = html;

    // 交互
    if (!locked) {
      $$("[data-pick]", box).forEach(function (btn) {
        btn.onclick = function () { pickOption(q, btn.getAttribute("data-pick")); };
      });
      $$("[data-fill]", box).forEach(function (input) {
        input.addEventListener("input", function () { fillInput(q, +input.getAttribute("data-fill"), input.value); });
      });
    }
  }

  function pickOption(q, letter) {
    var ans = session.answers[q.id];
    if (q.type === "single" || q.type === "judge") {
      ans = letter;
    } else if (q.type === "multi") {
      ans = Array.isArray(ans) ? ans.slice() : [];
      var i = ans.indexOf(letter);
      if (i >= 0) ans.splice(i, 1); else ans.push(letter);
    }
    session.answers[q.id] = ans;
    saveSession();
    if (session.mode === "wrong") renderWrongPractice();
    else renderQuiz();
  }
  function fillInput(q, idx, val) {
    var ans = Array.isArray(session.answers[q.id]) ? session.answers[q.id].slice() : [];
    while (ans.length < idx) ans.push("");
    ans[idx] = val;
    session.answers[q.id] = ans;
    saveSession();
    // 不整页重绘，避免输入被打断
  }

  /* 计时器 */
  function startTimer() {
    stopTimer();
    var el = $("[data-timer]", app);
    if (!el || !session) return;
    var tick = function () {
      if (!session || session.submitted) return;
      var sec = (Date.now() - session.start) / 1000;
      el.textContent = fmtTime(sec);
    };
    tick();
    timerHandle = setInterval(tick, 1000);
  }
  function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } }

  /* ================= 交卷与结果 ================= */
  function trySubmitExam() {
    var s = session;
    var unanswered = s.qids.filter(function (id) { return !isAnswered(QMAP[id], s.answers[id]); });
    var doSubmit = function () { submitExam(); };
    if (unanswered.length) {
      confirmDialog("还有未答的题", "还有 " + unanswered.length + " 道题未作答，未答题按错误计入，确定交卷吗？", "交卷", doSubmit);
    } else {
      doSubmit();
    }
  }

  function submitExam() {
    var s = session;
    stopTimer();
    s.submitted = true;
    s.duration = Math.floor((Date.now() - s.start) / 1000);
    saveSession();
    renderResult();
  }

  function renderResult() {
    var s = session;
    var correctIds = [], wrongIds = [];
    var perQ = s.qids.map(function (id) {
      var q = QMAP[id];
      var ans = s.answers[id];
      var correct = gradeAnswer(q, ans);
      (correct ? correctIds : wrongIds).push(id);
      return { q: q, ans: ans, correct: correct };
    });
    var score = correctIds.length * SCORE_PER_Q;
    var totalScore = s.qids.length * SCORE_PER_Q;
    var pct = Math.round(correctIds.length / s.qids.length * 100);

    // 统计 + 错题入册
    addStats(s.qids.length, correctIds.length);
    if (wrongIds.length) recordWrong(wrongIds, s.answers);

    var ringP = Math.round(correctIds.length / s.qids.length * 100);

    var listHtml = perQ.map(function (item, i) {
      var q = item.q, cls = item.correct ? "right" : "wrong";
      var mark = item.correct ? "✓" : "✕";
      var detail = "";
      if (q.type === "fillin") {
        var n = fillCount(q);
        for (var b = 0; b < n; b++) {
          var uVal = Array.isArray(item.ans) ? (item.ans[b] || "") : "";
          var ok = item.correct ? true : fillBlankOk(q, b, uVal);
          detail += '<div class="row"><span class="k">空' + (b + 1) + "：</span>" +
            '<span class="v ' + (ok ? "ans" : "you-bad") + '">' + esc(uVal || "（未填）") + "</span></div>";
          if (!ok) {
            detail += '<div class="row"><span class="k"></span><span class="v ans">应填：' + esc(q.answer[b][0]) + "</span></div>";
          }
        }
      } else {
        detail = '<div class="row"><span class="k">你的答案：</span><span class="v ' + (item.correct ? "ans" : "you-bad") + '">' + esc(answerText(q, item.ans)) + "</span></div>";
        if (!item.correct) {
          detail += '<div class="row"><span class="k">正确答案：</span><span class="v ans">' + esc(correctText(q)) + "</span></div>";
        }
      }
      detail += '<div class="row"><span class="k">依据：</span><span class="v src">' + esc(q.source) + "</span></div>";

      return '<div class="r-item ' + cls + '">' +
        '<div class="qline"><span class="mark">' + mark + '</span><div class="stem">' +
        (i + 1) + ". " + esc(q.stem) + "</div></div>" +
        '<div class="r-detail">' + detail + "</div></div>";
    }).join("");

    app.innerHTML =
      renderTopbar("练习结果") +
      '<div class="page">' +
      '<div class="card score-card">' +
      '<div class="score-ring" style="--p:' + ringP + '%"><div class="val">' + score + '<small> / ' + totalScore + " 分</small></div><div class=\"lab\">正确率 " + pct + '%</div></div>' +
      '<div class="sub"><b>' + correctIds.length + "</b> 题正确<span class=\"sep\">|</span><b>" + wrongIds.length + "</b> 题错误<span class=\"sep\">|</span>用时 <b>" + fmtTime(s.duration || 0) + "</b></div>" +
      (wrongIds.length
        ? '<div class="sub" style="margin-top:4px;color:var(--red)">' + wrongIds.length + " 道错题已加入错题集</div>"
        : '<div class="sub" style="margin-top:4px;color:var(--green)">太棒了，全对！🎉</div>') +
      "</div>" +
      '<div class="btn-row" style="margin-bottom:14px">' +
      (wrongIds.length ? '<button class="btn-sub" data-act="redo-wrong">错题重练</button>' : "") +
      '<button class="btn-sub" data-act="again">再来一套</button>' +
      "</div>" +
      '<div class="card">' + listHtml + "</div>" +
      '<div style="height:12px"></div>' +
      '<button class="btn-main" data-act="home">返回首页</button>' +
      "</div>";

    bindBack(renderHome);
    var redo = $("[data-act=redo-wrong]", app);
    if (redo) redo.onclick = function () { startWrongPractice(wrongIds); };
    $("[data-act=again]", app).onclick = function () { startExam(); };
    $("[data-act=home]", app).onclick = renderHome;
  }

  /* ================= 错题集 ================= */
  function renderWrongbook() {
    stopTimer();
    session = null; saveSession();
    var wrong = getWrong();
    var entries = Object.keys(wrong).map(function (id) {
      return { q: QMAP[+id], item: wrong[id] };
    }).filter(function (e) { return e.q; })
      .sort(function (a, b) { return b.item.time - a.item.time; });

    var listHtml;
    if (!entries.length) {
      listHtml = '<div class="empty"><div class="big">🎉</div>错题集是空的<br>去练习吧，错题会自动收录到这里</div>';
    } else {
      listHtml = entries.map(function (e) {
        var q = e.q;
        var optsMini = (q.type === "fillin") ? "" :
          '<div class="opts-mini">' + q.options.map(function (o) {
            var isAns = q.answer.indexOf(o[0]) >= 0;
            return '<div class="' + (isAns ? "is-ans" : "") + '">' + o[0] + ". " + esc(o[1]) + "</div>";
          }).join("") + "</div>";
        return '<div class="w-item" data-wid="' + q.id + '">' +
          '<div class="head">' +
          '<span class="badge type">' + TYPE_NAME[q.type] + "</span>" +
          '<span class="stem-s">' + esc(q.stem) + "</span>" +
          '<span class="cnt">错 ' + e.item.count + " 次</span>" +
          '<button class="del" data-wdel="' + q.id + '" title="移出">×</button>' +
          "</div>" +
          '<div class="body"><div class="stem-full">' + esc(q.stem) + "</div>" +
          optsMini +
          '<div class="r-detail"><div class="row"><span class="k">正确答案：</span><span class="v ans">' + esc(correctText(q)) + "</span></div>" +
          (q.type === "fillin" && q.note ? '<div class="row"><span class="k">备注：</span><span class="v src">' + esc(q.note) + "</span></div>" : "") +
          '<div class="row"><span class="k">依据：</span><span class="v src">' + esc(q.source) + "</span></div></div></div>" +
          "</div>";
      }).join("");
    }

    app.innerHTML =
      renderTopbar("我的错题集", true) +
      '<div class="page">' +
      '<div class="btn-row" style="margin-bottom:14px">' +
      '<button class="btn-main" data-act="practice" ' + (entries.length ? "" : "disabled") + ">错题重练（即时批改）</button>" +
      "</div>" +
      (entries.length
        ? '<div style="text-align:right;margin-bottom:6px"><button class="link-btn" data-act="clear">清空错题集</button></div>'
        : "") +
      '<div class="card">' + listHtml + "</div>" +
      "</div>";

    bindBack(renderHome);
    $("[data-act=practice]", app).onclick = function () {
      startWrongPractice(entries.map(function (e) { return e.q.id; }));
    };
    var clearBtn = $("[data-act=clear]", app);
    if (clearBtn) clearBtn.onclick = function () {
      confirmDialog("清空错题集", "将删除全部 " + entries.length + " 道错题记录，此操作不可恢复。", "清空", function () {
        setWrong({});
        toast("已清空");
        renderWrongbook();
      });
    };
    // 展开收起
    $$("[data-wid]", app).forEach(function (item) {
      $(".head", item).onclick = function (e) {
        if (e.target.closest("[data-wdel]")) return;
        item.classList.toggle("open");
      };
    });
    $$("[data-wdel]", app).forEach(function (btn) {
      btn.onclick = function () {
        var id = +btn.getAttribute("data-wdel");
        confirmDialog("移出错题", "确定把这道题移出错题集吗？", "移出", function () {
          removeWrong(id);
          toast("已移出");
          renderWrongbook();
        });
      };
    });
  }

  /* ================= 错题重练（即时反馈） ================= */
  function startWrongPractice(qids) {
    if (!qids.length) { toast("没有可重练的错题"); return; }
    session = {
      mode: "wrong",
      qids: shuffle(qids),
      idx: 0,
      answers: {},
      start: Date.now(),
      submitted: false,
      wpFeedback: null
    };
    saveSession();
    renderWrongPractice();
  }

  function renderWrongPractice() {
    var s = session;
    if (s.idx >= s.qids.length) { renderWrongPracticeSummary(); return; }
    var q = QMAP[s.qids[s.idx]];
    var total = s.qids.length;
    var fb = s.wpFeedback && s.wpFeedback.qid === q.id ? s.wpFeedback : null;
    var ans = s.answers[q.id];

    app.innerHTML =
      '<div class="topbar quiz-top">' +
      '<div class="meta"><div class="no">错题重练 <b>' + (s.idx + 1) + "</b>/" + total + "</div></div>" +
      '<button class="quit" data-act="quit">退出</button>' +
      "</div>" +
      '<div class="page"><div class="card qcard" data-qcard></div>' +
      '<div class="quiz-nav">' +
      (fb
        ? '<button class="primary" data-nav="wp-next">' + (s.idx === total - 1 ? "查看总结" : "下一题") + "</button>"
        : '<button class="primary" data-nav="wp-submit" ' + (isAnswered(q, ans) ? "" : "disabled") + ">提交本题</button>") +
      "</div></div>";

    renderQuestionCard(q, ans, !!fb);

    // 已批改时给选项/输入框上色
    if (fb) applyReviewStyle(q, ans, fb);

    // 批改反馈面板
    if (fb) {
      var detail = fb.correct
        ? "<b>回答正确 ✓</b><div class=\"why\">已自动移出错题集</div>"
        : "<b>回答错误 ✕</b><div class=\"why\">正确答案：<em>" + esc(correctText(q)) + "</em>" +
          (q.type === "fillin" && q.note ? "<br>备注：<em>" + esc(q.note) + "</em>" : "") +
          "<br>依据：<em>" + esc(q.source) + "</em></div>";
      var panel = document.createElement("div");
      panel.className = "feedback " + (fb.correct ? "good" : "bad");
      panel.innerHTML = detail;
      $(".quiz-nav", app).before(panel);
    }

    $("[data-act=quit]", app).onclick = function () {
      confirmDialog("退出重练", "退出后剩余错题保留在错题集中，确定退出吗？", "退出", renderWrongbook);
    };
    var sub = $("[data-nav=wp-submit]", app);
    if (sub) sub.onclick = wpSubmit;
    var nx = $("[data-nav=wp-next]", app);
    if (nx) nx.onclick = function () {
      session.wpFeedback = null;
      session.idx++;
      saveSession();
      renderWrongPractice();
    };
  }

  function wpSubmit() {
    var s = session;
    var q = QMAP[s.qids[s.idx]];
    var ans = s.answers[q.id];
    if (!isAnswered(q, ans)) { toast("请先作答"); return; }
    var correct = gradeAnswer(q, ans);
    session.wpFeedback = { qid: q.id, correct: correct };
    if (correct) {
      removeWrong(q.id);
      addStats(1, 1);
    } else {
      addStats(1, 0);
      // 错题次数+1
      var w = getWrong();
      if (w[q.id]) {
        w[q.id].count += 1; w[q.id].lastAnswer = ans; w[q.id].time = Date.now();
        setWrong(w);
      } else {
        recordWrong([q.id], s.answers);
      }
    }
    saveSession();
    renderWrongPractice();
    window.scrollTo(0, 0);
  }

  /* 批改后的选项着色 */
  function applyReviewStyle(q, ans, fb) {
    var box = $("[data-qcard]", app);
    if (q.type === "judge" || q.type === "single") {
      var right = q.answer[0];
      $$("[data-pick]", box).forEach(function (btn) {
        var l = btn.getAttribute("data-pick");
        if (l === right) btn.classList.add("correct");
        else if (l === ans) btn.classList.add("wrong");
      });
    } else if (q.type === "multi") {
      $$("[data-pick]", box).forEach(function (btn) {
        var l = btn.getAttribute("data-pick");
        var inAns = q.answer.indexOf(l) >= 0;
        var picked = Array.isArray(ans) && ans.indexOf(l) >= 0;
        if (inAns && !picked) btn.classList.add("correct");
        else if (picked && !inAns) btn.classList.add("wrong");
        else if (picked && inAns) btn.classList.add("correct");
      });
    } else if (q.type === "fillin") {
      var n = fillCount(q);
      for (var b = 0; b < n; b++) {
        var input = $('[data-fill="' + b + '"]', box);
        if (!input) continue;
        var v = Array.isArray(ans) ? (ans[b] || "") : "";
        if (fillBlankOk(q, b, v)) input.classList.add("ok");
        else {
          input.classList.add("bad");
          var std = document.createElement("div");
          std.className = "std";
          std.innerHTML = '<span style="color:var(--green)">应填：' + esc(q.answer[b][0]) + "</span>";
          input.closest(".fill-item").after(std);
        }
      }
      $$("[data-fill]", box).forEach(function (i) { i.disabled = true; });
    }
    $$("[data-pick]", box).forEach(function (btn) { btn.style.pointerEvents = "none"; });
  }

  function renderWrongPracticeSummary() {
    var s = session;
    var duration = Math.floor((Date.now() - s.start) / 1000);
    // 统计本次重练对错（从 answers 回算）
    var correct = 0;
    s.qids.forEach(function (id) {
      if (gradeAnswer(QMAP[id], s.answers[id])) correct++;
    });
    var wrong = s.qids.length - correct;
    app.innerHTML =
      renderTopbar("重练完成") +
      '<div class="page">' +
      '<div class="card score-card">' +
      '<div class="score-ring" style="--p:' + Math.round(correct / s.qids.length * 100) + '%">' +
      '<div class="val">' + correct + '<small> / ' + s.qids.length + " 题</small></div><div class=\"lab\">答对题数</div></div>" +
      '<div class="sub">用时 <b>' + fmtTime(duration) + "</b></div>" +
      (wrong
        ? '<div class="sub" style="margin-top:4px;color:var(--red)">还有 ' + wrong + " 道错题保留在错题集</div>"
        : '<div class="sub" style="margin-top:4px;color:var(--green)">全部消灭，错题集清空相关题目！🎉</div>') +
      "</div>" +
      '<div class="btn-row"><button class="btn-sub" data-act="book">返回错题集</button>' +
      '<button class="btn-sub" data-act="home">返回首页</button></div>' +
      "</div>";
    bindBack(renderWrongbook);
    $("[data-act=book]", app).onclick = renderWrongbook;
    $("[data-act=home]", app).onclick = renderHome;
  }

  /* ---------------- 通用返回 ---------------- */
  function bindBack(fn) {
    var b = $("[data-act=back]", app);
    if (b) b.onclick = fn;
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    var s = loadSession();
    if (s) {
      session = s;
      if (session.mode === "wrong") { renderWrongPractice(); return; }
      renderQuiz(); return;
    }
    renderHome();
  }
  boot();
})();
