import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootstrapTestApp, TestAppHandles } from './e2e-helpers/bootstrap-test-app';
import { asEmployee } from './e2e-helpers/http-headers';

describe('validation-pipe (FakeHcmClient)', () => {
  let handles: TestAppHandles;

  beforeEach(async () => {
    handles = await bootstrapTestApp();
    handles.fakeHcm!.seedBalance('emp1', 'loc1', 20);
  });

  afterEach(async () => {
    await handles.app.close();
  });

  it('submit with malformed startDate → 400', async () => {
    await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', randomUUID())
      .send({ employeeId: 'emp1', locationId: 'loc1', startDate: 'not-a-date', endDate: '2026-07-08' })
      .expect(400);
  });

  it('submit with endDate < startDate → 400', async () => {
    await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', randomUUID())
      .send({ employeeId: 'emp1', locationId: 'loc1', startDate: '2026-07-10', endDate: '2026-07-07' })
      .expect(400);
  });

  it('submit missing employeeId → 400', async () => {
    await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', randomUUID())
      .send({ locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(400);
  });

  it('submit with extra field `days: 999` is silently stripped, server recomputes', async () => {
    const res = await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', randomUUID())
      .send({ employeeId: 'emp1', locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08', days: 999 })
      .expect(201);

    // days must be server-computed business day count, not the injected 999
    expect(res.body.days).not.toBe(999);
    expect(res.body.days).toBeGreaterThan(0);
  });

  it('submit with extra field `idempotencyKey` in body is stripped', async () => {
    const headerKey = randomUUID();
    const res = await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', headerKey)
      .send({ employeeId: 'emp1', locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08', idempotencyKey: 'sneaky-value' })
      .expect(201);

    // idempotencyKey in response should match header, not body field
    expect(res.body.idempotencyKey).toBe(headerKey);
  });

  it('approve with non-UUID id → 400 (ParseUUIDPipe)', async () => {
    await request(handles.app.getHttpServer())
      .post('/time-off-requests/not-a-uuid/approve')
      .set({ 'X-Employee-Id': 'mgr1', 'X-Role': 'manager' })
      .send({})
      .expect(400);
  });

  it('batch with sequence: "not-a-number" → 400', async () => {
    await request(handles.app.getHttpServer())
      .post('/timeoff/hcm/batch')
      .send({
        sequence: 'not-a-number',
        asOf: '2026-05-27T12:00:00.000Z',
        balances: [{ employeeId: 'emp1', locationId: 'loc1', balance: 10, asOf: '2026-05-27T12:00:00.000Z' }],
      })
      .expect(400);
  });

  it('batch with missing balances array → 400', async () => {
    await request(handles.app.getHttpServer())
      .post('/timeoff/hcm/batch')
      .send({ sequence: 1, asOf: '2026-05-27T12:00:00.000Z' })
      .expect(400);
  });
});
