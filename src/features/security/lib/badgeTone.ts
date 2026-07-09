import type { ChipTone } from "@/shared/ui/data/Chip";

/** Map a profile's base-policy mode to a Chip tone (was `.mode-badge.{deny,ask,allow}`). */
export function modeTone(mode: string): ChipTone {
  return mode === "deny" ? "danger" : mode === "ask" ? "accent" : mode === "allow" ? "success" : "neutral";
}

/** Map a profile origin class to a Chip tone (was `.origin-badge.{approle,gen}`; else neutral). */
export function originTone(cls: string): ChipTone {
  return cls === "approle" ? "info" : cls === "gen" ? "accent" : "neutral";
}
