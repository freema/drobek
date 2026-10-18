function notFound(): never {
  throw new Response(null, { status: 404, statusText: 'Not Found' });
}

export const loader = notFound;
export const action = notFound;

export default function NotFound() {
  return null;
}
