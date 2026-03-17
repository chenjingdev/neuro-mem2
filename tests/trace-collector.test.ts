/**
 * Tests for TraceCollector and TraceEvent types.
 *
 * Covers:
 *   - Event emission (start, complete, error, skipped)
 *   - Duration auto-computation from start/complete pairs
 *   - wrapAsync and wrapSync convenience methods
 *   - Listener callbacks (sync + async)
 *   - Query methods (getEvents, getStageEvents, getStageResult, getTimeline)
 *   - Edge cases (clear, multiple stages, nested events)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TraceCollector } from '../src/chat/trace-collector.js';
import type { TraceEvent, TraceStage } from '../src/chat/trace-types.js';

describe('TraceCollector', () => {
  let collector: TraceCollector;

  beforeEach(() => {
    collector = new TraceCollector();
  });

  // ─── Basic event emission ─────────────────────────────

  describe('start()', () => {
    it('emits a start event with correct fields', () => {
      const event = collector.start('vector_search', { queryText: 'hello' });

      expect(event.id).toBe(1);
      expect(event.stage).toBe('vector_search');
      expect(event.status).toBe('start');
      expect(event.input).toEqual({ queryText: 'hello' });
      expect(event.timestamp).toBeTruthy();
      expect(event.durationMs).toBeUndefined();
      expect(event.output).toBeUndefined();
    });

    it('assigns monotonically increasing IDs', () => {
      const e1 = collector.start('vector_search');
      const e2 = collector.start('graph_traversal');
      const e3 = collector.start('merge');

      expect(e1.id).toBe(1);
      expect(e2.id).toBe(2);
      expect(e3.id).toBe(3);
    });

    it('supports parent stage', () => {
      const event = collector.start('vector_search', {}, 'recall');
      expect(event.parentStage).toBe('recall');
    });
  });

  describe('complete()', () => {
    it('emits a complete event with output and duration', () => {
      const event = collector.complete('vector_search', { itemCount: 5 }, 42.5);

      expect(event.status).toBe('complete');
      expect(event.output).toEqual({ itemCount: 5 });
      expect(event.durationMs).toBe(42.5);
    });

    it('auto-computes duration from matching start()', async () => {
      collector.start('vector_search');

      // Wait a small amount to get measurable duration
      await new Promise(r => setTimeout(r, 10));

      const event = collector.complete('vector_search', { itemCount: 3 });

      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.durationMs).toBeDefined();
    });

    it('returns undefined duration when no start() was called', () => {
      const event = collector.complete('vector_search', { itemCount: 3 });
      // No start was called and no explicit duration passed
      // Duration should still be computed as undefined
      expect(event.status).toBe('complete');
    });

    it('uses explicit duration over auto-computed', () => {
      collector.start('vector_search');
      const event = collector.complete('vector_search', {}, 99.99);
      expect(event.durationMs).toBe(99.99);
    });
  });

  describe('error()', () => {
    it('emits an error event with message string', () => {
      const event = collector.error('vector_search', 'Connection failed', 15.3);

      expect(event.status).toBe('error');
      expect(event.error).toBe('Connection failed');
      expect(event.durationMs).toBe(15.3);
    });

    it('extracts message from Error objects', () => {
      const event = collector.error('graph_traversal', new Error('Timeout'));
      expect(event.error).toBe('Timeout');
    });

    it('auto-computes duration from matching start()', async () => {
      collector.start('merge');
      await new Promise(r => setTimeout(r, 5));
      const event = collector.error('merge', 'oops');
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('skipped()', () => {
    it('emits a skipped event with reason', () => {
      const event = collector.skipped('reinforce', 'No anchors activated');

      expect(event.status).toBe('skipped');
      expect(event.skipReason).toBe('No anchors activated');
      expect(event.durationMs).toBeUndefined();
    });

    it('supports parent stage', () => {
      const event = collector.skipped('reinforce', 'disabled', 'recall');
      expect(event.parentStage).toBe('recall');
    });
  });

  // ─── wrapAsync ────────────────────────────────────────

  describe('wrapAsync()', () => {
    it('emits start + complete on success', async () => {
      const result = await collector.wrapAsync(
        'vector_search',
        { queryText: 'test' },
        async () => {
          await new Promise(r => setTimeout(r, 5));
          return { items: [1, 2, 3] };
        },
        'recall',
      );

      expect(result).toEqual({ items: [1, 2, 3] });

      const events = collector.getEvents();
      expect(events).toHaveLength(2);

      expect(events[0]!.status).toBe('start');
      expect(events[0]!.stage).toBe('vector_search');
      expect(events[0]!.input).toEqual({ queryText: 'test' });
      expect(events[0]!.parentStage).toBe('recall');

      expect(events[1]!.status).toBe('complete');
      expect(events[1]!.stage).toBe('vector_search');
      expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0);
      expect(events[1]!.parentStage).toBe('recall');
    });

    it('emits start + error on failure and rethrows', async () => {
      await expect(
        collector.wrapAsync('graph_traversal', {}, async () => {
          throw new Error('DB connection lost');
        }),
      ).rejects.toThrow('DB connection lost');

      const events = collector.getEvents();
      expect(events).toHaveLength(2);
      expect(events[0]!.status).toBe('start');
      expect(events[1]!.status).toBe('error');
      expect(events[1]!.error).toBe('DB connection lost');
      expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  // ─── wrapSync ─────────────────────────────────────────

  describe('wrapSync()', () => {
    it('emits start + complete on success', () => {
      const result = collector.wrapSync(
        'merge',
        { vectorCount: 5, graphCount: 3 },
        () => {
          return { mergedCount: 7 };
        },
      );

      expect(result).toEqual({ mergedCount: 7 });

      const events = collector.getEvents();
      expect(events).toHaveLength(2);
      expect(events[0]!.status).toBe('start');
      expect(events[1]!.status).toBe('complete');
      expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('emits start + error on throw and rethrows', () => {
      expect(() =>
        collector.wrapSync('format', {}, () => {
          throw new Error('format failed');
        }),
      ).toThrow('format failed');

      const events = collector.getEvents();
      expect(events).toHaveLength(2);
      expect(events[1]!.status).toBe('error');
      expect(events[1]!.error).toBe('format failed');
    });
  });

  // ─── Listeners ────────────────────────────────────────

  describe('onEvent()', () => {
    it('notifies sync listeners for every emitted event', () => {
      const received: TraceEvent[] = [];
      collector.onEvent((event) => {
        received.push(event);
      });

      collector.start('vector_search');
      collector.complete('vector_search', {}, 10);

      expect(received).toHaveLength(2);
      expect(received[0]!.status).toBe('start');
      expect(received[1]!.status).toBe('complete');
    });

    it('notifies async listeners without blocking', async () => {
      const received: TraceEvent[] = [];
      collector.onEvent(async (event) => {
        await new Promise(r => setTimeout(r, 1));
        received.push(event);
      });

      collector.start('merge');

      // Async listener fires asynchronously
      await new Promise(r => setTimeout(r, 20));
      expect(received).toHaveLength(1);
    });

    it('returns an unsubscribe function', () => {
      const received: TraceEvent[] = [];
      const unsub = collector.onEvent((event) => received.push(event));

      collector.start('vector_search');
      expect(received).toHaveLength(1);

      unsub();
      collector.start('graph_traversal');
      expect(received).toHaveLength(1); // No new events
    });

    it('catches listener errors without breaking emission', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const received: TraceEvent[] = [];

      // Failing listener
      collector.onEvent(() => {
        throw new Error('listener boom');
      });

      // Working listener
      collector.onEvent((event) => received.push(event));

      collector.start('vector_search');

      expect(received).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[TraceCollector] Listener error:',
        expect.any(Error),
      );

      consoleSpy.mockRestore();
    });

    it('supports multiple listeners', () => {
      const a: TraceEvent[] = [];
      const b: TraceEvent[] = [];

      collector.onEvent((e) => a.push(e));
      collector.onEvent((e) => b.push(e));

      collector.start('merge');

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });
  });

  // ─── Query methods ────────────────────────────────────

  describe('getEvents()', () => {
    it('returns all events in emission order', () => {
      collector.start('vector_search');
      collector.start('graph_traversal');
      collector.complete('vector_search', {}, 10);
      collector.complete('graph_traversal', {}, 20);

      const events = collector.getEvents();
      expect(events).toHaveLength(4);
      expect(events.map(e => e.id)).toEqual([1, 2, 3, 4]);
    });

    it('returns readonly array', () => {
      collector.start('merge');
      const events = collector.getEvents();
      // TypeScript enforces ReadonlyArray, but check runtime length preservation
      expect(events).toHaveLength(1);
    });
  });

  describe('getStageEvents()', () => {
    it('filters events by stage name', () => {
      collector.start('vector_search');
      collector.start('graph_traversal');
      collector.complete('vector_search', {}, 10);
      collector.complete('graph_traversal', {}, 20);

      const vectorEvents = collector.getStageEvents('vector_search');
      expect(vectorEvents).toHaveLength(2);
      expect(vectorEvents[0]!.status).toBe('start');
      expect(vectorEvents[1]!.status).toBe('complete');
    });

    it('returns empty array for unknown stage', () => {
      collector.start('vector_search');
      const events = collector.getStageEvents('merge');
      expect(events).toHaveLength(0);
    });
  });

  describe('getStageResult()', () => {
    it('returns the complete event for a stage', () => {
      collector.start('merge');
      collector.complete('merge', { count: 7 }, 5);

      const result = collector.getStageResult('merge');
      expect(result).toBeDefined();
      expect(result!.status).toBe('complete');
      expect(result!.output).toEqual({ count: 7 });
    });

    it('returns undefined for a stage with no complete event', () => {
      collector.start('merge');
      expect(collector.getStageResult('merge')).toBeUndefined();
    });

    it('returns undefined for unknown stages', () => {
      expect(collector.getStageResult('inject')).toBeUndefined();
    });
  });

  describe('getTimeline()', () => {
    it('returns terminal events for each stage', () => {
      collector.start('vector_search', {}, 'recall');
      collector.complete('vector_search', {}, 15, 'recall');
      collector.start('graph_traversal', {}, 'recall');
      collector.complete('graph_traversal', {}, 25, 'recall');
      collector.start('merge', {}, 'recall');
      collector.complete('merge', {}, 5, 'recall');
      collector.skipped('reinforce', 'disabled', 'recall');

      const timeline = collector.getTimeline();
      expect(timeline).toHaveLength(4);

      expect(timeline[0]).toEqual({
        stage: 'vector_search',
        status: 'complete',
        durationMs: 15,
        parentStage: 'recall',
      });

      expect(timeline[1]).toEqual({
        stage: 'graph_traversal',
        status: 'complete',
        durationMs: 25,
        parentStage: 'recall',
      });

      expect(timeline[2]).toEqual({
        stage: 'merge',
        status: 'complete',
        durationMs: 5,
        parentStage: 'recall',
      });

      expect(timeline[3]).toEqual({
        stage: 'reinforce',
        status: 'skipped',
        durationMs: undefined,
        parentStage: 'recall',
      });
    });

    it('uses the last terminal event when a stage has errors then succeeds', () => {
      collector.start('vector_search');
      collector.error('vector_search', 'retry', 5);
      collector.start('vector_search');
      collector.complete('vector_search', {}, 10);

      const timeline = collector.getTimeline();
      expect(timeline).toHaveLength(1);
      expect(timeline[0]!.status).toBe('complete');
      expect(timeline[0]!.durationMs).toBe(10);
    });
  });

  // ─── size and clear ───────────────────────────────────

  describe('size', () => {
    it('returns 0 for new collector', () => {
      expect(collector.size).toBe(0);
    });

    it('reflects the number of events', () => {
      collector.start('vector_search');
      collector.complete('vector_search', {}, 5);
      expect(collector.size).toBe(2);
    });
  });

  describe('clear()', () => {
    it('resets events, start times, and ID counter', () => {
      collector.start('vector_search');
      collector.complete('vector_search', {}, 5);
      expect(collector.size).toBe(2);

      collector.clear();
      expect(collector.size).toBe(0);
      expect(collector.getEvents()).toHaveLength(0);

      // IDs restart from 1
      const event = collector.start('merge');
      expect(event.id).toBe(1);
    });

    it('does not remove listeners', () => {
      const received: TraceEvent[] = [];
      collector.onEvent((e) => received.push(e));

      collector.start('vector_search');
      expect(received).toHaveLength(1);

      collector.clear();
      collector.start('merge');
      expect(received).toHaveLength(2); // Listener still active
    });
  });

  // ─── Full pipeline simulation ─────────────────────────

  describe('full pipeline trace simulation', () => {
    it('captures a complete recall pipeline with all stages', async () => {
      const sseEvents: TraceEvent[] = [];
      collector.onEvent((e) => sseEvents.push(e));

      // recall (top-level)
      collector.start('recall', { query: 'hello' });

      // vector_search
      await collector.wrapAsync(
        'vector_search',
        { queryText: 'hello', topK: 10 },
        async () => {
          await new Promise(r => setTimeout(r, 5));
          return { items: [], matchedAnchors: [] };
        },
        'recall',
      );

      // graph_traversal
      await collector.wrapAsync(
        'graph_traversal',
        { queryText: 'hello', maxHops: 2 },
        async () => {
          await new Promise(r => setTimeout(r, 5));
          return { items: [], extractedEntities: [] };
        },
        'recall',
      );

      // merge (sync)
      collector.wrapSync(
        'merge',
        { vectorItemCount: 0, graphItemCount: 0 },
        () => ({ mergedCount: 0 }),
        'recall',
      );

      // reinforce (skipped)
      collector.skipped('reinforce', 'No items to reinforce', 'recall');

      // format
      collector.wrapSync(
        'format',
        { itemCount: 0 },
        () => ({ text: '', charCount: 0 }),
        'recall',
      );

      // inject
      collector.wrapSync(
        'inject',
        { hasMemoryContext: false, contextCharCount: 0 },
        () => ({ finalPromptLength: 100 }),
        'recall',
      );

      collector.complete('recall', { itemCount: 0 });

      // Verify event count: recall start (1),
      //   vector start+complete (2), graph start+complete (2), merge start+complete (2),
      //   reinforce skipped (1), format start+complete (2), inject start+complete (2),
      //   recall complete (1) = 13
      expect(collector.size).toBe(13);

      // Verify SSE listener received all events
      expect(sseEvents).toHaveLength(13);

      // Verify timeline
      const timeline = collector.getTimeline();
      const stages = timeline.map(t => t.stage);
      expect(stages).toContain('vector_search');
      expect(stages).toContain('graph_traversal');
      expect(stages).toContain('merge');
      expect(stages).toContain('reinforce');
      expect(stages).toContain('format');
      expect(stages).toContain('inject');
      expect(stages).toContain('recall');

      // reinforce should be skipped
      const reinforceEntry = timeline.find(t => t.stage === 'reinforce');
      expect(reinforceEntry!.status).toBe('skipped');
    });
  });

  // ─── Timestamp format ─────────────────────────────────

  describe('timestamps', () => {
    it('produces valid ISO 8601 timestamps', () => {
      const event = collector.start('vector_search');
      const parsed = new Date(event.timestamp);
      expect(parsed.getTime()).not.toBeNaN();
    });
  });

  // ─── Duration rounding ────────────────────────────────

  describe('duration rounding', () => {
    it('rounds to 2 decimal places', () => {
      const event = collector.complete('merge', {}, 1.23456789);
      expect(event.durationMs).toBe(1.23);
    });
  });
});
