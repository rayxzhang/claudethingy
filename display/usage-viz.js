(function () {
  var mountedStamp = null;
  var DATA = null;

  var CELL = 15;
  var BAR_MIN = 2;
  var BAR_EMPTY = 2;
  var ROW_W = 452;
  var STAGE_W = 720;
  var LABEL_W = 54;
  var BEAT1 = 420;
  var SPREAD = 150;
  var BEAT2 = 560;

  function fmt(n) {
    n = +n || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e4) return Math.round(n / 1e3) + "K";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  }
  function money(c) {
    c = +c || 0;
    if (c >= 100) return "$" + c.toFixed(0);
    if (c >= 0.01) return "$" + c.toFixed(2);
    return c > 0 ? "<$0.01" : "$0.00";
  }
  function dateLabel(iso) {
    return new Date(iso + "T12:00:00").toLocaleDateString(undefined, {
      weekday: "short", month: "short", day: "numeric"
    });
  }
  function shortDate(iso) {
    return new Date(iso + "T12:00:00").toLocaleDateString(undefined, {
      month: "short", day: "numeric"
    });
  }
  function hourLabel(h) { return ((h % 12) || 12) + (h < 12 ? "am" : "pm"); }
  function tokens(d) { return (d.main || 0) + (d.sub || 0); }
  function metricValue(d, m) { return m === "cost" ? (d.cost || 0) : tokens(d); }
  function metricText(v, m) { return m === "cost" ? money(v) : fmt(v); }

  var EMPTY = {
    main: 0, sub: 0, sessions: 0, cost: 0, priced: false,
    tin: 0, tout: 0, tcc: 0, tcr: 0
  };
  function hourRec(iso, h) { return DATA.hours[iso + "|" + h] || EMPTY; }
  function hoursFor(iso) {
    var out = [];
    for (var h = 0; h < 24; h++) out.push(hourRec(iso, h));
    return out;
  }
  function dayRec(iso) {
    var i, d;
    for (i = 0; i < DATA.calendar.length; i++) {
      d = DATA.calendar[i];
      if (d.date === iso) return d;
    }
    for (i = 0; i < DATA.recent.length; i++) {
      d = DATA.recent[i];
      if (d.date === iso) return d;
    }
    return EMPTY;
  }

  function niceRound(v) {
    if (!(v > 0)) return 0;
    var e = Math.pow(10, Math.floor(Math.log10(v)));
    var m = v / e;
    return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * e;
  }

  function bucketer(values) {
    var nz = values.filter(function (v) { return v > 0; }).sort(function (a, b) { return a - b; });
    if (!nz.length) return { level: function () { return 0; }, cuts: [] };
    var lo = nz[0], hi = nz[nz.length - 1];
    var cuts;
    if (hi <= lo) {
      cuts = [lo, lo, lo];
    } else {
      var a = Math.log(lo), b = Math.log(hi);
      cuts = [1, 2, 3].map(function (i) { return niceRound(Math.exp(a + (b - a) * i / 4)); });
      if (!(cuts[0] < cuts[1] && cuts[1] < cuts[2])) {
        cuts = [1, 2, 3].map(function (i) { return Math.exp(a + (b - a) * i / 4); });
      }
    }
    return {
      cuts: cuts,
      level: function (v) {
        if (!v) return 0;
        if (v <= cuts[0]) return 1;
        if (v <= cuts[1]) return 2;
        if (v <= cuts[2]) return 3;
        return 4;
      }
    };
  }

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var SCOPES = ["hours", "days", "weeks"];

  var root = null;
  var state = {
    scope: "hours",
    metric: "cost",
    pace: 1
  };
  var naming = null;
  var collapsed = null;
  var entering = false;
  var anchorSet = null;
  var anchorOnly = false;
  var chromeInstant = false;
  var dayRowOffset = null;
  var calOffset = {};
  var busy = false;
  var queuedScope = null;

  function nm(kind, key) { return "z-" + kind + "-" + key; }

  function liveStage() {
    return root ? root.querySelector(".stage:not([data-shadow])") : null;
  }

  function rampColor(level) {
    var el = root || document.documentElement;
    return getComputedStyle(el).getPropertyValue(level ? "--lv" + level : "--lv0").trim();
  }
  function seriesColor(which) {
    return getComputedStyle(root).getPropertyValue(which === "sub" ? "--viz-sub" : "--viz-main").trim();
  }

  function cellInk(rec, level) {
    return rampColor(level);
  }

  function barSegsHtml(c) {
    var subShare = state.metric === "cost" ? 0 : c.sub / Math.max(1, tokens(c));
    return (subShare > 0.02 ? '<div class="bar-seg sub top" style="flex:' + subShare + '"></div>' : "") +
      '<div class="bar-seg' + (subShare > 0.02 ? "" : " top") + '" style="flex:' +
        (1 - subShare) + '"></div>';
  }

  function gridBucket() {
    var all = [];
    var i, h;
    for (i = 0; i < DATA.gridDays.length; i++) {
      for (h = 0; h < 24; h++) all.push(metricValue(hourRec(DATA.gridDays[i], h), state.metric));
    }
    return bucketer(all);
  }
  function calBucket() {
    return bucketer(DATA.calendar.map(function (d) { return metricValue(d, state.metric); }));
  }
  function hourCellColor(iso, h, buck) {
    var rec = hourRec(iso, h);
    return cellInk(rec, (buck || gridBucket()).level(metricValue(rec, state.metric)));
  }
  function dayCellColor(iso, buck) {
    var rec = dayRec(iso);
    return cellInk(rec, (buck || calBucket()).level(metricValue(rec, state.metric)));
  }
  function reduced() {
    return window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function paint() {
    return new Promise(function (r) {
      requestAnimationFrame(function () { requestAnimationFrame(r); });
    });
  }

  function animDone(a) {
    if (!a) return Promise.resolve();
    return new Promise(function (r) {
      var done = false;
      function fin() {
        if (done) return;
        done = true;
        r();
      }
      if (a.finished && typeof a.finished.then === "function") {
        a.finished.then(fin, fin);
      }
      a.onfinish = fin;
      a.oncancel = fin;
      setTimeout(fin, 1600);
    });
  }

  function settleAnim(a) {
    if (typeof a.commitStyles === "function") {
      try { a.commitStyles(); } catch (e) {}
    }
    try { a.cancel(); } catch (e) {}
  }

  function fromLimits() {
    var home = document.getElementById("screen-home");
    return !!(home && home.className.indexOf("page-limits") !== -1);
  }

  function collapseBeat(from, dur) {
    var d = (dur || BEAT1) * state.pace;
    var opts = { duration: d, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "forwards" };
    var anims = [];
    var stage = liveStage();
    stage.classList.add("beating");

    if (from === "hours") {
      var buck = gridBucket();
      var iso = DATA.today.date;
      var bars = stage.querySelector(".bars");
      if (bars) {
        anims.push(bars.animate(
          [{ width: bars.getBoundingClientRect().width + "px",
             marginLeft: "0px", columnGap: "5px" },
           { width: ROW_W + "px", marginLeft: LABEL_W + "px", columnGap: "4px" }], opts));
      }
      var bodies = stage.querySelectorAll(".bar-body");
      var bi;
      for (bi = 0; bi < bodies.length; bi++) {
        var body = bodies[bi];
        var h = +body.parentNode.dataset.h;
        var to = hourCellColor(iso, h, buck);
        anims.push(body.animate(
          [{ height: body.getBoundingClientRect().height + "px",
             padding: "0px", margin: "0px" },
           { height: CELL + "px", padding: "2px", margin: "-2px" }], opts));
        var segs = body.querySelectorAll(".bar-seg");
        var si;
        for (si = 0; si < segs.length; si++) {
          var seg = segs[si];
          anims.push(seg.animate(
            [{ backgroundColor: getComputedStyle(seg).backgroundColor,
               borderRadius: getComputedStyle(seg).borderRadius },
             { backgroundColor: to, borderRadius: "3px" }], opts));
        }
      }
    } else {
      var buck2 = calBucket();
      var cols = stage.querySelectorAll(".row-collapse");
      var ci;
      for (ci = 0; ci < cols.length; ci++) {
        var col = cols[ci];
        var toDay = dayCellColor(col.dataset.iso, buck2);
        anims.push(col.animate([{ width: ROW_W + "px" }, { width: CELL + "px" }], opts));
        var cells = col.querySelectorAll(".cell");
        var ki;
        for (ki = 0; ki < cells.length; ki++) {
          var cell = cells[ki];
          if (cell.classList.contains("l0")) continue;
          anims.push(cell.animate(
            [{ backgroundColor: getComputedStyle(cell).backgroundColor },
             { backgroundColor: toDay }], opts));
        }
      }
    }
    return Promise.all(anims.map(animDone));
  }

  function expandBeat(to, dur) {
    var d = (dur || BEAT1) * state.pace;
    var opts = { duration: d, easing: "cubic-bezier(0, 0, 0.2, 1)", fill: "both" };
    var anims = [];
    var stage = liveStage();

    if (to === "hours") {
      var bars = stage.querySelector(".bars");
      if (bars) {
        anims.push(bars.animate(
          [{ width: ROW_W + "px", marginLeft: LABEL_W + "px", columnGap: "4px" },
           { width: STAGE_W + "px", marginLeft: "0px", columnGap: "5px" }], opts));
      }
      var bodies = stage.querySelectorAll(".bar-body");
      var bi;
      for (bi = 0; bi < bodies.length; bi++) {
        var body = bodies[bi];
        var target = +body.dataset.h || BAR_EMPTY;
        anims.push(body.animate(
          [{ height: CELL + "px", padding: "2px", margin: "-2px" },
           { height: target + "px", padding: "0px", margin: "0px" }], opts));
        var segs = body.querySelectorAll(".bar-seg");
        var si;
        for (si = 0; si < segs.length; si++) {
          var seg = segs[si];
          if (!seg.dataset.toColor) continue;
          anims.push(seg.animate(
            [{ backgroundColor: seg.dataset.fromColor },
             { backgroundColor: seg.dataset.toColor }], opts));
        }
      }
    } else {
      var cols = stage.querySelectorAll(".row-collapse");
      var ci;
      for (ci = 0; ci < cols.length; ci++) {
        var col = cols[ci];
        anims.push(col.animate([{ width: CELL + "px" }, { width: ROW_W + "px" }], opts));
        var cells = col.querySelectorAll(".cell");
        var ki;
        for (ki = 0; ki < cells.length; ki++) {
          var cell = cells[ki];
          if (!cell.dataset.toColor) continue;
          anims.push(cell.animate(
            [{ backgroundColor: cell.dataset.fromColor },
             { backgroundColor: cell.dataset.toColor }], opts));
        }
      }
    }
    Promise.all(anims.map(animDone)).then(function () {
      var ai, bi2, si2;
      for (ai = 0; ai < anims.length; ai++) settleAnim(anims[ai]);
      var bars2 = stage.querySelector(".bars");
      if (bars2) { bars2.style.width = ""; bars2.style.marginLeft = ""; bars2.style.columnGap = ""; }
      var bodies2 = stage.querySelectorAll(".bar-body");
      for (bi2 = 0; bi2 < bodies2.length; bi2++) {
        bodies2[bi2].style.padding = "";
        bodies2[bi2].style.margin = "";
      }
      var segs2 = stage.querySelectorAll(".bar-seg");
      for (si2 = 0; si2 < segs2.length; si2++) segs2[si2].style.borderRadius = "";
      var colored = stage.querySelectorAll("[data-to-color]");
      var ei;
      for (ei = 0; ei < colored.length; ei++) {
        var el = colored[ei];
        el.style.backgroundColor = "";
        delete el.dataset.fromColor;
        delete el.dataset.toColor;
      }
      stage.classList.remove("beating");
    });
    return Promise.all(anims.map(animDone));
  }

  function enterBeat(startDelay) {
    var stage = liveStage();
    var nodeList = stage.querySelectorAll(".enter");
    var marks = [];
    var i;
    for (i = 0; i < nodeList.length; i++) marks.push(nodeList[i]);
    if (!marks.length) return Promise.resolve();
    marks.reverse();
    var d = 260 * state.pace;
    var base = startDelay || 0;
    var anims = marks.map(function (el, idx) {
      return el.animate(
        [{ opacity: 0, transform: "translateY(3px) scale(0.94)" },
         { opacity: 1, transform: "none" }],
        { duration: d, delay: base + (idx / Math.max(1, marks.length - 1)) * SPREAD * state.pace,
          easing: "cubic-bezier(0.35, 0, 0.5, 1)", fill: "both" });
    });
    return Promise.all(anims.map(animDone)).then(function () {
      for (i = 0; i < marks.length; i++) marks[i].classList.remove("enter");
      for (i = 0; i < anims.length; i++) {
        try { anims[i].cancel(); } catch (e) {}
      }
    });
  }

  function exitBeat(from) {
    var stage = liveStage();
    stage.classList.add("beating");
    var marks = [];
    var i;
    if (from === "days") {
      var rows = stage.querySelectorAll(".grid-row[data-iso]");
      for (i = 0; i < rows.length; i++) {
        if (rows[i].dataset.iso !== DATA.today.date) marks.push(rows[i]);
      }
    } else if (from === "weeks") {
      var cells = stage.querySelectorAll(".cal-grid .cell");
      for (i = 0; i < cells.length; i++) {
        if (DATA.gridDays.indexOf(cells[i].dataset.iso) < 0) marks.push(cells[i]);
      }
      var side = stage.querySelector(".cal-side");
      if (side) marks.push(side);
    }
    if (!marks.length) return Promise.resolve();
    var d = 260 * state.pace;
    var anims = marks.map(function (el, idx) {
      return el.animate(
        [{ opacity: 1, transform: "none" },
         { opacity: 0, transform: "translateY(3px) scale(0.94)" }],
        { duration: d, delay: (idx / Math.max(1, marks.length - 1)) * SPREAD * state.pace,
          easing: "cubic-bezier(0.35, 0, 0.5, 1)", fill: "forwards" });
    });
    return Promise.all(anims.map(animDone));
  }

  function chromeIn(delay) {
    var stage = liveStage();
    if (!delay) { stage.classList.remove("beating"); return; }
    setTimeout(function () { stage.classList.remove("beating"); }, delay);
  }

  function travelBarsToRow(D, easing, back) {
    var stage = liveStage();
    var bars = stage.querySelector(".bars");
    var body = stage.querySelector(".bar-body");
    if (!bars || !body) return Promise.resolve();
    var strip = body.getBoundingClientRect();
    var targetTop = dayRowOffset === null
      ? strip.top : stage.getBoundingClientRect().top + dayRowOffset;
    var dy = back ? strip.top - targetTop : targetTop - strip.top;
    if (!dy) return Promise.resolve();
    var at = "translateY(" + (back ? -dy : dy) + "px)";
    var start = back
      ? Promise.resolve().then(function () {
          bars.style.transform = at;
          return paint();
        })
      : Promise.resolve();
    return start.then(function () {
      var frames = back
        ? [{ transform: at }, { transform: "none" }]
        : [{ transform: "none" }, { transform: at }];
      return animDone(bars.animate(frames, {
        duration: D, easing: easing, fill: back ? "both" : "forwards"
      })).then(function () {
        if (back) bars.style.transform = "";
        return paint();
      });
    });
  }

  function travelCalMarks(D, easing, toCalendar) {
    var moves = calTravel(liveStage());
    if (!moves.length) return Promise.resolve();
    var prep = Promise.resolve();
    if (!toCalendar) {
      prep = Promise.resolve().then(function () {
        var i;
        for (i = 0; i < moves.length; i++) moves[i].el.style.transform = moves[i].t;
        return paint();
      });
    }
    return prep.then(function () {
      return Promise.all(moves.map(function (m) {
        var frames = toCalendar
          ? [{ transform: "none" }, { transform: m.t }]
          : [{ transform: m.t }, { transform: "none" }];
        var delay = (toCalendar ? m.delay : SPREAD * 0.7 - m.delay) * state.pace;
        return animDone(m.el.animate(frames, {
          duration: D, easing: easing,
          fill: toCalendar ? "forwards" : "both", delay: delay
        }));
      }));
    }).then(function () {
      if (!toCalendar) {
        var i;
        for (i = 0; i < moves.length; i++) moves[i].el.style.transform = "";
      }
      return paint();
    });
  }

  function stepDirect(zoomingOut) {
    var today = DATA.today.date;
    var D = 340 * state.pace;
    var travel = "cubic-bezier(0.3, 0, 0.15, 1)";
    entering = true;
    chromeInstant = false;
    anchorSet = {};
    anchorSet[today] = true;

    var chain;
    if (zoomingOut) {
      chain = collapseBeat("hours", 300)
        .then(paint)
        .then(function () { return travelBarsToRow(D, travel); })
        .then(function () {
          state.scope = "days";
          render();
          return paint();
        })
        .then(function () { return collapseBeat("days", 300); })
        .then(paint)
        .then(function () { return travelCalMarks(D, travel, true); })
        .then(function () {
          state.scope = "weeks";
          render();
          return paint();
        })
        .then(function () {
          chromeIn(0);
          return enterBeat(0);
        });
    } else {
      chain = exitBeat("weeks")
        .then(function () {
          collapsed = "days";
          state.scope = "days";
          render();
          collapsed = null;
          return travelCalMarks(D, travel, false);
        })
        .then(function () { return expandBeat("days", 300); })
        .then(paint)
        .then(function () {
          collapsed = "hours";
          state.scope = "hours";
          render();
          collapsed = null;
          return travelBarsToRow(D, travel, true);
        })
        .then(function () { return expandBeat("hours", 300); })
        .then(function () { chromeIn(0); });
    }
    return chain.then(function () {
      entering = false;
      chromeInstant = false;
      anchorSet = null;
    });
  }

  function stepBars(zoomingOut) {
    var stage = liveStage;
    var D = 380 * state.pace;
    var travel = "cubic-bezier(0.22, 0, 0, 1)";
    var today = DATA.today.date;

    if (zoomingOut) {
      return collapseBeat("hours")
        .then(paint)
        .then(function () { return travelBarsToRow(D, travel); })
        .then(function () {
          entering = true;
          anchorSet = {};
          anchorSet[today] = true;
          chromeInstant = true;
          state.scope = "days";
          render();
          return paint();
        })
        .then(function () {
          cacheRowOffset(stage());
          return enterBeat(0);
        })
        .then(function () {
          anchorSet = null;
          anchorOnly = false;
          chromeInstant = false;
          entering = false;
        });
    }

    var fromRect = stage().querySelector(
      '.grid-row[data-iso="' + today + '"] .hours').getBoundingClientRect();
    return exitBeat("days")
      .then(function () {
        collapsed = "hours";
        entering = true;
        state.scope = "hours";
        render();
        collapsed = null;
        var strip = stage().querySelector(".bar-body").getBoundingClientRect();
        var dy = fromRect.top - strip.top;
        var bars = stage().querySelector(".bars");
        var move = bars.animate(
          [{ transform: "translateY(" + dy + "px)" }, { transform: "none" }],
          { duration: D, easing: travel, fill: "both" });
        return wait(D * 0.4).then(function () {
          chromeIn(D * 0.3);
          return Promise.all([animDone(move), expandBeat("hours")]).then(function () {
            try { move.cancel(); } catch (e) {}
          });
        });
      })
      .then(function () { entering = false; });
  }

  function calTravel(stage) {
    var st = stage.getBoundingClientRect();
    var out = [];
    var cols = stage.querySelectorAll(".row-collapse");
    var i;
    for (i = 0; i < cols.length; i++) {
      var col = cols[i];
      var off = calOffset[col.dataset.iso];
      if (!off) continue;
      var r = col.getBoundingClientRect();
      var dx = st.left + off.x - r.left;
      var dy = st.top + off.y - r.top;
      out.push({
        el: col,
        dist: Math.sqrt(dx * dx + dy * dy),
        t: "translate(" + dx + "px, " + dy + "px)"
      });
    }
    out.sort(function (a, b) { return a.dist - b.dist; });
    for (i = 0; i < out.length; i++) {
      out[i].delay = (i / Math.max(1, out.length - 1)) * (SPREAD * 0.7);
    }
    return out;
  }

  function stepCal(zoomingOut) {
    var D = 420 * state.pace;
    var travel = "cubic-bezier(0.3, 0, 0.15, 1)";
    var opts = { duration: D, easing: travel };

    if (zoomingOut) {
      return collapseBeat("days")
        .then(paint)
        .then(function () {
          var moves = calTravel(liveStage());
          return Promise.all(moves.map(function (m) {
            return animDone(m.el.animate(
              [{ transform: "none" }, { transform: m.t }],
              { duration: opts.duration, easing: opts.easing,
                fill: "forwards", delay: m.delay * state.pace }));
          }));
        })
        .then(paint)
        .then(function () {
          entering = true;
          chromeInstant = true;
          anchorSet = {};
          var i;
          for (i = 0; i < DATA.gridDays.length; i++) anchorSet[DATA.gridDays[i]] = true;
          state.scope = "weeks";
          render();
          return paint();
        })
        .then(function () { return enterBeat(0); })
        .then(function () {
          entering = false;
          chromeInstant = false;
          anchorSet = null;
        });
    }

    return exitBeat("weeks")
      .then(function () {
        collapsed = "days";
        entering = true;
        chromeInstant = true;
        anchorSet = {};
        var i;
        for (i = 0; i < DATA.gridDays.length; i++) anchorSet[DATA.gridDays[i]] = true;
        state.scope = "days";
        render();
        collapsed = null;
        var moves = calTravel(liveStage());
        for (i = 0; i < moves.length; i++) moves[i].el.style.transform = moves[i].t;
        return paint().then(function () {
          return Promise.all(moves.map(function (m) {
            return animDone(m.el.animate(
              [{ transform: m.t }, { transform: "none" }],
              { duration: opts.duration, easing: opts.easing, fill: "both",
                delay: (SPREAD * 0.7 - m.delay) * state.pace }));
          })).then(function () {
            for (i = 0; i < moves.length; i++) moves[i].el.style.transform = "";
            return expandBeat("days");
          });
        });
      })
      .then(function () {
        entering = false;
        chromeInstant = false;
        anchorSet = null;
      });
  }

  function step(from, to) {
    var pair = [from, to].sort().join("-");
    if (pair === "days-hours") {
      return stepBars(to === "days").then(function () {
        naming = null;
        render();
      });
    }
    return stepCal(to === "weeks").then(function () {
      naming = null;
      render();
    });
  }

  function setScope(next) {
    if (SCOPES.indexOf(next) < 0) return Promise.resolve();
    if (busy) { queuedScope = next; return Promise.resolve(); }
    if (state.scope === next) return Promise.resolve();
    if (reduced() || !Element.prototype.animate || fromLimits()) {
      state.scope = next;
      if (root) render();
      return Promise.resolve();
    }
    busy = true;
    var from = SCOPES.indexOf(state.scope);
    var to = SCOPES.indexOf(next);
    var dir = to > from ? 1 : -1;
    var chain;
    if (Math.abs(to - from) === 2) {
      chain = stepDirect(to > from).then(function () {
        naming = null;
        render();
      });
    } else {
      chain = Promise.resolve();
      var i = from;
      function hop() {
        if (i === to) return Promise.resolve();
        var a = SCOPES[i];
        var b = SCOPES[i + dir];
        i += dir;
        return step(a, b).then(hop);
      }
      chain = hop();
    }
    return chain.then(function () {
      busy = false;
      render();
      if (queuedScope && queuedScope !== state.scope) {
        var q = queuedScope;
        queuedScope = null;
        return setScope(q);
      }
      queuedScope = null;
    });
  }

  function hasAnchor(iso) {
    return !!(anchorSet && anchorSet[iso]);
  }

  function stageHours(stage) {
    var iso = DATA.today.date;
    var hrs = hoursFor(iso);
    var max = 1;
    var hi;
    for (hi = 0; hi < hrs.length; hi++) {
      var mv = metricValue(hrs[hi], state.metric);
      if (mv > max) max = mv;
    }
    var pre = collapsed === "hours";
    var active = 0;
    for (hi = 0; hi < hrs.length; hi++) if (tokens(hrs[hi])) active++;

    stage.innerHTML =
      '<div class="chrome viz-kicker">' +
        dateLabel(iso) + '<span class="viz-muted"> · ' +
        active + " active hours</span></div>" +
      '<div class="bars"></div><div class="baseline chrome"></div>' +
      '<div class="bar-labels axis chrome"></div>';

    var host = stage.querySelector(".bars");
    if (pre) {
      host.style.width = ROW_W + "px";
      host.style.marginLeft = LABEL_W + "px";
      host.style.columnGap = "4px";
    }
    hrs.forEach(function (c, h) {
      var v = metricValue(c, state.metric);
      var height = v ? Math.max(BAR_MIN, Math.round(v / max * 150)) : BAR_EMPTY;
      var col = document.createElement("div");
      col.className = "bar-col" + (v ? "" : " empty");
      col.dataset.h = h;

      var body = document.createElement("div");
      body.className = "bar-body";
      body.dataset.h = height;
      body.style.height = (pre ? CELL : height) + "px";
      if (pre) { body.style.padding = "2px"; body.style.margin = "-2px"; }
      if (naming === "hour") body.style.viewTransitionName = nm("hour", h);
      if (v) {
        body.innerHTML = barSegsHtml(c);
        if (pre) {
          var fromColor = hourCellColor(iso, h);
          var segs = body.querySelectorAll(".bar-seg");
          var si;
          for (si = 0; si < segs.length; si++) {
            var seg = segs[si];
            seg.dataset.fromColor = fromColor;
            seg.dataset.toColor = seg.style.backgroundColor ||
              seriesColor(seg.classList.contains("sub") ? "sub" : "main");
            seg.style.backgroundColor = fromColor;
            seg.style.borderRadius = "3px";
          }
        }
      }
      col.appendChild(body);
      host.appendChild(col);
    });

    var labels = stage.querySelector(".bar-labels");
    for (var h = 0; h < 24; h++) {
      var s = document.createElement("span");
      s.textContent = h % 4 === 0 ? hourLabel(h) : "";
      labels.appendChild(s);
    }
    if (pre) stage.classList.add("beating");
  }

  function stageDays(stage) {
    var all = [];
    var i, h;
    for (i = 0; i < DATA.gridDays.length; i++) {
      for (h = 0; h < 24; h++) all.push(metricValue(hourRec(DATA.gridDays[i], h), state.metric));
    }
    var buck = bucketer(all);
    var pre = collapsed === "days";

    var head = '<div class="grid-row chrome' + (entering ? " enter" : "") +
      '"><span class="grid-daylabel"></span>' +
      '<div class="row-track"><div class="hour-axis axis">';
    for (h = 0; h < 24; h++) head += "<span>" + (h % 6 === 0 ? h : "") + "</span>";
    head += '</div></div><span class="grid-total axis">' +
      (state.metric === "cost" ? "Cost" : "Output") + "</span></div>";
    stage.innerHTML = head + '<div class="rows"></div>';

    var host = stage.querySelector(".rows");
    var isos = anchorOnly ? [DATA.today.date] : DATA.gridDays;
    for (i = 0; i < isos.length; i++) {
      host.appendChild(buildRow(isos[i], buck, pre));
    }
    if (pre) stage.classList.add("beating");
    if (!anchorOnly) cacheRowOffset(stage);
  }

  function cacheCalOffsets(stage) {
    if (!stage.isConnected) return;
    var st = stage.getBoundingClientRect();
    var i;
    for (i = 0; i < DATA.gridDays.length; i++) {
      var iso = DATA.gridDays[i];
      var c = stage.querySelector('.cal-grid .cell[data-iso="' + iso + '"]');
      if (!c) continue;
      var r = c.getBoundingClientRect();
      if (r.width) calOffset[iso] = { x: r.left - st.left, y: r.top - st.top };
    }
  }

  function cacheRowOffset(stage) {
    var row = stage.querySelector(
      '.grid-row[data-iso="' + DATA.today.date + '"] .hours');
    if (!row || !stage.isConnected) return;
    var off = row.getBoundingClientRect().top - stage.getBoundingClientRect().top;
    if (off > 0) dayRowOffset = off;
  }

  function buildRow(iso, buck, pre) {
    var d = dayRec(iso);
    var row = document.createElement("div");
    var morphs = naming === "day" || hasAnchor(iso);
    row.className = "grid-row" + (entering && !morphs ? " enter" : "");
    row.dataset.iso = iso;

    var label = document.createElement("span");
    label.className = "grid-daylabel axis chrome";
    label.textContent = new Date(iso + "T12:00:00")
      .toLocaleDateString(undefined, { weekday: "short", day: "numeric" });

    var track = document.createElement("div");
    track.className = "row-track";
    var collapse = document.createElement("div");
    collapse.className = "row-collapse";
    collapse.dataset.iso = iso;
    collapse.style.width = (pre ? CELL : ROW_W) + "px";
    if (naming === "day") collapse.style.viewTransitionName = nm("day", iso.replace(/-/g, ""));

    var holder = document.createElement("div");
    holder.className = "hours";
    hoursFor(iso).forEach(function (c, h) {
      var div = document.createElement("div");
      var lvl = buck.level(metricValue(c, state.metric));
      div.className = "cell l" + lvl;
      if (pre && lvl) {
        div.dataset.fromColor = dayCellColor(iso, calBucket());
        div.dataset.toColor = cellInk(c, lvl);
        div.style.backgroundColor = div.dataset.fromColor;
      }
      if (naming === "hour" && iso === DATA.today.date) {
        div.style.viewTransitionName = nm("hour", h);
      }
      div.dataset.iso = iso;
      div.dataset.h = h;
      holder.appendChild(div);
    });
    collapse.appendChild(holder);
    track.appendChild(collapse);

    var total = document.createElement("span");
    total.className = "grid-total axis chrome";
    total.dataset.iso = iso;
    total.textContent = (state.metric === "cost" && !d.priced)
      ? "—" : metricText(metricValue(d, state.metric), state.metric);

    row.appendChild(label);
    row.appendChild(track);
    row.appendChild(total);
    return row;
  }

  function calStats() {
    var tracked = DATA.calendar.filter(function (d) { return d.tracked; });
    var active = tracked.filter(function (d) { return tokens(d) > 0; });
    var cost = state.metric === "cost";
    if (!tracked.length) return "";
    var top = tracked[0];
    var i;
    for (i = 1; i < tracked.length; i++) {
      if (metricValue(tracked[i], state.metric) > metricValue(top, state.metric)) top = tracked[i];
    }
    var total = cost ? DATA.totalCost : DATA.totalTokens;
    var sub = 0;
    for (i = 0; i < tracked.length; i++) sub += tracked[i].sub;
    var subShare = cost
      ? tracked.reduce(function (n, day) {
          var t = tokens(day);
          return n + (t ? (day.cost || 0) * (day.sub / t) : 0);
        }, 0)
      : sub;
    var per = active.length ? total / active.length : 0;
    function stat(label, value, detail) {
      return '<div><div class="cal-stat-label">' + label + '</div><div class="cal-stat-value">' +
        value + '</div><div class="cal-stat-detail">' + detail + "</div></div>";
    }
    return (
      stat("All time", cost ? money(DATA.totalCost) : fmt(DATA.totalTokens),
           DATA.trackedDays + " days tracked") +
      stat(cost ? "Priciest day" : "Busiest day",
           metricText(metricValue(top, state.metric), state.metric), dateLabel(top.date)) +
      stat("Per active day", metricText(per, state.metric), active.length + " active days") +
      stat("In subagents",
           Math.round(subShare / Math.max(1e-9, total) * 100) + "%",
           metricText(subShare, state.metric))
    );
  }

  function stageWeeks(stage) {
    var weeks = Math.ceil(DATA.calendar.length / 7);
    var buck = bucketer(DATA.calendar.map(function (d) { return metricValue(d, state.metric); }));
    stage.innerHTML =
      '<div class="cal-wrap"><div class="cal-dows chrome"><span></span><span>Mon</span><span></span>' +
        "<span>Wed</span><span></span><span>Fri</span><span></span></div>" +
        '<div><div class="cal-months axis chrome"></div><div class="cal-grid"></div></div>' +
        '<div class="cal-side' + (entering ? " enter" : "") + '">' + calStats() + "</div></div>";
    var monthsEl = stage.querySelector(".cal-months");
    monthsEl.style.gridTemplateColumns = "repeat(" + weeks + ", 15px)";
    var grid = stage.querySelector(".cal-grid");
    DATA.calendar.forEach(function (d, i) {
      var div = document.createElement("div");
      var morphs = (naming === "day" && DATA.gridDays.indexOf(d.date) >= 0) || hasAnchor(d.date);
      var lvl = d.tracked ? buck.level(metricValue(d, state.metric)) : 0;
      div.className = "cell " + (d.tracked ? "l" + lvl : "untracked") +
        (entering && !morphs ? " enter" : "");
      if (naming === "day" && DATA.gridDays.indexOf(d.date) >= 0) {
        div.style.viewTransitionName = nm("day", d.date.replace(/-/g, ""));
      }
      div.dataset.iso = d.date;
      grid.appendChild(div);
    });
    cacheCalOffsets(stage);
    var last = null;
    var w;
    for (w = 0; w < weeks; w++) {
      var first = DATA.calendar[w * 7];
      var span = document.createElement("span");
      var m = first ? +first.date.slice(5, 7) : null;
      if (m && m !== last && +first.date.slice(8, 10) <= 7) {
        span.textContent = MONTHS[m - 1];
        last = m;
      }
      monthsEl.appendChild(span);
    }
  }

  function render() {
    if (!root || !DATA) return;
    root.innerHTML = '<div class="stage"></div>';
    var stage = liveStage();
    if (entering && !chromeInstant) stage.classList.add("beating");
    if (state.scope === "hours") stageHours(stage);
    else if (state.scope === "days") stageDays(stage);
    else stageWeeks(stage);
  }

  function pickMetric(payload) {
    if (payload.totalCost === 0 && payload.totalTokens > 0) return "tokens";
    return "cost";
  }

  window.UsageViz = {
    mount: function (node, payload) {
      if (!node || !payload) return;
      if (typeof node.querySelector !== "function") return;
      var stamp = [payload.syncedAt, payload.totalTokens, payload.totalCost,
                    payload.today && payload.today.date].join(":");
      if (busy) return;
      if (root === node && stamp === mountedStamp && node.childElementCount) return;
      root = node;
      DATA = payload;
      state.metric = pickMetric(payload);
      mountedStamp = stamp;
      document.documentElement.style.setProperty("--pace", String(state.pace));
      render();
    },
    unmount: function () { root = null; mountedStamp = null; },
    get busy() { return busy; },
    get scope() { return state.scope; },
    setScope: setScope
  };
})();
