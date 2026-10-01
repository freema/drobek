/**
 * Our own JSON Schema → form renderer (no vendor form
 * library): renders the `FormField`s of `schemaFields()` as plain inputs named
 * after their config path (`cfg.<path>`), so the form posts without any client
 * JS and the server rebuilds the config with `formToConfig()`. Validation is
 * the server's (the module's configSchema): errors come back per field.
 * `readOnly` (a viewer) renders the same values disabled and no button.
 *
 * A `record` (named entries) or `object-list` field renders each
 * entry with its own fields (recursively), a "Remove" checkbox per entry and
 * ONE empty entry to add a new one — still no client JS. Errors inside an
 * entry are shown at the top-level record / list they belong to.
 *
 * Labels are the schema's `title` (else the humanized key); the config keys
 * sit in a collapsed "Config keys for agents" table. With `states`, each
 * top-level setting says whether it is the module's default or saved for
 * the app, and what a change awaiting confirmation would make it.
 *
 * A string field annotated `x-drobek-choices` is a select of the list
 * `choices` holds for it (module-choices.ts): a current value outside the
 * list stays selectable, marked; with nothing to choose the field says what
 * to set up first and links there; a list that failed to load leaves a
 * text input. A select's empty option names the schema's default. A
 * record whose entry name is annotated suggests the names no entry uses yet
 * for a new entry (a datalist; any other name can still be typed).
 *
 * Rule fields (`x-drobek-rule`) next to each other share one table, a
 * checkbox per principal, like the collections editor's. A `bytes` field is
 * entered in MB. A hidden field (`x-drobek-hidden`) is only a hidden input
 * carrying its value through a save. A field naming the limit an empty
 * value stands for says what that is (`limits`).
 */
import type { ReactNode } from 'react';
import { Form } from 'react-router';
import { hasChoices, nameSuggestions, optionText, selectGroups, type ChoiceLink, type ChoiceList } from '../module-choices.js';
import {
  blankEntryValues,
  choiceKey,
  entryInputs,
  fieldName,
  instancePath,
  isEntriesValue,
  leafFields,
  listRule,
  mbLabel,
  needsValue,
  optionInputName,
  ruleInputs,
  ruleToPrincipals,
  ENTRY_VALUE,
  PRINCIPALS,
  type EntriesValue,
  type FieldState,
  type FieldValue,
  type FormField,
  type PrincipalName,
} from '../module-config.js';
import { RuleTable } from './rules-editors.js';
import { ui } from './styles.js';

export interface JsonSchemaFormProps {
  fields: FormField[];
  values: Record<string, FieldValue>;
  errors?: Record<string, string[]>;
  readOnly: boolean;
  busy?: boolean;
  /** Per top-level field: the module's default or saved for this app, and its value once a pending change is confirmed. */
  states?: Record<string, FieldState>;
  /** The choices of the fields annotated `x-drobek-choices`, by `choiceKey()`. */
  choices?: Record<string, ChoiceList>;
  /** The workspace's values of the limits fields name with `x-drobek-default-limit`. */
  limits?: Record<string, number>;
}

function testId(path: string): string {
  return path.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+$/, '');
}

function FieldErrors({ path, errors }: { path: string; errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p style={ui.fieldError} role="alert" id={`err-${testId(path)}`} data-testid={`field-error-${testId(path)}`}>
      {errors.join(' · ')}
    </p>
  );
}

/** Where a field's inputs live and how it is shown. */
interface Place {
  /** `''` top level, `<collection>[<i>]` inside an entry. */
  prefix: string;
  readOnly: boolean;
  /** Inside the empty "add" entry: every select offers its empty option. */
  blank: boolean;
  /** Top level only: where each field's value comes from. */
  states?: Record<string, FieldState>;
  choices?: Record<string, ChoiceList>;
  limits?: Record<string, number>;
}

/** The empty option of a select: the schema's default, else "Choose…" (required) / "(not set)". */
function emptyOptionLabel(field: FormField): string {
  if (typeof field.default === 'string' && field.default !== '') return `Default (${field.default})`;
  return field.required ? 'Choose…' : '(not set)';
}

function ChoiceNote({ text, link, testId: id }: { text: string; link?: ChoiceLink; testId: string }) {
  return (
    <span style={ui.desc} data-testid={id}>
      {text}
      {link ? (
        <>
          {' '}
          <a href={link.href}>{link.label}</a>
        </>
      ) : null}
    </span>
  );
}

function RequiredMark({ field }: { field: FormField }) {
  return needsValue(field) ? (
    <span style={ui.muted} title="Must have a value">
      {' '}
      *
    </span>
  ) : null;
}

/** "Default" / "Saved for this app" next to a top-level label. */
function OriginTag({ path, place }: { path: string; place: Place }) {
  const state = place.prefix === '' ? place.states?.[path] : undefined;
  if (!state) return null;
  return state.origin === 'saved' ? (
    <span style={ui.savedTag} data-testid={`field-origin-${testId(path)}`} data-origin="saved">
      Saved for this app
    </span>
  ) : (
    <span style={ui.originTag} data-testid={`field-origin-${testId(path)}`} data-origin="default">
      Default
    </span>
  );
}

/** The value a top-level field takes once the change awaiting confirmation is confirmed. */
function PendingNote({ path, place }: { path: string; place: Place }) {
  const pending = place.prefix === '' ? place.states?.[path]?.pending : undefined;
  if (pending === undefined) return null;
  return (
    <span style={ui.pendingNote} data-testid={`field-pending-${testId(path)}`}>
      Waiting for confirmation: <code style={ui.mono}>{pending}</code> — the value shown here stays in force until it is confirmed.
    </span>
  );
}

function Description({ field }: { field: FormField }) {
  const text = [field.description, listRule(field)].filter(Boolean).join(' ');
  return text ? <span style={ui.desc}>{text}</span> : null;
}

/** A number as the field's hints show it (bytes in MB). */
function sizeText(field: FormField, n: number): string {
  return field.unit === 'bytes' ? mbLabel(n) : String(n);
}

/** The schema's bounds in words (a `bytes` minimum of one byte says nothing). */
function rangeText(field: FormField): string {
  if (field.unit === 'bytes') {
    const low = field.min !== undefined && field.min > 1 ? field.min : undefined;
    if (low !== undefined && field.max !== undefined) return ` ${sizeText(field, low)}–${sizeText(field, field.max)}.`;
    if (field.max !== undefined) return ` At most ${sizeText(field, field.max)}.`;
    return low !== undefined ? ` At least ${sizeText(field, low)}.` : '';
  }
  if (field.min !== undefined || field.max !== undefined) return ` ${field.min ?? '…'}–${field.max ?? '…'}.`;
  return field.maxLength !== undefined ? ` At most ${field.maxLength} characters.` : '';
}

/** What an empty field means: the workspace's value of the limit it names, else a unit field's default. */
function emptyText(field: FormField, place: Place): string {
  const limit = field.defaultLimit ? place.limits?.[field.defaultLimit] : undefined;
  if (limit !== undefined) return ` Left empty: ${sizeText(field, limit)}, the limit in force.`;
  if (field.unit && typeof field.default === 'number') return ` Default: ${sizeText(field, field.default)}.`;
  return '';
}

function Leaf({ field, value, errors, place }: { field: FormField; value: FieldValue | undefined; errors?: string[]; place: Place }) {
  const instance = instancePath(place.prefix, field.path);
  const id = `cfg-${testId(instance)}`;
  const name = fieldName(instance);
  const invalid = Boolean(errors?.length);
  const common = {
    id,
    name,
    disabled: place.readOnly,
    'aria-invalid': invalid || undefined,
    'aria-describedby': invalid ? `err-${testId(instance)}` : undefined,
    'data-testid': `field-${testId(instance)}`,
  };
  const inputStyle = invalid ? { ...ui.input, ...ui.inputError } : ui.input;
  const areaStyle = invalid ? { ...ui.textarea, ...ui.inputError } : ui.textarea;
  const text = typeof value === 'string' ? value : '';
  if (field.hidden) {
    return place.readOnly ? null : <input type="hidden" name={name} value={text} data-testid={`field-${testId(instance)}`} />;
  }
  const key = field.kind === 'string' ? choiceKey(field) : null;
  const list = key ? place.choices?.[key] : undefined;

  if (list && !list.failed && !hasChoices(list) && text === '') {
    return (
      <div style={ui.field} data-testid={`field-${testId(instance)}`} data-choices="empty">
        <span style={ui.label}>
          {field.label}
          <RequiredMark field={field} />
          <OriginTag path={field.path} place={place} />
        </span>
        {field.description ? <span style={ui.desc}>{field.description}</span> : null}
        <PendingNote path={field.path} place={place} />
        <p style={{ ...ui.small, margin: '0.25rem 0 0' }} data-testid={`field-empty-${testId(instance)}`}>
          {list.empty.text}
          {list.empty.link ? (
            <>
              {' '}
              <a href={list.empty.link.href}>{list.empty.link.label}</a>
            </>
          ) : null}
        </p>
        <FieldErrors path={instance} errors={errors} />
      </div>
    );
  }

  let control;
  let choiceNote = null;
  switch (field.kind) {
    case 'boolean':
      return (
        <div style={ui.field}>
          <label style={{ ...ui.label, display: 'flex', gap: '0.45rem', alignItems: 'center' }} htmlFor={id}>
            <input type="checkbox" {...common} defaultChecked={value === true} />
            {field.label}
            <OriginTag path={field.path} place={place} />
          </label>
          {field.description ? <span style={ui.desc}>{field.description}</span> : null}
          <PendingNote path={field.path} place={place} />
          <FieldErrors path={instance} errors={errors} />
        </div>
      );
    case 'enum-list': {
      const picked = new Set(Array.isArray(value) ? value : []);
      return (
        <fieldset style={ui.fieldset} data-testid={`field-${testId(instance)}`}>
          <legend style={ui.legend}>
            {field.label}
            <OriginTag path={field.path} place={place} />
          </legend>
          <Description field={field} />
          <PendingNote path={field.path} place={place} />
          <div style={{ ...ui.row, margin: '0.3rem 0 0.5rem' }}>
            {field.options?.map((o, j) => (
              <label key={o} style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center', fontSize: '0.88rem' }}>
                <input
                  type="checkbox"
                  name={optionInputName(instance, j)}
                  defaultChecked={picked.has(o)}
                  disabled={place.readOnly}
                  data-testid={`option-${testId(instance)}-${j}`}
                />
                <code style={ui.mono}>{o}</code>
              </label>
            ))}
          </div>
          <FieldErrors path={instance} errors={errors} />
        </fieldset>
      );
    }
    case 'enum':
      control = (
        <select {...common} defaultValue={text} style={inputStyle}>
          {!field.required || place.blank ? <option value="">{emptyOptionLabel(field)}</option> : null}
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'number':
    case 'integer':
      control =
        field.unit === 'bytes' ? (
          <span style={{ display: 'flex', gap: '0.45rem', alignItems: 'center', maxWidth: '14rem' }}>
            <input type="text" inputMode="decimal" {...common} defaultValue={text} style={inputStyle} />
            <span style={ui.muted}>MB</span>
          </span>
        ) : (
          <input
            type="text"
            inputMode={field.kind === 'integer' ? 'numeric' : 'decimal'}
            {...common}
            defaultValue={text}
            style={inputStyle}
          />
        );
      break;
    case 'string-list':
      control = <textarea {...common} defaultValue={text} style={areaStyle} rows={Math.min(8, Math.max(3, text.split('\n').length + 1))} />;
      break;
    case 'json':
      control = <textarea {...common} defaultValue={text} style={{ ...areaStyle, minHeight: '8rem' }} spellCheck={false} />;
      break;
    default:
      if (list && !list.failed) {
        control = (
          <select {...common} defaultValue={text} style={inputStyle} data-choices={field.choices}>
            {!field.required || place.blank || text === '' ? <option value="">{emptyOptionLabel(field)}</option> : null}
            {selectGroups(list, text).map((g, i) =>
              g.label ? (
                <optgroup key={`${i}-${g.label}`} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {optionText(o)}
                    </option>
                  ))}
                </optgroup>
              ) : (
                g.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {optionText(o)}
                  </option>
                ))
              )
            )}
          </select>
        );
        if (list.note && !place.readOnly) choiceNote = <ChoiceNote text={list.note.text} link={list.note.link} testId={`field-note-${testId(instance)}`} />;
      } else {
        control = <input type="text" {...common} defaultValue={text} style={inputStyle} autoComplete="off" />;
        if (list?.failed) choiceNote = <ChoiceNote text={list.failed} testId={`field-note-${testId(instance)}`} />;
      }
  }
  const kindHint =
    field.kind === 'string-list'
      ? `One per line. ${listRule(field) ?? ''}`.trim()
      : field.kind === 'json'
        ? 'JSON.'
        : field.kind === 'integer' && !field.unit
          ? 'A whole number.'
          : null;
  const range = `${rangeText(field)}${emptyText(field, place)}`;
  return (
    <div style={ui.field}>
      <label style={ui.label} htmlFor={id}>
        {field.label}
        <RequiredMark field={field} />
        <OriginTag path={field.path} place={place} />
      </label>
      {field.description || kindHint || range ? (
        <span style={ui.desc}>
          {[field.description, kindHint].filter(Boolean).join(' ')}
          {range}
        </span>
      ) : null}
      <PendingNote path={field.path} place={place} />
      {control}
      {choiceNote}
      <FieldErrors path={instance} errors={errors} />
    </div>
  );
}

/** Names suggested for a new record entry: the datalist's id and the same names in words. */
interface NameSuggestions {
  listId: string;
  text: string;
}

/** At most this many suggested names are listed in words (the datalist has them all). */
const SUGGESTED_NAMES_SHOWN = 8;

/** One entry of a record / list: its name (records), its fields, a remove box — or the empty "add" entry. */
function Entry({
  field,
  instance,
  index,
  entry,
  isNew,
  readOnly,
  choices,
  limits,
  suggest,
}: {
  field: FormField;
  instance: string;
  index: number;
  entry: { key?: string; values: Record<string, FieldValue> };
  isNew: boolean;
  readOnly: boolean;
  choices?: Record<string, ChoiceList>;
  limits?: Record<string, number>;
  suggest?: NameSuggestions;
}) {
  const record = field.kind === 'record';
  const prefix = entryInputs.prefix(instance, index);
  const keyId = `cfg-${testId(prefix)}-key`;
  const plain = field.entry?.length === 1 && field.entry[0].path === ENTRY_VALUE;
  return (
    <div style={isNew ? ui.newEntry : ui.entry} data-testid={isNew ? `entry-new-${testId(instance)}` : `entry-${testId(instance)}`}>
      {isNew ? (
        <>
          <input type="hidden" name={entryInputs.isNew(instance, index)} value="1" />
          <p style={{ ...ui.small, margin: '0 0 0.4rem', fontWeight: 600 }}>{record ? 'Add an entry' : 'Add an item'} — leave empty to add nothing</p>
        </>
      ) : null}
      {record ? (
        <div style={ui.field}>
          <label style={ui.label} htmlFor={keyId}>
            {field.entryKey?.label ?? 'Name'}
          </label>
          {field.entryKey?.description ? <span style={ui.desc}>{field.entryKey.description}</span> : null}
          {isNew && suggest ? (
            <span style={ui.desc} data-testid={`entry-suggested-${testId(instance)}`}>
              {suggest.text}
            </span>
          ) : null}
          <input
            type="text"
            id={keyId}
            name={entryInputs.key(instance, index)}
            defaultValue={entry.key ?? ''}
            disabled={readOnly}
            autoComplete="off"
            list={isNew ? suggest?.listId : undefined}
            style={ui.input}
            data-testid={`entry-key-${testId(prefix)}`}
          />
        </div>
      ) : null}
      <div style={plain ? undefined : ui.entryBody}>
        <Fields fields={field.entry ?? []} values={entry.values} place={{ prefix, readOnly, blank: isNew, choices, limits }} />
      </div>
      {!isNew && !readOnly ? (
        <label style={{ ...ui.small, display: 'inline-flex', gap: '0.35rem', alignItems: 'center' }}>
          <input type="checkbox" name={entryInputs.remove(instance, index)} data-testid={`entry-remove-${testId(prefix)}`} />
          Remove {record ? `“${entry.key ?? ''}”` : `item ${index + 1}`}
        </label>
      ) : null}
    </div>
  );
}

function EntriesField({ field, value, errors, place }: { field: FormField; value: FieldValue | undefined; errors?: string[]; place: Place }) {
  const instance = instancePath(place.prefix, field.path);
  const entries = isEntriesValue(value) ? value.entries : ([] as EntriesValue['entries']);
  const count = entries.length + (place.readOnly ? 0 : 1);
  const namesKey = field.kind === 'record' && field.entryKey ? choiceKey(field.entryKey) : null;
  const names = namesKey && !place.readOnly ? nameSuggestions(place.choices?.[namesKey], entries.map((e) => e.key ?? '')) : [];
  const listId = `names-${testId(instance)}`;
  const shown = names.slice(0, SUGGESTED_NAMES_SHOWN).map((o) => (o.detail ? `${o.value} (${o.detail})` : o.value));
  const suggest: NameSuggestions | undefined =
    names.length > 0 ? { listId, text: `Suggested: ${shown.join(', ')}${names.length > shown.length ? ', …' : ''}.` } : undefined;
  return (
    <fieldset style={ui.fieldset} data-testid={`field-${testId(instance)}`} aria-invalid={errors?.length ? true : undefined}>
      <legend style={ui.legend}>
        {field.label}
        <OriginTag path={field.path} place={place} />
      </legend>
      <Description field={field} />
      <PendingNote path={field.path} place={place} />
      <input type="hidden" name={entryInputs.count(instance)} value={count} />
      {suggest ? (
        <datalist id={listId} data-testid={`entry-names-${testId(instance)}`}>
          {names.map((o) => (
            <option key={o.value} value={o.value} label={o.detail} />
          ))}
        </datalist>
      ) : null}
      {entries.length === 0 && place.readOnly ? <p style={ui.small}>No entries.</p> : null}
      {entries.map((e, i) => (
        <Entry
          key={`${i}-${e.key ?? ''}`}
          field={field}
          instance={instance}
          index={i}
          entry={e}
          isNew={false}
          readOnly={place.readOnly}
          choices={place.choices}
          limits={place.limits}
        />
      ))}
      {!place.readOnly ? (
        <Entry
          field={field}
          instance={instance}
          index={entries.length}
          entry={{ values: blankEntryValues(field) }}
          isNew
          readOnly={false}
          choices={place.choices}
          limits={place.limits}
          suggest={suggest}
        />
      ) : null}
      <FieldErrors path={instance} errors={errors} />
    </fieldset>
  );
}

/** Rule fields next to each other: one table, a row per field and a checkbox per principal its rule may name. */
function RuleFields({ fields, values, errors, place }: { fields: FormField[]; values: Record<string, FieldValue>; errors?: Record<string, string[]>; place: Place }) {
  const rows = fields.map((f) => {
    const instance = instancePath(place.prefix, f.path);
    const value = values[f.path];
    const rule = typeof value === 'string' ? value : '';
    const offered = new Set<PrincipalName>([...(f.principals ?? PRINCIPALS), ...ruleToPrincipals(rule)]);
    return { f, instance, rule, offered: PRINCIPALS.filter((p) => offered.has(p)) };
  });
  return (
    <div style={ui.field}>
      {place.readOnly ? null : rows.map((r) => <input key={r.instance} type="hidden" name={ruleInputs.shown(r.instance)} value={r.rule} />)}
      <RuleTable
        head="Setting"
        principals={PRINCIPALS.filter((p) => rows.some((r) => r.offered.includes(p)))}
        readOnly={place.readOnly}
        testPrefix="rule"
        rows={rows.map(({ f, instance, rule, offered }) => ({
          op: testId(instance),
          name: f.label,
          title: (
            <>
              <strong>{f.label}</strong>
              <OriginTag path={f.path} place={place} />
            </>
          ),
          meaning: f.description,
          after: (
            <>
              <PendingNote path={f.path} place={place} />
              <FieldErrors path={instance} errors={errors?.[f.path]} />
            </>
          ),
          rule,
          offered,
          inputName: (p: PrincipalName) => ruleInputs.principal(instance, p),
          testId: `field-${testId(instance)}`,
        }))}
      />
      <span style={ui.desc}>Nothing checked means nobody (none).</span>
    </div>
  );
}

function Fields({
  fields,
  values,
  errors,
  place,
}: {
  fields: FormField[];
  values: Record<string, FieldValue>;
  /** Top level only: inside an entry the errors are shown at its record / list. */
  errors?: Record<string, string[]>;
  place: Place;
}) {
  const out: ReactNode[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.kind === 'rule') {
      const run = [f];
      while (i + 1 < fields.length && fields[i + 1].kind === 'rule') run.push(fields[++i]);
      out.push(<RuleFields key={f.path} fields={run} values={values} errors={errors} place={place} />);
    } else if (f.kind === 'object') {
      out.push(
        <fieldset key={f.path} style={ui.fieldset}>
          <legend style={ui.legend}>{f.label}</legend>
          {f.description ? <span style={ui.desc}>{f.description}</span> : null}
          <Fields fields={f.children ?? []} values={values} errors={errors} place={place} />
        </fieldset>
      );
    } else if (f.kind === 'record' || f.kind === 'object-list') {
      out.push(<EntriesField key={f.path} field={f} value={values[f.path]} errors={errors?.[f.path]} place={place} />);
    } else {
      out.push(<Leaf key={f.path} field={f} value={values[f.path]} errors={errors?.[f.path]} place={place} />);
    }
  }
  return <>{out}</>;
}

/** Which config key each field sets — what an agent passes to configure_module. */
function ConfigPaths({ fields, states }: { fields: FormField[]; states?: Record<string, FieldState> }) {
  const leaves = leafFields(fields);
  return (
    <details style={ui.details} data-testid="config-paths">
      <summary style={ui.summary}>Config keys for agents</summary>
      <p style={{ ...ui.small, margin: '0.3rem 0' }}>
        The key each setting is stored under — what an agent passes to <code style={ui.mono}>configure_module</code>.
      </p>
      <div style={ui.tableWrap}>
        <table style={ui.table}>
          <thead>
            <tr>
              <th style={ui.th}>Setting</th>
              <th style={ui.th}>Key</th>
              <th style={ui.th}>Value from</th>
            </tr>
          </thead>
          <tbody>
            {leaves.map((f) => (
              <tr key={f.path} data-testid="config-path-row" data-path={f.path}>
                <td style={ui.td}>{f.label}</td>
                <td style={ui.td}>
                  <code style={ui.mono}>{f.path}</code>
                </td>
                <td style={ui.td}>{states?.[f.path]?.origin === 'saved' ? 'saved for this app' : 'module default'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Legend({ fields, states }: { fields: FormField[]; states?: Record<string, FieldState> }) {
  const leaves = leafFields(fields);
  const marked = leaves.some(needsValue);
  const pending = states ? Object.values(states).some((s) => s.pending !== undefined) : false;
  return (
    <p style={{ ...ui.small, margin: '0 0 0.8rem' }} data-testid="config-legend">
      <span style={ui.originTag}>Default</span> the module’s value — nothing is saved for this app.{' '}
      <span style={ui.savedTag}>Saved for this app</span> set on this page or by an agent.
      {marked ? ' * must have a value.' : ''} A list can be left empty unless it says how many items it needs.
      {pending ? ' Fields with a change waiting for confirmation show the new value; the one in force stays until it is confirmed.' : ''}
    </p>
  );
}

export function JsonSchemaForm({ fields, values, errors, readOnly, busy, states, choices, limits }: JsonSchemaFormProps) {
  if (fields.length === 0) return null;
  const body = (
    <>
      {states ? <Legend fields={fields} states={states} /> : null}
      <Fields fields={fields} values={values} errors={errors} place={{ prefix: '', readOnly, blank: false, states, choices, limits }} />
    </>
  );
  if (readOnly) {
    return (
      <div data-testid="config-form" data-readonly="true">
        {body}
        <ConfigPaths fields={fields} states={states} />
      </div>
    );
  }
  return (
    // noValidate: the module's schema on the server is the one validator.
    <Form method="post" noValidate data-testid="config-form">
      <input type="hidden" name="intent" value="save-config" />
      {body}
      <button type="submit" style={ui.button} disabled={busy} data-testid="config-save">
        Save configuration
      </button>
      <ConfigPaths fields={fields} states={states} />
    </Form>
  );
}
