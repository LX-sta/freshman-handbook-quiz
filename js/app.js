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
  var QUIZ_SIZES = [20, 50, 100];
  var SCORE_PER_Q = 2;
  var WRONG_NEED = 3;   // 错题需连续答对的次数才移出错题集

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
    s.answered += answered; s.correct += correct;
    lsSet(LS_KEY.stats, s);
  }
  function bumpQuizCount() {
    var s = getStats();
    s.quizzes += 1;
    lsSet(LS_KEY.stats, s);
  }

  /* 错题入册（答错）：新增或 count+1，连对计数清零 */
  function recordWrong(qids, answers) {
    var w = getWrong();
    qids.forEach(function (qid) {
      var item = w[qid] || { count: 0, okStreak: 0, lastAnswer: null, time: 0 };
      item.count += 1;
      item.okStreak = 0;
      item.lastAnswer = answers[qid];
      item.time = Date.now();
      w[qid] = item;
    });
    setWrong(w);
  }
  /* 答对：在错题集中则连对 +1，达到 WRONG_NEED 次移出。返回 {streak, removed} */
  function streakWrong(qid) {
    var w = getWrong();
    var item = w[qid];
    if (!item) return null;
    item.okStreak = (item.okStreak || 0) + 1;
    item.time = Date.now();
    var removed = item.okStreak >= WRONG_NEED;
    if (removed) delete w[qid]; else w[qid] = item;
    setWrong(w);
    return { streak: Math.min(item.okStreak, WRONG_NEED), removed: removed };
  }
  /* 手动移出错题集 */
  function removeWrong(qid) {
    var w = getWrong();
    if (w[qid]) { delete w[qid]; setWrong(w); }
  }

  /* ---------------- 会话 ---------------- */
  var session = null;   // {mode, qids, idx, answers, start, submitted, fb}
  var timerHandle = null;

  function saveSession() { if (session) lsSet(LS_KEY.session, session); else localStorage.removeItem(LS_KEY.session); }
  function loadSession() {
    var s = lsGet(LS_KEY.session, null);
    if (s && s.qids && s.qids.length && !s.submitted) {
      // 校验题目仍存在；旧版会话无逐题批改状态，直接作废
      var ok = s.qids.every(function (id) { return !!QMAP[id]; }) && s.fb !== undefined;
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
    var filters = lsGet(LS_KEY.filters, { types: ["single", "multi", "judge", "fillin"], cats: [], size: 20 });
    if (!filters.types || !filters.types.length) filters.types = ["single", "multi", "judge", "fillin"];
    if (QUIZ_SIZES.indexOf(filters.size) < 0) filters.size = 20;
    var poolSize = poolFromFilters().length;

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

    var sizeChips = QUIZ_SIZES.map(function (n) {
      var on = filters.size === n;
      var short = poolSize < n && poolSize > 0;
      return '<button class="chip' + (on ? " on" : "") + '" data-size="' + n + '">' +
        "<b>" + (short ? poolSize : n) + "</b>" + n + " 题" + (short ? "（不足）" : "") + "</button>";
    }).join("");

    app.innerHTML =
      '<div class="page">' +
      '<div class="hero"><h1>新生手册刷题</h1>' +
      "<p>中国石油大学（华东）· 共 " + QUESTIONS.length + " 道题 · 每次随机 " + filters.size + " 题</p>" +
      '<div class="total"><b>' + QUESTIONS.length + "</b><span>道题目收录题库</span></div></div>" +

      '<button class="wrong-entry" data-act="wrongbook">' +
      '<div class="icon">✕</div><div class="info"><b>我的错题集</b>' +
      "<span>" + (Object.keys(wrong).length ? "共 " + Object.keys(wrong).length + " 道错题，连对 " + WRONG_NEED + " 次自动移出" : "暂无错题，练习后错题会自动加入") + "</span></div>" +
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

      '<div class="card"><div class="section-title">每次题数 <span class="hint">答一题判一题</span></div>' +
      '<div class="chip-grid type-grid">' + sizeChips + "</div></div>" +

      '<button class="btn-main" data-act="start">开始练习（随机 ' +
      (poolSize < filters.size && poolSize > 0 ? poolSize : filters.size) + " 题）</button>" +
      '<p style="text-align:center;color:var(--text-sub);font-size:12px;margin-top:10px">每答一题立即判对错 · 错题连对 ' + WRONG_NEED + ' 次自动移出错题集 · 进度本地保存</p>' +
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
    // 题数切换（单选）
    $$("[data-size]", app).forEach(function (btn) {
      btn.onclick = function () {
        filters.size = +btn.getAttribute("data-size");
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
    var filters = lsGet(LS_KEY.filters, { types: ["single", "multi", "judge", "fillin"], cats: [], size: 20 });
    var want = QUIZ_SIZES.indexOf(filters.size) >= 0 ? filters.size : 20;
    var picks = shuffle(pool).slice(0, want);
    if (picks.length < want) toast("筛选范围内仅有 " + pool.length + " 道题，本次全部练习");
    session = {
      mode: "exam",
      qids: picks.map(function (q) { return q.id; }),
      idx: 0,
      answers: {},
      start: Date.now(),
      submitted: false,
      fb: null
    };
    saveSession();
    renderPractice();
  }

  /* ================= 答题页（练习/错题重练 共用，逐题即时批改） ================= */
  function renderPractice() {
    var s = session;
    if (s.idx >= s.qids.length) {
      stopTimer();
      if (s.mode === "wrong") { renderWrongPracticeSummary(); return; }
      s.submitted = true;
      s.duration = Math.floor((Date.now() - s.start) / 1000);
      bumpQuizCount();
      saveSession();
      renderResult();
      return;
    }
    var q = QMAP[s.qids[s.idx]];
    var total = s.qids.length;
    var isW = s.mode === "wrong";
    var fb = s.fb && s.fb.qid === q.id ? s.fb : null;
    var ans = s.answers[q.id];

    app.innerHTML =
      '<div class="topbar quiz-top">' +
      '<div class="meta"><div class="no">' +
      (isW ? "错题重练 <b>" + (s.idx + 1) + "</b>/" + total
           : "第 <b>" + (s.idx + 1) + "</b>/" + total + " 题") +
      '</div><div class="timer" data-timer>00:00</div></div>' +
      '<button class="quit" data-act="quit">退出</button>' +
      "</div>" +
      '<div class="page"><div class="card qcard" data-qcard></div>' +
      '<div class="quiz-nav">' +
      (fb
        ? '<button class="primary" data-nav="next">' +
          (s.idx === total - 1 ? (isW ? "查看总结" : "查看结果") : "下一题") + "</button>"
        : ((q.type === "multi" || q.type === "fillin")
            ? '<button class="primary" data-nav="submit" ' +
              (isAnswered(q, ans) ? "" : "disabled") + ">提交本题</button>"
            : "")) +
      "</div></div>";

    renderQuestionCard(q, ans, !!fb);

    // 已批改：选项/输入框着色 + 反馈面板
    if (fb) {
      applyReviewStyle(q, ans, fb);
      var extra = "";
      if (fb.book) {
        if (fb.correct) {
          extra = fb.removed
            ? "已连对 " + WRONG_NEED + "/" + WRONG_NEED + " 次，移出错题集"
            : "已连对 " + fb.streak + "/" + WRONG_NEED + " 次，再连对 " + (WRONG_NEED - fb.streak) + " 次自动移出";
        } else {
          extra = "连对计数已清零，错误次数 +1，保留在错题集";
        }
      } else if (!fb.correct) {
        extra = "已加入错题集";
      }
      var detail = (fb.correct
        ? "<b>回答正确 ✓</b>"
        : "<b>回答错误 ✕</b><div class=\"why\">正确答案：<em>" + esc(correctText(q)) + "</em>" +
          (q.type === "fillin" && q.note ? "<br>备注：<em>" + esc(q.note) + "</em>" : "") +
          "<br>依据：<em>" + esc(q.source) + "</em></div>") +
        (extra ? '<div class="why">' + esc(extra) + "</div>" : "");
      var panel = document.createElement("div");
      panel.className = "feedback " + (fb.correct ? "good" : "bad");
      panel.innerHTML = detail;
      $(".quiz-nav", app).before(panel);
    }

    $("[data-act=quit]", app).onclick = function () {
      confirmDialog("退出练习", "已作答的题目已完成即时批改，退出后未作答的题不再继续。确定退出吗？", "退出", function () {
        stopTimer();
        session = null; saveSession();
        if (isW) renderWrongbook(); else renderHome();
      });
    };
    var sub = $("[data-nav=submit]", app);
    if (sub) sub.onclick = gradeCurrent;
    var nx = $("[data-nav=next]", app);
    if (nx) nx.onclick = function () {
      session.fb = null;
      session.idx++;
      saveSession();
      renderPractice();
      window.scrollTo(0, 0);
    };

    startTimer();
  }

  /* 批改当前题：立即判对错并产生副作用（统计/错题集） */
  function gradeCurrent() {
    var s = session;
    var q = QMAP[s.qids[s.idx]];
    var ans = s.answers[q.id];
    if (!isAnswered(q, ans)) { toast("请先作答"); return; }
    var correct = gradeAnswer(q, ans);
    var fb = { qid: q.id, correct: correct };
    var w = getWrong();
    var inBook = !!w[q.id];
    fb.book = inBook;
    if (correct) {
      if (inBook) {
        var st = streakWrong(q.id);
        fb.streak = st.streak;
        fb.removed = st.removed;
      }
    } else {
      recordWrong([q.id], s.answers);
      if (inBook) fb.streak = 0;
    }
    s.fb = fb;
    addStats(1, correct ? 1 : 0);
    saveSession();
    renderPractice();
    window.scrollTo(0, 0);
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
    if (session.fb && session.fb.qid === q.id) return; // 已批改，锁定
    var ans = session.answers[q.id];
    if (q.type === "single" || q.type === "judge") {
      // 点选即批改
      session.answers[q.id] = letter;
      saveSession();
      gradeCurrent();
      return;
    }
    if (q.type === "multi") {
      ans = Array.isArray(ans) ? ans.slice() : [];
      var i = ans.indexOf(letter);
      if (i >= 0) ans.splice(i, 1); else ans.push(letter);
      session.answers[q.id] = ans;
      saveSession();
      renderPractice(); // 重绘以更新勾选与提交按钮状态
    }
  }
  function fillInput(q, idx, val) {
    var ans = Array.isArray(session.answers[q.id]) ? session.answers[q.id].slice() : [];
    while (ans.length < idx) ans.push("");
    ans[idx] = val;
    session.answers[q.id] = ans;
    saveSession();
    // 不整页重绘，避免输入被打断；只更新提交按钮可用状态
    var sub = $("[data-nav=submit]", app);
    if (sub) sub.disabled = !isAnswered(q, ans);
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

  /* ================= 结果页（逐题批改已完成，此处仅汇总展示） ================= */
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
        ? '<div class="sub" style="margin-top:4px;color:var(--red)">' + wrongIds.length + " 道答错，已加入错题集（连对 " + WRONG_NEED + " 次移出）</div>"
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
        var streak = e.item.okStreak || 0;
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
          (streak > 0 ? '<span class="cnt ok">连对 ' + streak + "/" + WRONG_NEED + "</span>" : "") +
          '<button class="del" data-wdel="' + q.id + '" title="移出">×</button>' +
          "</div>" +
          '<div class="body"><div class="stem-full">' + esc(q.stem) + "</div>" +
          optsMini +
          '<div class="r-detail"><div class="row"><span class="k">正确答案：</span><span class="v ans">' + esc(correctText(q)) + "</span></div>" +
          '<div class="row"><span class="k">掌握进度：</span><span class="v">已连对 ' + streak + "/" + WRONG_NEED + " 次，连对 " + WRONG_NEED + " 次自动移出</span></div>" +
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
      fb: null
    };
    saveSession();
    renderPractice();
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
    var remaining = Object.keys(getWrong()).length;
    app.innerHTML =
      renderTopbar("重练完成") +
      '<div class="page">' +
      '<div class="card score-card">' +
      '<div class="score-ring" style="--p:' + Math.round(correct / s.qids.length * 100) + '%">' +
      '<div class="val">' + correct + '<small> / ' + s.qids.length + " 题</small></div><div class=\"lab\">答对题数</div></div>" +
      '<div class="sub">用时 <b>' + fmtTime(duration) + "</b></div>" +
      (remaining
        ? '<div class="sub" style="margin-top:4px;color:var(--red)">' + remaining + " 道错题未连对 " + WRONG_NEED + " 次，保留在错题集</div>"
        : '<div class="sub" style="margin-top:4px;color:var(--green)">全部错题已连对 ' + WRONG_NEED + " 次，成功移出！🎉</div>") +
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
      renderPractice();
      return;
    }
    renderHome();
  }
  boot();
})();
