/**
 * The browser half of the guestbook fixture: bundled into `/__drobek/sdk.js`
 * as `drobek.guestbook`. Dependency-free.
 */
export default function guestbook(core) {
  return {
    list: () => core.request('GET', '/'),
    sign: (name, message) => core.request('POST', '/sign', { body: { name, message } }),
  };
}
