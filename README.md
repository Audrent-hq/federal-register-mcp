# Federal Register MCP

The Audrent Federal Register MCP server gives AI agents structured access to U.S. Federal Register documents — proposed rules, final rules, notices, and presidential documents — with built-in change-detection watchlists.

## What it does

Exposes the [Federal Register public API](https://www.federalregister.gov/developers/documentation/api/v1) as MCP tools that agents can call directly. Tools available:

| Tool | Purpose | Pricing |
|---|---|---|
| `search_documents` | Search documents by keyword, agency, date range, or document type | $0.01 per call |
| `get_document` | Fetch full details of a specific document by Federal Register Document Number | $0.01 per call |
| `list_recent` | List recent documents from a specific agency or topic | $0.01 per call |
| `list_agencies` | List all agencies and their slugs | Free |
| `track_changes` | Add a watchlist entry to monitor for changes (paid feature) | $0.05 per call |
| `check_watchlist` | Retrieve any new documents matching active watchlist entries | $0.02 per call |

Subscription tier coming: **$15/month** for unlimited search/get/list calls plus 50 active watchlist entries with daily polling. Pay-per-call (above) suits agents and integrations; subscription suits operators with regular workflows.

## Why this exists

Existing services that aggregate and surface Federal Register data are priced for enterprise — Bloomberg Government and Politico Pro charge $1,500–$10,000/year. The underlying Federal Register API is free and well-documented, but using it from an AI agent requires either custom API client code in every project or a generic MCP wrapper. **This MCP provides a tested, structured, agent-native interface with the watchlist feature as the differentiated paid capability** — turning what would otherwise be a code-once-per-project integration into a single discoverable tool.

The watchlist feature is the genuine paid value: an agent (or human via an agent) defines a watchlist (e.g., "any rule from EPA mentioning 'PFAS'"), and the MCP polls the Federal Register on a schedule, surfacing matches on subsequent `check_watchlist` calls. No more manual checking.

## Customers

- **Lawyers and policy analysts** following specific regulatory areas, integrated with their AI research workflow.
- **Compliance professionals** at SaaS / fintech / health-tech companies tracking rules in their domain.
- **Government-affairs and lobbying staff** building agent-augmented monitoring.
- **Researchers and journalists** covering federal regulatory developments.
- **AI builders** assembling agents that need to be aware of regulatory context for their users.

## Architecture

- **Runtime:** TypeScript on Cloudflare Workers (free tier sufficient at V1 scale).
- **MCP transport:** Streamable HTTP (the production-ready transport for paid MCP servers in 2026).
- **Authentication:** No accounts required for pay-per-call (x402 micropayments). Subscription customers get an API key.
- **Billing:** x402 reverse-proxy gateway for per-call charges; Stripe for monthly subscriptions.
- **Data source:** [federalregister.gov public API](https://www.federalregister.gov/developers/documentation/api/v1). No paid data licenses, no rate limits beyond the public API's own (60 req/min, courtesy).
- **Caching:** 5-minute edge cache on search results, 1-hour cache on document details (documents rarely change once published).
- **State:** Watchlists stored in Cloudflare KV (free at our scale).

## Source layout

```
src/
├── index.ts                  # Worker entry point, MCP server setup
├── tools/                    # Tool implementations
│   ├── search.ts
│   ├── get.ts
│   ├── recent.ts
│   ├── agencies.ts
│   └── watchlist.ts
├── api/
│   └── federal-register.ts   # Typed Federal Register API client
└── billing/
    └── x402.ts               # x402 payment verification stub
```

## Installation (for AI agent operators)

### Pay-per-call mode (no account needed)

Add to your MCP client configuration (Claude Desktop example):

```json
{
  "mcpServers": {
    "federal-register": {
      "url": "https://federal-register-mcp.audrent.workers.dev",
      "transport": "streamable-http"
    }
  }
}
```

The first time a tool is called, the MCP returns an x402 challenge. Your agent's wallet (or x402 client) responds with a USDC payment for the call. Calls go through.

### Subscription mode (Stripe)

Subscribe at [audrent.com/federal-register-mcp](https://audrent.com/federal-register-mcp) for $15/month. Receive an API key. Configure:

```json
{
  "mcpServers": {
    "federal-register": {
      "url": "https://federal-register-mcp.audrent.workers.dev",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

## Development

```bash
# Clone
git clone git@github.com:audrent-hq/federal-register-mcp.git
cd federal-register-mcp

# Install
npm install

# Local dev
npm run dev   # runs wrangler dev — local Cloudflare Workers runtime

# Deploy
npm run deploy   # wrangler deploy
```

## License

MIT. Server source is open; usage is paid (per-call or subscription) when operated against the Audrent-hosted endpoint. Self-hosting against the Federal Register API directly is permitted under MIT, with the understanding that the watchlist functionality requires Cloudflare KV state and isn't trivially portable to other runtimes without modification.

## Status

V1 — initial public release. Phase 1 of the Audrent agent-economy infrastructure portfolio.
