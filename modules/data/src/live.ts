/**
 * Live subscriptions of this process: `GET /__drobek/v1/data/:collection/events`
 * answers a `text/event-stream` that carries every committed change of the
 * collection the caller may read — exactly what a list would return them:
 *
 *   event: ready    once a new subscription is live (id = where it starts):
 *                   the client loads the list now; a resumed one (with a
 *                   Last-Event-ID) gets the missed events instead
 *   event: change   { op: 'create' | 'update', record, at } | { op: 'delete', id, at }
 *   event: reset    events may have been missed: load the list again
 *   event: error    { error, message } — the stream ends (the rule no longer
 *                   admits the caller, the collection is gone, a slow reader)
 *   : ping          every HEARTBEAT_MS
 *
 * Authorization runs at the subscribe (the route: the collection's read
 * rule, like a list) AND for every event: the collection's read rule is read
 * again from the stored config (once per event and process, shared by the
 * collection's subscribers) and the caller's session at most every
 * PRINCIPAL_RECHECK_MS (and on every heartbeat). Under a rule that admits
 * the caller only through `owner`, a subscriber gets only events of records
 * whose stored `_owner` is the caller. A visitor never gets `_owner`. A
 * delete event carries only the id.
 *
 * Slots: DATA_SUBSCRIBE_MAX_PER_APP streams per app and
 * DATA_SUBSCRIBE_MAX_PER_CALLER per caller (the signed-in user, or the
 * visitor's IP) in this process; a stream ends after DATA_SUBSCRIBE_MAX_MS
 * (the client reconnects and resumes). Every way a stream ends — the client
 * leaving, its lifetime, an error, the server stopping — runs one `close`
 * that releases the slots, the timers and the feed listener.
 */
import { Readable } from 'node:stream';
import { moduleStreamsEnding, onModuleStreamsEnd, type Principal, type Rule } from '@drobek/modules';
import { listScope } from './access.js';
import { changeFeed, compareEventIds, type ChangeFeed, type FeedListener, type FeedMessage } from './live-feed.js';

const HEARTBEAT_MS = 25_000;
export const PRINCIPAL_RECHECK_MS = 10_000;
/** Unsent bytes a stream may hold for a client that reads too slowly; past it the stream ends. */
export const MAX_BUFFERED_BYTES = 1024 * 1024;
export const DEFAULT_SUBSCRIBE_MAX_PER_APP = 200;
export const DEFAULT_SUBSCRIBE_MAX_PER_CALLER = 4;
export const DEFAULT_SUBSCRIBE_MAX_MS = 3_600_000;
/** The client's reconnect delay (the SSE `retry:` field). */
const RETRY_MS = 2000;

export interface SubscribeInput {
  appId: string;
  collection: string;
  principal: Principal;
  /** The caller's slot key (`u:<id>` / `ip:<ip>`), or null (no per-caller cap). */
  callerKey: string | null;
  /** The client's `Last-Event-ID`, already validated (or null). */
  lastEventId: string | null;
  limits: { maxPerApp: number; maxPerCaller: number; maxMs: number };
  /** The collection's read rule as stored now; null = the collection is no longer declared. */
  currentRule(): Promise<Rule | null>;
  currentPrincipal(): Promise<Principal>;
  /** A record as this caller may see it (no `_owner` for a visitor). */
  forCaller(record: Record<string, unknown>, principal: Principal): Record<string, unknown>;
}

export type SubscribeResult =
  | { ok: true; stream: Readable }
  | { ok: false; code: 'limit_exceeded' | 'unavailable'; message: string; details: Record<string, unknown> };

interface Sub {
  input: SubscribeInput;
  stream: Readable;
  principal: Principal;
  principalAt: number;
  /** Entries that arrived while the backlog of a resume was sent. */
  held: FeedMessage[] | null;
  lastId: string | null;
  closed: boolean;
  close(): void;
}

interface Channel {
  key: string;
  subs: Set<Sub>;
  queue: Promise<void>;
  listener: FeedListener;
}

type Check = { ok: true; ownerId: string | null } | { ok: false; code: 'unauthorized' | 'forbidden' | 'not_found'; message: string };

function check(collection: string, rule: Rule | null, principal: Principal): Check {
  if (rule === null) return { ok: false, code: 'not_found', message: `The collection "${collection}" is no longer declared.` };
  const scope = listScope(rule, principal);
  if (scope.ok) return { ok: true, ownerId: scope.ownerId };
  return scope.status === 401
    ? { ok: false, code: 'unauthorized', message: `Sign in to this app first: only signed-in users may read records of "${collection}".` }
    : { ok: false, code: 'forbidden', message: `You may no longer read records of "${collection}" (rule read: "${rule}").` };
}

function frame(type: string, data: unknown, id?: string | null): string {
  return `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class LiveHub {
  private readonly channels = new Map<string, Channel>();
  private readonly perApp = new Map<string, number>();
  private readonly perCaller = new Map<string, number>();
  private readonly all = new Set<Sub>();
  private ending = false;

  constructor(
    private readonly feed: ChangeFeed,
    private readonly opts: { now?: () => number; heartbeatMs?: number } = {}
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Open streams (all, or of one app). */
  open(appId?: string): number {
    return appId === undefined ? this.all.size : (this.perApp.get(appId) ?? 0);
  }

  subscribe(input: SubscribeInput): SubscribeResult {
    if (this.ending || moduleStreamsEnding()) {
      return { ok: false, code: 'unavailable', message: 'The server is restarting; subscribe again in a few seconds.', details: {} };
    }
    const appCount = this.perApp.get(input.appId) ?? 0;
    if (appCount >= input.limits.maxPerApp) {
      return {
        ok: false,
        code: 'limit_exceeded',
        message: `This app already has ${appCount} live subscriptions open (at most ${input.limits.maxPerApp}). Try again later.`,
        details: { limit: 'DATA_SUBSCRIBE_MAX_PER_APP', value: input.limits.maxPerApp },
      };
    }
    const callerSlot = input.callerKey ? `${input.appId}:${input.callerKey}` : null;
    const callerCount = callerSlot ? (this.perCaller.get(callerSlot) ?? 0) : 0;
    if (callerSlot && callerCount >= input.limits.maxPerCaller) {
      return {
        ok: false,
        code: 'limit_exceeded',
        message: `You already have ${callerCount} live subscriptions open in this app (at most ${input.limits.maxPerCaller}). Close one (call its unsubscribe) first.`,
        details: { limit: 'DATA_SUBSCRIBE_MAX_PER_CALLER', value: input.limits.maxPerCaller },
      };
    }
    this.perApp.set(input.appId, appCount + 1);
    if (callerSlot) this.perCaller.set(callerSlot, callerCount + 1);

    const timers: NodeJS.Timeout[] = [];
    let channel: Channel | null = null;
    const stream = new Readable({ read() {} });
    const sub: Sub = {
      input,
      stream,
      principal: input.principal,
      principalAt: this.now(),
      held: [],
      lastId: null,
      closed: false,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        for (const t of timers) clearInterval(t);
        this.all.delete(sub);
        const left = (this.perApp.get(input.appId) ?? 1) - 1;
        if (left > 0) this.perApp.set(input.appId, left);
        else this.perApp.delete(input.appId);
        if (callerSlot) {
          const c = (this.perCaller.get(callerSlot) ?? 1) - 1;
          if (c > 0) this.perCaller.set(callerSlot, c);
          else this.perCaller.delete(callerSlot);
        }
        if (channel) {
          channel.subs.delete(sub);
          if (channel.subs.size === 0) {
            channel.listener.off();
            this.channels.delete(channel.key);
          }
        }
        if (!stream.destroyed) stream.push(null);
      },
    };
    this.all.add(sub);
    stream.on('close', sub.close);
    stream.on('error', sub.close);

    timers.push(setInterval(() => void this.heartbeat(sub), this.opts.heartbeatMs ?? HEARTBEAT_MS));
    timers.push(setTimeout(sub.close, input.limits.maxMs));
    for (const t of timers) t.unref?.();

    channel = this.join(sub);
    void this.start(sub, channel);
    return { ok: true, stream };
  }

  /** End every stream and refuse new ones (the server stops). */
  endAll(): void {
    this.ending = true;
    for (const sub of [...this.all]) sub.close();
  }

  private join(sub: Sub): Channel {
    const key = `${sub.input.appId}:${sub.input.collection}`;
    let ch = this.channels.get(key);
    if (!ch) {
      const created: Channel = { key, subs: new Set(), queue: Promise.resolve(), listener: null as unknown as FeedListener };
      created.listener = this.feed.listen(sub.input.appId, sub.input.collection, (m) => {
        created.queue = created.queue.then(() => this.dispatch(created, m)).catch(() => undefined);
      });
      this.channels.set(key, created);
      ch = created;
    }
    ch.subs.add(sub);
    return ch;
  }

  /** Live once the channel is subscribed: the ready event, then (on a resume) the backlog, then what arrived meanwhile. */
  private async start(sub: Sub, ch: Channel): Promise<void> {
    try {
      await ch.listener.ready;
      const startId = await this.feed.now();
      if (sub.closed) return;
      this.write(sub, `retry: ${RETRY_MS}\n\n`);
      const resume = sub.input.lastEventId;
      if (resume) {
        const entries = await this.feed.since(sub.input.appId, sub.input.collection, resume);
        if (sub.closed) return;
        if (entries === null) {
          sub.lastId = startId;
          this.write(sub, frame('reset', { at: new Date(this.now()).toISOString() }, startId));
        } else {
          sub.lastId = resume;
          const rule = await sub.input.currentRule();
          for (const e of entries) if (!sub.closed) await this.deliver(sub, e, rule);
        }
      } else {
        sub.lastId = startId;
        this.write(sub, frame('ready', { at: new Date(this.now()).toISOString() }, startId));
      }
      const held = sub.held ?? [];
      sub.held = null;
      if (held.length > 0 && !sub.closed) {
        const rule = await sub.input.currentRule();
        for (const m of held) if (!sub.closed) await this.deliver(sub, m, rule);
      }
    } catch {
      this.fail(sub, 'unavailable', 'The live subscription could not start; it reconnects.');
    }
  }

  private async dispatch(ch: Channel, m: FeedMessage): Promise<void> {
    const subs = [...ch.subs].filter((s) => !s.closed);
    if (subs.length === 0) return;
    const live = subs.filter((s) => s.held === null);
    for (const s of subs) if (s.held !== null) s.held.push(m);
    if (live.length === 0) return;
    let rule: Rule | null;
    try {
      rule = await live[0].input.currentRule();
    } catch {
      for (const s of live) this.fail(s, 'unavailable', 'The live subscription lost its connection to the server; it reconnects.');
      return;
    }
    await Promise.all(live.map((s) => this.deliver(s, m, rule)));
  }

  /** The caller as of now: the session read again at most every PRINCIPAL_RECHECK_MS (`force`: now). */
  private async principalOf(sub: Sub, force = false): Promise<Principal> {
    if (force || this.now() - sub.principalAt >= PRINCIPAL_RECHECK_MS) {
      sub.principal = await sub.input.currentPrincipal();
      sub.principalAt = this.now();
    }
    return sub.principal;
  }

  private async deliver(sub: Sub, m: FeedMessage, rule: Rule | null): Promise<void> {
    if (sub.closed) return;
    let principal: Principal;
    try {
      principal = await this.principalOf(sub);
    } catch {
      this.fail(sub, 'unavailable', 'The live subscription lost its connection to the server; it reconnects.');
      return;
    }
    const c = check(sub.input.collection, rule, principal);
    if (!c.ok) {
      this.fail(sub, c.code, c.message);
      return;
    }
    if (m === 'reset') {
      this.write(sub, frame('reset', { at: new Date(this.now()).toISOString() }));
      return;
    }
    if (sub.lastId && compareEventIds(m.id, sub.lastId) <= 0) return;
    const e = m.event;
    let out: unknown;
    if (e.op === 'reset') out = null;
    else if (e.op === 'delete') {
      if (c.ownerId !== null && e.owner !== c.ownerId) return;
      out = { op: 'delete', id: e.id, at: e.at };
    } else {
      if (c.ownerId !== null && e.record._owner !== c.ownerId) return;
      out = { op: e.op, record: sub.input.forCaller(e.record, principal), at: e.at };
    }
    sub.lastId = m.id;
    this.write(sub, out === null ? frame('reset', { at: e.at }, m.id) : frame('change', out, m.id));
  }

  private async heartbeat(sub: Sub): Promise<void> {
    if (sub.closed) return;
    try {
      const principal = await this.principalOf(sub, true);
      const c = check(sub.input.collection, await sub.input.currentRule(), principal);
      if (!c.ok) {
        this.fail(sub, c.code, c.message);
        return;
      }
    } catch {
      this.fail(sub, 'unavailable', 'The live subscription lost its connection to the server; it reconnects.');
      return;
    }
    this.write(sub, ': ping\n\n');
  }

  private write(sub: Sub, text: string): void {
    if (sub.closed) return;
    if (sub.stream.readableLength > MAX_BUFFERED_BYTES) {
      this.fail(sub, 'slow_client', 'The app read the live events too slowly; it reconnects and resumes.');
      return;
    }
    sub.stream.push(text);
  }

  private fail(sub: Sub, code: string, message: string): void {
    if (sub.closed) return;
    sub.stream.push(frame('error', { error: code, message }));
    sub.close();
  }
}

let hub: LiveHub | null = null;

/** The process's hub (ended by the server's graceful stop). */
export function liveHub(): LiveHub {
  if (!hub) {
    const h = new LiveHub(changeFeed());
    onModuleStreamsEnd(() => h.endAll());
    hub = h;
  }
  return hub;
}

/** Tests: use `h` as the process's hub (null = a new default one on next use). */
export function setLiveHubForTests(h: LiveHub | null): void {
  hub = h;
}
