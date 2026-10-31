export type Src = "ig.dm" | "ig.cm" | "ig.mn" | "yt.cm" | "li.cm";
export const SRCS: Src[] = ["ig.dm", "ig.cm", "ig.mn", "yt.cm", "li.cm"];

export type Label = "q" | "lead" | "praise" | "spam" | "complaint" | "needs-wozu";
export const LABELS: Label[] = ["q", "lead", "praise", "spam", "complaint", "needs-wozu"];

export type DraftKind = "reply" | "dm" | "private_reply" | "hide" | "unhide" | "delete" | "reject" | "publish";
export const MODERATION_KINDS = ["hide", "unhide", "delete", "reject", "publish"] as const;
export type ModerationKind = (typeof MODERATION_KINDS)[number];

export type DraftStatus = "pending" | "approved" | "rejected" | "sending" | "sent" | "failed";

/** What a connector hands to the store. Native IDs only; the store assigns short IDs. */
export interface IncomingItem {
  net: string; // dedupe namespace, e.g. "ig" or "fake"
  nativeId: string;
  src: Src;
  threadNativeId: string; // "dm:<igsid>" for DMs, top-level comment id for comments
  authorId?: string;
  who?: string;
  text?: string;
  ts: number;
  me?: boolean;
  post?: { nativeId: string; permalink?: string; caption?: string; ts?: number; cmCount?: number };
  parentNativeId?: string;
  permalink?: string;
  hidden?: boolean;
  raw?: unknown;
}

export interface ItemRow {
  id: string;
  seq: number;
  net: string;
  native_id: string;
  src: Src;
  thread_id: string;
  author_id: string | null;
  who: string | null;
  text: string | null;
  ts: number;
  me: number;
  post_id: string | null;
  parent_nid: string | null;
  permalink: string | null;
  hidden: number;
  deleted: number;
  read: number;
  labels: string;
  raw: string | null;
  created_at: number;
}

export interface ThreadRow {
  id: string;
  net: string;
  native_id: string;
  src: Src;
  who: string | null;
  author_id: string | null;
  post_id: string | null;
  last_ts: number | null;
  last_in_ts: number | null;
  last_out_ts: number | null;
  n_in: number;
  n_out: number;
  note: string | null;
  note_tags: string | null;
  note_at: number | null;
}

export interface DraftRow {
  id: string;
  kind: DraftKind;
  item_id: string | null;
  thread_id: string | null;
  text: string | null;
  status: DraftStatus;
  idem_key: string | null;
  checks: string | null;
  created_by: string | null;
  created_at: number;
  approved_by: string | null;
  approved_at: number | null;
  confirmed: string | null;
  sent_at: number | null;
  native_id: string | null;
  result: string | null;
  error: string | null;
  attempts: number;
  next_at: number | null;
}

/** Everything a connector needs to execute an approved draft. */
export interface SendRequest {
  draft: DraftRow;
  item?: ItemRow;
  thread?: ThreadRow;
  /** Native id of the DM counterpart (IGSID) for DMs. */
  recipientId?: string;
  /** Native media id for comment replies / mention replies. */
  postNativeId?: string;
  humanAgent?: boolean;
}

export interface SendResult {
  nativeId?: string;
  raw?: unknown;
}

export interface Connector {
  /** Matches IncomingItem.net / ItemRow.net. */
  net: string;
  /** Pull new data. `scope` narrows to a source family ("dm", "cm", "mn"); undefined = everything. */
  poll(scope?: string): Promise<IncomingItem[]>;
  send(req: SendRequest): Promise<SendResult>;
  /** False while the connector has no account/credentials; sync skips it. */
  enabled?(): boolean;
  /** Network-specific draft rules, e.g. reply windows and length limits. */
  limits: { dmWindowMs: number; humanAgentWindowMs?: number; privateReplyWindowMs?: number; dmMax: number; replyMax: number };
  moderation: readonly ModerationKind[];
}
