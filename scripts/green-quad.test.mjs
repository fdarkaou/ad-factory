import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'green-quad.py');

function ppm(width, height, paint) {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const body = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * width + x) * 3;
      body[i] = r; body[i + 1] = g; body[i + 2] = b;
    }
  }
  return Buffer.concat([header, body]);
}

test('finds the corners of an upright green screen', () => {
  const image = ppm(200, 300, (x, y) => (x >= 40 && x < 160 && y >= 50 && y < 250 ? [0, 255, 0] : [30, 30, 30]));

  const run = spawnSync('python3', [script], { input: image });

  assert.equal(run.status, 0, run.stderr.toString());
  const { corners } = JSON.parse(run.stdout.toString());
  const flat = Object.values(corners).flat();
  const expected = [40, 50, 160, 50, 160, 250, 40, 250];
  flat.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= 1.5, `corner value ${value} vs ${expected[i]}`));
});

test('fails clearly when there is no green screen', () => {
  const image = ppm(50, 50, () => [30, 30, 30]);

  const run = spawnSync('python3', [script], { input: image });

  assert.notEqual(run.status, 0);
});
