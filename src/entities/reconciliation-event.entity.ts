import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import { ReconResolution } from './enums';

/**
 * ReconciliationEvent — immutable audit log entry per reconciliation outcome.
 *
 * Created by ReconciliationService for every balance examined during a batch
 * ingest. The `resolution` captures the outcome:
 *
 *   REPLAYED           — local in-flight effects were replayed on top of the HCM base.
 *   FLAGGED_NEGATIVE   — replay produced a negative available; needsReview set (B4).
 *   NO_CHANGE          — local and HCM values matched; no adjustments needed.
 *   STALE_REJECTED     — batch sequence <= last applied; entire batch rejected (ADR-009).
 *
 * Append-only — no UPDATE or DELETE ever issued against this table.
 */
@Entity('reconciliation_events')
export class ReconciliationEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  employeeId!: string;

  @Column({ type: 'varchar' })
  locationId!: string;

  /** Local available value before reconciliation. */
  @Column({ type: 'integer' })
  localValue!: number;

  /** HCM value from the batch snapshot. */
  @Column({ type: 'integer' })
  hcmValue!: number;

  @Column({ type: 'varchar' })
  resolution!: ReconResolution;

  @CreateDateColumn()
  createdAt!: Date;
}
