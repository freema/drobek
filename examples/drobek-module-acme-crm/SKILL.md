# acmecrm — collect contacts into a CRM list

## 1. When to use

The app collects people — sign-ups, leads, attendees — into one contact
list on the server, one contact per e-mail address. Only end users signed
in through the `auth` module may read or add contacts, and everyone who
signs in to the app is added by itself (source `sign-in`). The module is
opt-in: `get_app` → `modules.acmecrm.enabled: false` means a super-admin
has not turned it on for the workspace yet — tell the user, do not work
around it.

## 2. Minimal working code

```ts
// src/main.ts — the bare `drobek` import is the platform SDK (no install).
import { drobek, DrobekError } from 'drobek';

const list = document.querySelector<HTMLUListElement>('#contacts')!;
const form = document.querySelector<HTMLFormElement>('#add')!;

async function render() {
  const { contacts } = await drobek.acmecrm.list();
  list.replaceChildren(...contacts.map((c) => Object.assign(document.createElement('li'), { textContent: `${c.name ?? c.email} (${c.source})` })));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  try {
    await drobek.acmecrm.add({ email: String(data.get('email') ?? ''), name: String(data.get('name') ?? '') || undefined });
    form.reset();
    await render();
  } catch (err) {
    // err.code: see "Errors → fix"
    alert(err instanceof DrobekError && err.code === 'crm_duplicate' ? 'That address is on the list already.' : String(err));
  }
});

void render();
```

Sign the user in first (`<LoginGate>`, `skill_info('auth')`); both calls
answer `unauthorized` otherwise.

## 3. API and types

```ts api
// drobek.acmecrm
export interface Contact {
  id: number;
  email: string;
  name: string | null;
  /** "app" (added by the app) or "sign-in" (recorded when the user signed in) */
  source: 'app' | 'sign-in';
  tags: string[];
  fields: Record<string, string>;
  created_at: string;
}
export interface NewContact {
  email: string;
  /** 1–120 characters */
  name?: string;
  /** values of the custom fields the config declares (key → text, at most 500 characters) */
  fields?: Record<string, string>;
}
export interface Api {
  /** The app's contacts, newest first (at most 100); upstream: the owner set ACMECRM_API_KEY. Signed-in users only. */
  list(): Promise<{ contacts: Contact[]; upstream: boolean }>;
  /** Add a contact (signed-in users only); an address the app has already is crm_duplicate. */
  add(contact: NewContact): Promise<Contact>;
}
```

HTTP (what the SDK calls): `GET /__drobek/v1/acmecrm/` and
`POST /__drobek/v1/acmecrm/` with `{ "email": "…", "name": "…" }`. Only
the app itself may call them (same origin; the SDK sends `X-Drobek-SDK: 1`).

Config (configure_module takes a partial config; `null` resets a key):

```json
{ "app_id": "…", "module": "acmecrm", "config": {
  "tags": ["newsletter"],
  "fields": { "company": { "label": "Company", "required": true } } } }
```

- `tags` (at most 20, each 1–40 characters): every contact the app adds
  gets them. Contacts from sign-ins get none.
- `fields`: the custom fields by key (lower case letters, digits, `_`);
  `add()` must send every `required` one and no other key.

## 4. Rules and limits

- The module must be on for the app's workspace (a super-admin decides on
  the workspace's Modules page); until then every call answers
  `module_not_enabled` and sign-ins are not recorded.
- `ACMECRM_CONTACTS_PER_APP` (default 1000; the operator may set another
  value per workspace): `add()` past it is refused. Sign-ins are still
  recorded.
- Optional secret `ACMECRM_API_KEY`: the app owner sets it in the
  dashboard; `list()` answers `upstream: true` then. Never ask the user for
  its value and never put it in the app's code.

## 5. Errors → fix

| error | cause | fix |
|---|---|---|
| `invalid_request` + `details[].path` | a bad address, or `fields` missing a required key or naming an unknown one | fix the value at `path` |
| `unauthorized` | nobody is signed in | sign in first (`skill_info('auth')`) |
| `crm_duplicate` (409) | the app has a contact with this address | tell the user; `list()` shows it |
| `quota_exceeded` (409) | the app keeps `ACMECRM_CONTACTS_PER_APP` contacts | tell the user; the operator can raise the limit |
| `module_not_enabled` (404) | the module is off for the workspace | ask a super-admin to turn it on |
| `csrf_rejected` | called with fetch from another origin or without the SDK | call through `drobek.acmecrm` from the app itself |
