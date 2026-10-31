import { z } from "zod";
import { LABELS, MODERATION_KINDS, SRCS } from "./types.js";

// Shared input schemas: MCP tools and REST routes validate with the same shapes.
// Kept as raw shapes because the MCP SDK takes `inputSchema` as a shape.

const src = z.enum(SRCS as [string, ...string[]]);
const srcList = z.union([src, z.array(src)]);
const strList = z.union([z.string(), z.array(z.string())]);

export const listShape = {
  since: z.string().optional().describe('Cursor from a previous call ("c_…"): only newer items'),
  src: srcList.optional(),
  lbl: strList.optional().describe("Filter by triage label: q, lead, praise, spam, complaint, needs-wozu"),
  unread: z.boolean().optional().describe("Default true"),
  q: z.string().optional().describe("Full-text filter"),
  on: z.string().optional().describe('Post short id, e.g. "p9"'),
  t: z.string().optional().describe("Thread id"),
  limit: z.number().int().optional().describe("Default 20, max 50"),
  maxChars: z.number().int().optional().describe("Text truncation, default 200, max 2000"),
  fields: z.array(z.string()).optional().describe("Columns: id src t who age x lbl win on me ts read url nid raw"),
  fmt: z.enum(["cols", "lines"]).optional(),
};

export const threadShape = {
  t: z.string(),
  last: z.number().int().optional().describe("Messages to return, default 8, max 30"),
  maxChars: z.number().int().optional().describe("Default 400"),
  summary: z.boolean().optional().describe("Default true"),
};

export const itemShape = { id: z.string(), full: z.boolean().optional() };

export const searchShape = {
  q: z.string().min(1),
  src: srcList.optional(),
  from: z.string().optional().describe("ISO date"),
  to: z.string().optional().describe("ISO date"),
  limit: z.number().int().optional(),
};

export const markShape = {
  ids: z.array(z.string()).optional().describe("Item or thread ids"),
  upTo: z.string().optional().describe("Mark every unread item up to this cursor as read"),
  read: z.boolean().optional(),
  lbl_add: z.array(z.enum(LABELS as [string, ...string[]])).optional(),
  lbl_rm: z.array(z.string()).optional(),
};

export const noteShape = {
  t: z.string(),
  summary: z.string().min(1).max(300),
  tags: z.array(z.string().max(30)).max(10).optional(),
};

export const draftReplyShape = {
  to: z.string().describe("Item id (i…) or thread id (t…)"),
  text: z.string().min(1),
  kind: z.enum(["reply", "dm", "private_reply"]).optional(),
  key: z.string().max(100).optional().describe("Idempotency key"),
};

export const draftModerationShape = {
  id: z.string(),
  action: z.enum(MODERATION_KINDS),
  banAuthor: z.boolean().optional(),
  key: z.string().max(100).optional(),
};

export const draftsShape = {
  status: z.enum(["pending", "approved", "rejected", "sending", "sent", "failed"]).optional(),
  limit: z.number().int().optional(),
};

export const sendShape = { d: z.string() };

export const approveShape = {
  d: z.string(),
  confirmedBy: z.string().min(1).describe("Who said yes (e.g. wozu)"),
  ref: z.string().min(1).describe("Chat message reference where the human approved"),
};

export const syncShape = { src: src.optional() };

export type Shape = Record<string, z.ZodType>;
export const obj = <S extends Shape>(s: S) => z.object(s);
export type In<S extends Shape> = z.infer<z.ZodObject<S>>;
