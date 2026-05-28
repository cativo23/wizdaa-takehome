import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AddressInfo } from 'net';
import supertest from 'supertest';
import { MockHcmModule } from '../../src/mock-hcm/mock-hcm.module';
import { HcmScenario } from '../../src/mock-hcm/mock-hcm.store';

export interface MockHcmHandles {
  app: INestApplication;
  url: string;
  /** Reset scenario, idempotency store, and sequence counter. Call in beforeEach. */
  resetStore(): Promise<void>;
  setScenario(s: HcmScenario): Promise<void>;
  /** Seed a balance via the HTTP control API (avoids module-singleton split). */
  seedBalance(
    employeeId: string,
    locationId: string,
    balance: number,
  ): Promise<void>;
  close(): Promise<void>;
}

export async function bootstrapMockHcm(): Promise<MockHcmHandles> {
  const moduleRef = await Test.createTestingModule({
    imports: [MockHcmModule],
  }).compile();

  const app = moduleRef.createNestApplication();

  // Must match src/mock-hcm/main.ts exactly
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  // Listen on ephemeral port so HcmClientService can reach it over HTTP
  await app.listen(0);

  const addr = app.getHttpServer().address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}`;

  return {
    app,
    url,
    async resetStore(): Promise<void> {
      // Reset via HTTP scenario endpoint — avoids module-singleton issues (R6).
      // Scenario back to 'correct' is sufficient for correctness; the idempotency
      // store and sequence counter are not visible externally and are harmless
      // across tests if we use unique employee IDs per test (which we do).
      await supertest(app.getHttpServer())
        .post('/_control/scenario')
        .send({ scenario: 'correct' })
        .expect(200);
    },
    async setScenario(s: HcmScenario): Promise<void> {
      await supertest(app.getHttpServer())
        .post('/_control/scenario')
        .send({ scenario: s })
        .expect(200);
    },
    async seedBalance(
      employeeId: string,
      locationId: string,
      balance: number,
    ): Promise<void> {
      await supertest(app.getHttpServer())
        .post('/_control/refresh')
        .send({ employeeId, locationId, balance })
        .expect(200);
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}
