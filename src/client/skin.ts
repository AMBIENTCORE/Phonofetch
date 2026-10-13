export type Skin = "original" | "accents" | "liquid";

export const SKIN_STORAGE_KEY = "phonofetch-skin";

export function isSkin(value: string | null): value is Skin {
  return value === "original" || value === "accents" || value === "liquid";
}
