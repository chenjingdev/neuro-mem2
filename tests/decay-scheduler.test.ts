/**
 * Tests for DecayScheduler — periodic background process that applies
 * Hebbian weight decay to all weighted edges.
 *
 * Sub-AC 6.3: 주기적 decay 적용 스케줄러/배치 프로세스 구현
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createDatabase } from '../src/db/connection.js';
import { AnchorRepository } from '../src/db/anchor-repo.js';
import { WeightedEdgeRepository } from '../src/db/weighted-edge-repo.js';
import { EventBus } from '../src/events/event-bus.js';
import { DecayScheduler, type DecayCycleResult, type DecayCompletedEvent, type DecayErrorEvent } from '../src/services/decay-scheduler.js';

describe('DecayScheduler', () => {
  let db: Database.Database;
  let anchorRepo: AnchorRepository;
  let weightedEdgeRepo: WeightedEdgeRepository;
  let eventBus: EventBus;
  let scheduler: DecayScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    db = createDatabase({ inMemory: true });
    anchorRepo = new AnchorRepository(db);
    weightedEdgeRepo = new WeightedEdgeRepository(db);
    eventBus = new EventBus();
  });

  afterEach(() => {
    scheduler?.dispose();
    eventBus.clear();
    vi.useRealTimers();
  });

  // Helper to create test edges
  function createTestEdges() {
    // Create some edges with different weights and decay rates
    weightedEdgeRepo.createEdge({
      sourceId: 'anchor-1', sourceType: 'anchor',
      targetId: 'fact-1', targetType: 'fact',
      edgeType: 'anchor_to_fact', weight: 0.8, decayRate: 0.1,
    });
    weightedEdgeRepo.createEdge({
      sourceId: 'anchor-1', sourceType: 'anchor',
      targetId: 'fact-2', targetType: 'fact',
      edgeType: 'anchor_to_fact', weight: 0.5, decayRate: 0.1,
    });
    weightedEdgeRepo.createEdge({
      sourceId: 'anchor-1', sourceType: 'anchor',
      targetId: 'ep-1', targetType: 'episode',
      edgeType: 'anchor_to_episode', weight: 0.3, decayRate: 0.05,
    });
    // Edge with zero decay rate — should not be affected
    weightedEdgeRepo.createEdge({
      sourceId: 'anchor-1', sourceType: 'anchor',
      targetId: 'concept-1', targetType: 'concept',
      edgeType: 'anchor_to_concept', weight: 0.9, decayRate: 0.0,
    });
  }

  // ── Constructor & Configuration ──

  describe('constructor', () => {
    it('should create with default options', () => {
      scheduler = new DecayScheduler(weightedEdgeRepo);
      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getTotalCycles()).toBe(0);
      expect(scheduler.getLastResult()).toBeNull();
    });

    it('should accept custom options', () => {
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, {
        intervalMs: 5000,
        pruneBelow: 0.05,
      });
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should throw for non-positive intervalMs', () => {
      expect(() => {
        new DecayScheduler(weightedEdgeRepo, eventBus, { intervalMs: 0 });
      }).toThrow('intervalMs must be positive');

      expect(() => {
        new DecayScheduler(weightedEdgeRepo, eventBus, { intervalMs: -100 });
      }).toThrow('intervalMs must be positive');
    });
  });

  // ── Manual Execution (executeCycle) ──

  describe('executeCycle', () => {
    it('should execute a single decay cycle and return results', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { pruneBelow: 0.01 });

      const result = await scheduler.executeCycle();

      expect(result.decayedCount).toBe(3); // 3 edges with decay_rate > 0
      expect(result.prunedCount).toBe(0);  // No edges below threshold
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
    });

    it('should apply decay formula: w_new = w * (1 - decay_rate)', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus);

      await scheduler.executeCycle();

      const edges = weightedEdgeRepo.getOutgoingEdges('anchor-1');
      // Sort by target for deterministic checks
      const edgeMap = new Map(edges.map(e => [e.targetId, e]));

      // fact-1: 0.8 * (1 - 0.1) = 0.72
      expect(edgeMap.get('fact-1')!.weight).toBeCloseTo(0.72);
      // fact-2: 0.5 * (1 - 0.1) = 0.45
      expect(edgeMap.get('fact-2')!.weight).toBeCloseTo(0.45);
      // ep-1: 0.3 * (1 - 0.05) = 0.285
      expect(edgeMap.get('ep-1')!.weight).toBeCloseTo(0.285);
      // concept-1: should remain 0.9 (zero decay rate)
      expect(edgeMap.get('concept-1')!.weight).toBeCloseTo(0.9);
    });

    it('should prune edges below threshold after decay', async () => {
      // Create an edge that will drop below threshold
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.02, decayRate: 0.5,
      });
      // After decay: 0.02 * 0.5 = 0.01 → below 0.02 threshold

      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { pruneBelow: 0.02 });

      const result = await scheduler.executeCycle();
      expect(result.prunedCount).toBe(1);
      expect(weightedEdgeRepo.countEdges()).toBe(0);
    });

    it('should handle empty edge set gracefully', async () => {
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus);

      const result = await scheduler.executeCycle();
      expect(result.decayedCount).toBe(0);
      expect(result.prunedCount).toBe(0);
    });

    it('should track cycle count', async () => {
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus);

      expect(scheduler.getTotalCycles()).toBe(0);
      await scheduler.executeCycle();
      expect(scheduler.getTotalCycles()).toBe(1);
      await scheduler.executeCycle();
      expect(scheduler.getTotalCycles()).toBe(2);
    });

    it('should update lastResult after each cycle', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus);

      expect(scheduler.getLastResult()).toBeNull();

      await scheduler.executeCycle();
      const result1 = scheduler.getLastResult();
      expect(result1).not.toBeNull();
      expect(result1!.decayedCount).toBe(3);

      // Advance time so the second cycle gets a different timestamp
      vi.advanceTimersByTime(1000);

      await scheduler.executeCycle();
      const result2 = scheduler.getLastResult();
      expect(result2).not.toBeNull();
      expect(result2!.timestamp).not.toBe(result1!.timestamp);
    });

    it('should apply cumulative decay over multiple cycles', async () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 1.0, decayRate: 0.1,
      });

      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus);

      // Cycle 1: 1.0 * 0.9 = 0.9
      await scheduler.executeCycle();
      let edge = weightedEdgeRepo.getOutgoingEdges('a1')[0];
      expect(edge.weight).toBeCloseTo(0.9);

      // Cycle 2: 0.9 * 0.9 = 0.81
      await scheduler.executeCycle();
      edge = weightedEdgeRepo.getOutgoingEdges('a1')[0];
      expect(edge.weight).toBeCloseTo(0.81);

      // Cycle 3: 0.81 * 0.9 = 0.729
      await scheduler.executeCycle();
      edge = weightedEdgeRepo.getOutgoingEdges('a1')[0];
      expect(edge.weight).toBeCloseTo(0.729);
    });
  });

  // ── EventBus Integration ──

  describe('event emission', () => {
    it('should emit decay.completed event after successful cycle', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus);

      const events: DecayCompletedEvent[] = [];
      eventBus.on('decay.completed' as any, (event: any) => {
        events.push(event);
      });

      await scheduler.executeCycle();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('decay.completed');
      expect(events[0].decayedCount).toBe(3);
      expect(events[0].prunedCount).toBe(0);
      expect(events[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(events[0].timestamp).toBeDefined();
    });

    it('should work without eventBus (null)', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, null);

      // Should not throw even though no eventBus
      const result = await scheduler.executeCycle();
      expect(result.decayedCount).toBe(3);
    });
  });

  // ── Periodic Scheduling ──

  describe('periodic scheduling', () => {
    it('should start and stop the scheduler', () => {
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { intervalMs: 1000 });

      expect(scheduler.isRunning()).toBe(false);
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('start should be idempotent', () => {
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { intervalMs: 1000 });

      scheduler.start();
      scheduler.start(); // No-op
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });

    it('stop should be idempotent', () => {
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { intervalMs: 1000 });

      scheduler.stop(); // No-op when not running
      scheduler.start();
      scheduler.stop();
      scheduler.stop(); // No-op when already stopped
      expect(scheduler.isRunning()).toBe(false);
    });

    it('should execute decay cycle periodically', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { intervalMs: 1000 });

      const events: any[] = [];
      eventBus.on('decay.completed' as any, (event: any) => {
        events.push(event);
      });

      scheduler.start();

      // Advance timer by 1 second — first interval fires
      await vi.advanceTimersByTimeAsync(1000);
      expect(events.length).toBeGreaterThanOrEqual(1);

      // Advance by another second — second interval fires
      await vi.advanceTimersByTimeAsync(1000);
      expect(events.length).toBeGreaterThanOrEqual(2);

      scheduler.stop();
    });

    it('should not execute after stop', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { intervalMs: 1000 });

      let cycleCount = 0;
      eventBus.on('decay.completed' as any, () => { cycleCount++; });

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1000);
      const countAfterOne = cycleCount;

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(cycleCount).toBe(countAfterOne); // No additional cycles
    });

    it('should run immediate cycle when runOnStart is true', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, {
        intervalMs: 10000,
        runOnStart: true,
      });

      const events: any[] = [];
      eventBus.on('decay.completed' as any, (event: any) => {
        events.push(event);
      });

      scheduler.start();

      // Flush microtasks for the immediate cycle
      await vi.advanceTimersByTimeAsync(0);

      expect(events.length).toBeGreaterThanOrEqual(1);
      scheduler.stop();
    });
  });

  // ── Dispose ──

  describe('dispose', () => {
    it('should stop scheduler and reset state', async () => {
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { intervalMs: 1000 });

      await scheduler.executeCycle();
      expect(scheduler.getTotalCycles()).toBe(1);

      scheduler.start();
      scheduler.dispose();

      expect(scheduler.isRunning()).toBe(false);
      expect(scheduler.getTotalCycles()).toBe(0);
      expect(scheduler.getLastResult()).toBeNull();
    });
  });

  // ── Edge Cases ──

  describe('edge cases', () => {
    it('should handle concurrent executeCycle calls gracefully', async () => {
      createTestEdges();
      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus);

      // Fire two cycles concurrently
      const [result1, result2] = await Promise.all([
        scheduler.executeCycle(),
        scheduler.executeCycle(),
      ]);

      // One should get the real result, the other a fallback
      expect(result1.decayedCount + result2.decayedCount).toBeGreaterThan(0);
    });

    it('should work with only zero-decay-rate edges', async () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.8, decayRate: 0.0,
      });

      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus);
      const result = await scheduler.executeCycle();

      expect(result.decayedCount).toBe(0);
      // Weight unchanged
      const edge = weightedEdgeRepo.getOutgoingEdges('a1')[0];
      expect(edge.weight).toBeCloseTo(0.8);
    });

    it('should work with very small prune threshold', async () => {
      weightedEdgeRepo.createEdge({
        sourceId: 'a1', sourceType: 'anchor',
        targetId: 'f1', targetType: 'fact',
        edgeType: 'anchor_to_fact', weight: 0.001, decayRate: 0.5,
      });

      scheduler = new DecayScheduler(weightedEdgeRepo, eventBus, { pruneBelow: 0.001 });
      const result = await scheduler.executeCycle();

      // After decay: 0.001 * 0.5 = 0.0005, below 0.001 → pruned
      expect(result.prunedCount).toBe(1);
    });
  });
});
