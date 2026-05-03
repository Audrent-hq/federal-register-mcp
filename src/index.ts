/**
 * Audrent — Federal Register MCP server.
 *
 * Cloudflare Worker entry point. Hosts an MCP server over Streamable HTTP
 * (JSON-RPC 2.0 over POST) that exposes Federal Register search, document
 * retrieval, and watchlist tools to AI agents.
 *
 * Implementation note: this worker handles MCP JSON-RPC directly rather than
 * via the @modelcontextprotocol/sdk's transport layer. The SDK's transport
 * abstraction assumes Node.js HTTP (req/res objects); Cloudflare Workers uses
 * Web Standard Request/Response. Implementing the protocol directly is more
 * reliable than adapting the SDK's transport for Workers.
 *
 * Billing modes (handled upstream of this worker):
 *   - x402 micropayments (per-call, no account required) — verified by reverse-proxy gateway, signaled to worker via X-Payment-Address header
 *   - Stripe subscription (monthly) — API key in Authorization: Bearer header
 */

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
  id: string;
  ownerKey: string;
  query: {
    term?: string;
    agencies?: string[];
    type?: string[];
  };
  createdAt: string;
  lastCheckedAt: string | null;
  lastSeenDocumentNumbers: string[];
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
  const ts = Date.now().toString(36);
  const rand = crypto.getRandomValues(new Uint8Array(8));
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${ts}${randHex}`;
}

// ---------------------------------------------------------------------
// Tool definitions (MCP tools/list response)
// ---------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: "search_documents",
    description:
      "Search the Federal Register for proposed rules, final rules, notices, " +
      "and presidential documents matching a keyword, agency, date range, or " +
      "document type. Returns a paginated list of summaries.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string", description: "Search keyword (full-text)." },
        agencies: {
          type: "array",
          items: { type: "string" },
          description:
            "Agency slugs (e.g., 'environmental-protection-agency'). Use list_agencies to discover.",
        },
        publication_date_gte: {
          type: "string",
          description: "Earliest publication date (YYYY-MM-DD).",
        },
        publication_date_lte: {
          type: "string",
          description: "Latest publication date (YYYY-MM-DD).",
        },
        type: {
          type: "array",
          items: { type: "string", enum: ["RULE", "PRORULE", "NOTICE", "PRESDOCU"] },
          description: "Filter by document type.",
        },
        per_page: { type: "number", default: 20, minimum: 1, maximum: 100 },
        page: { type: "number", default: 1, minimum: 1 },
      },
    },
  },
  {
    name: "get_document",
    description:
      "Fetch the full record for a specific Federal Register document by its " +
      "Document Number (e.g., '2026-08234').",
    inputSchema: {
      type: "object",
      properties: {
        document_number: {
          type: "string",
          description: "Federal Register Document Number.",
        },
      },
      required: ["document_number"],
    },
  },
  {
    name: "list_recent",
    description:
      "List documents published recently, optionally filtered by agency or type. " +
      "Convenience wrapper around search_documents with sensible defaults.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", default: 7, minimum: 1, maximum: 90 },
        agencies: { type: "array", items: { type: "string" } },
        type: {
          type: "array",
          items: { type: "string", enum: ["RULE", "PRORULE", "NOTICE", "PRESDOCU"] },
        },
        per_page: { type: "number", default: 20, minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: "list_agencies",
    description:
      "List all federal agencies and their slugs (use slugs as filters in search_documents).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "track_changes",
    description:
      "Create a watchlist entry that will be polled hourly for new matching documents. " +
      "Subsequent calls to check_watchlist return new matches not yet seen by this owner.",
    inputSchema: {
      type: "object",
      properties: {
        term: { type: "string" },
        agencies: { type: "array", items: { type: "string" } },
        type: {
          type: "array",
          items: { type: "string", enum: ["RULE", "PRORULE", "NOTICE", "PRESDOCU"] },
        },
      },
    },
  },
  {
    name: "check_watchlist",
    description:
      "Return all new documents matching this owner's active watchlist entries " +
      "since the last check. Documents are surfaced exactly once per watchlist.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ---------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------

async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env,
  ownerKey: string,
): Promise<unknown> {
  const client = new FederalRegisterClient({
    baseUrl: env.FR_API_BASE,
    userAgent: env.USER_AGENT,
  });

  switch (name) {
    case "search_documents": {
      return await client.search({
        term: args.term as string | undefined,
        agencies: args.agencies as string[] | undefined,
        publicationDateGte: args.publication_date_gte as string | undefined,
        publicationDateLte: args.publication_date_lte as string | undefined,
        type: args.type as ("RULE" | "PRORULE" | "NOTICE" | "PRESDOCU")[] | undefined,
        perPage: (args.per_page as number | undefined) ?? 20,
        page: (args.page as number | undefined) ?? 1,
      });
    }

    case "get_document": {
      const documentNumber = args.document_number as string;
      if (!documentNumber) {
        throw new Error("get_document requires 'document_number' argument");
      }
      return await client.getDocument(documentNumber);
    }

    case "list_recent": {
      const days = (args.days as number | undefined) ?? 7;
      const today = new Date();
      const earlier = new Date(today.getTime() - days * 24 * 60 * 60 * 1000);
      const fmt = (d: Date) => d.toISOString().slice(0, 10);
      return await client.search({
        agencies: args.agencies as string[] | undefined,
        publicationDateGte: fmt(earlier),
        publicationDateLte: fmt(today),
        type: args.type as ("RULE" | "PRORULE" | "NOTICE" | "PRESDOCU")[] | undefined,
        perPage: (args.per_page as number | undefined) ?? 20,
      });
    }

    case "list_agencies": {
      return await client.listAgencies();
    }

    case "track_changes": {
      if (ownerKey === "anon") {
        throw new Error(
          "track_changes requires authentication: provide either an Authorization Bearer subscription key or x402 payment.",
        );
      }
      const entry: WatchlistEntry = {
        id: newId(),
        ownerKey,
        query: {
          term: args.term as string | undefined,
          agencies: args.agencies as string[] | undefined,
          type: args.type as string[] | undefined,
        },
        createdAt: new Date().toISOString(),
        lastCheckedAt: null,
        lastSeenDocumentNumbers: [],
      };
      await saveWatchlist(env.WATCHLISTS, entry);
      return {
        watchlist_id: entry.id,
        created: entry.createdAt,
        query: entry.query,
        next_check: "Hourly. Use check_watchlist to retrieve new matches.",
      };
    }

    case "check_watchlist": {
      if (ownerKey === "anon") {
        throw new Error(
          "check_watchlist requires authentication: provide either an Authorization Bearer subscription key or x402 payment.",
        );
      }
      const watchlists = await listWatchlistsForOwner(env.WATCHLISTS, ownerKey);
      const allNew: Array<{ watchlist_id: string; new_documents: unknown[] }> = [];

      for (const wl of watchlists) {
        const result = await client.search({
          term: wl.query.term,
          agencies: wl.query.agencies,
          type: wl.query.type as ("RULE" | "PRORULE" | "NOTICE" | "PRESDOCU")[] | undefined,
          perPage: 100,
        });
        const fresh = result.results.filter(
          (d) => !wl.lastSeenDocumentNumbers.includes(d.document_number),
        );
        if (fresh.length > 0) {
          wl.lastSeenDocumentNumbers = [
            ...wl.lastSeenDocumentNumbers,
            ...fresh.map((d) => d.document_number),
          ].slice(-1000);
          wl.lastCheckedAt = new Date().toISOString();
          await saveWatchlist(env.WATCHLISTS, wl);
          allNew.push({
            watchlist_id: wl.id,
            new_documents: fresh,
          });
        }
      }
      return allNew;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------
// MCP JSON-RPC dispatch
// ---------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResponse(id: string | number | null | undefined, result: unknown): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }),
    { headers: { "Content-Type": "application/json" } },
  );
}

function jsonRpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  status = 400,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return jsonRpcError(null, -32600, "MCP requests must use POST", 405);
  }

  let body: JsonRpcRequest;
  try {
    body = (await request.json()) as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error: invalid JSON");
  }

  const { jsonrpc, method, params, id } = body;
  if (jsonrpc !== "2.0") {
    return jsonRpcError(id, -32600, "Invalid Request: jsonrpc must be '2.0'");
  }
  if (typeof method !== "string") {
    return jsonRpcError(id, -32600, "Invalid Request: method must be a string");
  }

  const ownerKey = ownerKeyFromRequest(request);

  try {
    switch (method) {
      case "initialize":
        return jsonRpcResponse(id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: {
            name: "audrent-federal-register",
            version: "1.0.1",
          },
        });

      case "notifications/initialized":
        // Notification — no response expected.
        return new Response(null, { status: 204 });

      case "ping":
        return jsonRpcResponse(id, {});

      case "tools/list":
        return jsonRpcResponse(id, { tools: TOOL_DEFINITIONS });

      case "tools/call": {
        const toolName = params?.name as string | undefined;
        const toolArgs = (params?.arguments as Record<string, unknown> | undefined) ?? {};
        if (!toolName) {
          return jsonRpcError(id, -32602, "Invalid params: 'name' is required");
        }
        const result = await callTool(toolName, toolArgs, env, ownerKey);
        return jsonRpcResponse(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        });
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonRpcError(id, -32603, `Internal error: ${message}`, 500);
  }
}

// ---------------------------------------------------------------------
// Owner identification (which API key / wallet is calling?)
// ---------------------------------------------------------------------

function ownerKeyFromRequest(request: Request): string {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return `sub:${auth.slice(7)}`;
  }
  const x402 = request.headers.get("X-Payment-Address");
  if (x402) {
    return `x402:${x402.toLowerCase()}`;
  }
  return "anon";
}

// ---------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "audrent-federal-register-mcp",
          version: "1.0.1",
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // Service info
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
      return new Response(
        JSON.stringify(
          {
            service: "audrent-federal-register-mcp",
            version: "1.0.1",
            transport: "Streamable HTTP (JSON-RPC 2.0 over POST)",
            mcp_endpoint: "POST /mcp or POST /",
            health_endpoint: "GET /health",
            docs: "https://audrent.com/federal-register-mcp",
            source: "https://github.com/audrent-hq/federal-register-mcp",
          },
          null,
          2,
        ),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    // MCP requests — accept on / or /mcp
    if (request.method === "POST" && (url.pathname === "/" || url.pathname === "/mcp")) {
      return await handleMcpRequest(request, env);
    }

    return new Response(
      JSON.stringify({
        error: "Not found",
        available_endpoints: ["GET /", "GET /health", "POST / (MCP)", "POST /mcp"],
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  },

  /**
   * Cron handler — runs hourly per wrangler.toml triggers.
   * V1: no-op. Watchlist polling is lazy (executed on check_watchlist invocation).
   * Future: pre-warm watchlist results at scale so check_watchlist responses are fast.
   */
  async scheduled(_event: ScheduledEvent, _env: Env): Promise<void> {
    console.log(
      JSON.stringify({
        msg: "scheduled trigger fired",
        timestamp: new Date().toISOString(),
        note: "V1: lazy polling on check_watchlist; cron is no-op until scale warrants pre-warming",
      }),
    );
  },
};
