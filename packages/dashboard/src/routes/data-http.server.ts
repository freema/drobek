/**
 * Shared server glue for the Data-tab routes (M1b, PHY-121). Turns a
 * @drobek/data DataError into the react-router `data(...)` throw the dashboard
 * uses elsewhere: a not_found (unknown app/collection/record, or a
 * cross-workspace locator) → 404, a forbidden → 403. Any other DataError code
 * bubbles up as a 500 (it should not happen on a read/delete path). Keeps the
 * loaders/actions terse and consistent with the U8 rollback route.
 */
import { data } from 'react-router';
import { DataError } from '@drobek/data';

export async function withDataErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof DataError) {
      if (err.code === 'not_found') {
        throw data({ message: 'Not found' }, { status: 404 });
      }
      if (err.code === 'forbidden') {
        throw data({ message: 'Forbidden' }, { status: 403 });
      }
    }
    throw err;
  }
}
