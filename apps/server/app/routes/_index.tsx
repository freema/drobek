export function meta() {
  return [
    { title: 'drobek' },
    {
      name: 'description',
      content: 'MCP-native hosting for vibecoded static micro-apps.',
    },
  ];
}

const styles = {
  main: {
    fontFamily: 'system-ui, sans-serif',
    maxWidth: '38rem',
    margin: '0 auto',
    padding: '4rem 1.5rem',
    color: '#1a1a1a',
    lineHeight: 1.6,
  },
  h1: { fontSize: '2.25rem', marginBottom: '0.25rem' },
  tagline: { color: '#555', marginTop: 0 },
  list: { paddingLeft: '1.25rem' },
  nav: { display: 'flex', justifyContent: 'flex-end' },
  signIn: { color: '#1a1a1a', fontWeight: 600 },
} as const;

export default function Index() {
  return (
    <main style={styles.main}>
      <nav style={styles.nav}>
        <a href="/login" style={styles.signIn}>
          Sign in
        </a>
      </nav>
      <h1 style={styles.h1}>drobek</h1>
      <p style={styles.tagline}>
        MCP-native hosting for vibecoded static micro-apps. Drop a folder,
        get a live URL.
      </p>
      <ul style={styles.list}>
        <li>
          <a href="/healthz">/healthz</a> — service health (db + redis)
        </li>
        <li>
          <a href="/api/version">/api/version</a> — running build sha
        </li>
      </ul>
    </main>
  );
}
