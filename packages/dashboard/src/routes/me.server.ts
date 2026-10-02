/**
 * GET/POST /me — server half: the account page. Who you are, your workspaces (the
 * quick switch), how to connect an agent (the MCP URL and the supported
 * clients' steps from @drobek/agent-dx), which workspace the agent uses by
 * default (your personal one) and, while that workspace has no app yet, a
 * first prompt. Anonymous → /login.
 *
 * POST changes the sign-in e-mail (only here: no MCP tool) through
 * @drobek/tenancy: `intent=email-send-code` e-mails a code to the new address
 * `email`; `intent=email-change` checks that code, changes the address, ends
 * every other session and signs this browser in again →
 * /me?email=changed.
 */
import { data, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router';
import { connectClients, docPageUrl, firstAppPrompt, mcpEndpoint } from '@drobek/agent-dx';
import { getClientIp, isSuperAdmin, requireSessionUser } from '@drobek/auth';
import { confirmEmailChange, ensurePersonalWorkspace, listUserWorkspaces, requestEmailChange } from '@drobek/tenancy';
import { listWorkspaceApps } from '../apps.server.js';

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);
  const personal = await ensurePersonalWorkspace(user.id, user.email);
  const [mine, personalApps] = await Promise.all([listUserWorkspaces(user.id), listWorkspaceApps(personal.id)]);
  const mcpUrl = mcpEndpoint();
  return {
    email: user.email,
    superAdmin: isSuperAdmin(user.email),
    emailChanged: new URL(request.url).searchParams.get('email') === 'changed',
    mcpUrl,
    agentGuideUrl: docPageUrl('agent'),
    clients: connectClients(mcpUrl),
    personal: { slug: personal.slug, name: personal.name, appCount: personalApps.length },
    firstPrompt: firstAppPrompt(personal.slug),
    workspaces: mine.map((w) => ({
      slug: w.slug,
      name: w.name,
      kind: w.kind,
      role: w.role,
      personal: w.id === personal.id,
    })),
  };
}

export type EmailChangeActionData =
  /** The code step for `email`; `sent: false` — a code went out moments ago, the newest one counts. */
  | { stage: 'code'; email: string; sent: boolean; error?: string }
  | { stage: 'start'; email: string; error: string };

const NO_STORE = { 'Cache-Control': 'no-store' };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireSessionUser(request);
  const form = await request.formData();
  const intent = String(form.get('intent') ?? '');
  const email = String(form.get('email') ?? '').trim();
  const ip = getClientIp(request);
  const reply = (body: EmailChangeActionData, status = 200) => data(body, { status, headers: NO_STORE });

  if (intent === 'email-send-code') {
    const sent = await requestEmailChange({ userId: user.id, currentEmail: user.email, newEmail: email, ip });
    if (!sent.ok) return reply({ stage: 'start', email, error: sent.message }, sent.status);
    return reply({ stage: 'code', email: sent.email, sent: sent.sent });
  }

  if (intent === 'email-change') {
    const changed = await confirmEmailChange({ userId: user.id, newEmail: email, code: String(form.get('code') ?? ''), ip });
    if (!changed.ok) {
      if (changed.status === 409) return reply({ stage: 'start', email, error: changed.message }, 409);
      return reply({ stage: 'code', email, sent: false, error: changed.message }, changed.status);
    }
    return redirect('/me?email=changed', { headers: { ...NO_STORE, 'Set-Cookie': changed.setCookie } });
  }

  return reply({ stage: 'start', email, error: 'Unsupported action.' }, 400);
}
