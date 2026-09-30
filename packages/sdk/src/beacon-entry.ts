/**
 * The entry bundled into `/__drobek/beacon.js`: install the error
 * beacon on load. The compiler imports it at the top of every app entry.
 */
import { installBeacon } from './beacon.js';

installBeacon();
