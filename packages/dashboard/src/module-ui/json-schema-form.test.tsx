import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { z, type ConfigFieldMeta } from '@drobek/modules';
import { collectionChoices, intervalChoices, upstreamChoices, type ChoiceList } from '../module-choices.js';
import { fieldValues, schemaFields } from '../module-config.js';
import { JsonSchemaForm } from './json-schema-form.js';

const SCHEMA = z.strictObject({
  upstream: z.string().meta({ title: 'Upstream', 'x-drobek-choices': 'upstreams' } satisfies ConfigFieldMeta),
  every: z.string().default('1h').meta({ title: 'Schedule', 'x-drobek-choices': 'intervals', 'x-drobek-min-interval': 'MIN' } satisfies ConfigFieldMeta),
  collection: z.string().meta({ title: 'Collection', 'x-drobek-choices': 'collections' } satisfies ConfigFieldMeta),
  mode: z.enum(['replace', 'upsert']).default('replace'),
  kind: z.enum(['a', 'b']).optional(),
  sources: z.record(z.string().meta({ title: 'Source name' }), z.strictObject({ upstream: z.string().meta({ 'x-drobek-choices': 'upstreams' } satisfies ConfigFieldMeta) })).default({}),
});

const FIELDS = schemaFields(z.toJSONSchema(SCHEMA, { unrepresentable: 'any', io: 'input' }));

const UPSTREAMS = upstreamChoices({
  upstreams: [
    { name: 'scores', assigned: true },
    { name: 'weather', assigned: false },
  ],
  register: { href: '/workspaces/acme/upstreams', label: 'Open the Upstreams page' },
  assign: { module: 'gateway', href: '/workspaces/acme/apps/shop/modules/gateway#upstreams', label: 'Assign an upstream' },
});
const NO_UPSTREAMS = upstreamChoices({ upstreams: [], register: { href: '/workspaces/acme/upstreams', label: 'Open the Upstreams page' }, assign: null });
const COLLECTIONS = collectionChoices({ collections: ['players'], create: null });
const NO_COLLECTIONS = collectionChoices({
  collections: [],
  create: { module: 'store', href: '/workspaces/acme/apps/shop/modules/store#collections', label: 'Create a collection' },
});

function render(config: unknown, choices: Record<string, ChoiceList> | undefined, readOnly = false): string {
  const element = <JsonSchemaForm fields={FIELDS} values={fieldValues(FIELDS, config)} readOnly={readOnly} choices={choices} />;
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] });
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

/** The <select> element that carries the given test id. */
function select(html: string, testId: string): string {
  const start = html.indexOf(`data-testid="${testId}"`);
  expect(start, testId).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<select', start);
  return html.slice(open, html.indexOf('</select>', start) + '</select>'.length);
}

const ALL = { upstreams: UPSTREAMS, 'intervals:MIN': intervalChoices(15), collections: COLLECTIONS };

describe('JsonSchemaForm — fields with choices', () => {
  it('a select per annotated field: grouped upstreams, intervals from the minimum, the default named in the empty option', () => {
    const html = render({ upstream: 'scores', every: '1h', collection: 'players', mode: 'replace', sources: {} }, ALL);
    const upstream = select(html, 'field-upstream');
    expect(upstream).toContain('name="cfg.upstream"');
    expect(upstream).toContain('<optgroup label="Assigned to this app"><option value="scores" selected="">scores</option></optgroup>');
    expect(upstream).toContain('<optgroup label="Not assigned to this app yet"><option value="weather">weather</option></optgroup>');
    expect(upstream).not.toContain('<option value="">');
    expect(html).toContain('data-testid="field-note-upstream"');
    expect(html).toContain('href="/workspaces/acme/apps/shop/modules/gateway#upstreams"');

    const every = select(html, 'field-every');
    expect(every).toContain('<option value="">Default (1h)</option>');
    expect(every).not.toContain('value="5m"');
    expect(every).toContain('<option value="15m">every 15 minutes</option>');
    expect(every).toContain('<option value="1h" selected="">every hour</option>');
    expect(html).toContain('This server runs a schedule at most every 15 minutes.');

    expect(select(html, 'field-collection')).toContain('<option value="players" selected="">players</option>');
    // A plain enum with a default names it too.
    expect(select(html, 'field-mode')).toContain('<option value="">Default (replace)</option>');
    expect(select(html, 'field-kind')).toContain('<option value="" selected="">(not set)</option>');
  });

  it('a current value that is not among the choices stays selected, marked; a required field without a value offers Choose…', () => {
    const html = render({ upstream: 'gone', every: '2h', collection: '', sources: {} }, ALL);
    const upstream = select(html, 'field-upstream');
    expect(upstream).toContain('<option value="gone" selected="">gone — not registered in this workspace</option>');
    expect(select(html, 'field-every')).toContain('<option value="2h" selected="">2h — the current value</option>');
    const collection = select(html, 'field-collection');
    expect(collection).toContain('<option value="" selected="">Choose…</option>');
  });

  it('nothing to choose: no select — what to set up first, with the link; a kept value still shows in a select', () => {
    const html = render({ upstream: '', collection: '', sources: {} }, { ...ALL, upstreams: NO_UPSTREAMS, collections: NO_COLLECTIONS });
    expect(html).not.toContain('name="cfg.upstream"');
    expect(html).toContain('data-testid="field-empty-upstream"');
    expect(html).toContain('This workspace has no upstream yet. A workspace admin registers one on the Upstreams page.');
    expect(html).toContain('<a href="/workspaces/acme/upstreams">Open the Upstreams page</a>');
    expect(html).toContain('This app has no data collection yet. Create one in the store module first.');
    expect(html).toContain('<a href="/workspaces/acme/apps/shop/modules/store#collections">Create a collection</a>');
    // The empty "add" entry of the record says the same.
    expect(html).toContain('data-testid="field-empty-sources-0-upstream"');

    const kept = render({ upstream: 'scores', collection: '', sources: {} }, { ...ALL, upstreams: NO_UPSTREAMS });
    expect(select(kept, 'field-upstream')).toContain('<option value="scores" selected="">scores — not registered in this workspace</option>');
  });

  it('a list that failed to load leaves a text input with a note; without choices every field is a text input', () => {
    const failed = render({ upstream: 'scores', sources: {} }, { ...ALL, upstreams: { groups: [], missing: '', empty: { text: '' }, failed: 'The upstreams could not be loaded.' } });
    expect(failed).toMatch(/<input type="text"[^>]*name="cfg.upstream"[^>]*value="scores"/);
    expect(failed).toContain('The upstreams could not be loaded.');
    const plain = render({ upstream: 'scores', sources: {} }, undefined);
    expect(plain).toMatch(/<input type="text"[^>]*name="cfg.upstream"/);
    expect(plain).not.toContain('data-choices=');
  });

  it("an entry's choices come from the same lists; its name is labelled by the record's propertyNames title", () => {
    const html = render({ sources: { feed: { upstream: 'weather' } } }, ALL);
    expect(select(html, 'field-sources-0-upstream')).toContain('<option value="weather" selected="">weather</option>');
    expect(select(html, 'field-sources-1-upstream')).toContain('<option value="" selected="">Choose…</option>');
    expect(html).toContain('>Source name</label>');
  });

  it('a viewer gets the same selects disabled, without the notes that lead to a change', () => {
    const html = render({ upstream: 'scores', every: '1h', collection: 'players', sources: {} }, ALL, true);
    expect(select(html, 'field-upstream')).toContain('disabled=""');
    expect(html).not.toContain('data-testid="field-note-upstream"');
  });
});
