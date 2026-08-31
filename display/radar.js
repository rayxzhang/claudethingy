(function () {
  var canvas = null;
  var ctx = null;
  var SIZE = 240;
  var PLOT_R = 92;
  var INK = "#1d1d1f";
  var MUTED = "#86868b";
  var DISC = "#f5f5f7";
  var BLUE = "#007aff";
  var WHITE = "#ffffff";
  var FONT = " -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
  var TAG_FONT = "600 11px ui-monospace, 'SF Mono', Menlo, Monaco, monospace";

  function polar(distanceNm, bearingDeg, radiusNm) {
    var dist = distanceNm;
    if (dist > radiusNm) dist = radiusNm;
    if (dist < 0) dist = 0;
    var r = (dist / radiusNm) * PLOT_R;
    var rad = bearingDeg * Math.PI / 180;
    return {
      x: SIZE / 2 + r * Math.sin(rad),
      y: SIZE / 2 - r * Math.cos(rad)
    };
  }

  function hasPolar(p) {
    return p && p.distanceNm != null && p.bearingDeg != null &&
      isFinite(p.distanceNm) && isFinite(p.bearingDeg);
  }

  function fmtNm(n) {
    var r = Math.round(n * 10) / 10;
    if (r === Math.floor(r)) return String(Math.floor(r));
    return String(r);
  }

  function relLabel(rel, trend) {
    if (rel == null || !isFinite(rel)) return "";
    var mag = Math.abs(rel);
    var s = (rel < 0 ? "-" : "+") + (mag < 10 ? "0" : "") + mag;
    if (trend === "up") s += " \u2191";
    else if (trend === "down") s += " \u2193";
    return s;
  }

  function boxesOverlap(a, b, pad) {
    return !(a.x + a.w + pad < b.x || b.x + b.w + pad < a.x ||
      a.y + a.h + pad < b.y || b.y + b.h + pad < a.y);
  }

  function placeBox(px, py, w, h, symbolR, used) {
    var candidates = [
      { x: px + symbolR + 4, y: py - h / 2 },
      { x: px - symbolR - 4 - w, y: py - h / 2 },
      { x: px - w / 2, y: py - symbolR - 4 - h },
      { x: px - w / 2, y: py + symbolR + 4 }
    ];
    var i, j, box, ok;
    for (i = 0; i < candidates.length; i++) {
      box = { x: candidates[i].x, y: candidates[i].y, w: w, h: h };
      if (box.x < 2 || box.y < 2 || box.x + box.w > SIZE - 2 || box.y + box.h > SIZE - 2) {
        continue;
      }
      ok = true;
      for (j = 0; j < used.length; j++) {
        if (boxesOverlap(box, used[j], 3)) {
          ok = false;
          break;
        }
      }
      if (ok) return box;
    }
    return { x: candidates[0].x, y: candidates[0].y, w: w, h: h };
  }

  function drawDisc(radiusNm) {
    var cx = SIZE / 2;
    var cy = SIZE / 2;
    var innerNm = radiusNm * 2 / 7;
    var midNm = radiusNm * 5 / 7;
    var rings = [innerNm, midNm, radiusNm];
    var i, rr;

    ctx.fillStyle = DISC;
    ctx.beginPath();
    ctx.arc(cx, cy, PLOT_R, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = MUTED;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    for (i = 0; i < rings.length; i++) {
      rr = (rings[i] / radiusNm) * PLOT_R;
      ctx.beginPath();
      ctx.arc(cx, cy, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.lineCap = "butt";
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx + 5, cy);
    ctx.moveTo(cx, cy - 5);
    ctx.lineTo(cx, cy + 5);
    ctx.stroke();

    ctx.fillStyle = INK;
    ctx.font = "700 11px" + FONT;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText("N", cx, cy - PLOT_R - 1);

    ctx.fillStyle = MUTED;
    ctx.font = "600 10px" + FONT;
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillText(fmtNm(innerNm), cx + (innerNm / radiusNm) * PLOT_R - 3, cy - 3);
    ctx.fillText(fmtNm(midNm), cx + (midNm / radiusNm) * PLOT_R - 3, cy - 3);
    ctx.fillText(fmtNm(radiusNm) + " nm", cx + PLOT_R - 3, cy - 3);
  }

  function ringLabelBoxes(radiusNm) {
    var cx = SIZE / 2;
    var cy = SIZE / 2;
    var innerNm = radiusNm * 2 / 7;
    var midNm = radiusNm * 5 / 7;
    var labels = [
      { text: fmtNm(innerNm), nm: innerNm },
      { text: fmtNm(midNm), nm: midNm },
      { text: fmtNm(radiusNm) + " nm", nm: radiusNm }
    ];
    var out = [];
    var i, w, x;
    ctx.font = "600 10px" + FONT;
    for (i = 0; i < labels.length; i++) {
      w = ctx.measureText(labels[i].text).width;
      x = cx + (labels[i].nm / radiusNm) * PLOT_R - 3 - w;
      out.push({ x: x, y: cy - 14, w: w, h: 12 });
    }
    return out;
  }

  function drawDiamond(x, y, size, fill, stroke) {
    ctx.beginPath();
    ctx.moveTo(x, y - size);
    ctx.lineTo(x + size * 0.85, y);
    ctx.lineTo(x, y + size);
    ctx.lineTo(x - size * 0.85, y);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.25;
      ctx.stroke();
    }
  }

  function drawChevron(x, y, headingDeg, size, color) {
    var rad = (headingDeg == null || !isFinite(headingDeg) ? 0 : headingDeg) * Math.PI / 180;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rad);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.72, size * 0.55);
    ctx.lineTo(0, size * 0.2);
    ctx.lineTo(-size * 0.72, size * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawTick(x, y, trackDeg, startR, endR, color) {
    if (trackDeg == null || !isFinite(trackDeg)) return;
    var rad = trackDeg * Math.PI / 180;
    var s = Math.sin(rad);
    var c = Math.cos(rad);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x + startR * s, y - startR * c);
    ctx.lineTo(x + endR * s, y - endR * c);
    ctx.stroke();
  }

  function drawLabel(text, box, color, font) {
    ctx.fillStyle = color;
    ctx.font = font;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(text, box.x, box.y);
  }

  function paint(scene) {
    if (!ctx) return;
    var radiusNm = scene && scene.radiusNm > 0 ? scene.radiusNm : 7;
    var traffic = scene && scene.traffic ? scene.traffic : [];
    var airports = scene && scene.airports ? scene.airports : [];
    var used = [];
    var i, p, pt, text, w, h, box, focus, others;

    ctx.clearRect(0, 0, SIZE, SIZE);
    drawDisc(radiusNm);
    used = ringLabelBoxes(radiusNm);

    ctx.font = "600 10px" + FONT;
    for (i = 0; i < airports.length; i++) {
      p = airports[i];
      if (!hasPolar(p)) continue;
      pt = polar(p.distanceNm, p.bearingDeg, radiusNm);
      drawDiamond(pt.x, pt.y, 4, null, MUTED);
      text = String(p.code || "").toUpperCase();
      if (!text) continue;
      w = ctx.measureText(text).width;
      h = 12;
      box = { x: pt.x - w / 2, y: pt.y + 6, w: w, h: h };
      drawLabel(text, box, MUTED, "600 10px" + FONT);
      used.push(box);
    }

    others = [];
    focus = null;
    for (i = 0; i < traffic.length; i++) {
      p = traffic[i];
      if (!hasPolar(p)) continue;
      if (p.role === "focus") focus = p;
      else others.push(p);
    }

    for (i = 0; i < others.length; i++) {
      p = others[i];
      pt = polar(p.distanceNm, p.bearingDeg, radiusNm);
      drawDiamond(pt.x, pt.y, 5.5, WHITE, INK);
      drawTick(pt.x, pt.y, p.trackDeg, 6, 12, INK);
    }

    if (focus) {
      pt = polar(focus.distanceNm, focus.bearingDeg, radiusNm);
      drawChevron(pt.x, pt.y, focus.trackDeg, 8, BLUE);
      drawTick(pt.x, pt.y, focus.trackDeg, 8, 14, BLUE);
      text = String(focus.callsign || "");
      if (text) {
        ctx.font = "600 11px" + FONT;
        w = ctx.measureText(text).width;
        h = 13;
        box = placeBox(pt.x, pt.y, w, h, 10, used);
        drawLabel(text, box, BLUE, "600 11px" + FONT);
        used.push(box);
      }
    }

    ctx.font = TAG_FONT;
    for (i = 0; i < others.length; i++) {
      p = others[i];
      text = relLabel(p.relHundreds, p.trend);
      if (!text) continue;
      pt = polar(p.distanceNm, p.bearingDeg, radiusNm);
      w = ctx.measureText(text).width;
      h = 13;
      box = placeBox(pt.x, pt.y, w, h, 8, used);
      drawLabel(text, box, INK, TAG_FONT);
      used.push(box);
    }
  }

  window.RadarViz = {
    mount: function (node) {
      if (!node || typeof node.getContext !== "function") return;
      canvas = node;
      ctx = node.getContext("2d");
    },
    paint: paint,
    unmount: function () {
      canvas = null;
      ctx = null;
    }
  };
})();
