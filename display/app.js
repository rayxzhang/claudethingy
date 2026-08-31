(function () {
  var API_BASE = "http://127.0.0.1:8787";
  var FLIGHT_POLL_MS = 5000;
  var USAGE_POLL_MS = 60000;
  var USAGE_HISTORY_POLL_MS = 15000;
  var HOME_PAGES = ["hours", "days", "weeks", "limits"];
  var INPUT_ARM_MS = 160;
  var TOAST_MS = 1600;
  var ALERT_LINGER_MS = 25000;
  var MAX_VISIBLE_ALERTS = 2;

  var presentByHex = {};
  var alertsByHex = {};
  var arrivalQueue = [];
  var visibleHexes = [];
  var lingerTimerByHex = {};
  var slotHex = [null, null];

  var state = {
    screen: "home",
    homePage: "hours",
    extraIndex: 0,
    usage: null,
    usageHistory: null,
    detailHex: null,
    detailAircraft: null,
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

  function removeHex(list, hex) {
    var next = [];
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i] !== hex) next.push(list[i]);
    }
    return next;
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

  function formatAlt(ft) {
    if (ft == null) return "—";
    if (ft >= 1000) return Math.round(ft / 100) / 10 + "k ft";
    return ft + " ft";
  }

  function formatEta(min) {
    if (min == null) return "—";
    if (min <= 0) return "now";
    if (min < 60) return min + " min";
    return Math.floor(min / 60) + "h " + (min % 60) + "m";
  }

  function formatRoute(route) {
    if (!route) return "Route pending";
    var from = route.originCity || route.origin || "?";
    var to = route.destinationCity || route.destination || "?";
    return from + " → " + to;
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

  function extraPages(plane) {
    if (!plane) return [{ title: "Standby", body: "No aircraft nearby" }];
    var pages = [];
    if (plane.route) {
      pages.push({
        title: "Route",
        body: (plane.route.origin || "?") + " · " + (plane.route.originName || "") + "  →  " +
          (plane.route.destination || "?") + " · " + (plane.route.destinationName || ""),
      });
    } else {
      pages.push({ title: "Route", body: "Not in the route database yet" });
    }
    pages.push({
      title: "Aircraft",
      body: [plane.registration || "—", plane.typeName || plane.typeCode, plane.category, plane.squawk ? "squawk " + plane.squawk : ""]
        .filter(Boolean).join(" · "),
    });
    pages.push({
      title: "Flight",
      body: [
        plane.trackDeg != null ? plane.trackDeg + "° track" : null,
        plane.vRateFpm != null ? plane.vRateFpm + " fpm" : null,
        plane.navAltFt != null ? "assigned " + formatAlt(plane.navAltFt) : null,
      ].filter(Boolean).join(" · ") || "No extra telemetry",
    });
    return pages;
  }

  function bannerSub(plane) {
    return (plane.typeName || plane.typeCode || "Aircraft") + " · " + formatRoute(plane.route);
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

  function cancelLinger(hex) {
    var rec = alertsByHex[hex];
    if (rec) rec.generation += 1;
    if (lingerTimerByHex[hex]) {
      clearTimeout(lingerTimerByHex[hex]);
      lingerTimerByHex[hex] = 0;
    }
  }

  function pauseVisibleLingering() {
    var i;
    for (i = 0; i < visibleHexes.length; i++) {
      cancelLinger(visibleHexes[i]);
    }
  }

  function armLinger(hex) {
    var rec = alertsByHex[hex];
    if (!rec || rec.phase !== "visible") return;
    cancelLinger(hex);
    rec.generation += 1;
    var gen = rec.generation;
    var remaining = rec.expiresAt - Date.now();
    if (remaining <= 0) {
      closeAlert(hex);
      return;
    }
    lingerTimerByHex[hex] = setTimeout(function () {
      var current = alertsByHex[hex];
      if (!current || current.generation !== gen) return;
      closeAlert(hex);
      paintHome();
    }, remaining);
  }

  function rearmVisibleLingering() {
    var hexes = visibleHexes.slice();
    var i;
    for (i = 0; i < hexes.length; i++) {
      if (alertsByHex[hexes[i]] && alertsByHex[hexes[i]].phase === "visible") {
        armLinger(hexes[i]);
      }
    }
  }

  function promoteAlert(hex) {
    var rec = alertsByHex[hex];
    if (!rec || rec.phase !== "queued") return;
    if (visibleHexes.length >= MAX_VISIBLE_ALERTS) return;
    arrivalQueue = removeHex(arrivalQueue, hex);
    rec.phase = "visible";
    rec.expiresAt = Date.now() + ALERT_LINGER_MS;
    visibleHexes.push(hex);
    if (!state.focusedAlertHex) state.focusedAlertHex = hex;
    if (state.screen === "home") armLinger(hex);
  }

  function fillVisible() {
    while (visibleHexes.length < MAX_VISIBLE_ALERTS && arrivalQueue.length) {
      promoteAlert(arrivalQueue[0]);
    }
  }

  function closeAlert(hex) {
    var rec = alertsByHex[hex];
    if (!rec) return;
    cancelLinger(hex);
    delete alertsByHex[hex];
    arrivalQueue = removeHex(arrivalQueue, hex);
    visibleHexes = removeHex(visibleHexes, hex);
    if (state.focusedAlertHex === hex) {
      state.focusedAlertHex = visibleHexes[0] || null;
    }
    if (state.detailHex === hex) {
      state.detailHex = null;
      state.detailAircraft = null;
    }
    fillVisible();
  }

  function ingestAircraft(planes) {
    var incoming = {};
    var i, plane, hex, rec, departed;
    for (i = 0; i < planes.length; i++) {
      plane = planes[i];
      incoming[plane.hex] = plane;
    }

    departed = [];
    for (hex in presentByHex) {
      if (!hasOwn(presentByHex, hex)) continue;
      if (!hasOwn(incoming, hex)) departed.push(hex);
    }
    for (i = 0; i < departed.length; i++) {
      hex = departed[i];
      delete presentByHex[hex];
      rec = alertsByHex[hex];
      if (!rec) continue;
      if (state.screen === "detail" && state.detailHex === hex) continue;
      closeAlert(hex);
    }

    for (hex in incoming) {
      if (!hasOwn(incoming, hex)) continue;
      plane = incoming[hex];
      rec = alertsByHex[hex];
      if (rec) {
        rec.aircraft = plane;
        presentByHex[hex] = plane;
        if (state.detailHex === hex) state.detailAircraft = plane;
        continue;
      }
      if (hasOwn(presentByHex, hex)) {
        presentByHex[hex] = plane;
        continue;
      }
      presentByHex[hex] = plane;
      alertsByHex[hex] = {
        hex: hex,
        aircraft: plane,
        phase: "queued",
        generation: 0,
        expiresAt: 0,
      };
      arrivalQueue.push(hex);
    }

    fillVisible();
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
    var rec = alertsByHex[state.focusedAlertHex];
    if (!rec) return;
    state.detailHex = rec.hex;
    state.detailAircraft = rec.aircraft;
    state.extraIndex = 0;
    pauseVisibleLingering();
    setScreen("detail");
    paintDetail();
  }

  function goBack() {
    if (state.screen === "detail") {
      var hex = state.detailHex;
      setScreen("home");
      if (hex && !hasOwn(presentByHex, hex)) closeAlert(hex);
      rearmVisibleLingering();
      paintHome();
      return;
    }
    if (state.screen === "home" && state.focusedAlertHex) {
      closeAlert(state.focusedAlertHex);
      paintHome();
    }
  }

  function moveFocus(delta) {
    if (state.screen === "home") {
      var n = visibleHexes.length;
      if (n === 0) {
        cycleHomePage(delta);
        return;
      }
      var idx = 0;
      var i;
      for (i = 0; i < n; i++) {
        if (visibleHexes[i] === state.focusedAlertHex) {
          idx = i;
          break;
        }
      }
      idx = (idx + (delta % n) + n) % n;
      state.focusedAlertHex = visibleHexes[idx];
      paintHome();
      return;
    }
    if (state.screen === "detail") {
      var pages = extraPages(state.detailAircraft);
      if (!pages.length) return;
      state.extraIndex = (state.extraIndex + (delta % pages.length) + pages.length) % pages.length;
      paintDetail();
    }
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
      byId("hint").textContent = "Turn for more · Back to return";
      return;
    }
    if (visibleHexes.length) {
      byId("hint").textContent = "Turn to switch · Click to open · Back to dismiss";
      return;
    }
    if (state.homePage === "limits") {
      byId("hint").textContent = "Turn for usage · Presets 1-4 open apps";
      return;
    }
    byId("hint").textContent = "Turn for Today, 7 days, 12 weeks, limits";
  }

  function bindSlots() {
    var i, hex, s;
    for (s = 0; s < MAX_VISIBLE_ALERTS; s++) {
      if (slotHex[s] && visibleHexes.indexOf(slotHex[s]) === -1) slotHex[s] = null;
    }
    for (i = 0; i < visibleHexes.length; i++) {
      hex = visibleHexes[i];
      if (slotHex[0] === hex || slotHex[1] === hex) continue;
      if (!slotHex[0]) slotHex[0] = hex;
      else if (!slotHex[1]) slotHex[1] = hex;
    }
  }

  function paintBannerSlot(slot) {
    var hex = slotHex[slot];
    var el = byId("alert-" + slot);
    var rec = hex ? alertsByHex[hex] : null;
    var plane = rec ? rec.aircraft : null;
    var prev = el.getAttribute("data-hex") || "";
    if (plane) {
      byId("alert-" + slot + "-callsign").textContent = plane.callsign || plane.hex;
      byId("alert-" + slot + "-sub").textContent = bannerSub(plane);
      byId("alert-" + slot + "-eta").textContent = formatEta(plane.etaMin);
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
    el.className = "alert-banner is-open" + (hex === state.focusedAlertHex ? " is-focus" : "");
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
    bindSlots();
    paintBannerSlot(0);
    paintBannerSlot(1);
    paintUsageCards();
    byId("screen-home").className = homeClass();
    paintHint();
    paintChrome();
  }

  function paintDetail() {
    var plane = state.detailAircraft;
    byId("detail-callsign").textContent = plane ? plane.callsign : "—";
    byId("detail-type").textContent = plane ? (plane.typeName || plane.typeCode || "Aircraft") : "No aircraft selected";
    byId("detail-route").textContent = plane ? formatRoute(plane.route) : "Turn back to home";
    byId("detail-alt").textContent = plane ? formatAlt(plane.altFt) : "—";
    byId("detail-speed").textContent = plane && plane.gsKts != null ? plane.gsKts + " kt" : "—";
    byId("detail-distance").textContent = plane && plane.distanceNm != null ? plane.distanceNm + " nm" : "—";
    byId("detail-eta").textContent = plane ? formatEta(plane.etaMin) : "—";

    var pages = extraPages(plane);
    if (state.extraIndex >= pages.length) state.extraIndex = 0;
    if (state.extraIndex < 0) state.extraIndex = pages.length - 1;
    var page = pages[state.extraIndex];
    byId("extra-title").textContent = page.title;
    byId("extra-body").textContent = page.body;
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
  fetchHotkeys();
  fetchFlights();
  fetchUsage();
  fetchUsageHistory();
  setInterval(tickClock, 1000);
  setInterval(fetchFlights, FLIGHT_POLL_MS);
  setInterval(fetchUsage, USAGE_POLL_MS);
  setInterval(fetchUsageHistory, USAGE_HISTORY_POLL_MS);
})();
