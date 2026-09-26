/**
 * Our own JSON Schema → form renderer (M2-02, NSO-291; no vendor form
 * library): renders the `FormField`s of `schemaFields()` as plain inputs named
 * after their config path (`cfg.<path>`), so the form posts without any client
 * JS and the server rebuilds the config with `formToConfig()`. Validation is
 * the server's (the module's configSchema): errors come back per field.
 * `readOnly` (a viewer) renders the same values disabled and no button.
 *
 * NSO-347: a `record` (named entries) or `object-list` field renders each
 * entry with its own fields (recursively), a "Remove" checkbox per entry and
 * ONE empty entry to add a new one — still no client JS. Errors inside an
 * entry are shown at the top-level record / list they belong to.
 */
import { Form } from 'react-router';
import {
  blankEntryValues,
  entryInputs,
  fieldName,
  instancePath,
  isEntriesValue,
  optionInputName,
  ENTRY_VALUE,
  type EntriesValue,
  type FieldValue,
  type FormField,
} from '../module-config.js';
import { ui } from './styles.js';

export interface JsonSchemaFormProps {
  fields: FormField[];
  values: Record<string, FieldValue>;
  errors?: Record<string, string[]>;
  readOnly: boolean;
  busy?: boolean;
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
  /** Inside the empty "add" entry: every select offers "(not set)". */
  blank: boolean;
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

  let control;
  switch (field.kind) {
    case 'boolean':
      return (
        <div style={ui.field}>
          <label style={{ ...ui.label, display: 'flex', gap: '0.45rem', alignItems: 'center' }} htmlFor={id}>
            <input type="checkbox" {...common} defaultChecked={value === true} />
            {field.label}
          </label>
          {field.description ? <span style={ui.desc}>{field.description}</span> : null}
          <FieldErrors path={instance} errors={errors} />
        </div>
      );
    case 'enum-list': {
      const picked = new Set(Array.isArray(value) ? value : []);
      return (
        <fieldset style={ui.fieldset} data-testid={`field-${testId(instance)}`}>
          <legend style={ui.legend}>
            {field.label}
            {field.required ? <span style={ui.muted}> *</span> : null}
          </legend>
          {field.description ? <span style={ui.desc}>{field.description}</span> : null}
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
          {!field.required || place.blank ? <option value="">(not set)</option> : null}
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
      control = (
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
      control = <input type="text" {...common} defaultValue={text} style={inputStyle} autoComplete="off" />;
  }
  const kindHint =
    field.kind === 'string-list' ? 'One per line.' : field.kind === 'json' ? 'JSON.' : field.kind === 'integer' ? 'A whole number.' : null;
  const range =
    field.min !== undefined || field.max !== undefined ? ` ${field.min ?? '…'}–${field.max ?? '…'}.` : field.maxLength !== undefined ? ` At most ${field.maxLength} characters.` : '';
  return (
    <div style={ui.field}>
      <label style={ui.label} htmlFor={id}>
        {field.label}
        {field.required ? <span style={ui.muted}> *</span> : null}{' '}
        {place.prefix === '' ? <code style={{ ...ui.mono, ...ui.muted }}>{field.path}</code> : null}
      </label>
      {field.description || kindHint || range ? (
        <span style={ui.desc}>
          {[field.description, kindHint].filter(Boolean).join(' ')}
          {range}
        </span>
      ) : null}
      {control}
      <FieldErrors path={instance} errors={errors} />
    </div>
  );
}

/** One entry of a record / list: its name (records), its fields, a remove box — or the empty "add" entry. */
function Entry({
  field,
  instance,
  index,
  entry,
  isNew,
  readOnly,
}: {
  field: FormField;
  instance: string;
  index: number;
  entry: { key?: string; values: Record<string, FieldValue> };
  isNew: boolean;
  readOnly: boolean;
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
            Name
          </label>
          <input
            type="text"
            id={keyId}
            name={entryInputs.key(instance, index)}
            defaultValue={entry.key ?? ''}
            disabled={readOnly}
            autoComplete="off"
            style={ui.input}
            data-testid={`entry-key-${testId(prefix)}`}
          />
        </div>
      ) : null}
      <div style={plain ? undefined : ui.entryBody}>
        <Fields fields={field.entry ?? []} values={entry.values} place={{ prefix, readOnly, blank: isNew }} />
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
  return (
    <fieldset style={ui.fieldset} data-testid={`field-${testId(instance)}`} aria-invalid={errors?.length ? true : undefined}>
      <legend style={ui.legend}>
        {field.label}
        {field.required ? <span style={ui.muted}> *</span> : null}{' '}
        {place.prefix === '' ? <code style={{ ...ui.mono, ...ui.muted, fontWeight: 400 }}>{field.path}</code> : null}
      </legend>
      {field.description ? <span style={ui.desc}>{field.description}</span> : null}
      <input type="hidden" name={entryInputs.count(instance)} value={count} />
      {entries.length === 0 && place.readOnly ? <p style={ui.small}>No entries.</p> : null}
      {entries.map((e, i) => (
        <Entry key={`${i}-${e.key ?? ''}`} field={field} instance={instance} index={i} entry={e} isNew={false} readOnly={place.readOnly} />
      ))}
      {!place.readOnly ? (
        <Entry field={field} instance={instance} index={entries.length} entry={{ values: blankEntryValues(field) }} isNew readOnly={false} />
      ) : null}
      <FieldErrors path={instance} errors={errors} />
    </fieldset>
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
  return (
    <>
      {fields.map((f) =>
        f.kind === 'object' ? (
          <fieldset key={f.path} style={ui.fieldset}>
            <legend style={ui.legend}>{f.label}</legend>
            {f.description ? <span style={ui.desc}>{f.description}</span> : null}
            <Fields fields={f.children ?? []} values={values} errors={errors} place={place} />
          </fieldset>
        ) : f.kind === 'record' || f.kind === 'object-list' ? (
          <EntriesField key={f.path} field={f} value={values[f.path]} errors={errors?.[f.path]} place={place} />
        ) : (
          <Leaf key={f.path} field={f} value={values[f.path]} errors={errors?.[f.path]} place={place} />
        )
      )}
    </>
  );
}

export function JsonSchemaForm({ fields, values, errors, readOnly, busy }: JsonSchemaFormProps) {
  if (fields.length === 0) return null;
  const body = <Fields fields={fields} values={values} errors={errors} place={{ prefix: '', readOnly, blank: false }} />;
  if (readOnly) {
    return (
      <div data-testid="config-form" data-readonly="true">
        {body}
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
    </Form>
  );
}
