/**
 * Sandbox Entry Point — Forms Plugin v0.3.0
 *
 * Three tiers:
 * - Free: form collector, submissions, spam protection, webhooks, export
 * - Pro ($10/mo): managed email, auto-responders, analytics
 * - Pro CRM ($29/mo): lead pipeline, scoring, assignment, contacts
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";
import { z } from "astro/zod";

// ══════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════

interface FormField {
	id: string;
	type: "text" | "email" | "textarea" | "select" | "checkbox" | "radio" | "number" | "phone" | "url" | "date" | "file" | "hidden";
	label: string;
	required: boolean;
	placeholder?: string;
	options?: string[]; // for select, radio, checkbox
	defaultValue?: string;
}

interface Form {
	name: string;
	slug: string;
	description?: string;
	fields: FormField[];
	status: "active" | "draft" | "archived";
	settings: {
		notificationEmail?: string;
		redirectUrl?: string;
		successMessage?: string;
		autoResponder?: { subject: string; body: string }; // Pro
	};
	submissionCount: number;
	createdAt: string;
	updatedAt: string;
}

interface Submission {
	formId: string;
	formName: string;
	data: Record<string, unknown>;
	email?: string; // extracted if form has email field
	status: "new" | "read" | "starred" | "archived" | "spam";
	ip?: string;
	userAgent?: string;
	createdAt: string;
}

interface Contact {
	email: string;
	name: string;
	phone?: string;
	company?: string;
	status: "new" | "contacted" | "qualified" | "converted" | "lost";
	score: number; // 0-100
	assignee?: string;
	tags: string[];
	source?: string;
	submissionCount: number;
	lastSubmissionAt?: string;
	createdAt: string;
	updatedAt: string;
}

interface Activity {
	contactId: string;
	type: "note" | "status_change" | "assignment" | "submission" | "score_change";
	description: string;
	userId?: string;
	createdAt: string;
}

// ══════════════════════════════════════════
// SCHEMAS
// ══════════════════════════════════════════

const fieldSchema = z.object({
	id: z.string().min(1),
	type: z.enum(["text", "email", "textarea", "select", "checkbox", "radio", "number", "phone", "url", "date", "file", "hidden"]),
	label: z.string().min(1).max(200),
	required: z.boolean().default(false),
	placeholder: z.string().max(200).optional(),
	options: z.array(z.string()).optional(),
	defaultValue: z.string().optional(),
});

const formCreateSchema = z.object({
	name: z.string().min(1).max(200),
	slug: z.string().min(1).max(200).regex(/^[a-z0-9-]+$/),
	description: z.string().max(2000).optional(),
	fields: z.array(fieldSchema).min(1),
	status: z.enum(["active", "draft"]).default("draft"),
	notificationEmail: z.string().email().optional(),
	redirectUrl: z.string().max(500).optional(),
	successMessage: z.string().max(1000).optional(),
	autoResponderSubject: z.string().max(200).optional(),
	autoResponderBody: z.string().max(5000).optional(),
});

const formUpdateSchema = formCreateSchema.partial().extend({
	id: z.string().min(1),
});

const submitSchema = z.object({
	formSlug: z.string().min(1),
	data: z.record(z.unknown()),
	_hp_website: z.string().max(0).optional(),
	"cf-turnstile-response": z.string().optional(),
});

const contactUpdateSchema = z.object({
	id: z.string().min(1),
	status: z.enum(["new", "contacted", "qualified", "converted", "lost"]).optional(),
	assignee: z.string().optional(),
	score: z.number().min(0).max(100).optional(),
	tags: z.array(z.string()).optional(),
});

const noteSchema = z.object({
	contactId: z.string().min(1),
	note: z.string().min(1).max(5000),
});

const listSchema = z.object({
	limit: z.coerce.number().min(1).max(100).default(50),
	cursor: z.string().optional(),
	status: z.string().optional(),
	formId: z.string().optional(),
});

const idSchema = z.object({ id: z.string().min(1) });

const exportSchema = z.object({
	formId: z.string().optional(),
	status: z.string().optional(),
	format: z.enum(["csv", "json"]).default("csv"),
});

// ══════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════

function genId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function now(): string {
	return new Date().toISOString();
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function escapeCsv(value: unknown): string {
	const str = String(value ?? "");
	if (str.includes(",") || str.includes('"') || str.includes("\n")) {
		return `"${str.replace(/"/g, '""')}"`;
	}
	return str;
}

function formatNum(n: number): string {
	return new Intl.NumberFormat("en-US").format(n);
}

function throw404(msg: string): never {
	throw new Response(JSON.stringify({ error: msg }), { status: 404, headers: { "Content-Type": "application/json" } });
}
function throw400(msg: string): never {
	throw new Response(JSON.stringify({ error: msg }), { status: 400, headers: { "Content-Type": "application/json" } });
}
function throw403(msg: string): never {
	throw new Response(JSON.stringify({ error: msg, upgrade: true }), { status: 403, headers: { "Content-Type": "application/json" } });
}

// ══════════════════════════════════════════
// TIER & EMAIL
// ══════════════════════════════════════════

type Tier = "free" | "pro" | "pro_crm";

async function getTier(ctx: PluginContext): Promise<Tier> {
	const key = await ctx.kv.get<string>("settings:licenseKey");
	if (!key) return "free";
	const tier = await ctx.kv.get<string>("settings:licenseTier");
	if (tier === "pro_crm") return "pro_crm";
	return "pro";
}

async function isPro(ctx: PluginContext): Promise<boolean> {
	return (await getTier(ctx)) !== "free";
}

function requirePro(pro: boolean, feature: string): void {
	if (!pro) throw403(`${feature} requires Pro. Upgrade at pluginsforemdash.com/pricing`);
}

function requireCRM(tier: Tier, feature: string): void {
	if (tier !== "pro_crm") throw403(`${feature} requires Pro CRM ($29/mo). Upgrade at pluginsforemdash.com/pricing`);
}

const PLATFORM_API = "https://api.pluginsforemdash.com/v1";

async function sendEmail(ctx: PluginContext, to: string, subject: string, text: string): Promise<boolean> {
	if (!ctx.http) return false;

	const tier = await getTier(ctx);

	if (tier !== "free") {
		// Pro: managed email via platform
		const licenseKey = await ctx.kv.get<string>("settings:licenseKey");
		const from = (await ctx.kv.get<string>("settings:fromEmail")) ?? "forms@notifications.pluginsforemdash.com";
		try {
			const res = await ctx.http.fetch(`${PLATFORM_API}/email/send`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "Authorization": `Bearer ${licenseKey}` },
				body: JSON.stringify({ from, to, subject, text }),
			});
			return res.ok;
		} catch { return false; }
	}

	// Free: own Resend key
	const resendKey = await ctx.kv.get<string>("settings:resendApiKey");
	if (!resendKey) return false;

	const from = (await ctx.kv.get<string>("settings:fromEmail")) ?? "forms@notifications.pluginsforemdash.com";
	try {
		const res = await ctx.http.fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resendKey}` },
			body: JSON.stringify({ from, to, subject, text }),
		});
		return res.ok;
	} catch { return false; }
}

// ══════════════════════════════════════════
// SPAM PROTECTION
// ══════════════════════════════════════════

const rateLimits = new Map<string, number[]>();
function isRateLimited(key: string, max: number = 5, windowMs: number = 60_000): boolean {
	const cutoff = Date.now() - windowMs;
	const stamps = (rateLimits.get(key) ?? []).filter((t) => t > cutoff);
	rateLimits.set(key, stamps);
	if (stamps.length >= max) return true;
	stamps.push(Date.now());
	return false;
}

async function verifyTurnstile(token: string, secretKey: string, ctx: PluginContext): Promise<boolean> {
	if (!ctx.http) return false;
	try {
		const res = await ctx.http.fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ secret: secretKey, response: token }).toString(),
		});
		const data = (await res.json()) as { success: boolean };
		return data.success === true;
	} catch { return false; }
}

// ══════════════════════════════════════════
// PLUGIN DEFINITION
// ══════════════════════════════════════════

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("Forms plugin installed");
				await ctx.kv.set("settings:fromEmail", "");
				await ctx.kv.set("settings:resendApiKey", "");
			},
		},

		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				if (ctx.cron) {
					await ctx.cron.schedule("cleanup-spam", { schedule: "@weekly" });
				}
			},
		},

		cron: {
			handler: async (event: { name: string }, ctx: PluginContext) => {
				if (event.name === "cleanup-spam") {
					const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
					const spam = await ctx.storage.submissions!.query({
						where: { status: "spam", createdAt: { lte: cutoff } },
						limit: 100,
					});
					if (spam.items.length > 0) {
						await ctx.storage.submissions!.deleteMany(spam.items.map((i: { id: string }) => i.id));
						ctx.log.info(`Cleaned ${spam.items.length} old spam submissions`);
					}
				}
			},
		},
	},

	routes: {
		// ══════════════════════════════════════════
		// PUBLIC
		// ══════════════════════════════════════════

		"storefront/form": {
			public: true,
			input: z.object({ slug: z.string().min(1) }),
			handler: async (routeCtx: { input: { slug: string } }, ctx: PluginContext) => {
				const result = await ctx.storage.forms!.query({ where: { slug: routeCtx.input.slug, status: "active" }, limit: 1 });
				if (result.items.length === 0) throw404("Form not found");
				const form = result.items[0]!.data as Form;
				return {
					name: form.name,
					slug: form.slug,
					description: form.description,
					fields: form.fields,
					successMessage: form.settings.successMessage ?? "Thank you! Your submission has been received.",
				};
			},
		},

		"storefront/submit": {
			public: true,
			input: submitSchema,
			handler: async (routeCtx: { input: z.infer<typeof submitSchema> }, ctx: PluginContext) => {
				const { formSlug, data, _hp_website } = routeCtx.input;

				// Honeypot
				if (_hp_website && _hp_website.length > 0) {
					ctx.log.info("Honeypot triggered");
					return { success: true, id: genId() };
				}

				// Find form
				const formResult = await ctx.storage.forms!.query({ where: { slug: formSlug, status: "active" }, limit: 1 });
				if (formResult.items.length === 0) throw404("Form not found");
				const formItem = formResult.items[0]!;
				const form = formItem.data as Form;

				// Rate limit by form
				if (isRateLimited(`form:${formSlug}`)) throw400("Too many submissions. Try again later.");

				// Turnstile
				const turnstileSecret = await ctx.kv.get<string>("settings:turnstileSecretKey");
				if (turnstileSecret) {
					const token = routeCtx.input["cf-turnstile-response"];
					if (!token) throw400("CAPTCHA verification required.");
					const valid = await verifyTurnstile(token, turnstileSecret, ctx);
					if (!valid) throw400("CAPTCHA verification failed.");
				}

				// Validate required fields
				for (const field of form.fields) {
					if (field.required && !data[field.id]) {
						throw400(`${field.label} is required`);
					}
				}

				// Extract email if present
				const emailField = form.fields.find((f) => f.type === "email");
				const email = emailField ? String(data[emailField.id] ?? "") : undefined;

				// Rate limit by email too
				if (email && isRateLimited(`email:${email}`)) throw400("Too many submissions. Try again later.");

				// Save submission
				const id = genId();
				const submission: Submission = {
					formId: formItem.id,
					formName: form.name,
					data,
					email: email || undefined,
					status: "new",
					createdAt: now(),
				};
				await ctx.storage.submissions!.put(id, submission);

				// Update form submission count
				form.submissionCount = (form.submissionCount ?? 0) + 1;
				form.updatedAt = now();
				await ctx.storage.forms!.put(formItem.id, form);

				// Notification email (fire-and-forget)
				if (form.settings.notificationEmail) {
					const fieldLines = form.fields
						.map((f) => `${f.label}: ${data[f.id] ?? "(empty)"}`)
						.join("\n");

					sendEmail(ctx, form.settings.notificationEmail,
						`New submission: ${form.name}`,
						`New submission on "${form.name}":\n\n${fieldLines}\n\nView in admin: /_emdash/admin/plugins/forms/submissions`,
					).catch(() => {});
				}

				// Auto-responder (Pro)
				if (email && form.settings.autoResponder) {
					isPro(ctx).then((pro) => {
						if (pro) {
							sendEmail(ctx, email, form.settings.autoResponder!.subject, form.settings.autoResponder!.body).catch(() => {});
						}
					});
				}

				// Webhook forwarding
				const webhookUrl = await ctx.kv.get<string>("settings:webhookUrl");
				if (webhookUrl && ctx.http) {
					const webhookToken = await ctx.kv.get<string>("settings:webhookToken");
					const headers: Record<string, string> = { "Content-Type": "application/json", "X-EmDash-Event": "form:submission" };
					if (webhookToken) headers["Authorization"] = `Bearer ${webhookToken}`;
					ctx.http.fetch(webhookUrl, {
						method: "POST", headers,
						body: JSON.stringify({ event: "form:submission", form: form.name, formSlug, data, email, timestamp: now() }),
					}).catch(() => {});
				}

				// Upsert CRM contact (Pro CRM)
				if (email) {
					getTier(ctx).then(async (tier) => {
						if (tier !== "pro_crm") return;
						const existing = await ctx.storage.contacts!.query({ where: { email }, limit: 1 });
						if (existing.items.length > 0) {
							const c = existing.items[0]!;
							const contact = c.data as Contact;
							contact.submissionCount += 1;
							contact.lastSubmissionAt = now();
							contact.updatedAt = now();
							await ctx.storage.contacts!.put(c.id, contact);
							await ctx.storage.activities!.put(genId(), {
								contactId: c.id, type: "submission",
								description: `Submitted "${form.name}"`, createdAt: now(),
							});
						} else {
							const contactId = genId();
							const nameField = form.fields.find((f) => f.type === "text" && f.label.toLowerCase().includes("name"));
							await ctx.storage.contacts!.put(contactId, {
								email, name: nameField ? String(data[nameField.id] ?? email) : email,
								status: "new", score: 0, tags: [], source: form.name,
								submissionCount: 1, lastSubmissionAt: now(),
								createdAt: now(), updatedAt: now(),
							});
							await ctx.storage.activities!.put(genId(), {
								contactId, type: "submission",
								description: `First submission via "${form.name}"`, createdAt: now(),
							});
						}
					}).catch(() => {});
				}

				return {
					success: true, id,
					message: form.settings.successMessage ?? "Thank you! Your submission has been received.",
					redirect: form.settings.redirectUrl,
				};
			},
		},

		// ══════════════════════════════════════════
		// ADMIN — FORMS
		// ══════════════════════════════════════════

		"forms/list": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const result = await ctx.storage.forms!.query({ orderBy: { createdAt: "desc" }, limit: 100 });
				return { items: result.items.map((i: { id: string; data: unknown }) => ({ id: i.id, ...(i.data as Form) })) };
			},
		},

		"forms/create": {
			input: formCreateSchema,
			handler: async (routeCtx: { input: z.infer<typeof formCreateSchema> }, ctx: PluginContext) => {
				const existing = await ctx.storage.forms!.query({ where: { slug: routeCtx.input.slug }, limit: 1 });
				if (existing.items.length > 0) throw400("A form with this slug already exists");

				if (routeCtx.input.autoResponderSubject || routeCtx.input.autoResponderBody) {
					const pro = await isPro(ctx);
					requirePro(pro, "Auto-responder emails");
				}

				const id = genId();
				const form: Form = {
					name: routeCtx.input.name,
					slug: routeCtx.input.slug,
					description: routeCtx.input.description,
					fields: routeCtx.input.fields,
					status: routeCtx.input.status,
					settings: {
						notificationEmail: routeCtx.input.notificationEmail,
						redirectUrl: routeCtx.input.redirectUrl,
						successMessage: routeCtx.input.successMessage,
						autoResponder: routeCtx.input.autoResponderSubject ? {
							subject: routeCtx.input.autoResponderSubject,
							body: routeCtx.input.autoResponderBody ?? "",
						} : undefined,
					},
					submissionCount: 0,
					createdAt: now(),
					updatedAt: now(),
				};
				await ctx.storage.forms!.put(id, form);
				return { success: true, id };
			},
		},

		"forms/update": {
			input: formUpdateSchema,
			handler: async (routeCtx: { input: z.infer<typeof formUpdateSchema> }, ctx: PluginContext) => {
				const { id, ...updates } = routeCtx.input;
				const existing = (await ctx.storage.forms!.get(id)) as Form | null;
				if (!existing) throw404("Form not found");

				const updated = { ...existing };
				if (updates.name) updated.name = updates.name;
				if (updates.slug) updated.slug = updates.slug;
				if (updates.description !== undefined) updated.description = updates.description;
				if (updates.fields) updated.fields = updates.fields;
				if (updates.status) updated.status = updates.status;
				if (updates.notificationEmail !== undefined) updated.settings.notificationEmail = updates.notificationEmail;
				if (updates.redirectUrl !== undefined) updated.settings.redirectUrl = updates.redirectUrl;
				if (updates.successMessage !== undefined) updated.settings.successMessage = updates.successMessage;
				updated.updatedAt = now();

				await ctx.storage.forms!.put(id, updated);
				return { success: true };
			},
		},

		"forms/delete": {
			input: idSchema,
			handler: async (routeCtx: { input: { id: string } }, ctx: PluginContext) => {
				await ctx.storage.forms!.delete(routeCtx.input.id);
				return { success: true };
			},
		},

		// ══════════════════════════════════════════
		// ADMIN — SUBMISSIONS
		// ══════════════════════════════════════════

		"submissions/list": {
			input: listSchema,
			handler: async (routeCtx: { input: z.infer<typeof listSchema> }, ctx: PluginContext) => {
				const { limit, cursor, status, formId } = routeCtx.input;
				const where: Record<string, unknown> = {};
				if (status) where.status = status;
				if (formId) where.formId = formId;

				const result = await ctx.storage.submissions!.query({
					where: Object.keys(where).length > 0 ? where : undefined,
					orderBy: { createdAt: "desc" }, limit, cursor,
				});
				return {
					items: result.items.map((i: { id: string; data: unknown }) => ({ id: i.id, ...(i.data as Submission) })),
					cursor: result.cursor, hasMore: result.hasMore,
				};
			},
		},

		"submissions/get": {
			input: idSchema,
			handler: async (routeCtx: { input: { id: string } }, ctx: PluginContext) => {
				const sub = (await ctx.storage.submissions!.get(routeCtx.input.id)) as Submission | null;
				if (!sub) throw404("Submission not found");

				// Mark as read
				if (sub.status === "new") {
					sub.status = "read";
					await ctx.storage.submissions!.put(routeCtx.input.id, sub);
				}
				return { id: routeCtx.input.id, ...sub };
			},
		},

		"submissions/update": {
			input: z.object({ id: z.string().min(1), status: z.enum(["new", "read", "starred", "archived", "spam"]) }),
			handler: async (routeCtx: { input: { id: string; status: string } }, ctx: PluginContext) => {
				const sub = (await ctx.storage.submissions!.get(routeCtx.input.id)) as Submission | null;
				if (!sub) throw404("Submission not found");
				sub.status = routeCtx.input.status as Submission["status"];
				await ctx.storage.submissions!.put(routeCtx.input.id, sub);
				return { success: true };
			},
		},

		"submissions/delete": {
			input: idSchema,
			handler: async (routeCtx: { input: { id: string } }, ctx: PluginContext) => {
				await ctx.storage.submissions!.delete(routeCtx.input.id);
				return { success: true };
			},
		},

		"submissions/export": {
			input: exportSchema,
			handler: async (routeCtx: { input: z.infer<typeof exportSchema> }, ctx: PluginContext) => {
				const where: Record<string, unknown> = {};
				if (routeCtx.input.formId) where.formId = routeCtx.input.formId;
				if (routeCtx.input.status) where.status = routeCtx.input.status;

				const all: Array<{ id: string; data: Submission }> = [];
				let cursor: string | undefined;
				do {
					const result = await ctx.storage.submissions!.query({
						where: Object.keys(where).length > 0 ? where : undefined,
						orderBy: { createdAt: "desc" }, limit: 100, cursor,
					});
					all.push(...(result.items as Array<{ id: string; data: Submission }>));
					cursor = result.cursor;
				} while (cursor);

				if (routeCtx.input.format === "json") {
					return { data: all.map((s) => ({ id: s.id, ...s.data })), count: all.length };
				}

				// CSV: collect all unique field keys
				const allKeys = new Set<string>();
				for (const s of all) {
					for (const key of Object.keys(s.data.data)) allKeys.add(key);
				}
				const keys = ["id", "form", "email", "status", "createdAt", ...allKeys];
				const rows = all.map((s) => {
					const d = s.data;
					return [s.id, d.formName, d.email ?? "", d.status, d.createdAt, ...([...allKeys].map((k) => d.data[k]))].map(escapeCsv).join(",");
				});

				return { csv: [keys.join(","), ...rows].join("\n"), count: all.length };
			},
		},

		// ══════════════════════════════════════════
		// ADMIN — CRM (Pro CRM)
		// ══════════════════════════════════════════

		"contacts/list": {
			input: listSchema,
			handler: async (routeCtx: { input: z.infer<typeof listSchema> }, ctx: PluginContext) => {
				const tier = await getTier(ctx);
				requireCRM(tier, "CRM contacts");

				const { limit, cursor, status } = routeCtx.input;
				const where = status ? { status } : undefined;
				const result = await ctx.storage.contacts!.query({ where, orderBy: { createdAt: "desc" }, limit, cursor });
				return {
					items: result.items.map((i: { id: string; data: unknown }) => ({ id: i.id, ...(i.data as Contact) })),
					cursor: result.cursor, hasMore: result.hasMore,
				};
			},
		},

		"contacts/get": {
			input: idSchema,
			handler: async (routeCtx: { input: { id: string } }, ctx: PluginContext) => {
				const tier = await getTier(ctx);
				requireCRM(tier, "CRM contacts");

				const contact = (await ctx.storage.contacts!.get(routeCtx.input.id)) as Contact | null;
				if (!contact) throw404("Contact not found");

				const activities = await ctx.storage.activities!.query({
					where: { contactId: routeCtx.input.id }, orderBy: { createdAt: "desc" }, limit: 50,
				});

				return {
					id: routeCtx.input.id, ...contact,
					activities: activities.items.map((a: { id: string; data: unknown }) => ({ id: a.id, ...(a.data as Activity) })),
				};
			},
		},

		"contacts/update": {
			input: contactUpdateSchema,
			handler: async (routeCtx: { input: z.infer<typeof contactUpdateSchema> }, ctx: PluginContext) => {
				const tier = await getTier(ctx);
				requireCRM(tier, "CRM contacts");

				const { id, ...updates } = routeCtx.input;
				const existing = (await ctx.storage.contacts!.get(id)) as Contact | null;
				if (!existing) throw404("Contact not found");

				const updated = { ...existing, ...updates, updatedAt: now() };
				await ctx.storage.contacts!.put(id, updated);

				if (updates.status && updates.status !== existing.status) {
					await ctx.storage.activities!.put(genId(), {
						contactId: id, type: "status_change",
						description: `${existing.status} → ${updates.status}`, createdAt: now(),
					});
				}
				if (updates.assignee && updates.assignee !== existing.assignee) {
					await ctx.storage.activities!.put(genId(), {
						contactId: id, type: "assignment",
						description: `Assigned to ${updates.assignee}`, createdAt: now(),
					});
				}
				if (updates.score !== undefined && updates.score !== existing.score) {
					await ctx.storage.activities!.put(genId(), {
						contactId: id, type: "score_change",
						description: `Score: ${existing.score} → ${updates.score}`, createdAt: now(),
					});
				}

				return { success: true };
			},
		},

		"contacts/notes/add": {
			input: noteSchema,
			handler: async (routeCtx: { input: z.infer<typeof noteSchema> }, ctx: PluginContext) => {
				const tier = await getTier(ctx);
				requireCRM(tier, "CRM contacts");

				const exists = await ctx.storage.contacts!.exists(routeCtx.input.contactId);
				if (!exists) throw404("Contact not found");

				await ctx.storage.activities!.put(genId(), {
					contactId: routeCtx.input.contactId, type: "note",
					description: routeCtx.input.note, createdAt: now(),
				});
				return { success: true };
			},
		},

		// ══════════════════════════════════════════
		// ADMIN — STATS & ANALYTICS
		// ══════════════════════════════════════════

		stats: {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const [totalForms, activeForms, totalSubmissions, newSubmissions, totalContacts] = await Promise.all([
					ctx.storage.forms!.count(),
					ctx.storage.forms!.count({ status: "active" }),
					ctx.storage.submissions!.count(),
					ctx.storage.submissions!.count({ status: "new" }),
					ctx.storage.contacts!.count(),
				]);
				return { forms: { total: totalForms, active: activeForms }, submissions: { total: totalSubmissions, new: newSubmissions }, contacts: totalContacts };
			},
		},

		"analytics/summary": {
			handler: async (_routeCtx: unknown, ctx: PluginContext) => {
				const pro = await isPro(ctx);
				requirePro(pro, "Analytics");

				// Last 30 days of submissions by day
				const days: Array<{ date: string; count: number }> = [];
				for (let i = 29; i >= 0; i--) {
					const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
					const dateStr = d.toISOString().slice(0, 10);
					const dayStart = dateStr + "T00:00:00.000Z";
					const dayEnd = dateStr + "T23:59:59.999Z";
					const result = await ctx.storage.submissions!.query({
						where: { createdAt: { gte: dayStart, lte: dayEnd } }, limit: 1,
					});
					// count is approximate from the query — use count() for accuracy
					days.push({ date: dateStr, count: result.items.length });
				}

				// Top forms
				const forms = await ctx.storage.forms!.query({ orderBy: { createdAt: "desc" }, limit: 20 });
				const topForms = (forms.items as Array<{ id: string; data: Form }>)
					.map((f) => ({ name: f.data.name, submissions: f.data.submissionCount ?? 0 }))
					.sort((a, b) => b.submissions - a.submissions)
					.slice(0, 5);

				return { period: "30d", daily: days, topForms };
			},
		},

		// ══════════════════════════════════════════
		// BLOCK KIT ADMIN UI
		// ══════════════════════════════════════════

		admin: {
			handler: async (routeCtx: { input: unknown }, ctx: PluginContext) => {
				const interaction = routeCtx.input as {
					type: string; page?: string; action_id?: string; values?: Record<string, unknown>;
				};

				if (interaction.type === "page_load" && interaction.page === "widget:submissions-overview") return buildSubmissionsWidget(ctx);
				if (interaction.type === "page_load" && interaction.page === "/") return buildDashboard(ctx);
				if (interaction.type === "page_load" && interaction.page === "/forms") return buildFormsPage(ctx);
				if (interaction.type === "page_load" && interaction.page === "/submissions") return buildSubmissionsPage(ctx);
				if (interaction.type === "page_load" && interaction.page === "/contacts") return buildContactsPage(ctx);
				if (interaction.type === "page_load" && interaction.page === "/analytics") return buildAnalyticsPage(ctx);
				if (interaction.type === "page_load" && interaction.page === "/settings") return buildSettingsPage(ctx);

				if (interaction.type === "form_submit" && interaction.action_id === "save_settings") return saveSettings(ctx, interaction.values ?? {});
				if (interaction.type === "form_submit" && interaction.action_id === "quick_form") return quickCreateForm(ctx, interaction.values ?? {});

				// Submission status changes
				if (interaction.type === "block_action" && interaction.action_id?.startsWith("sub_status:")) {
					const [, id, status] = interaction.action_id.split(":");
					if (id && status) {
						const sub = (await ctx.storage.submissions!.get(id)) as Submission | null;
						if (sub) {
							sub.status = status as Submission["status"];
							await ctx.storage.submissions!.put(id, sub);
						}
					}
					return buildSubmissionsPage(ctx);
				}

				// Contact status changes
				if (interaction.type === "block_action" && interaction.action_id?.startsWith("contact_status:")) {
					const [, id, status] = interaction.action_id.split(":");
					if (id && status) {
						const contact = (await ctx.storage.contacts!.get(id)) as Contact | null;
						if (contact) {
							const old = contact.status;
							contact.status = status as Contact["status"];
							contact.updatedAt = now();
							await ctx.storage.contacts!.put(id, contact);
							await ctx.storage.activities!.put(genId(), {
								contactId: id, type: "status_change",
								description: `${old} → ${status}`, createdAt: now(),
							});
						}
					}
					return buildContactsPage(ctx);
				}

				return { blocks: [] };
			},
		},
	},
});

// ══════════════════════════════════════════
// BLOCK KIT BUILDERS
// ══════════════════════════════════════════

async function buildSubmissionsWidget(ctx: PluginContext) {
	try {
		const result = await ctx.storage.submissions!.query({ orderBy: { createdAt: "desc" }, limit: 5 });
		const newCount = await ctx.storage.submissions!.count({ status: "new" });
		if (result.items.length === 0) return { blocks: [{ type: "context", text: "No submissions yet" }] };
		return {
			blocks: [
				{ type: "stats", stats: [{ label: "Unread", value: String(newCount) }] },
				{
					type: "table",
					columns: [
						{ key: "form", label: "Form" }, { key: "email", label: "Email" },
						{ key: "status", label: "Status", format: "badge" },
						{ key: "date", label: "Date", format: "relative_time" },
					],
					rows: result.items.map((i: { data: unknown }) => {
						const s = i.data as Submission;
						return { form: s.formName, email: s.email ?? "-", status: s.status, date: s.createdAt };
					}),
				},
			],
		};
	} catch { return { blocks: [{ type: "context", text: "Failed to load" }] }; }
}

async function buildDashboard(ctx: PluginContext) {
	try {
		const tier = await getTier(ctx);
		const [activeForms, totalSubmissions, newSubmissions, totalContacts] = await Promise.all([
			ctx.storage.forms!.count({ status: "active" }),
			ctx.storage.submissions!.count(),
			ctx.storage.submissions!.count({ status: "new" }),
			ctx.storage.contacts!.count(),
		]);

		const blocks: unknown[] = [{ type: "header", text: "Forms Dashboard" }];

		if (tier === "free") {
			blocks.push({ type: "banner", variant: "default", title: "Upgrade to Pro", description: "Get managed email, auto-responders, and analytics ($10/mo). Or Pro CRM ($29/mo) for lead pipeline, scoring, and contact management. pluginsforemdash.com/pricing" });
		}

		const stats = [
			{ label: "Active Forms", value: String(activeForms) },
			{ label: "Total Submissions", value: formatNum(totalSubmissions) },
			{ label: "Unread", value: String(newSubmissions) },
		];
		if (tier === "pro_crm") stats.push({ label: "Contacts", value: formatNum(totalContacts) });
		blocks.push({ type: "stats", stats });

		if (newSubmissions > 0) {
			blocks.push({ type: "banner", variant: "default", title: `${newSubmissions} unread submission${newSubmissions > 1 ? "s" : ""}`, description: "Go to Submissions to review them." });
		}

		// Recent submissions
		const recent = await ctx.storage.submissions!.query({ orderBy: { createdAt: "desc" }, limit: 10 });
		if (recent.items.length > 0) {
			blocks.push(
				{ type: "divider" },
				{ type: "section", text: "**Recent Submissions**" },
				{
					type: "table",
					columns: [
						{ key: "form", label: "Form" }, { key: "email", label: "Email" },
						{ key: "status", label: "Status", format: "badge" },
						{ key: "date", label: "Date", format: "relative_time" },
					],
					rows: recent.items.map((i: { data: unknown }) => {
						const s = i.data as Submission;
						return { form: s.formName, email: s.email ?? "-", status: s.status, date: s.createdAt };
					}),
				},
			);
		}

		return { blocks };
	} catch (error) { ctx.log.error("Dashboard error", error); return { blocks: [{ type: "context", text: "Failed to load" }] }; }
}

async function buildFormsPage(ctx: PluginContext) {
	try {
		const result = await ctx.storage.forms!.query({ orderBy: { createdAt: "desc" }, limit: 50 });
		const forms = result.items as Array<{ id: string; data: Form }>;

		const blocks: unknown[] = [
			{ type: "header", text: "Forms" },
			{
				type: "form", block_id: "quick-form",
				fields: [
					{ type: "text_input", action_id: "name", label: "Form Name" },
					{ type: "text_input", action_id: "slug", label: "URL Slug" },
					{ type: "text_input", action_id: "notificationEmail", label: "Notification Email (optional)" },
					{ type: "select", action_id: "template", label: "Template", options: [
						{ label: "Contact Form (name, email, message)", value: "contact" },
						{ label: "Feedback (name, email, rating, comments)", value: "feedback" },
						{ label: "Newsletter Signup (email only)", value: "newsletter" },
						{ label: "Blank (add fields via API)", value: "blank" },
					] },
				],
				submit: { label: "Create Form", action_id: "quick_form" },
			},
			{ type: "divider" },
		];

		if (forms.length === 0) {
			blocks.push({ type: "context", text: "No forms yet. Create your first form above." });
		} else {
			blocks.push({
				type: "table",
				columns: [
					{ key: "name", label: "Name" }, { key: "slug", label: "Slug" },
					{ key: "fields", label: "Fields" }, { key: "submissions", label: "Submissions" },
					{ key: "status", label: "Status", format: "badge" },
				],
				rows: forms.map((f) => ({
					name: f.data.name, slug: f.data.slug, fields: String(f.data.fields.length),
					submissions: formatNum(f.data.submissionCount ?? 0), status: f.data.status,
				})),
			});

			// Embed code for each active form
			for (const f of forms.filter((f) => f.data.status === "active").slice(0, 3)) {
				blocks.push(
					{ type: "context", text: `Embed code for "${f.data.name}":` },
					{ type: "code", code: `POST /_emdash/api/plugins/forms/storefront/submit\n{ "formSlug": "${f.data.slug}", "data": { ... } }`, language: "bash" as never },
				);
			}
		}

		return { blocks };
	} catch (error) { ctx.log.error("Forms page error", error); return { blocks: [{ type: "context", text: "Failed to load" }] }; }
}

async function buildSubmissionsPage(ctx: PluginContext) {
	try {
		const result = await ctx.storage.submissions!.query({ orderBy: { createdAt: "desc" }, limit: 50 });
		const submissions = result.items as Array<{ id: string; data: Submission }>;

		const blocks: unknown[] = [{ type: "header", text: "Submissions" }];

		if (submissions.length === 0) {
			blocks.push({ type: "context", text: "No submissions yet." });
		} else {
			blocks.push({
				type: "table",
				columns: [
					{ key: "form", label: "Form" }, { key: "email", label: "Email" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "date", label: "Date", format: "relative_time" },
				],
				rows: submissions.map((s) => ({
					_id: s.id, form: s.data.formName, email: s.data.email ?? "-",
					status: s.data.status, date: s.data.createdAt,
				})),
			});

			for (const s of submissions.slice(0, 5)) {
				if (s.data.status === "new") {
					blocks.push({ type: "actions", elements: [
						{ type: "button", text: `Mark Read`, action_id: `sub_status:${s.id}:read` },
						{ type: "button", text: "Star", action_id: `sub_status:${s.id}:starred` },
						{ type: "button", text: "Spam", action_id: `sub_status:${s.id}:spam`, style: "danger" },
					]});
				}
			}
		}

		return { blocks };
	} catch (error) { ctx.log.error("Submissions error", error); return { blocks: [{ type: "context", text: "Failed to load" }] }; }
}

async function buildContactsPage(ctx: PluginContext) {
	const tier = await getTier(ctx);
	if (tier !== "pro_crm") {
		return {
			blocks: [
				{ type: "header", text: "CRM Contacts" },
				{ type: "banner", variant: "alert", title: "Pro CRM feature", description: "Lead pipeline, scoring, assignment, and contact management requires Pro CRM ($29/mo). Upgrade at pluginsforemdash.com/pricing" },
			],
		};
	}

	try {
		const result = await ctx.storage.contacts!.query({ orderBy: { createdAt: "desc" }, limit: 50 });
		const contacts = result.items as Array<{ id: string; data: Contact }>;

		const [newCount, contacted, qualified, converted] = await Promise.all([
			ctx.storage.contacts!.count({ status: "new" }),
			ctx.storage.contacts!.count({ status: "contacted" }),
			ctx.storage.contacts!.count({ status: "qualified" }),
			ctx.storage.contacts!.count({ status: "converted" }),
		]);

		const blocks: unknown[] = [
			{ type: "header", text: "CRM Contacts" },
			{ type: "stats", stats: [
				{ label: "New", value: String(newCount) }, { label: "Contacted", value: String(contacted) },
				{ label: "Qualified", value: String(qualified) }, { label: "Converted", value: String(converted) },
			]},
			{ type: "divider" },
		];

		if (contacts.length === 0) {
			blocks.push({ type: "context", text: "No contacts yet. Contacts are created automatically from form submissions with email fields." });
		} else {
			blocks.push({
				type: "table",
				columns: [
					{ key: "name", label: "Name" }, { key: "email", label: "Email" },
					{ key: "source", label: "Source" }, { key: "score", label: "Score" },
					{ key: "submissions", label: "Submissions" },
					{ key: "status", label: "Status", format: "badge" },
				],
				rows: contacts.map((c) => ({
					_id: c.id, name: c.data.name, email: c.data.email,
					source: c.data.source ?? "-", score: String(c.data.score),
					submissions: String(c.data.submissionCount), status: c.data.status,
				})),
			});

			for (const c of contacts.slice(0, 5)) {
				if (c.data.status === "new") {
					blocks.push({ type: "actions", elements: [
						{ type: "button", text: `Mark "${c.data.name}" Contacted`, action_id: `contact_status:${c.id}:contacted` },
					]});
				}
			}
		}

		return { blocks };
	} catch (error) { ctx.log.error("Contacts error", error); return { blocks: [{ type: "context", text: "Failed to load" }] }; }
}

async function buildAnalyticsPage(ctx: PluginContext) {
	const pro = await isPro(ctx);
	if (!pro) {
		return {
			blocks: [
				{ type: "header", text: "Analytics" },
				{ type: "banner", variant: "alert", title: "Pro feature", description: "Submission analytics requires Pro ($10/mo) or Pro CRM ($29/mo). Upgrade at pluginsforemdash.com/pricing" },
			],
		};
	}

	try {
		const totalSubmissions = await ctx.storage.submissions!.count();
		const activeForms = await ctx.storage.forms!.count({ status: "active" });

		const forms = await ctx.storage.forms!.query({ orderBy: { createdAt: "desc" }, limit: 20 });
		const topForms = (forms.items as Array<{ id: string; data: Form }>)
			.map((f) => ({ name: f.data.name, count: f.data.submissionCount ?? 0 }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 5);

		const blocks: unknown[] = [
			{ type: "header", text: "Analytics" },
			{ type: "stats", stats: [
				{ label: "Total Submissions", value: formatNum(totalSubmissions) },
				{ label: "Active Forms", value: String(activeForms) },
			]},
			{ type: "divider" },
		];

		if (topForms.length > 0) {
			blocks.push(
				{ type: "section", text: "**Top Forms by Submissions**" },
				{
					type: "table",
					columns: [{ key: "name", label: "Form" }, { key: "count", label: "Submissions" }],
					rows: topForms.map((f) => ({ name: f.name, count: formatNum(f.count) })),
				},
			);
		}

		return { blocks };
	} catch (error) { ctx.log.error("Analytics error", error); return { blocks: [{ type: "context", text: "Failed to load" }] }; }
}

async function buildSettingsPage(ctx: PluginContext) {
	try {
		const tier = await getTier(ctx);
		const fromEmail = (await ctx.kv.get<string>("settings:fromEmail")) ?? "";
		const webhookUrl = (await ctx.kv.get<string>("settings:webhookUrl")) ?? "";
		const turnstileSiteKey = (await ctx.kv.get<string>("settings:turnstileSiteKey")) ?? "";

		const blocks: unknown[] = [{ type: "header", text: "Settings" }];

		// Tier banner
		if (tier === "pro_crm") {
			blocks.push({ type: "banner", variant: "default", title: "Pro CRM Active", description: "All features enabled including lead pipeline and contact management." });
		} else if (tier === "pro") {
			blocks.push({ type: "banner", variant: "default", title: "Pro Active", description: "Managed email and analytics enabled. Upgrade to Pro CRM ($29/mo) for lead pipeline." });
		} else {
			blocks.push({ type: "banner", variant: "default", title: "Free Plan", description: "Upgrade to Pro ($10/mo) for managed email and analytics, or Pro CRM ($29/mo) for the full pipeline." });
		}

		blocks.push({
			type: "form", block_id: "settings",
			fields: [
				{ type: "secret_input", action_id: "licenseKey", label: "License Key (Pro $10/mo or Pro CRM $29/mo)" },
				{ type: "select", action_id: "licenseTier", label: "License Tier", options: [
					{ label: "Pro ($10/mo)", value: "pro" },
					{ label: "Pro CRM ($29/mo)", value: "pro_crm" },
				]},
				{ type: "divider" },
				{ type: "text_input", action_id: "fromEmail", label: "From Email Address", initial_value: fromEmail },
				{ type: "secret_input", action_id: "resendApiKey", label: "Resend API Key (free tier)" },
				{ type: "divider" },
				{ type: "text_input", action_id: "turnstileSiteKey", label: "Turnstile Site Key (optional)", initial_value: turnstileSiteKey },
				{ type: "secret_input", action_id: "turnstileSecretKey", label: "Turnstile Secret Key" },
				{ type: "divider" },
				{ type: "text_input", action_id: "webhookUrl", label: "Webhook URL (Zapier, Make, etc.)", initial_value: webhookUrl },
				{ type: "secret_input", action_id: "webhookToken", label: "Webhook Auth Token" },
			],
			submit: { label: "Save Settings", action_id: "save_settings" },
		});

		return { blocks };
	} catch (error) { ctx.log.error("Settings error", error); return { blocks: [{ type: "context", text: "Failed to load" }] }; }
}

async function saveSettings(ctx: PluginContext, values: Record<string, unknown>) {
	try {
		const secrets = ["licenseKey", "resendApiKey", "turnstileSecretKey", "webhookToken"];
		const strings = ["fromEmail", "turnstileSiteKey", "webhookUrl", "licenseTier"];

		for (const key of secrets) {
			if (typeof values[key] === "string" && values[key] !== "") await ctx.kv.set(`settings:${key}`, values[key]);
		}
		for (const key of strings) {
			if (typeof values[key] === "string") await ctx.kv.set(`settings:${key}`, values[key]);
		}

		return { ...(await buildSettingsPage(ctx)), toast: { message: "Settings saved", type: "success" } };
	} catch {
		return { blocks: [{ type: "banner", variant: "error", title: "Failed to save" }], toast: { message: "Failed", type: "error" } };
	}
}

async function quickCreateForm(ctx: PluginContext, values: Record<string, unknown>) {
	try {
		const name = values.name as string;
		const slug = values.slug as string;
		const template = (values.template as string) || "contact";

		if (!name || !slug) return { ...(await buildFormsPage(ctx)), toast: { message: "Name and slug required", type: "error" } };

		const existing = await ctx.storage.forms!.query({ where: { slug }, limit: 1 });
		if (existing.items.length > 0) return { ...(await buildFormsPage(ctx)), toast: { message: "Slug already exists", type: "error" } };

		const templates: Record<string, FormField[]> = {
			contact: [
				{ id: "name", type: "text", label: "Name", required: true, placeholder: "Your name" },
				{ id: "email", type: "email", label: "Email", required: true, placeholder: "you@example.com" },
				{ id: "message", type: "textarea", label: "Message", required: true, placeholder: "How can we help?" },
			],
			feedback: [
				{ id: "name", type: "text", label: "Name", required: false, placeholder: "Your name" },
				{ id: "email", type: "email", label: "Email", required: true, placeholder: "you@example.com" },
				{ id: "rating", type: "select", label: "Rating", required: true, options: ["5 - Excellent", "4 - Good", "3 - Average", "2 - Poor", "1 - Terrible"] },
				{ id: "comments", type: "textarea", label: "Comments", required: false, placeholder: "Tell us more..." },
			],
			newsletter: [
				{ id: "email", type: "email", label: "Email", required: true, placeholder: "you@example.com" },
			],
			blank: [],
		};

		const form: Form = {
			name, slug, fields: templates[template] ?? [],
			status: "active",
			settings: { notificationEmail: (values.notificationEmail as string) || undefined },
			submissionCount: 0, createdAt: now(), updatedAt: now(),
		};

		await ctx.storage.forms!.put(genId(), form);
		return { ...(await buildFormsPage(ctx)), toast: { message: `"${name}" created`, type: "success" } };
	} catch (error) {
		ctx.log.error("Create form error", error);
		return { ...(await buildFormsPage(ctx)), toast: { message: "Failed to create form", type: "error" } };
	}
}
