# emdash-plugin-leads

Lead capture and pipeline management plugin for [EmDash CMS](https://github.com/emdash-cms/emdash).

Capture leads from any page on your site, manage them through a pipeline, get notified by email, and forward to your CRM — all from the EmDash admin panel.

## Features

- **Lead capture endpoint** — Public API at `/_emdash/api/plugins/leads/capture` with Zod validation
- **Spam protection** — Honeypot field (always active) + optional Cloudflare Turnstile CAPTCHA
- **Rate limiting** — 5 submissions per email per minute
- **Pipeline management** — Track leads through: new, contacted, qualified, converted, lost
- **Activity log** — Every status change, assignment, and note is recorded
- **Email notifications** — Get notified on new leads (free with own Resend key, or Pro managed)
- **CRM webhook forwarding** — Forward leads to HubSpot, Zapier, Make, or any webhook URL
- **CSV/JSON export** — Export all leads or filter by status
- **Admin dashboard** — Pipeline stats widget, leads table with quick actions, settings page
- **Auto-archiving** — Stale leads automatically move to "lost" after configurable days
- **Embeddable form** — Copy-paste HTML form with spam protection included

## Installation

```bash
npm install emdash-plugin-leads
```

## Setup

Add the plugin to your EmDash config:

```typescript
// astro.config.mjs
import { defineConfig } from "astro/config";
import emdash from "emdash";
import { leadsPlugin } from "emdash-plugin-leads";

export default defineConfig({
  integrations: [
    emdash({
      plugins: [leadsPlugin()],
    }),
  ],
});
```

Then go to `/_emdash/admin` > Leads > Settings to configure:

1. **Notification email** — where to send new lead alerts
2. **Email provider** — Resend API key (free) or Pro license key ($10/mo managed)
3. **Turnstile** — optional, add site key + secret key for CAPTCHA protection
4. **CRM webhook** — optional, paste a webhook URL to forward leads

## Capturing Leads

### API Endpoint

```
POST /_emdash/api/plugins/leads/capture
Content-Type: application/json

{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "+1-555-0123",
  "company": "Acme Inc",
  "message": "Interested in your services",
  "source": "pricing-page",
  "customFields": {
    "plan": "enterprise"
  }
}
```

**Response:**

```json
{ "success": true, "id": "1711929600000-a1b2c3d4" }
```

### Embeddable Form

The Settings page in the admin panel provides a copy-paste HTML form. It includes the honeypot field automatically, and adds the Turnstile widget if you've configured it.

Basic example:

```html
<form id="lead-form">
  <input name="name" placeholder="Name" required />
  <input name="email" type="email" placeholder="Email" required />
  <input name="phone" placeholder="Phone" />
  <input name="company" placeholder="Company" />
  <textarea name="message" placeholder="Message"></textarea>
  <!-- Honeypot — hidden from humans -->
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
    }
  });
</script>
```

## Admin API

All admin routes require authentication (handled by EmDash automatically).

| Route | Method | Description |
|-------|--------|-------------|
| `leads/list` | GET | Paginated leads, filterable by `status`, `source`, `assignee` |
| `leads/get` | GET | Single lead with full activity history |
| `leads/update` | POST | Change status, assignee, score, tags |
| `leads/notes/add` | POST | Add a note to a lead |
| `leads/delete` | POST | Delete lead and all its activities |
| `leads/export` | GET | Export as CSV or JSON, filterable by status |
| `leads/stats` | GET | Pipeline counts and conversion rate |
| `leads/test-email` | POST | Send a test notification email |

All routes are at `/_emdash/api/plugins/leads/<route>`.

## Data Model

### Leads

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Contact name |
| `email` | string | Email address |
| `phone` | string? | Phone number |
| `company` | string? | Company name |
| `message` | string? | Message body |
| `source` | string | Where the lead came from (e.g. "website", "landing-page") |
| `status` | enum | `new`, `contacted`, `qualified`, `converted`, `lost` |
| `assignee` | string? | Team member assigned |
| `score` | number? | Lead score (0-100) |
| `tags` | string[]? | Tags |
| `customFields` | object? | Any additional data |
| `createdAt` | string | ISO timestamp |
| `updatedAt` | string | ISO timestamp |

### Activities

Every action on a lead is logged:

| Field | Type | Description |
|-------|------|-------------|
| `leadId` | string | Associated lead |
| `type` | enum | `created`, `status_change`, `assignment`, `note`, `email_sent` |
| `description` | string | Human-readable description |
| `userId` | string? | Who performed the action |
| `createdAt` | string | ISO timestamp |

## Email Tiers

| Tier | Cost | How |
|------|------|-----|
| **Free** | $0 | Paste your own [Resend](https://resend.com) API key in Settings |
| **Pro** | $10/mo | Enter a license key from [pluginsforemdash.com](https://pluginsforemdash.com/pricing) — managed delivery, no setup |
| **None** | $0 | Everything works except email notifications. Use webhooks instead. |

## Spam Protection

Three layers, all server-side:

1. **Honeypot** — A hidden `_hp_website` field. Bots fill it, humans don't see it. If filled, the plugin returns a fake success response (200) but discards the submission.
2. **Turnstile** — Optional. If configured in Settings, the capture endpoint validates the `cf-turnstile-response` token server-side against Cloudflare's API.
3. **Rate limiting** — 5 submissions per email address per 60-second window. Returns 429 if exceeded.

## Plugin Options

```typescript
leadsPlugin({
  maxLeads: 10000,       // Auto-archive oldest when exceeded (default: 10000)
  autoArchiveDays: 90,   // Move stale leads to "lost" after N days (default: 90)
})
```

## Capabilities

| Capability | Purpose |
|-----------|---------|
| `network:fetch` | Send to CRM webhooks, Resend API, Turnstile verification |
| `read:users` | Look up team members for lead assignment |

## Requirements

- EmDash CMS v0.1.0+
- Works on Cloudflare Workers (trusted or sandboxed) and Node.js (trusted only)

## License

MIT
