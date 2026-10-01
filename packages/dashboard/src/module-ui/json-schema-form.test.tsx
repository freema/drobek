import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { z, type ConfigFieldMeta } from '@drobek/modules';
import { collectionChoices, formChoices, intervalChoices, upstreamChoices, type ChoiceList } from '../module-choices.js';
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

const RULE = z.string().regex(/^(public|user|owner|admin|none)(\|(public|user|owner|admin|none))*$/);

const ADMIN = z.strictObject({
  rules: z
    .strictObject({
      upload: RULE.default('user').meta({ title: 'Who may upload', description: 'Opening uploads to anyone waits.', 'x-drobek-rule': ['public', 'user', 'admin'] } satisfies ConfigFieldMeta),
      read: RULE.default('user').meta({ title: 'Who may download', 'x-drobek-rule': true } satisfies ConfigFieldMeta),
    })
    .default({ upload: 'user', read: 'user' })
    .meta({ title: 'Access' }),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024 * 1024)
    .optional()
    .meta({ title: 'Largest file', 'x-drobek-unit': 'bytes', 'x-drobek-default-limit': 'FILES_MAX_BYTES' } satisfies ConfigFieldMeta),
  forms: z
    .record(
      z.string().meta({ title: 'Form name', 'x-drobek-choices': 'forms' } satisfies ConfigFieldMeta),
      z.strictObject({ note: z.string().optional(), paused: z.boolean().optional().meta({ 'x-drobek-hidden': true } satisfies ConfigFieldMeta) })
    )
    .default({}),
  provider: z
    .strictObject({ issuer: z.string().optional(), enabled: z.boolean().meta({ title: 'On' }) })
    .meta({ title: 'Company account', 'x-drobek-order': ['enabled'] } satisfies ConfigFieldMeta),
});

const ADMIN_FIELDS = schemaFields(z.toJSONSchema(ADMIN, { unrepresentable: 'any', io: 'input' }));

const FORMS = formChoices({
  forms: [
    { name: 'contact', submissions: 3 },
    { name: 'newsletter', submissions: 1 },
    { name: 'survey', submissions: 0 },
  ],
});

function renderAdmin(config: unknown, opts: { readOnly?: boolean; choices?: Record<string, ChoiceList>; limits?: Record<string, number> } = {}): string {
  const element = (
    <JsonSchemaForm
      fields={ADMIN_FIELDS}
      values={fieldValues(ADMIN_FIELDS, config)}
      readOnly={opts.readOnly ?? false}
      choices={opts.choices}
      limits={opts.limits}
    />
  );
  const router = createMemoryRouter([{ path: '/', element }], { initialEntries: ['/'] });
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

/** The opening tag of the element that carries the given test id. */
function tagOf(html: string, testId: string): string {
  const at = html.indexOf(`data-testid="${testId}"`);
  expect(at, testId).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<', at);
  return html.slice(open, html.indexOf('>', at) + 1);
}

const ADMIN_CONFIG = { rules: { upload: 'admin|user', read: 'owner' }, maxBytes: 5 * 1024 * 1024, forms: { contact: { paused: true } }, provider: { enabled: true } };

describe('JsonSchemaForm — rule, size, hidden and ordered fields', () => {
  it('rule fields next to each other share one table: a checkbox per principal each offers, the shown rule kept in a hidden input', () => {
    const html = renderAdmin(ADMIN_CONFIG);
    expect(html.match(/Anyone<\/th>/g)).toHaveLength(1);
    expect(html).toContain('Anyone</th>');
    expect(html).toContain('Record owner</th>');
    expect(tagOf(html, 'rule-rules-upload-user')).toContain('checked=""');
    expect(tagOf(html, 'rule-rules-upload-admin')).toContain('checked=""');
    expect(tagOf(html, 'rule-rules-upload-public')).not.toContain('checked');
    expect(tagOf(html, 'rule-rules-upload-user')).toContain('name="cfg.rules.upload.$user"');
    expect(html).not.toContain('data-testid="rule-rules-upload-owner"');
    expect(tagOf(html, 'rule-rules-read-owner')).toContain('checked=""');
    expect(html).toContain('<input type="hidden" name="cfg.rules.upload.$shown" value="admin|user"/>');
    expect(html).toContain('data-testid="rule-rules-upload-rule">admin|user</td>');
    expect(html).toContain('<strong>Who may upload</strong>');
    expect(html).toContain('Opening uploads to anyone waits.');
    expect(html).toContain('Nothing checked means nobody (none).');
    expect(html).not.toContain('name="cfg.rules.upload"');
  });

  it('a principal the rule names stays offered even where the field does not list it, so a save keeps it', () => {
    const html = renderAdmin({ ...ADMIN_CONFIG, rules: { upload: 'owner', read: 'user' } });
    expect(tagOf(html, 'rule-rules-upload-owner')).toContain('checked=""');
  });

  it('a bytes field is entered in MB, says its bounds in MB and what an empty field means', () => {
    const html = renderAdmin({ ...ADMIN_CONFIG, maxBytes: undefined }, { limits: { FILES_MAX_BYTES: 25 * 1024 * 1024 } });
    expect(tagOf(html, 'field-maxBytes')).toContain('inputMode="decimal"');
    expect(html).toMatch(/data-testid="field-maxBytes"[^>]*\/><span[^>]*>MB<\/span>/);
    expect(html).toContain('At most 1024 MB. Left empty: 25 MB, the limit in force.');
    expect(html).not.toContain('A whole number.');
    expect(tagOf(renderAdmin(ADMIN_CONFIG), 'field-maxBytes')).toContain('value="5"');
    expect(renderAdmin(ADMIN_CONFIG)).not.toContain('Left empty');
  });

  it('a hidden field is only a hidden input with its value; an ordered object leads with the listed key', () => {
    const html = renderAdmin(ADMIN_CONFIG);
    expect(tagOf(html, 'field-forms-0-paused')).toBe('<input type="hidden" data-testid="field-forms-0-paused" name="cfg.forms[0].paused" value="true"/>');
    expect(tagOf(html, 'field-forms-1-paused')).toContain('value=""');
    expect(html).not.toContain('>Paused<');
    expect(html.indexOf('name="cfg.provider.enabled"')).toBeLessThan(html.indexOf('name="cfg.provider.issuer"'));
  });

  it("a record's new entry suggests the names no entry uses yet (a datalist and in words)", () => {
    const html = renderAdmin(ADMIN_CONFIG, { choices: { forms: FORMS } });
    expect(html).toContain(
      '<datalist id="names-forms" data-testid="entry-names-forms"><option value="newsletter" label="1 submission"></option><option value="survey" label="no submissions yet"></option></datalist>'
    );
    expect(tagOf(html, 'entry-key-forms-1')).toContain('list="names-forms"');
    expect(tagOf(html, 'entry-key-forms-0')).not.toContain('list=');
    expect(html).toContain('Suggested: newsletter (1 submission), survey (no submissions yet).');
    const none = renderAdmin({ ...ADMIN_CONFIG, forms: { contact: {}, newsletter: {}, survey: {} } }, { choices: { forms: FORMS } });
    expect(none).not.toContain('<datalist');
    const failed = renderAdmin(ADMIN_CONFIG, { choices: { forms: { ...FORMS, failed: 'The app’s forms could not be loaded.' } } });
    expect(failed).not.toContain('<datalist');
  });

  it('a viewer sees the rule checkboxes disabled, no hidden inputs and no suggestions', () => {
    const html = renderAdmin(ADMIN_CONFIG, { readOnly: true, choices: { forms: FORMS } });
    expect(tagOf(html, 'rule-rules-upload-user')).toContain('disabled=""');
    expect(html).not.toContain('$shown');
    expect(html).not.toContain('name="cfg.forms[0].paused"');
    expect(html).not.toContain('<datalist');
  });
});
