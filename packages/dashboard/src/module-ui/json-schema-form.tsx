/**
 * Our own JSON Schema → form renderer (M2-02, NSO-291; no vendor form
 * library): renders the `FormField`s of `schemaFields()` as plain inputs named
 * after their config path (`cfg.<path>`), so the form posts without any client
 * JS and the server rebuilds the config with `formToConfig()`. Validation is
 * the server's (the module's configSchema): errors come back per field.
 * `readOnly` (a viewer) renders the same values disabled and no button.
 */
import { Form } from 'react-router';
import { fieldName, type FieldValue, type FormField } from '../module-config.js';
import { ui } from './styles.js';

export interface JsonSchemaFormProps {
  fields: FormField[];
  values: Record<string, FieldValue>;
  errors?: Record<string, string[]>;
  readOnly: boolean;
  busy?: boolean;
}

function testId(path: string): string {
  return path.replace(/[^A-Za-z0-9_-]+/g, '-');
}

function FieldErrors({ path, errors }: { path: string; errors?: string[] }) {
  if (!errors?.length) return null;
  return (
    <p style={ui.fieldError} role="alert" id={`err-${testId(path)}`} data-testid={`field-error-${testId(path)}`}>
      {errors.join(' · ')}
    </p>
  );
}

function Leaf({ field, value, errors, readOnly }: { field: FormField; value: FieldValue | undefined; errors?: string[]; readOnly: boolean }) {
  const id = `cfg-${testId(field.path)}`;
  const name = fieldName(field.path);
  const invalid = Boolean(errors?.length);
  const common = {
    id,
    name,
    disabled: readOnly,
    'aria-invalid': invalid || undefined,
    'aria-describedby': invalid ? `err-${testId(field.path)}` : undefined,
    'data-testid': `field-${testId(field.path)}`,
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
          <FieldErrors path={field.path} errors={errors} />
        </div>
      );
    case 'enum':
      control = (
        <select {...common} defaultValue={text} style={inputStyle}>
          {!field.required ? <option value="">(not set)</option> : null}
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
        {field.required ? <span style={ui.muted}> *</span> : null} <code style={{ ...ui.mono, ...ui.muted }}>{field.path}</code>
      </label>
      {field.description || kindHint || range ? (
        <span style={ui.desc}>
          {[field.description, kindHint].filter(Boolean).join(' ')}
          {range}
        </span>
      ) : null}
      {control}
      <FieldErrors path={field.path} errors={errors} />
    </div>
  );
}

function Fields({ fields, values, errors, readOnly }: Omit<JsonSchemaFormProps, 'busy'>) {
  return (
    <>
      {fields.map((f) =>
        f.kind === 'object' ? (
          <fieldset key={f.path} style={ui.fieldset}>
            <legend style={ui.legend}>{f.label}</legend>
            {f.description ? <span style={ui.desc}>{f.description}</span> : null}
            <Fields fields={f.children ?? []} values={values} errors={errors} readOnly={readOnly} />
          </fieldset>
        ) : (
          <Leaf key={f.path} field={f} value={values[f.path]} errors={errors?.[f.path]} readOnly={readOnly} />
        )
      )}
    </>
  );
}

export function JsonSchemaForm({ fields, values, errors, readOnly, busy }: JsonSchemaFormProps) {
  if (fields.length === 0) return null;
  const body = <Fields fields={fields} values={values} errors={errors} readOnly={readOnly} />;
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
