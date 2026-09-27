/**
 * GET /me — server half: the account page. Who you are, your workspaces (the
 * quick switch), how to connect an agent (the MCP URL and the supported
 * clients' steps from @drobek/agent-dx), which workspace the agent uses by
 * default (your personal one) and, while that workspace has no app yet, a
 * first prompt. Anonymous → /login.
 */
import { type LoaderFunctionArgs } from 'react-router';
import { connectClients, docPageUrl, firstAppPrompt, mcpEndpoint } from '@drobek/agent-dx';
import { isSuperAdmin, requireSessionUser } from '@drobek/auth';
import { ensurePersonalWorkspace, listUserWorkspaces } from '@drobek/tenancy';
import { listWorkspaceApps } from '../apps.server.js';

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireSessionUser(request);
  const personal = await ensurePersonalWorkspace(user.id, user.email);
  const [mine, personalApps] = await Promise.all([listUserWorkspaces(user.id), listWorkspaceApps(personal.id)]);
  const mcpUrl = mcpEndpoint();
  return {
    email: user.email,
    superAdmin: isSuperAdmin(user.email),
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
