/**
 * Sandbox Entry Point — Leads Plugin
 *
 * Runs in both trusted (in-process) and sandboxed (isolate) modes.
 *
 * Email delivery tiers:
 * - Free: user provides their own Resend API key
 * - Pro ($10/mo): managed relay via api.emdashleads.com
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { z } from "astro/zod";

// ── Types ──

interface Lead {
	name: string;
	email: string;
	phone?: string;
	company?: string;
	message?: string;
	source: string;
	status: "new" | "contacted" | "qualified" | "converted" | "lost";
	assignee?: string;
	score?: number;
	tags?: string[];
	customFields?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

interface Activity {
	leadId: string;
	type: "note" | "status_change" | "assignment" | "email_sent" | "created";
	description: string;
	userId?: string;
	createdAt: string;
}

type EmailTier = "none" | "free" | "pro";

const LEAD_STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;

const MANAGED_API_URL = "https://api.pluginsforemdash.com/v1/email/send";

// ── Input Schemas ──

const captureSchema = z.object({
	name: z.string().min(1).max(200),
	email: z.string().email().max(320),
	phone: z.string().max(50).optional(),
	company: z.string().max(200).optional(),
	message: z.string().max(5000).optional(),
	source: z.string().max(100).default("website"),
	customFields: z.record(z.unknown()).optional(),
	// Honeypot — must be empty (bots fill it, humans don't see it)
	_hp_website: z.string().max(0).optional(),
	// Turnstile token — optional, validated server-side if configured
	"cf-turnstile-response": z.string().optional(),
});

const listSchema = z.object({
	status: z.enum(LEAD_STATUSES).optional(),
	source: z.string().optional(),
	assignee: z.string().optional(),
	limit: z.coerce.number().min(1).max(100).default(50),
	cursor: z.string().optional(),
});

const getSchema = z.object({
	id: z.string().min(1),
});

const updateSchema = z.object({
	id: z.string().min(1),
	status: z.enum(LEAD_STATUSES).optional(),
	assignee: z.string().optional(),
	score: z.number().min(0).max(100).optional(),
	tags: z.array(z.string()).optional(),
});

const addNoteSchema = z.object({
	leadId: z.string().min(1),
	note: z.string().min(1).max(5000),
});

const deleteSchema = z.object({
	id: z.string().min(1),
});

const exportSchema = z.object({
	status: z.enum(LEAD_STATUSES).optional(),
	format: z.enum(["csv", "json"]).default("csv"),
});

// ── Helpers ──

function generateId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function now(): string {
	return new Date().toISOString();
}

function escapeCsv(value: unknown): string {
	const str = String(value ?? "");
	if (str.includes(",") || str.includes('"') || str.includes("\n")) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

// ── Spam Protection ──

async function verifyTurnstile(
	token: string,
	secretKey: string,
	ctx: PluginContext,
): Promise<boolean> {
	if (!ctx.http) return false;

	try {
		const response = await ctx.http.fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					secret: secretKey,
					response: token,
				}).toString(),
			},
		);

		const result = (await response.json()) as { success: boolean };
		return result.success === true;
	} catch (error) {
		ctx.log.warn("Turnstile verification failed", error);
		return false;
	}
}

// ── Email Delivery ──

async function getEmailTier(ctx: PluginContext): Promise<EmailTier> {
	const licenseKey = await ctx.kv.get<string>("settings:licenseKey");
	if (licenseKey) return "pro";

	const resendKey = await ctx.kv.get<string>("settings:resendApiKey");
	if (resendKey) return "free";

	return "none";
}

async function sendEmail(
	ctx: PluginContext,
	to: string,
	subject: string,
	text: string,
	from?: string,
): Promise<boolean> {
	if (!ctx.http) return false;

	const tier = await getEmailTier(ctx);
	if (tier === "none") return false;

	const senderEmail = from ?? (await ctx.kv.get<string>("settings:fromEmail")) ?? "leads@notifications.pluginsforemdash.com";

	try {
		if (tier === "pro") {
			// Managed API — authenticated with license key
			const licenseKey = await ctx.kv.get<string>("settings:licenseKey");
			const response = await ctx.http.fetch(MANAGED_API_URL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${licenseKey}`,
				},
				body: JSON.stringify({ from: senderEmail, to, subject, text }),
			});

			if (!response.ok) {
				const body = await response.text();
				ctx.log.warn(`Managed email API error: ${response.status} ${body}`);
				return false;
			}
			return true;
		}

		// Free tier — direct Resend API
		const resendKey = await ctx.kv.get<string>("settings:resendApiKey");
		const response = await ctx.http.fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${resendKey}`,
			},
			body: JSON.stringify({ from: senderEmail, to, subject, text }),
		});

		if (!response.ok) {
			const body = await response.text();
			ctx.log.warn(`Resend API error: ${response.status} ${body}`);
			return false;
		}
		return true;
	} catch (error) {
		ctx.log.warn("Email send failed", error);
		return false;
	}
}

// ── Notifications ──

async function notifyNewLead(lead: Lead, ctx: PluginContext): Promise<void> {
	const notifyEmail = await ctx.kv.get<string>("settings:notificationEmail");
	if (!notifyEmail) return;

	await sendEmail(
		ctx,
		notifyEmail,
		`New lead: ${lead.name} (${lead.source})`,
		[
			`New lead captured from ${lead.source}:`,
			"",
			`Name: ${lead.name}`,
			`Email: ${lead.email}`,
			lead.phone ? `Phone: ${lead.phone}` : null,
			lead.company ? `Company: ${lead.company}` : null,
			lead.message ? `\nMessage:\n${lead.message}` : null,
			"",
			`View in admin: /_emdash/admin/plugins/leads`,
		]
			.filter(Boolean)
			.join("\n"),
	);
}

async function forwardToWebhook(lead: Lead, ctx: PluginContext): Promise<void> {
	const webhookUrl = await ctx.kv.get<string>("settings:webhookUrl");
	if (!webhookUrl || !ctx.http) return;

	try {
		const token = await ctx.kv.get<string>("settings:webhookToken");
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"X-EmDash-Event": "lead:created",
		};
		if (token) headers["Authorization"] = `Bearer ${token}`;

		await ctx.http.fetch(webhookUrl, {
			method: "POST",
			headers,
			body: JSON.stringify({
				event: "lead:created",
				timestamp: now(),
				lead,
			}),
		});
	} catch (error) {
		ctx.log.warn("Failed to forward lead to webhook", error);
	}
}

async function logActivity(
	ctx: PluginContext,
	leadId: string,
	type: Activity["type"],
	description: string,
	userId?: string,
): Promise<void> {
	await ctx.storage.activities!.put(generateId(), {
		leadId,
		type,
		description,
		userId,
		createdAt: now(),
	});
}

// ── Rate Limiting (in-memory, per-isolate) ──

const captureTimestamps = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 5; // 5 submissions per minute per IP/email

function isRateLimited(key: string): boolean {
	const cutoff = Date.now() - RATE_LIMIT_WINDOW;
	const timestamps = (captureTimestamps.get(key) ?? []).filter((t) => t > cutoff);
	captureTimestamps.set(key, timestamps);

	if (timestamps.length >= RATE_LIMIT_MAX) return true;

	timestamps.push(Date.now());
	return false;
}

// ── Plugin Definition ──

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("Leads plugin installed");
				await ctx.kv.set("settings:notificationEmail", "");
				await ctx.kv.set("settings:webhookUrl", "");
				await ctx.kv.set("settings:autoArchiveDays", 90);
				await ctx.kv.set("settings:maxLeads", 10000);
				await ctx.kv.set("settings:spamProtection", "honeypot");
			},
		},

		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				if (ctx.cron) {
					await ctx.cron.schedule("archive-old-leads", { schedule: "@daily" });
				}
			},
		},

		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "archive-old-leads") {
					const days =
						(await ctx.kv.get<number>("settings:autoArchiveDays")) ?? 90;
					const cutoff = new Date(
						Date.now() - days * 24 * 60 * 60 * 1000,
					).toISOString();

					const old = await ctx.storage.leads!.query({
						where: {
							status: { in: ["new", "contacted"] },
							createdAt: { lte: cutoff },
						},
						limit: 100,
					});

					for (const item of old.items) {
						const lead = item.data as Lead;
						await ctx.storage.leads!.put(item.id, {
							...lead,
							status: "lost",
							updatedAt: now(),
						});
						await logActivity(ctx, item.id, "status_change", "Auto-archived (inactive)");
					}

					if (old.items.length > 0) {
						ctx.log.info(`Archived ${old.items.length} inactive leads`);
					}
				}
			},
		},
	},

	routes: {
		// ── Public: Lead Capture ──

		capture: {
			public: true,
			input: captureSchema,
			handler: async (routeCtx: { input: z.infer<typeof captureSchema>; request: Request }, ctx: PluginContext) => {
				const input = routeCtx.input;

				// Honeypot check — if the hidden field has content, it's a bot
				if (input._hp_website && input._hp_website.length > 0) {
					// Return success to not tip off the bot, but don't store
					ctx.log.info("Honeypot triggered, discarding submission");
					return { success: true, id: generateId() };
				}

				// Rate limiting by email
				if (isRateLimited(`email:${input.email}`)) {
					throw new Response(
						JSON.stringify({ error: "Too many submissions. Please try again later." }),
						{ status: 429, headers: { "Content-Type": "application/json" } },
					);
				}

				// Turnstile verification (if configured)
				const turnstileSecret = await ctx.kv.get<string>("settings:turnstileSecretKey");
				if (turnstileSecret) {
					const token = input["cf-turnstile-response"];
					if (!token) {
						throw new Response(
							JSON.stringify({ error: "CAPTCHA verification required." }),
							{ status: 400, headers: { "Content-Type": "application/json" } },
						);
					}
					const valid = await verifyTurnstile(token, turnstileSecret, ctx);
					if (!valid) {
						throw new Response(
							JSON.stringify({ error: "CAPTCHA verification failed." }),
							{ status: 403, headers: { "Content-Type": "application/json" } },
						);
					}
				}

				// Strip spam protection fields before storing
				const { _hp_website: _, "cf-turnstile-response": __, ...cleanInput } = input;

				const id = generateId();
				const lead: Lead = {
					...cleanInput,
					status: "new",
					createdAt: now(),
					updatedAt: now(),
				};

				await ctx.storage.leads!.put(id, lead);
				await logActivity(ctx, id, "created", `Lead captured from ${lead.source}`);

				// Fire-and-forget notifications
				notifyNewLead(lead, ctx).catch((err) =>
					ctx.log.warn("Email notification failed", err),
				);
				forwardToWebhook(lead, ctx).catch((err) =>
					ctx.log.warn("Webhook forward failed", err),
				);

				return { success: true, id };
			},
		},

		// ── Admin: List Leads ──

		list: {
			input: listSchema,
			handler: async (routeCtx: { input: z.infer<typeof listSchema> }, ctx: PluginContext) => {
				const { status, source, assignee, limit, cursor } = routeCtx.input;
				const where: Record<string, unknown> = {};
				if (status) where.status = status;
				if (source) where.source = source;
				if (assignee) where.assignee = assignee;

				const result = await ctx.storage.leads!.query({
					where: Object.keys(where).length > 0 ? where : undefined,
					orderBy: { createdAt: "desc" },
					limit,
					cursor,
				});

				return {
					items: result.items.map((item: { id: string; data: unknown }) => ({
						id: item.id,
						...(item.data as Lead),
					})),
					cursor: result.cursor,
					hasMore: result.hasMore,
				};
			},
		},

		// ── Admin: Get Lead ──

		get: {
			input: getSchema,
			handler: async (routeCtx: { input: z.infer<typeof getSchema> }, ctx: PluginContext) => {
				const lead = await ctx.storage.leads!.get(routeCtx.input.id);
				if (!lead) {
					throw new Response(JSON.stringify({ error: "Lead not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}

				const activities = await ctx.storage.activities!.query({
					where: { leadId: routeCtx.input.id },
					orderBy: { createdAt: "desc" },
					limit: 50,
				});

				return {
					id: routeCtx.input.id,
					...(lead as Lead),
					activities: activities.items.map((a: { id: string; data: unknown }) => ({
						id: a.id,
						...(a.data as Activity),
					})),
				};
			},
		},

		// ── Admin: Update Lead ──

		update: {
			input: updateSchema,
			handler: async (routeCtx: { input: z.infer<typeof updateSchema> }, ctx: PluginContext) => {
				const { id, ...updates } = routeCtx.input;
				const existing = (await ctx.storage.leads!.get(id)) as Lead | null;
				if (!existing) {
					throw new Response(JSON.stringify({ error: "Lead not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}

				const updated: Lead = { ...existing, ...updates, updatedAt: now() };
				await ctx.storage.leads!.put(id, updated);

				if (updates.status && updates.status !== existing.status) {
					await logActivity(ctx, id, "status_change", `Status changed: ${existing.status} → ${updates.status}`);
				}
				if (updates.assignee && updates.assignee !== existing.assignee) {
					await logActivity(ctx, id, "assignment", `Assigned to ${updates.assignee}`);
				}

				return { success: true, lead: { id, ...updated } };
			},
		},

		// ── Admin: Add Note ──

		"notes/add": {
			input: addNoteSchema,
			handler: async (routeCtx: { input: z.infer<typeof addNoteSchema> }, ctx: PluginContext) => {
				const existing = await ctx.storage.leads!.get(routeCtx.input.leadId);
				if (!existing) {
					throw new Response(JSON.stringify({ error: "Lead not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}

				await logActivity(ctx, routeCtx.input.leadId, "note", routeCtx.input.note);
				return { success: true };
			},
		},

		// ── Admin: Delete Lead ──

		delete: {
			input: deleteSchema,
			handler: async (routeCtx: { input: z.infer<typeof deleteSchema> }, ctx: PluginContext) => {
				const existed = await ctx.storage.leads!.exists(routeCtx.input.id);
				if (!existed) {
					throw new Response(JSON.stringify({ error: "Lead not found" }), {
						status: 404,
						headers: { "Content-Type": "application/json" },
					});
				}

				await ctx.storage.leads!.delete(routeCtx.input.id);

				const activities = await ctx.storage.activities!.query({
					where: { leadId: routeCtx.input.id },
					limit: 1000,
				});
				if (activities.items.length > 0) {
					await ctx.storage.activities!.deleteMany(
						activities.items.map((a: { id: string }) => a.id),
					);
				}

				return { success: true };
			},
		},

		// ── Admin: Export ──

		export: {
			input: exportSchema,
			handler: async (routeCtx: { input: z.infer<typeof exportSchema> }, ctx: PluginContext) => {
				const where = routeCtx.input.status ? { status: routeCtx.input.status } : undefined;
				const allLeads: Array<{ id: string; data: Lead }> = [];
				let cursor: string | undefined;

				do {
					const result = await ctx.storage.leads!.query({
						where,
						orderBy: { createdAt: "desc" },
						limit: 100,
						cursor,
					});
					allLeads.push(...(result.items as Array<{ id: string; data: Lead }>));
					cursor = result.cursor;
				} while (cursor);

				if (routeCtx.input.format === "json") {
					return {
						data: allLeads.map((l) => ({ id: l.id, ...l.data })),
						count: allLeads.length,
					};
				}

				const headers = ["id", "name", "email", "phone", "company", "source", "status", "assignee", "score", "message", "createdAt", "updatedAt"];
				const rows = allLeads.map((l) => {
					const d = l.data;
					return [l.id, d.name, d.email, d.phone, d.company, d.source, d.status, d.assignee, d.score, d.message, d.createdAt, d.updatedAt]
						.map(escapeCsv)
						.join(",");
				});

				return {
					csv: [headers.join(","), ...rows].join("\n"),
					count: allLeads.length,
				};
			},
		},

		// ── Admin: Pipeline Stats ──

		stats: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const [newCount, contacted, qualified, converted, lost, total] = await Promise.all([
					ctx.storage.leads!.count({ status: "new" }),
					ctx.storage.leads!.count({ status: "contacted" }),
					ctx.storage.leads!.count({ status: "qualified" }),
					ctx.storage.leads!.count({ status: "converted" }),
					ctx.storage.leads!.count({ status: "lost" }),
					ctx.storage.leads!.count(),
				]);

				const conversionRate = total > 0 ? Math.round((converted / total) * 100) : 0;

				return {
					pipeline: { new: newCount, contacted, qualified, converted, lost },
					total,
					conversionRate,
				};
			},
		},

		// ── Admin: Test Email ──

		"test-email": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const notifyEmail = await ctx.kv.get<string>("settings:notificationEmail");
				if (!notifyEmail) {
					return { success: false, error: "No notification email configured" };
				}

				const tier = await getEmailTier(ctx);
				if (tier === "none") {
					return { success: false, error: "No email provider configured. Add a Resend API key or Pro license key in settings." };
				}

				const sent = await sendEmail(
					ctx,
					notifyEmail,
					"Test email from Leads Plugin",
					"This is a test email to confirm your lead notification setup is working correctly.\n\nIf you received this, your email configuration is correct!",
				);

				return {
					success: sent,
					tier,
					error: sent ? undefined : "Failed to send. Check your API key.",
				};
			},
		},

		// ── Block Kit Admin UI ──

		admin: {
			handler: async (
				routeCtx: { input: unknown },
				ctx: PluginContext,
			) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					values?: Record<string, unknown>;
				};

				// Widget
				if (interaction.type === "page_load" && interaction.page === "widget:pipeline-overview") {
					return buildPipelineWidget(ctx);
				}

				// Leads List Page
				if (interaction.type === "page_load" && interaction.page === "/") {
					return buildLeadsPage(ctx);
				}

				// Settings Page
				if (interaction.type === "page_load" && interaction.page === "/settings") {
					return buildSettingsPage(ctx);
				}

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") {
					return saveSettings(ctx, interaction.values ?? {});
				}

				// Test Email
				if (interaction.type === "block_action" && interaction.action_id === "test_email") {
					return testEmail(ctx);
				}

				// Lead Status Actions
				if (interaction.type === "block_action" && interaction.action_id?.startsWith("set_status:")) {
					const [, id, status] = interaction.action_id.split(":");
					if (id && status) {
						const lead = (await ctx.storage.leads!.get(id)) as Lead | null;
						if (lead) {
							const oldStatus = lead.status;
							lead.status = status as Lead["status"];
							lead.updatedAt = now();
							await ctx.storage.leads!.put(id, lead);
							await logActivity(ctx, id, "status_change", `${oldStatus} → ${status}`);
						}
					}
					return buildLeadsPage(ctx);
				}

				// Delete Lead
				if (interaction.type === "block_action" && interaction.action_id?.startsWith("delete_lead:")) {
					const id = interaction.action_id.split(":")[1];
					if (id) {
						await ctx.storage.leads!.delete(id);
						const acts = await ctx.storage.activities!.query({
							where: { leadId: id },
							limit: 1000,
						});
						if (acts.items.length > 0) {
							await ctx.storage.activities!.deleteMany(
								acts.items.map((a: { id: string }) => a.id),
							);
						}
					}
					return {
						...(await buildLeadsPage(ctx)),
						toast: { message: "Lead deleted", type: "success" },
					};
				}

				return { blocks: [] };
			},
		},
	},
});

// ── Block Kit Builders ──

async function buildPipelineWidget(ctx: PluginContext) {
	try {
		const [newCount, contacted, qualified, converted, lost, total] = await Promise.all([
			ctx.storage.leads!.count({ status: "new" }),
			ctx.storage.leads!.count({ status: "contacted" }),
			ctx.storage.leads!.count({ status: "qualified" }),
			ctx.storage.leads!.count({ status: "converted" }),
			ctx.storage.leads!.count({ status: "lost" }),
			ctx.storage.leads!.count(),
		]);

		const conversionRate = total > 0 ? Math.round((converted / total) * 100) : 0;

		return {
			blocks: [
				{
					type: "stats",
					stats: [
						{ label: "New", value: String(newCount) },
						{ label: "Qualified", value: String(qualified) },
						{ label: "Converted", value: String(converted), trend: `${conversionRate}%`, trend_direction: "up" as const },
						{ label: "Total", value: String(total) },
					],
				},
				{
					type: "meter",
					label: "Pipeline",
					value: total > 0 ? Math.round(((newCount + contacted + qualified) / total) * 100) : 0,
					custom_value: `${newCount + contacted + qualified} active / ${total} total`,
				},
			],
		};
	} catch (error) {
		ctx.log.error("Failed to build pipeline widget", error);
		return { blocks: [{ type: "context", text: "Failed to load pipeline data" }] };
	}
}

async function buildLeadsPage(ctx: PluginContext) {
	try {
		// Check email config and show banner if needed
		const tier = await getEmailTier(ctx);
		const notifyEmail = await ctx.kv.get<string>("settings:notificationEmail");

		const result = await ctx.storage.leads!.query({
			orderBy: { createdAt: "desc" },
			limit: 50,
		});

		const leads = result.items as Array<{ id: string; data: Lead }>;

		const [newCount, contacted, qualified, converted, total] = await Promise.all([
			ctx.storage.leads!.count({ status: "new" }),
			ctx.storage.leads!.count({ status: "contacted" }),
			ctx.storage.leads!.count({ status: "qualified" }),
			ctx.storage.leads!.count({ status: "converted" }),
			ctx.storage.leads!.count(),
		]);

		const blocks: unknown[] = [
			{ type: "header", text: "Leads" },
		];

		// Email setup warning
		if (tier === "none" && notifyEmail) {
			blocks.push({
				type: "banner",
				variant: "alert",
				title: "Email notifications not configured",
				description: "You have a notification email set but no email provider. Go to Settings and add a Resend API key (free) or upgrade to Pro for managed email.",
			});
		} else if (tier === "none" && !notifyEmail) {
			blocks.push({
				type: "banner",
				variant: "default",
				title: "Set up email notifications",
				description: "Get notified instantly when new leads come in. Go to Settings to configure.",
			});
		}

		blocks.push(
			{
				type: "stats",
				stats: [
					{ label: "New", value: String(newCount) },
					{ label: "Contacted", value: String(contacted) },
					{ label: "Qualified", value: String(qualified) },
					{ label: "Converted", value: String(converted) },
					{ label: "Total", value: String(total) },
				],
			},
			{ type: "divider" },
		);

		if (leads.length === 0) {
			blocks.push({
				type: "context",
				text: "No leads yet. Embed the capture form or POST to /_emdash/api/plugins/leads/capture to start collecting leads.",
			});
		} else {
			blocks.push({
				type: "table",
				block_id: "leads-table",
				columns: [
					{ key: "name", label: "Name" },
					{ key: "email", label: "Email" },
					{ key: "company", label: "Company" },
					{ key: "source", label: "Source" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "createdAt", label: "Created", format: "relative_time" },
				],
				rows: leads.map((l) => ({
					_id: l.id,
					name: l.data.name,
					email: l.data.email,
					company: l.data.company ?? "-",
					source: l.data.source,
					status: l.data.status,
					createdAt: l.data.createdAt,
				})),
			});

			for (const l of leads.slice(0, 10)) {
				if (l.data.status === "new") {
					blocks.push({
						type: "actions",
						elements: [
							{
								type: "button",
								text: `Mark "${l.data.name}" Contacted`,
								action_id: `set_status:${l.id}:contacted`,
							},
							{
								type: "button",
								text: "Delete",
								action_id: `delete_lead:${l.id}`,
								style: "danger",
								confirm: {
									title: "Delete Lead?",
									text: `This will permanently delete ${l.data.name} and all their activity history.`,
									confirm: "Delete",
									deny: "Cancel",
								},
							},
						],
					});
				}
			}
		}

		return { blocks };
	} catch (error) {
		ctx.log.error("Failed to build leads page", error);
		return { blocks: [{ type: "context", text: "Failed to load leads" }] };
	}
}

async function buildSettingsPage(ctx: PluginContext) {
	try {
		const notificationEmail = (await ctx.kv.get<string>("settings:notificationEmail")) ?? "";
		const webhookUrl = (await ctx.kv.get<string>("settings:webhookUrl")) ?? "";
		const autoArchiveDays = (await ctx.kv.get<number>("settings:autoArchiveDays")) ?? 90;
		const maxLeads = (await ctx.kv.get<number>("settings:maxLeads")) ?? 10000;
		const turnstileSiteKey = (await ctx.kv.get<string>("settings:turnstileSiteKey")) ?? "";
		const fromEmail = (await ctx.kv.get<string>("settings:fromEmail")) ?? "";
		const tier = await getEmailTier(ctx);

		const blocks: unknown[] = [
			{ type: "header", text: "Lead Settings" },
		];

		// ── Email Tier Status ──

		if (tier === "pro") {
			blocks.push({
				type: "banner",
				variant: "default",
				title: "Pro Plan Active",
				description: "Email notifications are sent via managed relay. No configuration needed.",
			});
		} else if (tier === "free") {
			blocks.push({
				type: "banner",
				variant: "default",
				title: "Free Plan — Using Your Resend API Key",
				description: "Upgrade to Pro ($10/mo) for managed email delivery, higher limits, and priority support.",
			});
		} else {
			blocks.push({
				type: "banner",
				variant: "alert",
				title: "Email Not Configured",
				description: "Add a Resend API key below (free) or enter a Pro license key for managed email ($10/mo).",
			});
		}

		// ── Settings Form ──

		const fields: unknown[] = [
			{
				type: "text_input",
				action_id: "notificationEmail",
				label: "Notification Email",
				initial_value: notificationEmail,
			},
			{
				type: "text_input",
				action_id: "fromEmail",
				label: "From Email Address",
				initial_value: fromEmail,
			},
		];

		// Pro license key
		fields.push({
			type: "secret_input",
			action_id: "licenseKey",
			label: "Pro License Key ($10/mo managed email)",
		});

		// Free tier: own Resend key
		fields.push({
			type: "secret_input",
			action_id: "resendApiKey",
			label: "Resend API Key (free tier — bring your own)",
		});

		// Spam protection
		fields.push(
			{ type: "divider" },
			{
				type: "text_input",
				action_id: "turnstileSiteKey",
				label: "Turnstile Site Key (optional spam protection)",
				initial_value: turnstileSiteKey,
			},
			{
				type: "secret_input",
				action_id: "turnstileSecretKey",
				label: "Turnstile Secret Key",
			},
		);

		// CRM webhook
		fields.push(
			{ type: "divider" },
			{
				type: "text_input",
				action_id: "webhookUrl",
				label: "CRM Webhook URL",
				initial_value: webhookUrl,
			},
			{
				type: "secret_input",
				action_id: "webhookToken",
				label: "Webhook Auth Token",
			},
		);

		// Lead management
		fields.push(
			{ type: "divider" },
			{
				type: "number_input",
				action_id: "autoArchiveDays",
				label: "Auto-archive after (days)",
				initial_value: autoArchiveDays,
				min: 7,
				max: 365,
			},
			{
				type: "number_input",
				action_id: "maxLeads",
				label: "Maximum Leads",
				initial_value: maxLeads,
				min: 100,
				max: 100000,
			},
		);

		blocks.push(
			{
				type: "form",
				block_id: "lead-settings",
				fields,
				submit: { label: "Save Settings", action_id: "save_settings" },
			},
			{ type: "divider" },
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: "Send Test Email",
						action_id: "test_email",
						style: "primary",
					},
				],
			},
		);

		// ── Embed Code ──

		blocks.push(
			{ type: "divider" },
			{ type: "header", text: "Embed Code" },
			{
				type: "context",
				text: "Add this form to any page or external site. Includes honeypot spam protection automatically.",
			},
		);

		// Build embed code based on whether Turnstile is configured
		const hasTurnstile = !!turnstileSiteKey;

		const embedCode = hasTurnstile
			? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form id="lead-form">
  <input name="name" placeholder="Name" required />
  <input name="email" type="email" placeholder="Email" required />
  <input name="phone" placeholder="Phone" />
  <input name="company" placeholder="Company" />
  <textarea name="message" placeholder="Message"></textarea>
  <!-- Honeypot — hidden from humans, bots fill it -->
  <div style="position:absolute;left:-9999px" aria-hidden="true">
    <input name="_hp_website" tabindex="-1" autocomplete="off" />
  </div>
  <!-- Turnstile widget -->
  <div class="cf-turnstile" data-sitekey="${turnstileSiteKey}"></div>
  <button type="submit">Submit</button>
</form>
<script>
  document.getElementById("lead-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.source = "website";
    const res = await fetch("/_emdash/api/plugins/leads/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      e.target.reset();
      alert("Thank you! We'll be in touch.");
    } else {
      const err = await res.json().catch(() => ({}));
      alert(err.error || "Something went wrong. Please try again.");
    }
  });
</script>`
			: `<form id="lead-form">
  <input name="name" placeholder="Name" required />
  <input name="email" type="email" placeholder="Email" required />
  <input name="phone" placeholder="Phone" />
  <input name="company" placeholder="Company" />
  <textarea name="message" placeholder="Message"></textarea>
  <!-- Honeypot — hidden from humans, bots fill it -->
  <div style="position:absolute;left:-9999px" aria-hidden="true">
    <input name="_hp_website" tabindex="-1" autocomplete="off" />
  </div>
  <button type="submit">Submit</button>
</form>
<script>
  document.getElementById("lead-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    data.source = "website";
    const res = await fetch("/_emdash/api/plugins/leads/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) {
      e.target.reset();
      alert("Thank you! We'll be in touch.");
    } else {
      const err = await res.json().catch(() => ({}));
      alert(err.error || "Something went wrong. Please try again.");
    }
  });
</script>`;

		blocks.push({
			type: "code",
			code: embedCode,
			language: "html" as never,
		});

		return { blocks };
	} catch (error) {
		ctx.log.error("Failed to build settings page", error);
		return { blocks: [{ type: "context", text: "Failed to load settings" }] };
	}
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	try {
		if (typeof values.notificationEmail === "string")
			await ctx.kv.set("settings:notificationEmail", values.notificationEmail);
		if (typeof values.fromEmail === "string")
			await ctx.kv.set("settings:fromEmail", values.fromEmail);
		if (typeof values.licenseKey === "string" && values.licenseKey !== "")
			await ctx.kv.set("settings:licenseKey", values.licenseKey);
		if (typeof values.resendApiKey === "string" && values.resendApiKey !== "")
			await ctx.kv.set("settings:resendApiKey", values.resendApiKey);
		if (typeof values.turnstileSiteKey === "string")
			await ctx.kv.set("settings:turnstileSiteKey", values.turnstileSiteKey);
		if (typeof values.turnstileSecretKey === "string" && values.turnstileSecretKey !== "")
			await ctx.kv.set("settings:turnstileSecretKey", values.turnstileSecretKey);
		if (typeof values.webhookUrl === "string")
			await ctx.kv.set("settings:webhookUrl", values.webhookUrl);
		if (typeof values.webhookToken === "string" && values.webhookToken !== "")
			await ctx.kv.set("settings:webhookToken", values.webhookToken);
		if (typeof values.autoArchiveDays === "number")
			await ctx.kv.set("settings:autoArchiveDays", values.autoArchiveDays);
		if (typeof values.maxLeads === "number")
			await ctx.kv.set("settings:maxLeads", values.maxLeads);

		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: "Settings saved", type: "success" },
		};
	} catch (error) {
		ctx.log.error("Failed to save settings", error);
		return {
			blocks: [{ type: "banner", variant: "error", title: "Failed to save settings" }],
			toast: { message: "Failed to save settings", type: "error" },
		};
	}
}

async function testEmail(ctx: PluginContext) {
	const notifyEmail = await ctx.kv.get<string>("settings:notificationEmail");
	if (!notifyEmail) {
		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: "Set a notification email first", type: "error" },
		};
	}

	const tier = await getEmailTier(ctx);
	if (tier === "none") {
		return {
			...(await buildSettingsPage(ctx)),
			toast: { message: "Add a Resend API key or Pro license key first", type: "error" },
		};
	}

	const sent = await sendEmail(
		ctx,
		notifyEmail,
		"Test email from Leads Plugin",
		"This is a test email. If you received it, your lead notifications are working!",
	);

	return {
		...(await buildSettingsPage(ctx)),
		toast: sent
			? { message: `Test email sent to ${notifyEmail} (${tier} tier)`, type: "success" }
			: { message: "Failed to send. Check your API key.", type: "error" },
	};
}
