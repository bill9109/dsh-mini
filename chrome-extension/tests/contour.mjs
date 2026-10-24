// Verify rendered path geometry, independently of the production path builder.
import assert from 'node:assert/strict';
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const norm = a => Math.hypot(...a);
const near = (a, b) => Math.abs(a - b) < 0.00005;
export function verifyContour(path, radius, circularEnds = true) {
  let cursor;
  const segments = [];
  for (const [, command, data] of path.matchAll(/([MLCAZ])([^MLCAZ]*)/g)) {
    const v = (data.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if (command === 'Z') continue;
    const end = v.slice(-2), segment = { command, start: cursor, end, v };
    if (command === 'A') {
      assert.ok(near(v[0], radius) && near(v[1], radius), 'Arc must be a true circle of the specified radius');
      const chord = sub(end, cursor), length = norm(chord);
      const lift = Math.sqrt(radius * radius - length * length / 4);
      segment.center = [(cursor[0] + end[0]) / 2 - chord[1] / length * lift, (cursor[1] + end[1]) / 2 + chord[0] / length * lift];
    }
    segments.push(segment);
    cursor = end;
  }
  const arcs = segments.filter(s => s.command === 'A');
  assert.equal(arcs.length, 4);
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.command !== 'C') continue;
    const p = [segment.start, segment.v.slice(0, 2), segment.v.slice(2, 4), segment.end];
    for (const edge of [0, 1]) {
      const at = edge ? 3 : 0;
      const direction = edge ? sub(p[3], p[2]) : sub(p[1], p[0]);
      const acceleration = edge ? sub(sub(p[3], p[2]), sub(p[2], p[1])) : sub(sub(p[2], p[1]), sub(p[1], p[0]));
      const curvature = 2 / 3 * cross(direction, acceleration) / Math.pow(norm(direction), 3);
      const adjacent = segments[i + (edge ? 1 : -1)] || segments[0];
      if (adjacent.command === 'A') {
        assert.ok(near(curvature, 1 / radius), 'Blend must match circular curvature, not just tangent');
        const radial = sub(p[at], adjacent.center), tangent = [-radial[1], radial[0]];
        assert.ok(Math.abs(cross(direction, tangent)) / (norm(direction) * norm(tangent)) < 0.00005, 'Blend must match circular tangent: ' + JSON.stringify({segment,edge,direction,tangent,adjacent}));
      } else {
        assert.ok(near(curvature, 0), 'Blend must meet straight edge with zero curvature');
      }
    }
  }
  if (circularEnds) {
    assert.ok(near(arcs[0].center[0], arcs[1].center[0]) && near(arcs[0].center[1], arcs[1].center[1]), 'Right end arcs must lie on one circle');
    assert.ok(near(arcs[2].center[0], arcs[3].center[0]) && near(arcs[2].center[1], arcs[3].center[1]), 'Left end arcs must lie on one circle');
    assert.ok(near(arcs[0].center[1], arcs[2].center[1]), 'Both circular ends must have the same centerline');
  }
  return true;
}
