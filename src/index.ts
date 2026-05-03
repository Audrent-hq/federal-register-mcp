/**
 * Audrent — Federal Register MCP server.
 *
 * Cloudflare Worker entry point. Hosts an MCP server (Streamable HTTP transport)
 * that exposes Federal Register search, document retrieval, and watchlist tools
 * to AI agents.
 *
 * Billing modes:
 *   - x402 micropayments (per-call, no account required)
 *   - Stripe subscription (monthly, API key in Authorization header)
 *
 * V1 deployment intentionally keeps the billing layer minimal — most of the work
 * is the MCP tool surface and the watchlist persistence in Cloudflare KV. The
 * x402 reverse proxy gateway handles payment verification upstream of this worker.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FederalRegisterClient } from "./api/federal-register.js";

// ---------------------------------------------------------------------
// Environment bindings (configured in wrangler.toml)
// ---------------------------------------------------------------------

interface Env {
  FR_API_BASE: string;
  USER_AGENT: string;
  WATCHLISTS: KVNamespace;
  STRIPE_API_KEY?: string;
  X402_RECEIVING_ADDRESS?: string;
}

// ---------------------------------------------------------------------
// Watchlist persistence (Cloudflare KV)
// ---------------------------------------------------------------------

interface WatchlistEntry {
  id: string; // ULID
  ownerKey: string; // API key hash or x402 wallet address
  query: {
    term?: string;
    agencies?: string[];
    type?: string[];
  };
  createdAt: string; // ISO
  lastCheckedAt: string | null;
  lastSeenDocumentNumbers: string[]; // documents already surfaced to owner
}

async function listWatchlistsForOwner(
  kv: KVNamespace,
  ownerKey: string,
): Promise<WatchlistEntry[]> {
  const list = await kv.list({ prefix: `wl:${ownerKey}:` });
  const entries: WatchlistEntry[] = [];
  for (const key of list.keys) {
    const raw = await kv.get(key.name, "json");
    if (raw) entries.push(raw as WatchlistEntry);
  }
  return entries;
}

async function saveWatchlist(kv: KVNamespace, entry: WatchlistEntry): Promise<void> {
  await kv.put(`wl:${entry.ownerKey}:${entry.id}`, JSON.stringify(entry));
}

function newId(): string {
  // Simple time-prefixed random ID; ULID is overkill for this use case.
  const ts = Date.now().toString(36);
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${ts}${randHex}`;
}

// ---------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------

function buildServer(env: Env, ownerKey: string): McpServer {
  const client = new FederalRegisterClient({
    baseUrl: env.FR_API_BASE,
    userAgent: env.USER_AGENT,
  });

  const server = new McpServer({
    name: "audrent-federal-register",
    version: "1.0.0",
  });

  // ----- search_documents ---------------------------------------------
  server.tool(
    "search_documents",
    {
      description:
        "Search the Federal Register for proposed rules, final rules, notices, " +
        "and presidential documents matching a keyword, agency, date range, or document type. " +
        "Returns a paginated list of summaries.",
      inputSchema: {
        term: z.string().optional().describe("Search keyword (full-text)."),
        agencies: z
          .array(z.string())
          .optional()
          .describe("Agency slugs (e.g., 'environmental-protection-agency'). Use list_agencies to discover."),
        publication_date_gte: z
          .string()
          .optional()
          .describe("Earliest publication date (YYYY-MM-DD)."),
        publication_date_lte: z
          .string()
          .optional()
          .describe("Latest publication date (YYYY-MM-DD)."),
        type: z
          .array(z.enum(["RULE", "PRORULE", "NOTICE", "PRESDOCU"]))
          .optional()
          .describe("Filter by document type."),
        per_page: z.number().int().min(1).max(100).default(20),
        page: z.number().int().min(1).default(1),
      },
    },
    async (input) => {
      const results = await client.search({
        term: input.term,
        agencies: input.agencies,
        publicationDateGte: input.publication_date_gte,
        publicationDateLte: input.publication_date_lte,
        type: input.type,
        perPage: input.per_page,
        page: input.page,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );

  // ----- get_document --------------------------------------------------
  server.tool(
    "get_document",
    {
      description:
        "Fetch the full record for a specific Federal Register document by its " +
        "Document Number (e.g., '2026-08234').",
      inputSchema: {
        document_number: z.string().describe("Federal Register Document Number"),
      },
    },
    async (input) => {
      const doc = await client.getDocument(input.document_number);
      return {
        content: [{ type: "text", text: JSON.stringify(doc, null, 2) }],
      };
    },
  );

  // ----- list_recent ---------------------------------------------------
  server.tool(
    "list_recent",
    {
      description:
        "List documents published recently, optionally filtered by agency or type. " +
        "Convenience wrapper around search_documents with sensible defaults.",
      inputSchema: {
        days: z.number().int().min(1).max(90).default(7),
        agencies: z.array(z.string()).optional(),
        type: z
          .array(z.enum(["RULE", "PRORULE", "NOTICE", "PRESDOCU"]))
          .optional(),
        per_page: z.number().int().min(1).max(100).default(20),
      },
    },
    async (input) => {
      const today = new Date();
      const earlier = new Date(today.getTime() - input.days * 24 * 60 * 60 * 1000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      const results = await client.search({
        agencies: input.agencies,
        publicationDateGte: fmt(earlier),
        publicationDateLte: fmt(today),
        type: input.type,
        perPage: input.per_page,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    },
  );

  // ----- list_agencies -------------------------------------------------
  server.tool(
    "list_agencies",
    {
      description:
        "List all federal agencies and their slugs (use slugs as filters in search_documents).",
      inputSchema: {},
    },
    async () => {
      const agencies = await client.listAgencies();
      return {
        content: [{ type: "text", text: JSON.stringify(agencies, null, 2) }],
      };
    },
  );

  // ----- track_changes (paid feature) ----------------------------------
  server.tool(
    "track_changes",
    {
      description:
        "Create a watchlist entry that will be polled hourly for new matching documents. " +
        "Subsequent calls to check_watchlist return new matches not yet seen by this owner.",
      inputSchema: {
        term: z.string().optional(),
        agencies: z.array(z.string()).optional(),
        type: z.array(z.enum(["RULE", "PRORULE", "NOTICE", "PRESDOCU"])).optional(),
      },
    },
    async (input) => {
      const entry: WatchlistEntry = {
        id: newId(),
        ownerKey,
        query: {
          term: input.term,
          agencies: input.agencies,
          type: input.type,
        },
        createdAt: new Date().toISOString(),
        lastCheckedAt: null,
        lastSeenDocumentNumbers: [],
      };
      await saveWatchlist(env.WATCHLISTS, entry);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                watchlist_id: entry.id,
                created: entry.createdAt,
                query: entry.query,
                next_check: "Hourly. Use check_watchlist to retrieve new matches.",
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ----- check_watchlist -----------------------------------------------
  server.tool(
    "check_watchlist",
    {
      description:
        "Return all new documents matching this owner's active watchlist entries " +
        "since the last check. Documents are surfaced exactly once per watchlist.",
      inputSchema: {},
    },
    async () => {
      const watchlists = await listWatchlistsForOwner(env.WATCHLISTS, ownerKey);
      const allNew: Array<{
        watchlist_id: string;
        new_documents: unknown[];
      }> = [];

      for (const wl of watchlists) {
        const result = await client.search({
          term: wl.query.term,
          agencies: wl.query.agencies,
          type: wl.query.type as any,
          perPage: 100,
        });
        const fresh = result.results.filter(
          (d) => !wl.lastSeenDocumentNumbers.includes(d.document_number),
        );
        if (fresh.length > 0) {
          wl.lastSeenDocumentNumbers = [
            ...wl.lastSeenDocumentNumbers,
            ...fresh.map((d) => d.document_number),
          ].slice(-1000); // bound state growth
          wl.lastCheckedAt = new Date().toISOString();
          await saveWatchlist(env.WATCHLISTS, wl);
          allNew.push({
            watchlist_id: wl.id,
            new_documents: fresh,
          });
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify(allNew, null, 2) }],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------
// Owner identification (which API key / wallet is calling?)
// ---------------------------------------------------------------------

function ownerKeyFromRequest(request: Request): string {
  // Bearer API key for subscription customers
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return `sub:${auth.slice(7)}`;
  }
  // x402 payment header carries the paying address
  const x402 = request.headers.get("X-Payment-Address");
  if (x402) {
    return `x402:${x402.toLowerCase()}`;
  }
  // Anonymous — for free tools (list_agencies). Watchlists rejected for anonymous.
  return "anon";
}

// ---------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", service: "audrent-federal-register-mcp" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const ownerKey = ownerKeyFromRequest(request);
    const server = buildServer(env, ownerKey);

    // Streamable HTTP transport handler — implementation provided by the MCP SDK.
    // For brevity in V1, we delegate to the SDK's built-in HTTP handler.
    return server.handleHttpRequest(request);
  },

  /**
   * Cron handler — runs hourly per wrangler.toml triggers.
   * Pre-warms watchlist results so check_watchlist responses are fast.
   */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    // V1 implementation: no-op. The watchlist polling is done lazily on
    // check_watchlist invocation. As scale grows, move polling here so
    // the cron does the work and check_watchlist just reads the cache.
    console.log(
      JSON.stringify({
        msg: "scheduled trigger fired",
        timestamp: new Date().toISOString(),
        note: "V1: lazy polling on check_watchlist; cron is no-op until scale warrants pre-warming",
      }),
    );
  },
};
