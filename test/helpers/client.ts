import { INestApplication } from '@nestjs/common';
import request from 'supertest';

/** Thin convenience wrapper around supertest for the service's HTTP API. */
export function client(app: INestApplication) {
  const http = () => app.getHttpServer();
  return {
    create(body: Record<string, unknown>, idempotencyKey?: string) {
      const r = request(http()).post('/v1/time-off-requests');
      if (idempotencyKey) r.set('Idempotency-Key', idempotencyKey);
      return r.send(body);
    },
    approve(id: string, body: Record<string, unknown> = { approverId: 'mgr-1' }) {
      return request(http()).post(`/v1/time-off-requests/${id}/approve`).send(body);
    },
    reject(id: string, body: Record<string, unknown> = { approverId: 'mgr-1' }) {
      return request(http()).post(`/v1/time-off-requests/${id}/reject`).send(body);
    },
    cancel(id: string, body: Record<string, unknown> = {}) {
      return request(http()).post(`/v1/time-off-requests/${id}/cancel`).send(body);
    },
    getRequest(id: string) {
      return request(http()).get(`/v1/time-off-requests/${id}`);
    },
    listRequests(query = '') {
      return request(http()).get(`/v1/time-off-requests${query}`);
    },
    balance(employeeId: string, locationId: string, query = '') {
      return request(http()).get(`/v1/balances/${employeeId}/${locationId}${query}`);
    },
    listBalances(query = '') {
      return request(http()).get(`/v1/balances${query}`);
    },
    sync() {
      return request(http()).post('/v1/hcm/sync');
    },
    webhook(body: Record<string, unknown>) {
      return request(http()).post('/v1/hcm/webhook/balances').send(body);
    },
    processOutbox(force = true) {
      return request(http()).post(`/v1/hcm/outbox/process${force ? '?force=true' : ''}`);
    },
    listOutbox(status?: string) {
      return request(http()).get(`/v1/hcm/outbox${status ? `?status=${status}` : ''}`);
    },
  };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
