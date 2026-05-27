import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  VersionColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { RequestStatus } from './enums';

/**
 * TimeOffRequest — one leave request in the lifecycle state machine (§6).
 *
 * `idempotencyKey` is declared UNIQUE at the DB level. The service enforces
 * ADR-012 active-state scoping in application logic: a key tied to a terminal
 * request (EXPIRED/REJECTED/CANCELLED) does not block a fresh submit. The
 * UNIQUE constraint is the storage-level guard; active-state exclusivity is
 * the business-logic guard on top.
 *
 * `hcmIdempotencyKey` is allocated at request creation and reused verbatim on
 * every FILE and REVERSE call to HCM (ADR-008).
 *
 * `hcmAckAt` records when HCM acknowledged the FILE or REVERSE. ADR-003 uses
 * this timestamp (not `committedAt`) as the replay cutoff during batch
 * reconciliation — an approval committed before asOf but acked after asOf must
 * be re-applied.
 *
 * `days` is always server-computed from the date range + location calendar
 * (§12). The client-supplied value is never trusted.
 */
@Entity('time_off_requests')
export class TimeOffRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  employeeId!: string;

  @Column({ type: 'varchar' })
  locationId!: string;

  /** Inclusive start date stored as ISO date string (YYYY-MM-DD). */
  @Column({ type: 'varchar' })
  startDate!: string;

  /** Inclusive end date stored as ISO date string (YYYY-MM-DD). */
  @Column({ type: 'varchar' })
  endDate!: string;

  /** Business days — always server-computed, never client-supplied (§12). */
  @Column({ type: 'integer' })
  days!: number;

  @Column({ type: 'varchar', default: RequestStatus.DRAFT })
  status!: RequestStatus;

  /**
   * Inbound dedup key (client-minted UUID v4). UNIQUE at DB level.
   * ADR-012 scopes uniqueness to active states in application code.
   */
  @Index({ unique: true })
  @Column({ type: 'varchar' })
  idempotencyKey!: string;

  /**
   * Stable key reused on every HCM FILE/REVERSE call for this request (ADR-008).
   * Allocated at request creation, never changes.
   */
  @Column({ type: 'varchar' })
  hcmIdempotencyKey!: string;

  /** Reservation TTL (ADR-002). Reaper sweeps requests past this time. */
  @Column({ type: 'datetime' })
  expiresAt!: Date;

  /** Optimistic lock (ADR-005). */
  @VersionColumn()
  version!: number;

  /**
   * When the local deduction was committed (audit).
   * Set when status transitions to APPROVED.
   */
  @Column({ type: 'datetime', nullable: true, default: null })
  committedAt!: Date | null;

  /**
   * When HCM acknowledged the FILE or REVERSE (ADR-003).
   * The ADR-003 replay cutoff is: hcmAckAt IS NULL OR hcmAckAt > asOf.
   */
  @Column({ type: 'datetime', nullable: true, default: null })
  hcmAckAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
