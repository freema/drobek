/**
 * REST data endpoints (U10, PHY-55/PHY-56) — react/RR-agnostic: take a web
 * `Request` + route params, return a web `Response`. apps/web (and the saas web
 * app) mirror this with thin resource routes. Access is enforced by the
 * collection's access_mode against the resolved caller (anon vs workspace
 * session member); rate-limit + quota + schema validation apply to ALL modes.
 *
 * Responses are always `no-store` JSON (data is dynamic + may be private).
 * Same-origin only for U10 — the cross-origin apps-origin is U11.
 */
import { resolveWorkspaceId } from '@drobek/serving';
import { type DataCaller } from './access.js';
import { DataError, dataErrorStatus, type DataErrorCode } from './errors.js';
import {
  createRecord,
  deleteRecord,
  queryRecords,
  readRecord,
  updateRecord,
  type DataLocator,
} from './records.server.js';
import { resolveRestCaller } from './resolve.server.js';

export interface DataRestParams {
  wsSlug: string;
  appSlug: string;
  collection: string;
  id?: string;
}

const RESERVED_QUERY = new Set(['limit', 'cursor', 'sort', 'dir']);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function errorBody(code: DataErrorCode, message: string, details?: unknown) {
  return details === undefined
    ? { error: code, message }
    : { error: code, message, details };
}

/** Run a handler, mapping DataError → its HTTP status + JSON body. */
async function respond(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return jsonResponse(200, await fn());
  } catch (err) {
    if (err instanceof DataError) {
      return jsonResponse(
        dataErrorStatus(err.code),
        errorBody(err.code, err.message, err.details)
      );
    }
    throw err;
  }
}

async function parseJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DataError('invalid_request', 'request body must be valid JSON');
  }
}

/** Resolve the workspace + REST caller, or a 404 Response for an unknown ws. */
async function context(
  request: Request,
  wsSlug: string
): Promise<{ caller: DataCaller } | { response: Response }> {
  const workspaceId = await resolveWorkspaceId(wsSlug);
  if (!workspaceId) {
    return { response: jsonResponse(404, errorBody('not_found', 'app not found')) };
  }
  const caller = await resolveRestCaller(request, workspaceId);
  return { caller };
}

function locatorOf(params: DataRestParams): DataLocator {
  return { wsSlug: params.wsSlug, appSlug: params.appSlug };
}

/** `GET`(list/query) + `POST`(create) on `/:ws/app/:slug/data/:collection`. */
export async function handleDataCollection(
  request: Request,
  params: DataRestParams
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
    return jsonResponse(405, errorBody('invalid_request', 'method not allowed'));
  }
  const ctx = await context(request, params.wsSlug);
  if ('response' in ctx) return ctx.response;
  const locator = locatorOf(params);

  if (method === 'GET') {
    const url = new URL(request.url);
    const where: Record<string, string> = {};
    for (const [k, val] of url.searchParams.entries()) {
      if (!RESERVED_QUERY.has(k)) where[k] = val;
    }
    const sortField = url.searchParams.get('sort');
    const sort = sortField
      ? { field: sortField, dir: url.searchParams.get('dir') ?? undefined }
      : undefined;
    return respond(() =>
      queryRecords({
        locator,
        collection: params.collection,
        caller: ctx.caller,
        where: Object.keys(where).length > 0 ? where : undefined,
        sort,
        limit: url.searchParams.get('limit') ?? undefined,
        cursor: url.searchParams.get('cursor') ?? undefined,
      })
    );
  }

  const doc = await parseJsonBody(request);
  return respond(() =>
    createRecord({
      locator,
      collection: params.collection,
      caller: ctx.caller,
      doc,
    })
  );
}

/** `GET`/`PATCH`/`DELETE` on `/:ws/app/:slug/data/:collection/:id`. */
export async function handleDataDocument(
  request: Request,
  params: DataRestParams
): Promise<Response> {
  const method = request.method.toUpperCase();
  const id = params.id ?? '';
  if (!id) {
    return jsonResponse(404, errorBody('not_found', 'document not found'));
  }
  const ctx = await context(request, params.wsSlug);
  if ('response' in ctx) return ctx.response;
  const locator = locatorOf(params);
  const base = { locator, collection: params.collection, caller: ctx.caller };

  if (method === 'GET') {
    return respond(() => readRecord({ ...base, id }));
  }
  if (method === 'PATCH') {
    const patch = await parseJsonBody(request);
    return respond(() => updateRecord({ ...base, id, patch }));
  }
  if (method === 'DELETE') {
    return respond(() => deleteRecord({ ...base, id }));
  }
  return jsonResponse(405, errorBody('invalid_request', 'method not allowed'));
}
