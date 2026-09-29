import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeAds } from './judge-ads.mjs';

const CONFIG = {
  targets: { target_cpa: 20 },
  kill_rules: {
    min_age_days: 3,
    no_conversion_spend_multiple: 2,
    high_cpa_spend_multiple: 3,
    high_cpa_ratio: 1.5,
    winner_min_conversions: 5,
    winner_cpa_ratio: 1,
  },
};
const NOW = new Date('2026-10-10T12:00:00Z');

function ad(overrides) {
  return {
    ad_id: '1',
    name: 'AF_20261001_angle_c01_4x5',
    status: 'ACTIVE',
    created_time: '2026-10-01T00:00:00Z',
    spend: 0,
    conversions: 0,
    ...overrides,
  };
}

function verdictFor(input) {
  return judgeAds({ ads: [ad(input)], config: CONFIG, now: NOW })[0];
}

test('keeps an ad that is still inside the learning period', () => {
  const verdict = verdictFor({ created_time: '2026-10-08T12:00:00Z', spend: 500 });

  assert.equal(verdict.verdict, 'learning');
});

test('pauses an ad that spent 2x target CPA with zero conversions', () => {
  const verdict = verdictFor({ spend: 40, conversions: 0 });

  assert.equal(verdict.verdict, 'pause');
  assert.equal(verdict.rule, 'no_conversions');
});

test('pauses an ad that spent 3x target CPA at a CPA above 1.5x target', () => {
  const verdict = verdictFor({ spend: 64, conversions: 2 });

  assert.equal(verdict.verdict, 'pause');
  assert.equal(verdict.rule, 'cpa_too_high');
  assert.equal(verdict.cpa, 32);
});

test('flags a winner with enough conversions at or under target CPA', () => {
  const verdict = verdictFor({ spend: 100, conversions: 5 });

  assert.equal(verdict.verdict, 'winner');
});

test('keeps an ad that has not hit any threshold yet', () => {
  const verdict = verdictFor({ spend: 30, conversions: 1 });

  assert.equal(verdict.verdict, 'keep');
});

test('skips ads that are not active', () => {
  const verdict = verdictFor({ status: 'PAUSED', spend: 999 });

  assert.equal(verdict.verdict, 'skip');
});

test('rejects rows with missing numbers instead of guessing', () => {
  assert.throws(
    () => judgeAds({ ads: [ad({ spend: undefined })], config: CONFIG, now: NOW }),
    /spend/,
  );
});
