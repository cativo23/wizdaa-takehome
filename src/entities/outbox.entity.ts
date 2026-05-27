import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
} from 'typeorm';
import { OutboxOperation, OutboxStatus } from './enums';

/**
 * Outbox — transactional outbox for durable HCM calls (ADR-011).
 *
 * Written in the same transaction as the state change that triggers an HCM
 * call. The OutboxDispatcher reads PENDING rows, performs the HCM call, and
 * marks them SENT or FAILED. The Reaper VOIDs rows it supersedes in the same
 * transaction as the expiry (ADR-002/B2).
 *
 * `idempotencyKey` = `request.hcmIdempotencyKey + ':' + operation`, ensuring
 * FILE and REVERSE are distinct and each is idempotent across retries (ADR-008).
 */
@Entity('outbox')
export class Outbox {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** requestId — the TimeOffRequest this row belongs to. */
  @Column({ type: 'varchar' })
  aggregateId!: string;

  @Column({ type: 'varchar' })
  operation!: OutboxOperation;

  /**
   * Full command payload to pass to HcmClient.
   * Stored as JSON text; simple-json is adequate for SQLite.
   */
  @Column({ type: 'simple-json' })
  payload!: Record<string, unknown>;

  /**
   * Stable idempotency key: `${hcmIdempotencyKey}:${operation}`.
   * Reused on every retry — HCM deduplicates on it (ADR-008).
   */
  @Column({ type: 'varchar' })
  idempotencyKey!: string;

  @Column({ type: 'varchar', default: OutboxStatus.PENDING })
  status!: OutboxStatus;

  /** Delivery attempt count. Dispatcher increments before each attempt. */
  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
