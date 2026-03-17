/**
 * Batch Extraction Pipeline.
 *
 * Subscribes to session.ended events and creates batch extraction jobs
 * for Episode and Concept extraction. Jobs are processed asynchronously.
 *
 * The pipeline uses a pluggable extractor interface so the actual
 * extraction logic (LLM API calls) can be swapped without changing
 * the pipeline orchestration.
 */

import type { SessionRepository } from '../db/session-repo.js';
import type { EventBus, SessionEndedEvent } from '../events/event-bus.js';
import type { BatchJob, BatchJobType } from '../models/session.js';

/**
 * Extractor interface — pluggable extraction logic.
 * Implementations can use LLM API, local ML models, or rule-based extraction.
 */
export interface BatchExtractor {
  /** Unique extractor name */
  readonly name: string;
  /** The job type this extractor handles */
  readonly jobType: BatchJobType;
  /**
   * Execute the extraction for a conversation.
   * Returns result data to be stored with the job.
   */
  extract(conversationId: string, sessionId: string): Promise<Record<string, unknown>>;
}

export interface BatchPipelineOptions {
  /** Maximum concurrent jobs. Default: 2 */
  concurrency?: number;
  /** Job types to create on session end. Default: ['episode_extraction', 'concept_extraction'] */
  jobTypes?: BatchJobType[];
  /** Maximum retry attempts for failed jobs. Default: 0 (no retry) */
  maxRetries?: number;
}

export class BatchPipeline {
  private extractors = new Map<BatchJobType, BatchExtractor>();
  private processing = false;
  private unsubscribe: (() => void) | null = null;
  private readonly concurrency: number;
  private readonly jobTypes: BatchJobType[];
  private readonly maxRetries: number;

  /** Resolvers for waitForSession() callers */
  private sessionWaiters = new Map<string, Array<(jobs: BatchJob[]) => void>>();

  constructor(
    private repo: SessionRepository,
    private eventBus: EventBus,
    options: BatchPipelineOptions = {}
  ) {
    this.concurrency = options.concurrency ?? 2;
    this.jobTypes = options.jobTypes ?? ['episode_extraction', 'concept_extraction'];
    this.maxRetries = options.maxRetries ?? 0;
  }

  /**
   * Register an extractor for a specific job type.
   */
  registerExtractor(extractor: BatchExtractor): void {
    this.extractors.set(extractor.jobType, extractor);
  }

  /**
   * Start listening for session.ended events.
   */
  start(): void {
    if (this.unsubscribe) return;

    this.unsubscribe = this.eventBus.on<SessionEndedEvent>(
      'session.ended',
      async (event) => {
        await this.onSessionEnded(event);
      }
    );
  }

  /**
   * Stop listening and clean up.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /**
   * Handle a session ended event: create batch jobs for the session.
   */
  async onSessionEnded(event: SessionEndedEvent): Promise<BatchJob[]> {
    const jobs: BatchJob[] = [];

    for (const jobType of this.jobTypes) {
      const job = this.repo.createBatchJob(
        event.sessionId,
        event.conversationId,
        jobType
      );
      jobs.push(job);

      await this.eventBus.emit({
        type: 'batch.job.created',
        jobId: job.id,
        sessionId: event.sessionId,
        conversationId: event.conversationId,
        jobType,
        timestamp: new Date().toISOString(),
      });
    }

    // Update session status to processing
    this.repo.updateSessionStatus(event.sessionId, 'processing');

    // Process jobs (non-blocking)
    this.processJobs().catch((err) => {
      console.error('Batch pipeline processing error:', err);
    });

    return jobs;
  }

  /**
   * Process pending batch jobs.
   * Can be called manually or triggered automatically.
   */
  async processJobs(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (true) {
        const pendingJobs = this.repo.getPendingBatchJobs(this.concurrency);
        if (pendingJobs.length === 0) break;

        const promises = pendingJobs.map((job) => this.executeJob(job));
        await Promise.all(promises);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Retry all failed jobs for a session.
   * Resets failed jobs to pending and kicks off processing.
   */
  async retryFailedJobs(sessionId: string): Promise<BatchJob[]> {
    const retriedJobs = this.repo.retryFailedJobsForSession(sessionId);
    if (retriedJobs.length > 0) {
      // Non-blocking processing
      this.processJobs().catch((err) => {
        console.error('Batch pipeline retry processing error:', err);
      });
    }
    return retriedJobs;
  }

  /**
   * Wait for all batch jobs for a session to complete.
   * Returns a promise that resolves when all jobs are done (completed or failed).
   * Useful for testing and synchronous workflows.
   */
  waitForSession(sessionId: string, timeoutMs = 30_000): Promise<BatchJob[]> {
    // Check if already done
    const jobs = this.repo.getBatchJobsBySession(sessionId);
    const allDone = jobs.length > 0 && jobs.every(j => j.status === 'completed' || j.status === 'failed');
    if (allDone) return Promise.resolve(jobs);

    return new Promise<BatchJob[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`waitForSession timed out after ${timeoutMs}ms for session ${sessionId}`));
      }, timeoutMs);

      // Poll-based approach — check periodically
      const pollInterval = setInterval(() => {
        const currentJobs = this.repo.getBatchJobsBySession(sessionId);
        const done = currentJobs.length > 0 && currentJobs.every(j => j.status === 'completed' || j.status === 'failed');
        if (done) {
          cleanup();
          resolve(currentJobs);
        }
      }, 25);

      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(pollInterval);
      };
    });
  }

  /**
   * Execute a single batch job.
   */
  private async executeJob(job: BatchJob): Promise<void> {
    const extractor = this.extractors.get(job.jobType);

    // Mark as running
    this.repo.updateBatchJob(job.id, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    if (!extractor) {
      // No extractor registered — mark as failed
      this.repo.updateBatchJob(job.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: `No extractor registered for job type: ${job.jobType}`,
      });

      await this.eventBus.emit({
        type: 'batch.job.failed',
        jobId: job.id,
        sessionId: job.sessionId,
        jobType: job.jobType,
        error: `No extractor registered for job type: ${job.jobType}`,
        timestamp: new Date().toISOString(),
      });

      await this.checkSessionCompletion(job.sessionId);
      return;
    }

    try {
      const result = await extractor.extract(job.conversationId, job.sessionId);

      this.repo.updateBatchJob(job.id, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        result,
      });

      await this.eventBus.emit({
        type: 'batch.job.completed',
        jobId: job.id,
        sessionId: job.sessionId,
        jobType: job.jobType,
        timestamp: new Date().toISOString(),
      });

      // Check if all jobs for this session are done
      await this.checkSessionCompletion(job.sessionId);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);

      this.repo.updateBatchJob(job.id, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMsg,
      });

      await this.eventBus.emit({
        type: 'batch.job.failed',
        jobId: job.id,
        sessionId: job.sessionId,
        jobType: job.jobType,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      });

      await this.checkSessionCompletion(job.sessionId);
    }
  }

  /**
   * Check if all batch jobs for a session are complete,
   * and update the session status accordingly.
   */
  private async checkSessionCompletion(sessionId: string): Promise<void> {
    const jobs = this.repo.getBatchJobsBySession(sessionId);
    const allDone = jobs.every((j) => j.status === 'completed' || j.status === 'failed');

    if (allDone) {
      const anyFailed = jobs.some((j) => j.status === 'failed');
      this.repo.updateSessionStatus(sessionId, anyFailed ? 'failed' : 'completed');
    }
  }

  /**
   * Get the status of all batch jobs for a session.
   */
  getSessionJobs(sessionId: string): BatchJob[] {
    return this.repo.getBatchJobsBySession(sessionId);
  }
}
