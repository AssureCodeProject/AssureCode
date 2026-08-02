import { AsyncLocalStorage } from 'node:async_hooks';

export const correlationStorage = new AsyncLocalStorage();

export function getCorrelationId() {
  return correlationStorage.getStore()?.correlationId;
}

export function runWithCorrelationId(correlationId, fn) {
  return correlationStorage.run({ correlationId }, fn);
}
