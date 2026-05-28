import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  bootstrapTestApp,
  TestAppHandles,
} from './e2e-helpers/bootstrap-test-app';
import { asEmployee, asManager } from './e2e-helpers/http-headers';
import { Balance } from '../src/entities/balance.entity';
import { OutboxDispatcherService } from '../src/hcm/outbox-dispatcher.service';
import { runDispatcherOnce } from '../src/testing/concurrency-helpers';

describe('lifecycle (FakeHcmClient)', () => {
  let handles: TestAppHandles;

  beforeEach(async () => {
    handles = await bootstrapTestApp();
    const { fakeHcm } = handles;
    fakeHcm!.seedBalance('emp1', 'loc1', 10);
  });

  afterEach(async () => {
    await handles.app.close();
  });

  it('GET / returns { status: "ok" }', async () => {
    await request(handles.app.getHttpServer())
      .get('/')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('submit returns 201 + PENDING + days computed server-side', async () => {
    const { app } = handles;
    const idem = randomUUID();
    const res = await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send({
        employeeId: 'emp1',
        locationId: 'loc1',
        startDate: '2026-07-06',
        endDate: '2026-07-07',
      })
      .expect(201);

    expect(res.body.status).toBe('PENDING');
    expect(res.body.days).toBeGreaterThan(0);
    expect(res.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.body.employeeId).toBe('emp1');
  });

  it('submit → approve → manual dispatcher tick → APPROVED + balance reduced', async () => {
    const { app, moduleRef, fakeHcm } = handles;
    const idem = randomUUID();

    const submitRes = await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send({
        employeeId: 'emp1',
        locationId: 'loc1',
        startDate: '2026-07-07',
        endDate: '2026-07-08',
      })
      .expect(201);

    const requestId: string = submitRes.body.id;
    const days: number = submitRes.body.days;

    await request(app.getHttpServer())
      .post(`/time-off-requests/${requestId}/approve`)
      .set(asManager())
      .send({})
      .expect(201);

    const dispatcher = (moduleRef as any).get(OutboxDispatcherService);
    await runDispatcherOnce(dispatcher);

    const balRes = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);

    expect(balRes.body.available).toBe(10 - days);
    expect(balRes.body.reserved).toBe(0);
    expect(fakeHcm!.callsTo.fileTimeOff).toBe(1);
  });

  it('approve → cancel approved → REVERSE dispatched → balance restored', async () => {
    const { app, moduleRef, fakeHcm } = handles;
    const idem = randomUUID();

    const submitRes = await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send({
        employeeId: 'emp1',
        locationId: 'loc1',
        startDate: '2026-07-07',
        endDate: '2026-07-08',
      })
      .expect(201);
    const requestId: string = submitRes.body.id;

    await request(app.getHttpServer())
      .post(`/time-off-requests/${requestId}/approve`)
      .set(asManager())
      .send({})
      .expect(201);

    const dispatcher = (moduleRef as any).get(OutboxDispatcherService);
    await runDispatcherOnce(dispatcher);

    const cancelRes = await request(app.getHttpServer())
      .post(`/time-off-requests/${requestId}/cancel`)
      .set(asEmployee('emp1'))
      .expect(201);
    expect(cancelRes.body.status).toBe('CANCELLED');

    await runDispatcherOnce(dispatcher);

    const balRes = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);

    expect(balRes.body.available).toBe(10);
    expect(balRes.body.reserved).toBe(0);
    expect(fakeHcm!.callsTo.reverseTimeOff).toBe(1);
  });

  it('submit → reject → REJECTED + reservation released', async () => {
    const { app } = handles;
    const idem = randomUUID();

    const submitRes = await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send({
        employeeId: 'emp1',
        locationId: 'loc1',
        startDate: '2026-07-07',
        endDate: '2026-07-08',
      })
      .expect(201);
    const requestId: string = submitRes.body.id;

    await request(app.getHttpServer())
      .post(`/time-off-requests/${requestId}/reject`)
      .set(asManager())
      .send({ reason: 'budget' })
      .expect(201);

    const balRes = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);

    expect(balRes.body.available).toBe(10);
    expect(balRes.body.reserved).toBe(0);
  });

  it('submit insufficient balance → 409 + no reservation', async () => {
    const { app, moduleRef } = handles;
    const balanceRepo: Repository<Balance> = (moduleRef as any).get(
      getRepositoryToken(Balance),
    );
    await balanceRepo.save(
      balanceRepo.create({
        employeeId: 'emp1',
        locationId: 'loc1',
        available: 0,
        reserved: 0,
        needsReview: false,
        lastHcmAsOf: new Date('2026-05-27T00:00:00Z'),
      }),
    );

    const idem = randomUUID();
    await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send({
        employeeId: 'emp1',
        locationId: 'loc1',
        startDate: '2026-07-07',
        endDate: '2026-07-10',
      })
      .expect(409);

    const balRes = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);

    expect(balRes.body.reserved).toBe(0);
    expect(balRes.body.available).toBe(0);
  });

  it('duplicate submit with same key + same body returns same id', async () => {
    const { app } = handles;
    const idem = randomUUID();
    const body = {
      employeeId: 'emp1',
      locationId: 'loc1',
      startDate: '2026-07-07',
      endDate: '2026-07-08',
    };

    const first = await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send(body)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send(body)
      .expect(201);

    expect(first.body.id).toBe(second.body.id);

    const balRes = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);

    expect(balRes.body.reserved).toBe(first.body.days);
  });

  it('same key, different body → 422', async () => {
    const { app } = handles;
    const idem = randomUUID();

    const first = await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send({
        employeeId: 'emp1',
        locationId: 'loc1',
        startDate: '2026-07-07',
        endDate: '2026-07-08',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send({
        employeeId: 'emp1',
        locationId: 'loc1',
        startDate: '2026-07-14',
        endDate: '2026-07-16',
      })
      .expect(422);

    // First request is unchanged
    expect(first.body.startDate).toBe('2026-07-07');
  });
});
