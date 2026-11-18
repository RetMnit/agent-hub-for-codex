import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomic, backendOf, readJson } from './common.mjs';
import { conversationId } from './records.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function requestStore(state, configurations) {
  const file = path.join(state, 'dispatch-requests.json');
  let entries = fs.existsSync(file) ? readJson(file) : {};
  return {
    conversationOf(requestId) { return entries[requestId]?.selected?.conversationId; },
    targetOf(requestId) { return entries[requestId]?.selected; },
    resolveMany(tasks, operation = 'start') {
      const next = { ...entries };
      let changed = false;
      const results = tasks.map(params => {
        if (params.userAuthorized !== true) throw new Error('Explicit user permission to dispatch through Agent Hub is required');
        const owner = conversationId(params);
        const backend = backendOf(params);
        if (typeof params.requestId !== 'string' || !params.requestId.trim()) throw new Error('A unique requestId is required for each task');
        const key = hash([owner, backend, params.requestId]);
        const signature = hash([operation, params.prompt, params.title, params.mode, params.sessionId]);
        const prior = next[key];
        if (prior) {
          if (!prior.selected) throw new Error('This request was already cleaned; it will not be executed again');
          if (prior.signature !== signature) throw new Error('requestId already belongs to different arguments');
          return prior.selected;
        }
        const selected = { ...configurations.resolve(params, operation), conversationId: owner, requestId: key };
        next[key] = { signature, selected };
        changed = true;
        return selected;
      });
      if (changed) {
        atomic(file, next);
        entries = next;
      }
      return structuredClone(results);
    },
    resolve(params, operation) { return this.resolveMany([params], operation)[0]; },
    forget(requestId) {
      if (!Object.hasOwn(entries, requestId) || !entries[requestId].selected) return;
      const next = { ...entries, [requestId]: { signature: entries[requestId].signature } };
      atomic(file, next);
      entries = next;
    },
  };
}
