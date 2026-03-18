/**
 * Tests for hub size differentiation based on degree (connection count).
 * Verifies that hub nodes with more connections appear visually larger.
 *
 * Note: graphology is installed in web/node_modules, so integration tests
 * that need graphology Graph are marked with .skipIf when unavailable.
 */
import { describe, it, expect } from 'vitest';
import { computeDegreeSizedNode } from '../web/src/components/graph/graphUtils';

describe('computeDegreeSizedNode', () => {
  it('hub nodes should be larger than leaf nodes at same degree', () => {
    const hubSize = computeDegreeSizedNode(10, 20, 'hub', 0);
    const leafSize = computeDegreeSizedNode(10, 20, 'leaf', 0);
    expect(hubSize).toBeGreaterThan(leafSize);
  });

  it('higher degree should produce larger size', () => {
    const smallDegree = computeDegreeSizedNode(2, 50, 'hub', 0);
    const largeDegree = computeDegreeSizedNode(40, 50, 'hub', 0);
    expect(largeDegree).toBeGreaterThan(smallDegree);
  });

  it('zero degree should produce minimum size for hub (>=7)', () => {
    const hubMin = computeDegreeSizedNode(0, 100, 'hub', 0);
    expect(hubMin).toBeGreaterThanOrEqual(7);
    expect(hubMin).toBeLessThanOrEqual(30);
  });

  it('zero degree should produce minimum size for leaf (>=3)', () => {
    const leafMin = computeDegreeSizedNode(0, 100, 'leaf', 0);
    expect(leafMin).toBeGreaterThanOrEqual(3);
    expect(leafMin).toBeLessThanOrEqual(12);
  });

  it('max degree hub should approach maximum size (<=30)', () => {
    const hubMax = computeDegreeSizedNode(100, 100, 'hub', 0);
    expect(hubMax).toBeLessThanOrEqual(30);
    expect(hubMax).toBeGreaterThan(20); // Should be near max
  });

  it('max degree leaf should approach maximum leaf size (<=12)', () => {
    const leafMax = computeDegreeSizedNode(100, 100, 'leaf', 0);
    expect(leafMax).toBeLessThanOrEqual(12);
    expect(leafMax).toBeGreaterThan(8); // Should be near max
  });

  it('activation count provides secondary boost', () => {
    const noActivation = computeDegreeSizedNode(10, 50, 'hub', 0);
    const highActivation = computeDegreeSizedNode(10, 50, 'hub', 1000);
    expect(highActivation).toBeGreaterThan(noActivation);
  });

  it('handles edge case where maxDegree is 0', () => {
    const size = computeDegreeSizedNode(0, 0, 'hub', 0);
    expect(size).toBeGreaterThanOrEqual(7); // hub min
    expect(size).toBeLessThanOrEqual(30);
    expect(Number.isFinite(size)).toBe(true);
  });

  it('log scale prevents extreme outlier dominance', () => {
    // Degree 10 vs degree 1000 — ratio should be moderate, not 100x
    const deg10 = computeDegreeSizedNode(10, 1000, 'hub', 0);
    const deg1000 = computeDegreeSizedNode(1000, 1000, 'hub', 0);
    const ratio = deg1000 / deg10;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(5); // Log scale keeps ratio manageable
  });

  it('hub with degree 50 should be visually distinguishable from leaf with degree 50', () => {
    const hubSize = computeDegreeSizedNode(50, 100, 'hub', 5);
    const leafSize = computeDegreeSizedNode(50, 100, 'leaf', 5);
    // Hub should be at least 1.5x larger
    expect(hubSize / leafSize).toBeGreaterThan(1.5);
  });

  it('hub progression: degree 1 < 5 < 20 < 100', () => {
    const maxDeg = 100;
    const s1 = computeDegreeSizedNode(1, maxDeg, 'hub', 0);
    const s5 = computeDegreeSizedNode(5, maxDeg, 'hub', 0);
    const s20 = computeDegreeSizedNode(20, maxDeg, 'hub', 0);
    const s100 = computeDegreeSizedNode(100, maxDeg, 'hub', 0);
    expect(s5).toBeGreaterThan(s1);
    expect(s20).toBeGreaterThan(s5);
    expect(s100).toBeGreaterThan(s20);
  });
});
