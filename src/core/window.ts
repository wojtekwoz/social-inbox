import { dur } from "./time.js";

// Reply-window math for DMs. Instagram: 24 h after the user's last message,
// 7 days with the HUMAN_AGENT tag (separate Meta feature, behind a flag).

export interface WindowState {
  open: boolean;
  leftMs: number;
  /** "21h" | "closed" */
  label: string;
  humanAgent: boolean;
}

export function replyWindow(
  lastInboundTs: number | null | undefined,
  opts: { windowMs: number; humanAgentWindowMs?: number; humanAgent?: boolean },
  now = Date.now(),
): WindowState {
  if (!lastInboundTs) return { open: false, leftMs: 0, label: "closed", humanAgent: false };
  const std = lastInboundTs + opts.windowMs - now;
  if (std > 0) return { open: true, leftMs: std, label: dur(std), humanAgent: false };
  if (opts.humanAgent && opts.humanAgentWindowMs) {
    const ha = lastInboundTs + opts.humanAgentWindowMs - now;
    if (ha > 0) return { open: true, leftMs: ha, label: `${dur(ha)} HA`, humanAgent: true };
  }
  return { open: false, leftMs: 0, label: "closed", humanAgent: false };
}
