import type { CSSProperties } from "react";

/** 16Personalities group metadata (colors fixed by the product spec). */

export interface PersonaGroup {
  id: string;
  label: string;
  color: string;
  types: string[];
}

export const PERSONA_GROUPS: PersonaGroup[] = [
  { id: "analysts", label: "Analysts", color: "#88619a", types: ["INTJ", "INTP", "ENTJ", "ENTP"] },
  { id: "diplomats", label: "Diplomats", color: "#33a474", types: ["INFJ", "INFP", "ENFJ", "ENFP"] },
  { id: "sentinels", label: "Sentinels", color: "#4298b4", types: ["ISTJ", "ISFJ", "ESTJ", "ESFJ"] },
  { id: "explorers", label: "Explorers", color: "#e4ae3a", types: ["ISTP", "ISFP", "ESTP", "ESFP"] },
];

export function groupOfType(type: string): PersonaGroup | undefined {
  return PERSONA_GROUPS.find((g) => g.types.includes(type));
}

export function groupColorOf(type: string): string {
  return groupOfType(type)?.color ?? "#78716b";
}

/** Chip styling derived from a group color (tinted background, colored text). */
export function groupChipStyle(type: string): CSSProperties {
  const color = groupColorOf(type);
  return {
    backgroundColor: `${color}1f`,
    color,
    borderColor: `${color}66`,
  };
}
