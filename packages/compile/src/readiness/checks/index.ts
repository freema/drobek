import type { ReadinessCheck } from '../types.js';
import { clientXss } from './client-xss.js';
import { missingTitle } from './missing-title.js';
import { moduleRules } from './module-rules.js';
import { pageHead } from './page-head.js';

/**
 * Every readiness check, in report order. A new check is one file in this
 * folder + its test, one line here and an error-catalogue entry per code
 * (@drobek/agent-dx ERROR_CATALOGUE and @drobek/modules CORE_ERROR_CODES).
 */
export const READINESS_CHECKS: readonly ReadinessCheck[] = [missingTitle, pageHead, moduleRules, clientXss];
