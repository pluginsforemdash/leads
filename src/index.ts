/**
 * Leads Plugin for EmDash CMS
 *
 * Capture, manage, and convert leads from your website.
 *
 * Features:
 * - Public lead capture endpoint (embeddable forms)
 * - Spam protection (honeypot + optional Cloudflare Turnstile)
 * - Lead pipeline with statuses (new, contacted, qualified, converted, lost)
 * - Built-in email notifications (free with own Resend key, or $10/mo managed)
 * - Lead assignment to team members
 * - Notes and activity log per lead
 * - CSV export
 * - Dashboard widget with pipeline stats
 * - Webhook forwarding to external CRMs
 *
 * Standard format — works in both trusted and sandboxed modes.
 *
 * ## Email Tiers
 *
 * - **Free**: Bring your own Resend API key. Paste it in plugin settings.
 * - **Pro ($10/mo)**: Use our managed email relay. Enter your license key
 *   from https://pluginsforemdash.com/pricing to activate.
 *
 * @example
 * ```typescript
 * // astro.config.mjs
 * import { leadsPlugin } from "emdash-plugin-leads";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [leadsPlugin()],
 *     }),
 *   ],
 * });
 * ```
 */

import type { PluginDescriptor } from "emdash";

export interface LeadsPluginOptions {
	/** Maximum leads to store before auto-archiving oldest (default: 10000) */
	maxLeads?: number;
	/** Auto-archive leads older than N days (default: 90) */
	autoArchiveDays?: number;
}

export function leadsPlugin(options: LeadsPluginOptions = {}): PluginDescriptor<LeadsPluginOptions> {
	return {
		id: "leads",
		version: "0.2.0",
		format: "standard",
		entrypoint: "emdash-plugin-leads/sandbox",
		options,
		capabilities: ["network:fetch", "read:users"],
		allowedHosts: ["api.resend.com", "api.pluginsforemdash.com", "challenges.cloudflare.com"],
		storage: {
			leads: {
				indexes: ["status", "source", "assignee", "createdAt", "email"],
			},
			activities: {
				indexes: ["leadId", "createdAt"],
			},
		},
		adminPages: [
			{ path: "/", label: "Leads", icon: "list" },
			{ path: "/settings", label: "Settings", icon: "gear" },
		],
		adminWidgets: [{ id: "pipeline-overview", title: "Lead Pipeline", size: "half" }],
	};
}
