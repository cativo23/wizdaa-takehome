import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AddressInfo } from 'net';
import { bootstrapTestApp, TestAppHandles } from './e2e-helpers/bootstrap-test-app';
import { bootstrapMockHcm, MockHcmHandles } from './e2e-helpers/bootstrap-mock-hcm';
import { withLatencyBudget } from './e2e-helpers/with-latency-budget';
import { asEmployee, asManager } from './e2e-helpers/http-headers';
import { OutboxDispatcherService } from '../src/hcm/outbox-dispatcher.service';
import { runDispatcherOnce } from '../src/testing/concurrency-helpers';

describe('hcm-network (real MockHcmModule + real HcmClientService)', () => {
  let mockHcm: MockHcmHandles;

  // Boot mock-HCM once per file — it's stateless apart from the scenario store (R6).
  beforeAll(async () => {
    mockHcm = await bootstrapMockHcm();
  });

  afterAll(async () => {
    await mockHcm.close();
  });

  // SUT is per-test for isolation (§1.3)
  let sut: TestAppHandles;

  beforeEach(async () => {
    // Reset scenario to 'correct' before each test.
    // NOTE: reset happens AFTER SUT is bootstrapped to avoid a race where the SUT's
    // startup triggers a stale module evaluation. seedBalance is called in each test
    // body using a unique employee ID for balance-store isolation (R6).
    sut = await bootstrapTestApp({
      hcmBaseUrl: mockHcm.url,
      hcmRetryMaxAttempts: 3,
      hcmRetryBackoffMs: 100,
      // listen: true required for the emit-batch test (R7)
      listen: true,
    });
    await mockHcm.resetStore();
  });

  afterEach(async () => {
    await sut.app.close();
  });

  it('Real-HCM happy path: submit → approve → dispatchPending → APPROVED + HCM balance decremented', async () => {
    const emp = randomUUID();
    await mockHcm.seedBalance(emp, 'loc1', 10);

    const idem = randomUUID();
    const submitRes = await request(sut.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee(emp))
      .set('Idempotency-Key', idem)
      .send({ employeeId: emp, locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(201);

    const requestId: string = submitRes.body.id;
    const days: number = submitRes.body.days;

    await request(sut.app.getHttpServer())
      .post(`/time-off-requests/${requestId}/approve`)
      .set(asManager())
      .send({})
      .expect(201);

    const dispatcher = (sut.moduleRef as any).get(OutboxDispatcherService);
    await runDispatcherOnce(dispatcher);

    // Verify SUT local balance was committed
    const balRes = await request(sut.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: emp, locationId: 'loc1' })
      .set(asEmployee(emp))
      .expect(200);
    expect(balRes.body.reserved).toBe(0);
    expect(balRes.body.available).toBe(10 - days);

    // Verify HCM mock store was actually decremented
    const hcmBalRes = await request(mockHcm.app.getHttpServer())
      .get('/hcm/balance')
      .query({ employeeId: emp, locationId: 'loc1' })
      .expect(200);
    expect(hcmBalRes.body.balance).toBe(10 - days);
  });

  // THIS IS THE 31s BUG REGRESSION TEST (S4 / S16)
  it('Cold GET /balances with HCM=timeout returns degraded:true in < 2000 ms', async () => {
    const emp = randomUUID();
    await mockHcm.setScenario('timeout');

    const res = await withLatencyBudget('cold-read HCM=timeout', 2000, () =>
      request(sut.app.getHttpServer())
        .get('/balances')
        .query({ employeeId: emp, locationId: 'loc1' })
        .set(asEmployee(emp))
        .expect(200),
    );

    expect(res.body.available).toBe(0);
    expect(res.body.degraded).toBe(true);
    expect(res.body.lastHcmAsOf).toBeNull();
  });

  it('Warm GET /balances with HCM=timeout returns cached value in < 100 ms, degraded NOT set', async () => {
    const emp = randomUUID();
    await mockHcm.seedBalance(emp, 'loc1', 8);

    // Warm the SUT cache with a successful read
    await request(sut.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: emp, locationId: 'loc1' })
      .set(asEmployee(emp))
      .expect(200);

    // Flip to timeout scenario — subsequent HCM calls will fail
    await mockHcm.setScenario('timeout');

    const res = await withLatencyBudget('warm-read HCM=timeout', 100, () =>
      request(sut.app.getHttpServer())
        .get('/balances')
        .query({ employeeId: emp, locationId: 'loc1' })
        .set(asEmployee(emp))
        .expect(200),
    );

    // Warm cache serves the previously-hydrated value — no HCM call made
    expect(res.body.available).toBe(8);
    expect(res.body.degraded).toBeFalsy();
  });

  // REGRESSION TEST FOR S11 — approve hang under HCM-down
  it('Approve with HCM=timeout (warm balance) → PENDING_SYNC in < 2000 ms', async () => {
    const emp = randomUUID();
    await mockHcm.seedBalance(emp, 'loc1', 10);

    // Pre-warm the SUT balance cache
    await request(sut.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: emp, locationId: 'loc1' })
      .set(asEmployee(emp))
      .expect(200);

    const idem = randomUUID();
    const submitRes = await request(sut.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee(emp))
      .set('Idempotency-Key', idem)
      .send({ employeeId: emp, locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(201);

    await mockHcm.setScenario('timeout');

    const approveRes = await withLatencyBudget('approve PENDING_SYNC with HCM=timeout', 2000, () =>
      request(sut.app.getHttpServer())
        .post(`/time-off-requests/${submitRes.body.id}/approve`)
        .set(asManager())
        .send({})
        .expect(201),
    );

    expect(approveRes.body.status).toBe('PENDING_SYNC');
  });

  it('Idempotency-Key is honored end-to-end at the HCM mock', async () => {
    const emp = randomUUID();
    await mockHcm.seedBalance(emp, 'loc1', 10);

    const idem = randomUUID();
    const submitRes = await request(sut.app.getHttpServer())
      .post('/time-off-requests')
      .set(asEmployee(emp))
      .set('Idempotency-Key', idem)
      .send({ employeeId: emp, locationId: 'loc1', startDate: '2026-07-07', endDate: '2026-07-08' })
      .expect(201);

    await request(sut.app.getHttpServer())
      .post(`/time-off-requests/${submitRes.body.id}/approve`)
      .set(asManager())
      .send({})
      .expect(201);

    const dispatcher = (sut.moduleRef as any).get(OutboxDispatcherService);

    // Dispatch twice — HCM should dedup on the same idempotency key, decrement exactly once
    await runDispatcherOnce(dispatcher);
    await runDispatcherOnce(dispatcher);

    const hcmBalRes = await request(mockHcm.app.getHttpServer())
      .get('/hcm/balance')
      .query({ employeeId: emp, locationId: 'loc1' })
      .expect(200);

    const days: number = submitRes.body.days;
    expect(hcmBalRes.body.balance).toBe(10 - days);
  });

  it('Batch emit via mock HCM control endpoint reaches our BatchController', async () => {
    // R7: SUT listens on a real port (listen: true in beforeEach) for this test.
    const sutAddr = sut.app.getHttpServer().address() as AddressInfo;
    const sutUrl = `http://127.0.0.1:${sutAddr.port}`;

    const emp = randomUUID();
    await mockHcm.seedBalance(emp, 'loc1', 15);

    // Tell mock HCM to push a batch to the SUT
    const emitRes = await request(mockHcm.app.getHttpServer())
      .post('/_control/emit-batch')
      .send({
        targetUrl: `${sutUrl}/timeoff/hcm/batch`,
        balances: [{ employeeId: emp, locationId: 'loc1', balance: 15, asOf: new Date().toISOString() }],
        asOf: new Date().toISOString(),
      })
      .expect(200);

    expect(emitRes.body.ok).toBe(true);
    expect(emitRes.body.statusCode).toBe(202);

    // SUT should have updated the local balance
    const balRes = await request(sut.app.getHttpServer())
      .get('/balances')
      .query({ employeeId: emp, locationId: 'loc1' })
      .set(asEmployee(emp))
      .expect(200);

    expect(balRes.body.available).toBe(15);
  });
});
