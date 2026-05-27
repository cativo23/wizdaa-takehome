import {
  Entity,
  Column,
  PrimaryColumn,
  VersionColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Balance — the core financial record per (employeeId, locationId).
 *
 * Composite PK: (employeeId, locationId).
 * `version` is the optimistic lock column (ADR-005). TypeORM auto-increments
 * it on every save and throws OptimisticLockVersionMismatchError on conflict.
 * `needsReview` is set when reconciliation drives available negative (ADR-003/B4).
 * `lastHcmAsOf` tracks when the most-recent authoritative HCM snapshot was applied
 * so ADR-003 replay can determine what the snapshot already reflects.
 */
@Entity('balances')
export class Balance {
  @PrimaryColumn({ type: 'varchar' })
  employeeId!: string;

  @PrimaryColumn({ type: 'varchar' })
  locationId!: string;

  @Column({ type: 'integer', default: 0 })
  available!: number;

  @Column({ type: 'integer', default: 0 })
  reserved!: number;

  /** Set when reconciliation yields a negative result — manager must clear. */
  @Column({ type: 'boolean', default: false })
  needsReview!: boolean;

  /** Optimistic lock (ADR-005). */
  @VersionColumn()
  version!: number;

  /**
   * asOf timestamp of the most-recent HCM snapshot successfully applied.
   * Used as the replay cutoff in ADR-003 batch reconciliation.
   */
  @Column({ type: 'datetime', nullable: true, default: null })
  lastHcmAsOf!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
