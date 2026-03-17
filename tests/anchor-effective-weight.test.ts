/**
 * Tests for Anchor effective weight — dynamic decay computation on anchor nodes.
 *
 * Sub-AC 6.1: Anchor 모델에 decay 관련 필드(last_accessed_at, decay_rate, effective_weight)
 * 추가 및 가중치 감쇠 계산 함수 구현
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import {
  computeAnchorEffectiveWeight,
  AnchorDecay,
  DEFAULT_DECAY_CONFIG,
  type AnchorDecayInput,
} from '../src/scoring/anchor-decay.js';

// ────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function pastDate(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function makeAnchorInput(overrides: Partial<AnchorDecayInput> = {}): AnchorDecayInput {
  return {
    currentWeight: 0.8,
    decayRate: 0.01,
    lastAccessedAt: new Date().toISOString(),
    createdAt: pastDate(30 * ONE_DAY_MS),
    accessCount: 5,
    ...overrides,
  };
}

// ────────────────────────────────────────────────────────
// computeAnchorEffectiveWeight — pure function tests
// ────────────────────────────────────────────────────────

describe('computeAnchorEffectiveWeight', () => {
  it('returns currentWeight when just accessed (no decay elapsed)', () => {
    const now = new Date();
    const input = makeAnchorInput({ lastAccessedAt: now.toISOString() });
    const effective = computeAnchorEffectiveWeight(input, now);
    expect(effective).toBeCloseTo(input.currentWeight, 5);
  });

  it('returns currentWeight when decayRate is 0 (permanent anchor)', () => {
    const input = makeAnchorInput({
      decayRate: 0,
      lastAccessedAt: pastDate(100 * ONE_DAY_MS),
    });
    const effective = computeAnchorEffectiveWeight(input);
    expect(effective).toBe(input.currentWeight);
  });

  it('decays weight over time', () => {
    const now = new Date();
    const input = makeAnchorInput({
      currentWeight: 0.8,
      lastAccessedAt: pastDate(14 * ONE_DAY_MS), // 14 days ago = one half-life
      accessCount: 5,
    });
    const effective = computeAnchorEffectiveWeight(input, now);
    expect(effective).toBeLessThan(input.currentWeight);
    expect(effective).toBeGreaterThan(0);
  });

  it('higher access count resists decay (usage-based protection)', () => {
    const lastAccessed = pastDate(14 * ONE_DAY_MS);
    const lowUsage = makeAnchorInput({ lastAccessedAt: lastAccessed, accessCount: 0 });
    const highUsage = makeAnchorInput({ lastAccessedAt: lastAccessed, accessCount: 100 });

    const effLow = computeAnchorEffectiveWeight(lowUsage);
    const effHigh = computeAnchorEffectiveWeight(highUsage);

    expect(effHigh).toBeGreaterThan(effLow);
  });

  it('higher decay rate causes faster weight loss', () => {
    const lastAccessed = pastDate(14 * ONE_DAY_MS);
    const slow = makeAnchorInput({ lastAccessedAt: lastAccessed, decayRate: 0.005 });
    const fast = makeAnchorInput({ lastAccessedAt: lastAccessed, decayRate: 0.02 });

    const effSlow = computeAnchorEffectiveWeight(slow);
    const effFast = computeAnchorEffectiveWeight(fast);

    expect(effFast).toBeLessThan(effSlow);
  });

  it('respects minimum weight floor', () => {
    const input = makeAnchorInput({
      currentWeight: 0.02,
      lastAccessedAt: pastDate(200 * ONE_DAY_MS),
      accessCount: 0,
    });
    const effective = computeAnchorEffectiveWeight(input);
    expect(effective).toBeGreaterThanOrEqual(DEFAULT_DECAY_CONFIG.minWeight);
  });

  it('falls back to createdAt when lastAccessedAt is undefined', () => {
    const now = new Date();
    const createdAt = pastDate(14 * ONE_DAY_MS);
    const input = makeAnchorInput({
      lastAccessedAt: undefined,
      createdAt,
      currentWeight: 0.8,
    });
    const effective = computeAnchorEffectiveWeight(input, now);
    // Should decay based on time since creation
    expect(effective).toBeLessThan(input.currentWeight);
  });

  it('returns minWeight when currentWeight is 0', () => {
    const input = makeAnchorInput({ currentWeight: 0 });
    const effective = computeAnchorEffectiveWeight(input);
    expect(effective).toBe(DEFAULT_DECAY_CONFIG.minWeight);
  });

  it('accepts custom config', () => {
    const input = makeAnchorInput({
      lastAccessedAt: pastDate(3 * ONE_DAY_MS),
    });

    const shortHalfLife = computeAnchorEffectiveWeight(input, new Date(), {
      ...DEFAULT_DECAY_CONFIG,
      timeHalfLifeMs: 3 * ONE_DAY_MS, // very short
    });

    const longHalfLife = computeAnchorEffectiveWeight(input, new Date(), {
      ...DEFAULT_DECAY_CONFIG,
      timeHalfLifeMs: 60 * ONE_DAY_MS, // very long
    });

    expect(shortHalfLife).toBeLessThan(longHalfLife);
  });
});

// ────────────────────────────────────────────────────────
// AnchorDecay.computeAnchorWeight — class method tests
// ────────────────────────────────────────────────────────

describe('AnchorDecay.computeAnchorWeight', () => {
  it('delegates to computeAnchorEffectiveWeight with config', () => {
    const decay = new AnchorDecay();
    const input = makeAnchorInput({ lastAccessedAt: pastDate(7 * ONE_DAY_MS) });
    const result = decay.computeAnchorWeight(input);

    expect(result).toBeLessThan(input.currentWeight);
    expect(result).toBeGreaterThan(0);
  });

  it('uses custom config', () => {
    const shortDecay = new AnchorDecay({ timeHalfLifeMs: 3 * ONE_DAY_MS });
    const longDecay = new AnchorDecay({ timeHalfLifeMs: 60 * ONE_DAY_MS });

    const input = makeAnchorInput({ lastAccessedAt: pastDate(7 * ONE_DAY_MS) });
    const shortResult = shortDecay.computeAnchorWeight(input);
    const longResult = longDecay.computeAnchorWeight(input);

    expect(shortResult).toBeLessThan(longResult);
  });
});

// ────────────────────────────────────────────────────────
// AnchorRepository integration — effectiveWeight on model
// ────────────────────────────────────────────────────────

describe('AnchorRepository effectiveWeight', () => {
  let db: Database.Database;
  let repo: AnchorRepository;

  beforeEach(() => {
    db = createDatabase({ inMemory: true });
    repo = new AnchorRepository(db);
  });

  it('newly created anchor has effectiveWeight equal to currentWeight', () => {
    const anchor = repo.createAnchor({
      label: 'TypeScript',
      description: 'TypeScript language',
      anchorType: 'entity',
      initialWeight: 0.7,
    });

    expect(anchor.effectiveWeight).toBe(0.7);
    expect(anchor.effectiveWeight).toBe(anchor.currentWeight);
  });

  it('getAnchor returns anchor with computed effectiveWeight', () => {
    const created = repo.createAnchor({
      label: 'TypeScript',
      description: 'TypeScript language',
      anchorType: 'entity',
    });

    const fetched = repo.getAnchor(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.effectiveWeight).toBeDefined();
    expect(typeof fetched!.effectiveWeight).toBe('number');
    // Just created, so effective should be close to current
    expect(fetched!.effectiveWeight).toBeCloseTo(fetched!.currentWeight, 1);
  });

  it('findByLabel returns anchor with effectiveWeight', () => {
    repo.createAnchor({
      label: 'React',
      description: 'React framework',
      anchorType: 'topic',
    });

    const found = repo.findByLabel('React');
    expect(found).not.toBeNull();
    expect(found!.effectiveWeight).toBeDefined();
  });

  it('listAnchors returns refs with effectiveWeight', () => {
    repo.createAnchor({
      label: 'Node.js',
      description: 'Node runtime',
      anchorType: 'entity',
    });

    const refs = repo.listAnchors();
    expect(refs).toHaveLength(1);
    expect(refs[0].effectiveWeight).toBeDefined();
    expect(typeof refs[0].effectiveWeight).toBe('number');
  });

  it('updateAnchor returns updated effectiveWeight', () => {
    const created = repo.createAnchor({
      label: 'SQLite',
      description: 'Database engine',
      anchorType: 'entity',
    });

    const updated = repo.updateAnchor(created.id, { recordAccess: true });
    expect(updated).not.toBeNull();
    expect(updated!.effectiveWeight).toBeDefined();
    // After recording access (now), effective weight should be close to current
    expect(updated!.effectiveWeight).toBeCloseTo(updated!.currentWeight, 1);
  });

  it('effectiveWeight decreases for older anchors', () => {
    // Create anchor and manually set last_accessed_at to past
    const anchor = repo.createAnchor({
      label: 'OldAnchor',
      description: 'An old anchor',
      anchorType: 'topic',
      initialWeight: 0.8,
      decayRate: 0.01,
    });

    // Directly update the DB to set last_accessed_at in the past
    const thirtyDaysAgo = new Date(Date.now() - 30 * ONE_DAY_MS).toISOString();
    db.prepare(`UPDATE anchors SET last_accessed_at = ? WHERE id = ?`).run(
      thirtyDaysAgo,
      anchor.id,
    );

    const fetched = repo.getAnchor(anchor.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.effectiveWeight).toBeLessThan(fetched!.currentWeight);
  });

  it('getByType returns anchors with effectiveWeight', () => {
    repo.createAnchor({
      label: 'Topic1',
      description: 'First topic',
      anchorType: 'topic',
    });

    const topics = repo.getByType('topic');
    expect(topics).toHaveLength(1);
    expect(topics[0].effectiveWeight).toBeDefined();
  });

  it('getAnchorsWithEmbeddings returns anchors with effectiveWeight', () => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    repo.createAnchor({
      label: 'Embedded',
      description: 'Anchor with embedding',
      anchorType: 'entity',
      embedding,
    });

    const anchors = repo.getAnchorsWithEmbeddings();
    expect(anchors).toHaveLength(1);
    expect(anchors[0].effectiveWeight).toBeDefined();
  });

  it('Anchor model has all required decay fields', () => {
    const anchor = repo.createAnchor({
      label: 'Complete',
      description: 'Anchor with all fields',
      anchorType: 'entity',
      initialWeight: 0.6,
      decayRate: 0.02,
    });

    // Verify all decay-related fields exist
    expect(anchor.decayRate).toBe(0.02);
    expect(anchor.currentWeight).toBe(0.6);
    expect(anchor.initialWeight).toBe(0.6);
    expect(anchor.effectiveWeight).toBe(0.6);
    expect(anchor.accessCount).toBe(0);
    expect(anchor.lastAccessedAt).toBeUndefined(); // Not accessed yet
    expect(anchor.activationCount).toBe(0);

    // After access, lastAccessedAt should be set
    const accessed = repo.recordAccess(anchor.id);
    expect(accessed).not.toBeNull();
    expect(accessed!.lastAccessedAt).toBeDefined();
    expect(accessed!.accessCount).toBe(1);
  });
});
