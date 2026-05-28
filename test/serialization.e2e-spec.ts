import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  bootstrapTestApp,
  TestAppHandles,
} from './e2e-helpers/bootstrap-test-app';
import { asEmployee, asManager } from './e2e-helpers/http-headers';
import { OutboxDispatcherService } from '../src/hcm/outbox-dispatcher.service';
import { runDispatcherOnce } from '../src/testing/concurrency-helpers';

describe('serialization (FakeHcmClient)', () => {
  let handles: TestAppHandles;

  beforeEach(async () => {
    handles = await bootstrapTestApp();
    handles.fakeHcm!.seedBalance('emp1', 'loc1', 11);
  });

  afterEach(async () => {
    await handles.app.close();
  });

  it('GET /balances shape includes all documented fields', async () => {
    const { app } = handles;
    const res = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);

    expect(res.body).toMatchObject({
      employeeId: expect.any(String),
      locationId: expect.any(String),
      available: expect.any(Number),
      reserved: expect.any(Number),
      needsReview: expect.any(Boolean),
    });
    // No TypeORM internal leaks
    expect(res.body.__entity__).toBeUndefined();
  });

  it('GET /balances on cold tuple with FakeHcmClient(correct) hydrates available', async () => {
    const { app } = handles;
    const res = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);

    expect(res.body.available).toBe(11);
    expect(typeof res.body.lastHcmAsOf).toBe('string');
  });

  it('GET /balances on cold tuple with FakeHcmClient(timeout) returns { degraded: true, available: 0, lastHcmAsOf: null }', async () => {
    const { app, fakeHcm } = handles;
    fakeHcm!.setScenario('timeout');

    const res = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);

    expect(res.body.available).toBe(0);
    expect(res.body.degraded).toBe(true);
    expect(res.body.lastHcmAsOf).toBeNull();
  });

  it('POST submit response shape contains all required fields', async () => {
    const { app } = handles;
    const idem = randomUUID();
    const res = await request(app.getHttpServer())
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

    expect(res.body).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      employeeId: 'emp1',
      locationId: 'loc1',
      startDate: '2026-07-07',
      endDate: '2026-07-08',
      days: expect.any(Number),
      status: 'PENDING',
      idempotencyKey: idem,
      hcmIdempotencyKey: expect.any(String),
      expiresAt: expect.any(String),
      createdAt: expect.any(String),
    });
  });

  it('POST approve response shape includes committedAt (null before dispatcher, ISO after)', async () => {
    const { app, moduleRef } = handles;
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

    const approveRes = await request(app.getHttpServer())
      .post(`/time-off-requests/${submitRes.body.id}/approve`)
      .set(asManager())
      .send({})
      .expect(201);

    // Before dispatcher: status is PENDING_SYNC, committedAt should be set (approval was committed locally)
    expect(approveRes.body).toHaveProperty('committedAt');

    const dispatcher = (moduleRef as any).get(OutboxDispatcherService);
    await runDispatcherOnce(dispatcher);

    // After dispatcher runs, check balance changed (APPROVED path completed)
    const balRes = await request(app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(200);
    expect(balRes.body.reserved).toBe(0);
  });

  it('POST batch returns { accepted: true } with 202', async () => {
    const res = await request(handles.app.getHttpServer())
      .post('/timeoff/hcm/batch')
      .send({
        sequence: 1,
        asOf: '2026-05-27T12:00:00.000Z',
        balances: [
          {
            employeeId: 'emp1',
            locationId: 'loc1',
            balance: 11,
            asOf: '2026-05-27T12:00:00.000Z',
          },
        ],
      })
      .expect(202);

    expect(res.body).toEqual({ accepted: true });
  });
});
