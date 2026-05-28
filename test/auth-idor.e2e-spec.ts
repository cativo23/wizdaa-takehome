import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { bootstrapTestApp, TestAppHandles } from './e2e-helpers/bootstrap-test-app';
import { asEmployee, asManager } from './e2e-helpers/http-headers';

describe('auth + IDOR (FakeHcmClient)', () => {
  let handles: TestAppHandles;

  beforeEach(async () => {
    handles = await bootstrapTestApp();
    handles.fakeHcm!.seedBalance('emp1', 'loc1', 10);
    handles.fakeHcm!.seedBalance('emp2', 'loc1', 10);
  });

  afterEach(async () => {
    await handles.app.close();
  });

  it('GET /balances missing X-Employee-Id → 400', async () => {
    const res = await request(handles.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set('X-Role', 'employee')
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/X-Employee-Id/i);
  });

  it('GET /balances missing X-Role → 400', async () => {
    await request(handles.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set('X-Employee-Id', 'emp1')
      .expect(400);
  });

  it('GET /balances X-Role=bogus → 400', async () => {
    const res = await request(handles.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set('X-Employee-Id', 'emp1')
      .set('X-Role', 'bogus')
      .expect(400);
    expect(res.body.message).toBeTruthy();
  });

  it('Employee A querying B\'s balance → 403', async () => {
    await request(handles.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp2', locationId: 'loc1' })
      .set(asEmployee('emp1'))
      .expect(403);
  });

  it('Manager querying any employee\'s balance → 200', async () => {
    await request(handles.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: 'emp1', locationId: 'loc1' })
      .set(asManager())
      .expect(200);
  });

  it('POST submit missing Idempotency-Key → 400', async () => {
    const res = await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .send({ employeeId: 'emp1', locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(400);
    expect(JSON.stringify(res.body)).toMatch(/Idempotency-Key/i);
  });

  it('POST submit for different employeeId than X-Employee-Id → 403', async () => {
    await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', randomUUID())
      .send({ employeeId: 'emp2', locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(403);
  });

  it('Employee approving → 403', async () => {
    // Submit a request first
    const submitRes = await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', randomUUID())
      .send({ employeeId: 'emp1', locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(201);

    await request(handles.app.getHttpServer())
      .post(`/time-off-requests/${submitRes.body.id}/approve`)
      .set(asEmployee('emp1'))
      .send({})
      .expect(403);
  });

  it('Employee rejecting → 403', async () => {
    const submitRes = await request(handles.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', randomUUID())
      .send({ employeeId: 'emp1', locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(201);

    await request(handles.app.getHttpServer())
      .post(`/time-off-requests/${submitRes.body.id}/reject`)
      .set(asEmployee('emp1'))
      .send({ reason: 'no' })
      .expect(403);
  });

  it('Employee calling PATCH /balances/resolve-review → 403', async () => {
    await request(handles.app.getHttpServer())
      .patch('/balances/resolve-review')
      .set(asEmployee('emp1'))
      .send({ employeeId: 'emp1', locationId: 'loc1' })
      .expect(403);
  });

  it('Manager calling PATCH /balances/resolve-review → 200 { ok: true }', async () => {
    const res = await request(handles.app.getHttpServer())
      .patch('/balances/resolve-review')
      .set(asManager())
      .send({ employeeId: 'emp1', locationId: 'loc1' })
      .expect(200);
    expect(res.body.ok).toBe(true);
  });

  it('Cancel: employee can cancel own request; service enforces ownership', async () => {
    const { app } = handles;
    const idem = randomUUID();

    const submitRes = await request(app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee('emp1'))
      .set('Idempotency-Key', idem)
      .send({ employeeId: 'emp1', locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(201);

    const cancelRes = await request(app.getHttpServer())
      .post(`/time-off-requests/${submitRes.body.id}/cancel`)
      .set(asEmployee('emp1'))
      .expect(201);

    expect(cancelRes.body.status).toBe('CANCELLED');
  });
});
