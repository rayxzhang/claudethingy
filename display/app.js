(function () {
  var API_BASE = "http://127.0.0.1:8787";
  var FLIGHT_POLL_MS = 5000;
  var USAGE_POLL_MS = 60000;
  var USAGE_HISTORY_POLL_MS = 15000;
  var HOME_PAGES = ["hours", "days", "weeks", "limits"];
  var INPUT_ARM_MS = 160;
  var TOAST_MS = 1600;
  var HOLD_MS = 4000;
  var HYSTERESIS = 1.20;
  var SLOT_COUNT = 2;

  var mutedHex = {};
  var slotState = { hex: [null, null], seatedAt: [0, 0] };

  var state = {
    screen: "home",
    homePage: "hours",
    usage: null,
    usageHistory: null,
    detailHex: null,
    detailAircraft: null,
    snapshotAircraft: [],
    airports: [],
    radiusNm: 7,
    focusedAlertHex: null,
    paintedSessionPct: null,
    paintedWeeklyPct: null,
    officeLabel: "Office",
    hotkeys: [
      { n: 1, label: "Calendar" },
      { n: 2, label: "Mail" },
      { n: 3, label: "Slack" },
      { n: 4, label: "Safari" },
    ],
    inputArmedAt: 0,
    toastTimer: 0,
    hostNow: 0,
    hostSyncAt: 0,
    tzOffsetMinutes: 420,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function armInput() {
    state.inputArmedAt = Date.now() + INPUT_ARM_MS;
  }

  function inputReady() {
    return Date.now() >= state.inputArmedAt;
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function formatGrouped(n) {
    var sign = n < 0 ? "-" : "";
    var s = String(Math.abs(Math.round(n)));
    var out = "";
    var i;
    for (i = 0; i < s.length; i++) {
      if (i > 0 && (s.length - i) % 3 === 0) out += ",";
      out += s.charAt(i);
    }
    return sign + out;
  }

  function formatNm(nm) {
    if (nm == null || !isFinite(nm)) return "—";
    return String(Math.round(nm * 10) / 10);
  }

  function formatVs(v) {
    if (v == null || !isFinite(v)) return "—";
    if (Math.abs(v) < 64) return "0";
    var n = Math.round(v);
    var body = formatGrouped(Math.abs(n));
    if (n > 0) return "+" + body;
    if (n < 0) return "-" + body;
    return "0";
  }

  function formatNamedRoute(route) {
    if (!route) return "Route pending";
    var from = route.originName || route.originCity || route.origin || "?";
    var to = route.destinationName || route.destinationCity || route.destination || "?";
    return from + " → " + to;
  }

  function formatDetailRoute(route) {
    if (!route) return "Route pending";
    var from = route.originName || route.origin;
    var to = route.destinationName || route.destination;
    if (!from && !to) return "Route pending";
    return (from || "?") + " → " + (to || "?");
  }

  function formatDetailAlt(ft) {
    if (ft == null) return "—";
    return formatGrouped(ft) + " ft";
  }

  function formatAltMetric(altFt, navAltFt) {
    var base = formatDetailAlt(altFt);
    if (altFt == null || navAltFt == null) return base;
    if (Math.abs(navAltFt - altFt) < 200) return base;
    return base + " → " + formatGrouped(navAltFt);
  }

  function formatReset(iso) {
    if (!iso) return "Reset unknown";
    var date = new Date(iso);
    if (isNaN(date.getTime())) return "Reset unknown";
    var diffMs = date.getTime() - Date.now();
    if (diffMs <= 0) return "Resets soon";
    var mins = Math.floor(diffMs / 60000);
    var hours = Math.floor(mins / 60);
    mins = mins % 60;
    if (hours >= 24) return "Resets in " + Math.floor(hours / 24) + "d " + (hours % 24) + "h";
    if (hours > 0) return "Resets in " + hours + "h " + mins + "m";
    return "Resets in " + mins + "m";
  }

  function toneForPercent(pct) {
    if (pct >= 90) return "danger";
    if (pct >= 75) return "warn";
    return "";
  }

  function isEmergency(plane) {
    if (!plane) return false;
    if (plane.emergency) return true;
    var sq = String(plane.squawk || "");
    return sq === "7500" || sq === "7600" || sq === "7700";
  }

  function bannerSub(plane) {
    return (plane.typeName || plane.typeCode || "Aircraft") + " · " + formatNamedRoute(plane.route);
  }

  function bannerRight(plane) {
    if (isEmergency(plane)) return plane.squawk || plane.emergency || "EMER";
    if (plane.distanceNm == null || !isFinite(plane.distanceNm)) return "—";
    return formatNm(plane.distanceNm) + " nm";
  }

  function formatKicker(plane) {
    var type = plane.typeName || plane.typeCode || "Aircraft";
    var reg = plane.registration || "";
    var line = type;
    if (reg && reg !== plane.callsign) line += " · " + reg;
    if (isEmergency(plane)) {
      var tag = plane.squawk === "7500" || plane.squawk === "7600" || plane.squawk === "7700"
        ? plane.squawk
        : (plane.emergency || plane.squawk);
      if (tag) line = tag + " · " + line;
    }
    return line;
  }

  function parseAircraftList(raw) {
    var list = raw || [];
    var out = [];
    var i, plane;
    for (i = 0; i < list.length; i++) {
      plane = list[i];
      if (!plane || !plane.hex) continue;
      out.push(plane);
    }
    return out;
  }

  function formatClockPair() {
    var ms = state.hostNow ? state.hostNow + (Date.now() - state.hostSyncAt) : Date.now();
    var local = new Date(ms - state.tzOffsetMinutes * 60000);
    var h = local.getUTCHours();
    var m = local.getUTCMinutes();
    var am = h >= 12 ? "PM" : "AM";
    h = h % 12;
    if (h === 0) h = 12;
    var utc = new Date(ms);
    return {
      localLabel: h + ":" + pad2(m) + " " + am,
      utcLabel: pad2(utc.getUTCHours()) + ":" + pad2(utc.getUTCMinutes()) + " UTC",
    };
  }

  function findPlane(hex) {
    var list = state.snapshotAircraft || [];
    var i;
    if (!hex) return null;
    for (i = 0; i < list.length; i++) {
      if (list[i].hex === hex) return list[i];
    }
    return null;
  }

  function seatedHexes() {
    var out = [];
    if (slotState.hex[0]) out.push(slotState.hex[0]);
    if (slotState.hex[1]) out.push(slotState.hex[1]);
    return out;
  }

  function emptySlots() {
    return { hex: [null, null], seatedAt: [0, 0] };
  }

  function copySlots(prev) {
    var p = prev || emptySlots();
    return {
      hex: [p.hex[0] || null, p.hex[1] || null],
      seatedAt: [p.seatedAt[0] || 0, p.seatedAt[1] || 0]
    };
  }

  function indexByHex(planes) {
    var map = {};
    var i;
    for (i = 0; i < planes.length; i++) {
      if (planes[i] && planes[i].hex) map[planes[i].hex] = planes[i];
    }
    return map;
  }

  function sortRanked(planes) {
    var ranked = planes.slice();
    ranked.sort(function (a, b) {
      var ae = isEmergency(a) ? 1 : 0;
      var be = isEmergency(b) ? 1 : 0;
      if (ae !== be) return be - ae;
      var as = typeof a.score === "number" ? a.score : 0;
      var bs = typeof b.score === "number" ? b.score : 0;
      if (as !== bs) return bs - as;
      return 0;
    });
    return ranked;
  }

  function seatedSet(slots) {
    var s = {};
    if (slots.hex[0]) s[slots.hex[0]] = true;
    if (slots.hex[1]) s[slots.hex[1]] = true;
    return s;
  }

  function firstChallenger(ranked, occupied) {
    var i, p;
    for (i = 0; i < ranked.length; i++) {
      p = ranked[i];
      if (p && p.hex && !occupied[p.hex]) return p;
    }
    return null;
  }

  function firstEmergency(ranked) {
    var i;
    for (i = 0; i < ranked.length; i++) {
      if (isEmergency(ranked[i])) return ranked[i];
    }
    return null;
  }

  function seatAt(slots, i, hex, nowMs) {
    var j;
    for (j = 0; j < SLOT_COUNT; j++) {
      if (j !== i && slots.hex[j] === hex) {
        slots.hex[j] = null;
        slots.seatedAt[j] = 0;
      }
    }
    slots.hex[i] = hex;
    slots.seatedAt[i] = nowMs;
  }

  function compactLeft(slots) {
    if (!slots.hex[0] && slots.hex[1]) {
      slots.hex[0] = slots.hex[1];
      slots.seatedAt[0] = slots.seatedAt[1];
      slots.hex[1] = null;
      slots.seatedAt[1] = 0;
    }
  }

  function pickLiveSlots(planes, prev, nowMs) {
    var byHex = indexByHex(planes);
    var ranked = sortRanked(planes);
    var next = copySlots(prev);
    var i, h, occupant, challenger, occupied, emer, held;

    for (i = 0; i < SLOT_COUNT; i++) {
      h = next.hex[i];
      if (h && !byHex[h]) {
        next.hex[i] = null;
        next.seatedAt[i] = 0;
      }
    }
    compactLeft(next);

    emer = firstEmergency(ranked);
    if (emer && next.hex[0] !== emer.hex) {
      var prev0 = next.hex[0];
      var prev0At = next.seatedAt[0];
      seatAt(next, 0, emer.hex, nowMs);
      if (prev0 && prev0 !== emer.hex && byHex[prev0]) {
        seatAt(next, 1, prev0, prev0At);
      }
    }

    for (i = 0; i < SLOT_COUNT; i++) {
      h = next.hex[i];
      occupant = h ? byHex[h] : null;
      held = occupant && (nowMs - next.seatedAt[i] < HOLD_MS);
      if (held) continue;
      occupied = seatedSet(next);
      if (occupant) delete occupied[occupant.hex];
      if (i === 1 && next.hex[0]) occupied[next.hex[0]] = true;
      challenger = firstChallenger(ranked, occupied);
      if (!occupant) {
        if (challenger) seatAt(next, i, challenger.hex, nowMs);
        continue;
      }
      if (challenger && (challenger.score || 0) > (occupant.score || 0) * HYSTERESIS) {
        seatAt(next, i, challenger.hex, nowMs);
      }
    }

    compactLeft(next);
    occupied = seatedSet(next);
    for (i = 0; i < SLOT_COUNT; i++) {
      if (next.hex[i]) continue;
      challenger = firstChallenger(ranked, occupied);
      if (!challenger) break;
      seatAt(next, i, challenger.hex, nowMs);
      occupied[challenger.hex] = true;
    }
    compactLeft(next);
    return next;
  }

  function followFocus() {
    var a = slotState.hex[0];
    var b = slotState.hex[1];
    if (state.focusedAlertHex === a || state.focusedAlertHex === b) return;
    state.focusedAlertHex = a || b || null;
  }

  function ingestAircraft(planes) {
    state.snapshotAircraft = planes;
    var incoming = {};
    var i, plane, hex;
    for (i = 0; i < planes.length; i++) {
      plane = planes[i];
      incoming[plane.hex] = plane;
    }
    for (hex in mutedHex) {
      if (!hasOwn(mutedHex, hex)) continue;
      if (!hasOwn(incoming, hex)) delete mutedHex[hex];
    }
    var live = [];
    for (i = 0; i < planes.length; i++) {
      if (!mutedHex[planes[i].hex]) live.push(planes[i]);
    }
    slotState = pickLiveSlots(live, slotState, Date.now());
    followFocus();
    if (state.detailHex && incoming[state.detailHex]) {
      state.detailAircraft = incoming[state.detailHex];
    }
  }

  function homeClass() {
    return "panel" + (state.screen === "home" ? " panel-active" : "") +
      (state.homePage === "limits" ? " page-limits" : "");
  }

  function setScreen(name) {
    state.screen = name;
    byId("screen-home").className = homeClass();
    byId("screen-detail").className = "panel" + (name === "detail" ? " panel-active" : "");
    armInput();
    paintChrome();
  }

  function isVizPage(page) {
    return page === "hours" || page === "days" || page === "weeks";
  }

  var queuedHomePage = null;

  function applyHomePage(next) {
    var from = state.homePage;
    if (isVizPage(from) && isVizPage(next)) {
      state.homePage = next;
      if (window.UsageViz) {
        var p = UsageViz.setScope(next);
        if (p && p.then) p.then(flushHomeQueue);
      }
      paintHome();
      return;
    }
    if (from === "limits" && isVizPage(next) && window.UsageViz) {
      UsageViz.setScope(next);
    }
    state.homePage = next;
    paintHome();
  }

  function flushHomeQueue() {
    if (queuedHomePage == null) return;
    var q = queuedHomePage;
    queuedHomePage = null;
    applyHomePage(q);
  }

  function cycleHomePage(delta) {
    var i = HOME_PAGES.indexOf(state.homePage);
    if (i < 0) i = 0;
    var next = HOME_PAGES[(i + delta + HOME_PAGES.length) % HOME_PAGES.length];
    if (window.UsageViz && UsageViz.busy && !(isVizPage(state.homePage) && isVizPage(next))) {
      queuedHomePage = next;
      return;
    }
    applyHomePage(next);
  }

  function activate() {
    if (state.screen !== "home") return;
    if (!state.focusedAlertHex) return;
    var plane = findPlane(state.focusedAlertHex);
    if (!plane) return;
    state.detailHex = plane.hex;
    state.detailAircraft = plane;
    setScreen("detail");
    paintDetail();
  }

  function goBack() {
    if (state.screen === "detail") {
      setScreen("home");
      paintHome();
      return;
    }
    if (state.screen === "home" && state.focusedAlertHex) {
      mutedHex[state.focusedAlertHex] = true;
      ingestAircraft(state.snapshotAircraft);
      paintHome();
    }
  }

  function moveFocus(delta) {
    if (state.screen === "home") {
      var hexes = seatedHexes();
      var n = hexes.length;
      if (n === 0) {
        cycleHomePage(delta);
        return;
      }
      var idx = 0;
      var i;
      for (i = 0; i < n; i++) {
        if (hexes[i] === state.focusedAlertHex) {
          idx = i;
          break;
        }
      }
      idx = (idx + (delta % n) + n) % n;
      state.focusedAlertHex = hexes[idx];
      paintHome();
      return;
    }
    if (state.screen === "detail") {
      cycleDetailAircraft(delta);
    }
  }

  function cycleDetailAircraft(delta) {
    var list = state.snapshotAircraft || [];
    if (list.length < 2) return;
    var hex = state.detailHex;
    var idx = 0;
    var i;
    var found = false;
    for (i = 0; i < list.length; i++) {
      if (list[i].hex === hex) {
        idx = i;
        found = true;
        break;
      }
    }
    if (!found) idx = 0;
    else idx = (idx + (delta % list.length) + list.length) % list.length;
    var plane = list[idx];
    if (!plane) return;
    state.detailHex = plane.hex;
    state.detailAircraft = plane;
    if (seatedHexes().indexOf(plane.hex) !== -1) {
      state.focusedAlertHex = plane.hex;
    }
    paintDetail();
  }

  function showToast(text) {
    var el = byId("toast");
    el.textContent = text;
    el.className = "toast show";
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      el.className = "toast";
    }, TOAST_MS);
  }

  function paintChrome() {
    byId("office-label").textContent = state.officeLabel;
    var bar = byId("hotkey-bar");
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    var i, hk, cell, n, lab;
    for (i = 0; i < state.hotkeys.length; i++) {
      hk = state.hotkeys[i];
      cell = document.createElement("div");
      cell.className = "hotkey";
      n = document.createElement("span");
      n.className = "hotkey-n";
      n.textContent = String(hk.n);
      lab = document.createElement("span");
      lab.className = "hotkey-label";
      lab.textContent = hk.label || "Shortcut";
      cell.appendChild(n);
      cell.appendChild(lab);
      bar.appendChild(cell);
    }
  }

  function paintHint() {
    if (state.screen === "detail") {
      byId("hint").textContent = "Back dismisses";
      return;
    }
    if (seatedHexes().length) {
      byId("hint").textContent = "Turn to switch · Click to open · Back to dismiss";
      return;
    }
    if (state.homePage === "limits") {
      byId("hint").textContent = "Turn for usage · Presets 1-4 open apps";
      return;
    }
    byId("hint").textContent = "Turn for Today, 7 days, 12 weeks, limits";
  }

  function paintBannerSlot(slot) {
    var hex = slotState.hex[slot];
    var el = byId("alert-" + slot);
    var plane = hex ? findPlane(hex) : null;
    var prev = el.getAttribute("data-hex") || "";
    var cls;
    if (plane) {
      byId("alert-" + slot + "-callsign").textContent = plane.callsign || plane.hex;
      byId("alert-" + slot + "-sub").textContent = bannerSub(plane);
      byId("alert-" + slot + "-eta").textContent = bannerRight(plane);
    }
    if (prev !== (hex || "")) {
      el.className = "alert-banner";
      el.setAttribute("data-hex", hex || "");
      if (hex) el.offsetWidth;
    }
    if (!hex) {
      el.className = "alert-banner";
      return;
    }
    cls = "alert-banner is-open";
    if (hex === state.focusedAlertHex) cls += " is-focus";
    if (isEmergency(plane)) cls += " is-emer";
    el.className = cls;
  }

  function paintUsageCard(cardId, percentId, barId, resetId, bucket, paintedKey) {
    var card = byId(cardId);
    var pct = bucket && typeof bucket.percent === "number" ? bucket.percent : null;
    if (pct == null) {
      byId(percentId).textContent = "--";
      byId(barId).style.width = "0%";
      byId(resetId).textContent = "No data";
      card.className = "usage-card";
      state[paintedKey] = null;
      return;
    }
    var rounded = Math.round(pct);
    if (state[paintedKey] !== rounded) {
      byId(percentId).textContent = String(rounded);
      byId(barId).style.width = Math.min(pct, 100) + "%";
      state[paintedKey] = rounded;
    }
    byId(resetId).textContent = formatReset(bucket.resetsAt);
    var tone = toneForPercent(pct);
    card.className = tone ? "usage-card " + tone : "usage-card";
  }

  function paintUsageCards() {
    paintUsageCard(
      "session-card", "session-percent", "session-bar", "session-reset",
      state.usage && state.usage.session, "paintedSessionPct"
    );
    paintUsageCard(
      "weekly-card", "weekly-percent", "weekly-bar", "weekly-reset",
      state.usage && state.usage.weekly, "paintedWeeklyPct"
    );
  }

  function paintHome() {
    paintBannerSlot(0);
    paintBannerSlot(1);
    paintUsageCards();
    if (state.homePage !== "limits" && !state.usageHistory) {
      var viz = byId("usage-viz");
      if (viz && !viz.querySelector(".stage")) {
        viz.innerHTML = '<div class="usage-empty">Waiting for host</div>';
      }
    }
    byId("screen-home").className = homeClass();
    paintHint();
    paintChrome();
  }

  function clampRel(n) {
    if (n > 99) return 99;
    if (n < -99) return -99;
    return n;
  }

  function toRadarTarget(plane, focus, role) {
    if (!plane || plane.distanceNm == null || plane.bearingDeg == null) return null;
    if (!isFinite(plane.distanceNm) || !isFinite(plane.bearingDeg)) return null;
    var rel = null;
    var trend = null;
    if (role === "other") {
      if (plane.altFt != null && focus && focus.altFt != null) {
        rel = clampRel(Math.round((plane.altFt - focus.altFt) / 100));
      }
      if (plane.vRateFpm != null && Math.abs(plane.vRateFpm) >= 128) {
        trend = plane.vRateFpm > 0 ? "up" : "down";
      }
    }
    return {
      hex: plane.hex,
      callsign: plane.callsign || plane.hex,
      role: role,
      distanceNm: plane.distanceNm,
      bearingDeg: plane.bearingDeg,
      trackDeg: plane.trackDeg != null ? plane.trackDeg : null,
      relHundreds: rel,
      trend: trend
    };
  }

  function buildRadarScene() {
    var focus = state.detailAircraft;
    var planes = state.snapshotAircraft || [];
    var traffic = [];
    var seen = {};
    var i, plane, target;
    if (focus && focus.hex) {
      target = toRadarTarget(focus, focus, "focus");
      if (target) {
        traffic.push(target);
        seen[focus.hex] = true;
      }
    }
    for (i = 0; i < planes.length; i++) {
      plane = planes[i];
      if (!plane || !plane.hex || seen[plane.hex]) continue;
      target = toRadarTarget(plane, focus, "other");
      if (target) traffic.push(target);
    }
    return {
      radiusNm: state.radiusNm || 7,
      traffic: traffic,
      airports: state.airports || []
    };
  }

  function paintDetail() {
    var plane = state.detailAircraft;
    byId("detail-callsign").textContent = plane ? plane.callsign : "—";
    byId("detail-type").textContent = plane ? formatKicker(plane) : "No aircraft selected";
    byId("detail-route").textContent = plane ? formatDetailRoute(plane.route) : "Route pending";
    byId("detail-alt").textContent = plane ? formatAltMetric(plane.altFt, plane.navAltFt) : "—";
    byId("detail-speed").textContent = plane && plane.gsKts != null ? plane.gsKts + " kt" : "—";
    byId("detail-distance").textContent = plane && plane.distanceNm != null ? plane.distanceNm + " nm" : "—";
    byId("detail-vrate").textContent = plane ? formatVs(plane.vRateFpm) : "—";
    byId("detail-vs").textContent = "Traffic vs " + (plane && plane.callsign ? plane.callsign : "—");
    if (window.RadarViz) RadarViz.paint(buildRadarScene());
    paintHint();
  }

  function fireHotkey(n) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", API_BASE + "/api/hotkey", true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      var payload = {};
      try { payload = JSON.parse(xhr.responseText); } catch (e) { payload = {}; }
      if (payload.view === "usage" || payload.view === "home") {
        setScreen("home");
        paintHome();
        return;
      }
      showToast(payload.label ? "Opened " + payload.label : "Shortcut " + n);
    };
    xhr.send(JSON.stringify({ n: n }));
  }

  function fetchJson(path, onOk) {
    var xhr = new XMLHttpRequest();
    xhr.open("GET", API_BASE + path, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try { onOk(JSON.parse(xhr.responseText)); } catch (e) {}
      }
    };
    xhr.send();
  }

  function fetchFlights() {
    fetchJson("/api/flights", function (payload) {
      if (!payload.flights) return;
      if (payload.flights.office && payload.flights.office.label) {
        state.officeLabel = payload.flights.office.label;
      }
      if (payload.flights.office && typeof payload.flights.office.radiusNm === "number") {
        state.radiusNm = payload.flights.office.radiusNm;
      }
      state.airports = payload.flights.airports || [];
      syncClock(payload.clock);
      ingestAircraft(parseAircraftList(payload.flights.aircraft));
      paintHome();
      if (state.screen === "detail") paintDetail();
    });
  }

  function fetchUsage() {
    fetchJson("/api/usage", function (payload) {
      state.usage = payload.usage || null;
      paintUsageCards();
    });
  }

  function fetchUsageHistory() {
    fetchJson("/api/usage-history", function (payload) {
      if (!payload || !payload.today) return;
      state.usageHistory = payload;
      if (window.UsageViz) UsageViz.mount(byId("usage-viz"), payload);
    });
  }

  function fetchHotkeys() {
    fetchJson("/api/hotkeys", function (payload) {
      if (payload.hotkeys && payload.hotkeys.length) {
        state.hotkeys = payload.hotkeys;
        paintChrome();
      }
    });
  }

  function keyId(event) {
    var code = event.code || "";
    var key = event.key || "";
    if (code === "Digit1" || key === "1") return "Digit1";
    if (code === "Digit2" || key === "2") return "Digit2";
    if (code === "Digit3" || key === "3") return "Digit3";
    if (code === "Digit4" || key === "4") return "Digit4";
    if (code === "Enter" || key === "Enter") return "Enter";
    if (code === "Escape" || key === "Escape") return "Escape";
    if (code === "ArrowRight" || key === "ArrowRight" || code === "ArrowDown" || key === "ArrowDown") return "Next";
    if (code === "ArrowLeft" || key === "ArrowLeft" || code === "ArrowUp" || key === "ArrowUp") return "Prev";
    return code || key;
  }

  document.addEventListener("keydown", function (event) {
    if (event.repeat || !inputReady()) return;
    var id = keyId(event);
    if (id === "Digit1" || id === "Digit2" || id === "Digit3" || id === "Digit4" ||
        id === "Enter" || id === "Escape" || id === "Next" || id === "Prev") {
      event.preventDefault();
    }
    switch (id) {
      case "Digit1": fireHotkey(1); break;
      case "Digit2": fireHotkey(2); break;
      case "Digit3": fireHotkey(3); break;
      case "Digit4": fireHotkey(4); break;
      case "Next": moveFocus(1); break;
      case "Prev": moveFocus(-1); break;
      case "Enter": activate(); break;
      case "Escape": goBack(); break;
      default: break;
    }
  }, true);

  document.addEventListener("wheel", function (event) {
    if (!inputReady()) return;
    var dx = event.deltaX || 0;
    var dy = event.deltaY || 0;
    var mag = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
    if (Math.abs(mag) < 1) return;
    event.preventDefault();
    moveFocus(mag > 0 ? 1 : -1);
    armInput();
  }, true);

  function syncClock(clock) {
    // Car Thing RTC drifts; paint from the host's clock.now plus local elapsed.
    if (!clock || typeof clock.now !== "number") return;
    state.hostNow = clock.now;
    state.hostSyncAt = Date.now();
    if (typeof clock.tzOffsetMinutes === "number") state.tzOffsetMinutes = clock.tzOffsetMinutes;
  }

  function tickClock() {
    var pair = formatClockPair();
    byId("clock-local").textContent = pair.localLabel;
    byId("clock-utc").textContent = pair.utcLabel;
  }

  tickClock();
  paintHome();
  if (window.RadarViz) RadarViz.mount(byId("radar-canvas"));
  fetchHotkeys();
  fetchFlights();
  fetchUsage();
  fetchUsageHistory();
  setInterval(tickClock, 1000);
  setInterval(fetchFlights, FLIGHT_POLL_MS);
  setInterval(fetchUsage, USAGE_POLL_MS);
  setInterval(fetchUsageHistory, USAGE_HISTORY_POLL_MS);
})();
