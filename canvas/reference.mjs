// the same scene written directly against the DOM API — the oracle
export const drawDirect = (c, t) => {
  c.clearRect(0, 0, 640, 480);
  c.fillStyle = "#101418"; c.fillRect(0, 0, 640, 480);
  c.fillStyle = "#3aa9ff";
  for (let i = 0; i < 24; i++) {
    const a = t * 0.01 + i * 0.26;
    const r = 60 + 90 * Math.sin(a * 0.7);
    const x = 320 + r * Math.cos(a);
    const y = 240 + r * Math.sin(a);
    c.fillRect(Math.fround(x - 4), Math.fround(y - 4), 8, 8);
  }
  c.strokeStyle = "#ff6b6b"; c.lineWidth = 2;
  c.beginPath(); c.moveTo(40, 440);
  for (let i = 1; i < 60; i++) {
    c.moveTo(Math.fround(40 + (i - 1) * 10), Math.fround(440 - 60 * Math.sin((i - 1) * 0.2 + t * 0.02)));
    c.lineTo(Math.fround(40 + i * 10), Math.fround(440 - 60 * Math.sin(i * 0.2 + t * 0.02)));
  }
  c.stroke();
  c.save(); c.translate(320, 240); c.rotate(Math.fround(t * 0.02)); c.globalAlpha = Math.fround(0.6);
  c.fillStyle = "#ffd166"; c.beginPath(); c.arc(0, 0, 40, 0, Math.fround(Math.PI * 2)); c.fill(); c.restore();
  c.globalAlpha = 1; c.fillStyle = "#e6e6e6"; c.font = "16px monospace"; c.fillText("compiled canvas", 20, 30);
};
