/**
 * Decay Simulator API Router
 *
 * REST endpoints for edge decay simulation:
 *   POST /simulate          — Simulate decay for a single edge (by state or edge ID)
 *   POST /simulate/batch    — Simulate decay for multiple edges
 *   POST /project-death     — Project death event for an edge
 *   POST /project-shield    — Project shield depletion event
 *
 * All endpoints accept simulation parameters (totalSteps, stepSize, speed, etc.)
 * and return projected decay timelines.
 */

import { Hono } from 'hono';
import type Database from 'better-sqlite3';
import {
  DecaySimulator,
  simulateEdgeDecay,
  simulateBatchDecay,
  projectDeathEvent,
  projectShieldDepletionEvent,
  DEFAULT_SIMULATION_PARAMS,
  type DecaySimulationParams,
  type DecaySimulationResult,
  type BatchDecaySimulationResult,
} from '../scoring/decay-simulator.js';
import type { LazyDecayInput } from '../scoring/lazy-decay-evaluator.js';
import { WeightedEdgeRepository } from '../db/weighted-edge-repo.js';
import type { ErrorResponse } from './schemas.js';

// ─── Dependencies ─────────────────────────────────────────

export interface DecaySimulatorRouterDeps {
  /** Database for looking up edge state by ID */
  db: Database.Database;
  /** Optional pre-configured simulator instance */
  simulator?: DecaySimulator;
}

// ─── Request/Response Types ─────────────────────────────────

interface SimulateRequest {
  /** Edge state to simulate (provide this OR edgeId) */
  edgeState?: {
    weight: number;
    shield: number;
    decayRate: number;
    lastActivatedAtEvent: number;
  };
  /** Edge ID to look up state from DB (alternative to edgeState) */
  edgeId?: string;
  /** Simulation parameters */
  params?: Partial<DecaySimulationParams>;
}

interface BatchSimulateRequest {
  /** Array of edge states or IDs */
  edges: Array<{
    edgeId: string;
    edgeState?: {
      weight: number;
      shield: number;
      decayRate: number;
      lastActivatedAtEvent: number;
    };
  }>;
  /** Shared simulation parameters */
  params?: Partial<DecaySimulationParams>;
}

interface ProjectDeathRequest {
  edgeState?: {
    weight: number;
    shield: number;
    decayRate: number;
    lastActivatedAtEvent: number;
  };
  edgeId?: string;
  shieldDecayRate?: number;
}

interface ProjectShieldRequest {
  shield: number;
  lastActivatedAtEvent: number;
  shieldDecayRate?: number;
}

// ─── Validation ─────────────────────────────────────────────

function validateEdgeState(state: unknown): string[] {
  const errors: string[] = [];
  if (!state || typeof state !== 'object') {
    errors.push('edgeState must be an object');
    return errors;
  }
  const s = state as Record<string, unknown>;
  if (typeof s.weight !== 'number' || s.weight < 0) errors.push('edgeState.weight must be a non-negative number');
  if (typeof s.shield !== 'number' || s.shield < 0) errors.push('edgeState.shield must be a non-negative number');
  if (typeof s.decayRate !== 'number' || s.decayRate < 0) errors.push('edgeState.decayRate must be a non-negative number');
  if (typeof s.lastActivatedAtEvent !== 'number') errors.push('edgeState.lastActivatedAtEvent must be a number');
  return errors;
}

function validateSimParams(params: unknown): string[] {
  if (!params) return [];
  if (typeof params !== 'object') return ['params must be an object'];
  const p = params as Record<string, unknown>;
  const errors: string[] = [];
  if (p.totalSteps !== undefined && (typeof p.totalSteps !== 'number' || p.totalSteps < 1 || p.totalSteps > 10000)) {
    errors.push('params.totalSteps must be 1-10000');
  }
  if (p.stepSize !== undefined && (typeof p.stepSize !== 'number' || p.stepSize < 1 || p.stepSize > 1000)) {
    errors.push('params.stepSize must be 1-1000');
  }
  if (p.speed !== undefined && (typeof p.speed !== 'number' || p.speed <= 0 || p.speed > 100)) {
    errors.push('params.speed must be 0<speed<=100');
  }
  return errors;
}

// ─── Router Factory ─────────────────────────────────────────

export function createDecaySimulatorRouter(deps: DecaySimulatorRouterDeps): Hono {
  const app = new Hono();
  const edgeRepo = new WeightedEdgeRepository(deps.db);
  const simulator = deps.simulator ?? new DecaySimulator();

  /**
   * Resolve edge state: either from provided edgeState or by looking up edgeId.
   */
  function resolveEdgeState(edgeState?: SimulateRequest['edgeState'], edgeId?: string): LazyDecayInput | null {
    if (edgeState) {
      return {
        weight: edgeState.weight,
        shield: edgeState.shield,
        decayRate: edgeState.decayRate,
        lastActivatedAtEvent: edgeState.lastActivatedAtEvent,
      };
    }
    if (edgeId) {
      const edge = edgeRepo.getEdge(edgeId);
      if (!edge) return null;
      return {
        weight: edge.weight,
        shield: edge.shield,
        decayRate: edge.decayRate,
        lastActivatedAtEvent: edge.lastActivatedAtEvent,
      };
    }
    return null;
  }

  // ── POST /simulate — Single edge decay simulation ──
  app.post('/simulate', async (c) => {
    try {
      const body = await c.req.json() as SimulateRequest;

      // Validate
      if (!body.edgeState && !body.edgeId) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'Provide edgeState or edgeId' } as ErrorResponse, 400);
      }

      if (body.edgeState) {
        const stateErrors = validateEdgeState(body.edgeState);
        if (stateErrors.length > 0) {
          return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid edgeState', details: stateErrors } as ErrorResponse, 400);
        }
      }

      const paramErrors = validateSimParams(body.params);
      if (paramErrors.length > 0) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid params', details: paramErrors } as ErrorResponse, 400);
      }

      const state = resolveEdgeState(body.edgeState, body.edgeId);
      if (!state) {
        return c.json({ error: 'NOT_FOUND', message: `Edge not found: ${body.edgeId}` } as ErrorResponse, 404);
      }

      const result = simulator.simulate(state, body.params);
      return c.json(result, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return c.json({ error: 'INTERNAL_ERROR', message } as ErrorResponse, 500);
    }
  });

  // ── POST /simulate/batch — Batch edge decay simulation ──
  app.post('/simulate/batch', async (c) => {
    try {
      const body = await c.req.json() as BatchSimulateRequest;

      if (!body.edges || !Array.isArray(body.edges) || body.edges.length === 0) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'edges must be a non-empty array' } as ErrorResponse, 400);
      }

      if (body.edges.length > 1000) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'Maximum 1000 edges per batch' } as ErrorResponse, 400);
      }

      const paramErrors = validateSimParams(body.params);
      if (paramErrors.length > 0) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid params', details: paramErrors } as ErrorResponse, 400);
      }

      const resolvedEdges: Array<{ edgeId: string; state: LazyDecayInput }> = [];
      const notFound: string[] = [];

      for (const edge of body.edges) {
        const state = resolveEdgeState(edge.edgeState, edge.edgeId);
        if (!state) {
          notFound.push(edge.edgeId);
          continue;
        }
        resolvedEdges.push({ edgeId: edge.edgeId, state });
      }

      if (resolvedEdges.length === 0) {
        return c.json({ error: 'NOT_FOUND', message: 'No edges found', details: notFound } as ErrorResponse, 404);
      }

      const result = simulator.simulateBatch(resolvedEdges, body.params);

      // Include not-found IDs in response if any
      const response: BatchDecaySimulationResult & { notFound?: string[] } = {
        ...result,
        ...(notFound.length > 0 ? { notFound } : {}),
      };

      return c.json(response, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return c.json({ error: 'INTERNAL_ERROR', message } as ErrorResponse, 500);
    }
  });

  // ── POST /project-death — Project when an edge will die ──
  app.post('/project-death', async (c) => {
    try {
      const body = await c.req.json() as ProjectDeathRequest;

      if (!body.edgeState && !body.edgeId) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'Provide edgeState or edgeId' } as ErrorResponse, 400);
      }

      if (body.edgeState) {
        const stateErrors = validateEdgeState(body.edgeState);
        if (stateErrors.length > 0) {
          return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid edgeState', details: stateErrors } as ErrorResponse, 400);
        }
      }

      const state = resolveEdgeState(body.edgeState, body.edgeId);
      if (!state) {
        return c.json({ error: 'NOT_FOUND', message: `Edge not found: ${body.edgeId}` } as ErrorResponse, 404);
      }

      const config = body.shieldDecayRate !== undefined
        ? { shieldDecayRate: body.shieldDecayRate }
        : undefined;

      const deathEvent = projectDeathEvent(state, config);
      const shieldDepletion = projectShieldDepletionEvent(
        state.shield,
        state.lastActivatedAtEvent,
        body.shieldDecayRate,
      );

      return c.json({
        deathEvent,
        shieldDepletionEvent: shieldDepletion,
        currentWeight: state.weight,
        currentShield: state.shield,
        decayRate: state.decayRate,
        lastActivatedAtEvent: state.lastActivatedAtEvent,
        eventsUntilDeath: deathEvent !== null ? deathEvent - state.lastActivatedAtEvent : null,
        eventsUntilShieldDepleted: shieldDepletion !== null ? shieldDepletion - state.lastActivatedAtEvent : null,
      }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return c.json({ error: 'INTERNAL_ERROR', message } as ErrorResponse, 500);
    }
  });

  // ── POST /project-shield — Project shield depletion ──
  app.post('/project-shield', async (c) => {
    try {
      const body = await c.req.json() as ProjectShieldRequest;

      if (typeof body.shield !== 'number' || body.shield < 0) {
        return c.json({ error: 'VALIDATION_ERROR', message: 'shield must be a non-negative number' } as ErrorResponse, 400);
      }
      if (typeof body.lastActivatedAtEvent !== 'number') {
        return c.json({ error: 'VALIDATION_ERROR', message: 'lastActivatedAtEvent must be a number' } as ErrorResponse, 400);
      }

      const depletionEvent = projectShieldDepletionEvent(
        body.shield,
        body.lastActivatedAtEvent,
        body.shieldDecayRate,
      );

      return c.json({
        depletionEvent,
        shield: body.shield,
        lastActivatedAtEvent: body.lastActivatedAtEvent,
        shieldDecayRate: body.shieldDecayRate ?? 0.5,
        eventsUntilDepletion: depletionEvent !== null ? depletionEvent - body.lastActivatedAtEvent : null,
      }, 200);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Internal server error';
      return c.json({ error: 'INTERNAL_ERROR', message } as ErrorResponse, 500);
    }
  });

  return app;
}
