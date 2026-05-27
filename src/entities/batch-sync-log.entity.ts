import { Entity, Column, PrimaryColumn, CreateDateColumn } from 'typeorm';

/**
 * BatchSyncLog — records each applied batch corpus (ADR-009).
 *
 * `sequence` is the monotonic integer supplied by HCM with each batch push.
 * On ingest, the service rejects any batch whose sequence <= the highest
 * applied sequence (logged as STALE_REJECTED). This prevents re-delivered
 * or out-of-order batches from silently rewinding state.
 *
 * `asOf` drives the ADR-003 replay cutoff: effects with hcmAckAt > asOf
 * (or hcmAckAt IS NULL) must be replayed on top of the HCM base value.
 */
@Entity('batch_sync_log')
export class BatchSyncLog {
  /** Monotonic sequence from HCM. Acts as natural PK and dedup key. */
  @PrimaryColumn({ type: 'integer' })
  sequence!: number;

  /** HCM snapshot timestamp — the replay boundary for ADR-003. */
  @Column({ type: 'datetime' })
  asOf!: Date;

  /** When this service applied the batch. */
  @CreateDateColumn()
  appliedAt!: Date;
}
