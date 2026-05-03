/**
 * Federal Register API client.
 *
 * Wraps the public federalregister.gov API (v1) with typed responses.
 * The Federal Register API is free and well-documented; we don't have an
 * API key requirement, just a User-Agent identifying our service.
 *
 * Reference: https://www.federalregister.gov/developers/documentation/api/v1
 */

import { z } from "zod";

// ---------------------------------------------------------------------
// Schemas (zod) — single source of truth for response shapes
// ---------------------------------------------------------------------

export const DocumentSummarySchema = z.object({
  document_number: z.string(),
  title: z.string(),
  type: z.string(), // "Rule", "Proposed Rule", "Notice", "Presidential Document"
  abstract: z.string().nullable(),
  publication_date: z.string(), // ISO date
  agencies: z.array(
    z.object({
      raw_name: z.string().optional(),
      name: z.string().optional(),
      slug: z.string().optional(),
    }),
  ),
  html_url: z.string().url(),
  pdf_url: z.string().url().optional(),
  citation: z.string().optional(),
});

export type DocumentSummary = z.infer<typeof DocumentSummarySchema>;

export const DocumentDetailSchema = DocumentSummarySchema.extend({
  body_html_url: z.string().url().optional(),
  full_text_xml_url: z.string().url().optional(),
  comments_close_on: z.string().nullable().optional(),
  effective_on: z.string().nullable().optional(),
  cfr_references: z
    .array(
      z.object({
        title: z.number(),
        part: z.number().optional(),
      }),
    )
    .optional(),
  significant: z.boolean().optional(),
});

export type DocumentDetail = z.infer<typeof DocumentDetailSchema>;

export const SearchResponseSchema = z.object({
  count: z.number(),
  total_pages: z.number(),
  next_page_url: z.string().nullable().optional(),
  results: z.array(DocumentSummarySchema),
});

export type SearchResponse = z.infer<typeof SearchResponseSchema>;

export const AgencySchema = z.object({
  id: z.number(),
  name: z.string(),
  short_name: z.string().nullable(),
  slug: z.string(),
  parent_id: z.number().nullable().optional(),
});

export type Agency = z.infer<typeof AgencySchema>;

// ---------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------

export interface FederalRegisterClientConfig {
  baseUrl: string;
  userAgent: string;
  fetchImpl?: typeof fetch;
}

export class FederalRegisterClient {
  constructor(private readonly config: FederalRegisterClientConfig) {}

  private async request<T>(path: string, schema: z.ZodSchema<T>): Promise<T> {
    const url = `${this.config.baseUrl}${path}`;
    const init: RequestInit = {
      headers: {
        "User-Agent": this.config.userAgent,
        Accept: "application/json",
      },
    };

    // Cloudflare Workers requires fetch to be called with its global `this`
    // binding. A getter or stored reference detaches that binding and
    // produces "Illegal invocation" errors. Calling fetch directly from
    // the top-level identifier preserves correct binding.
    const response = this.config.fetchImpl
      ? await this.config.fetchImpl(url, init)
      : await fetch(url, init);

    if (!response.ok) {
      throw new FederalRegisterApiError(
        `Federal Register API returned ${response.status}: ${response.statusText}`,
        response.status,
      );
    }

    const json = await response.json();
    const parsed = schema.safeParse(json);

    if (!parsed.success) {
      throw new FederalRegisterApiError(
        `Federal Register API response did not match expected schema: ${parsed.error.message}`,
        500,
      );
    }

    return parsed.data;
  }

  /**
   * Search documents with filters.
   *
   * Federal Register's /documents endpoint supports rich query parameters.
   * We expose the most useful ones; see API docs for the full list.
   */
  async search(params: {
    term?: string;
    agencies?: string[]; // agency slugs
    publicationDateGte?: string; // ISO date
    publicationDateLte?: string;
    type?: ("RULE" | "PRORULE" | "NOTICE" | "PRESDOCU")[];
    perPage?: number;
    page?: number;
  }): Promise<SearchResponse> {
    const search = new URLSearchParams();
    if (params.term) search.set("conditions[term]", params.term);
    for (const slug of params.agencies ?? []) {
      search.append("conditions[agencies][]", slug);
    }
    if (params.publicationDateGte) {
      search.set("conditions[publication_date][gte]", params.publicationDateGte);
    }
    if (params.publicationDateLte) {
      search.set("conditions[publication_date][lte]", params.publicationDateLte);
    }
    for (const t of params.type ?? []) {
      search.append("conditions[type][]", t);
    }
    if (params.perPage) search.set("per_page", String(params.perPage));
    if (params.page) search.set("page", String(params.page));

    return this.request<SearchResponse>(
      `/documents.json?${search.toString()}`,
      SearchResponseSchema,
    );
  }

  /**
   * Fetch a single document by Federal Register Document Number.
   */
  async getDocument(documentNumber: string): Promise<DocumentDetail> {
    return this.request<DocumentDetail>(
      `/documents/${encodeURIComponent(documentNumber)}.json`,
      DocumentDetailSchema,
    );
  }

  /**
   * List all agencies.
   */
  async listAgencies(): Promise<Agency[]> {
    return this.request<Agency[]>("/agencies.json", z.array(AgencySchema));
  }
}

export class FederalRegisterApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "FederalRegisterApiError";
  }
}
