/**
 * Forms Plugin for EmDash CMS
 *
 * Build forms, collect submissions, and optionally manage leads with a
 * full CRM pipeline.
 *
 * ## Tiers
 *
 * **Free ($0)** — Unlimited forms and submissions. Spam protection,
 * webhooks, CSV export, email via own Resend key.
 *
 * **Pro ($10/mo)** — Managed email, auto-responders to submitters,
 * submission analytics, multi-page forms.
 *
 * **Pro CRM ($29/mo)** — Full lead pipeline, scoring, team assignment,
 * activity log, contact records.
 *
 * @example
 * ```typescript
 * import { formsPlugin } from "emdash-plugin-leads";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [formsPlugin()],
 *     }),
 *   ],
 * });
 * ```
 */

import type { PluginDescriptor } from "emdash";

export interface FormsPluginOptions {
	/** Max submissions to keep (default: 50000) */
	maxSubmissions?: number;
}

export function formsPlugin(
	options: FormsPluginOptions = {},
): PluginDescriptor<FormsPluginOptions> {
	return {
		id: "forms",
		version: "0.3.0",
		format: "standard",
		entrypoint: "emdash-plugin-leads/sandbox",
		options,
		capabilities: ["network:fetch", "read:users"],
		allowedHosts: [
			"api.resend.com",
			"api.pluginsforemdash.com",
			"challenges.cloudflare.com",
		],
		storage: {
			forms: {
				indexes: ["slug", "status", "createdAt"],
				uniqueIndexes: ["slug"],
			},
			submissions: {
				indexes: ["formId", "status", "createdAt", "email"],
				// composite for querying submissions by form + date
			},
			contacts: {
				indexes: ["email", "status", "assignee", "createdAt", "score"],
				uniqueIndexes: ["email"],
			},
			activities: {
				indexes: ["contactId", "createdAt"],
			},
		},
		adminPages: [
			{ path: "/", label: "Dashboard", icon: "chart" },
			{ path: "/forms", label: "Forms", icon: "list" },
			{ path: "/submissions", label: "Submissions", icon: "inbox" },
			{ path: "/contacts", label: "CRM", icon: "users" },
			{ path: "/analytics", label: "Analytics", icon: "chart" },
			{ path: "/settings", label: "Settings", icon: "gear" },
		],
		adminWidgets: [
			{ id: "submissions-overview", title: "Recent Submissions", size: "half" },
		],
	};
}

// Keep legacy export for backwards compat
export const leadsPlugin = formsPlugin;
