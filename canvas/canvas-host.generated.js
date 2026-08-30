// generated from canvas/ops.json by canvas/generate.mjs — do not edit
(function () {
  var interned = [];
  window.__ntc = function (canvas, bytes) {
    var c = canvas.getContext("2d");
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var o = 0;
    var u32 = function () { var v = dv.getUint32(o, true); o += 4; return v; };
    var f32 = function () { var v = dv.getFloat32(o, true); o += 4; return v; };
    var s = function () { var n = u32(), r = ""; for (var q = o; q < o + n; q++) r += String.fromCharCode(bytes[q]); o += n; return r; };
    var iv = function () { return interned[u32()]; };
    while (o < bytes.byteLength) {
      var code = bytes[o++];
      switch (code) {
      case 1: { c.save(); break; }
      case 2: { c.restore(); break; }
      case 3: { c.translate(f32(), f32()); break; }
      case 4: { c.rotate(f32()); break; }
      case 5: { c.scale(f32(), f32()); break; }
      case 6: { c.fillRect(f32(), f32(), f32(), f32()); break; }
      case 7: { c.strokeRect(f32(), f32(), f32(), f32()); break; }
      case 8: { c.clearRect(f32(), f32(), f32(), f32()); break; }
      case 9: { c.beginPath(); break; }
      case 10: { c.moveTo(f32(), f32()); break; }
      case 11: { c.lineTo(f32(), f32()); break; }
      case 12: { c.arc(f32(), f32(), f32(), f32(), f32()); break; }
      case 13: { c.closePath(); break; }
      case 14: { c.fill(); break; }
      case 15: { c.stroke(); break; }
      case 16: { c.fillStyle = iv(); break; }
      case 17: { c.strokeStyle = iv(); break; }
      case 18: { c.lineWidth = f32(); break; }
      case 19: { c.font = iv(); break; }
      case 20: { c.fillText(s(), f32(), f32()); break; }
      case 21: { c.globalAlpha = f32(); break; }
        case 22: { var id = u32(); interned[id] = s(); break; }
      }
    }
  };
})();
