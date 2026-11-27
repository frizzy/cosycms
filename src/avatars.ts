// Pixel avatars to pick from, drawn as 8 x 8 grids: "." is the background, "a" and "b" are the creature's colours, "#" is ink.
export type Avatar = { id: string; label: string; bg: string; a: string; b: string; rows: string[] };
export const AVATARS: Avatar[] = [
  { id: "cat", label: "Cat", bg: "#2b3a40", a: "#C46C71", b: "#EDF171", rows: ["a......a", "aa....aa", "aaaaaaaa", "a#aaaa#a", "aaaaaaaa", "aaabbaaa", ".aaaaaa.", "........"] },
  { id: "ghost", label: "Ghost", bg: "#2b3a40", a: "#75CEC8", b: "#EDF171", rows: ["..aaaa..", ".aaaaaa.", "aa#aa#aa", "aaaaaaaa", "aaabbaaa", "aaaaaaaa", "aa.aa.aa", "a..a..a."] },
  { id: "robot", label: "Robot", bg: "#2b3a40", a: "#706DEB", b: "#EDF171", rows: ["...b....", ".aaaaaa.", "aaaaaaaa", "a#aaaa#a", "aaaaaaaa", "a#bbbb#a", "aaaaaaaa", ".aaaaaa."] },
  { id: "mug", label: "Mug", bg: "#2b3a40", a: "#8E3C97", b: "#EDF171", rows: [".b.b....", "........", "aaaaaa..", "aaaaaaaa", "aaaaaa.a", "aaaaaaaa", "aaaaaa..", ".aaaa..."] },
  { id: "plant", label: "Plant", bg: "#2b3a40", a: "#A9FF9F", b: "#C46C71", rows: ["...a.a..", "..aaa.a.", ".a.aa.a.", "...aa...", "..bbbb..", "..bbbb..", "...bb...", "..bbbb.."] },
  { id: "cloud", label: "Cloud", bg: "#2b3a40", a: "#75CEC8", b: "#EDF171", rows: ["........", "...aa...", "..aaaa.a", ".aaaaaaa", "aaaaaaaa", "aa#aa#aa", ".aaaaaa.", "........"] },
  { id: "heart", label: "Heart", bg: "#2b3a40", a: "#C46C71", b: "#EDF171", rows: ["........", ".aa..aa.", "aaaaaaaa", "aabaaaaa", "aaaaaaaa", ".aaaaaa.", "..aaaa..", "...aa..."] },
  { id: "star", label: "Star", bg: "#2b3a40", a: "#EDF171", b: "#C46C71", rows: ["...aa...", "...aa...", "aaaaaaaa", ".aaaaaa.", "..aaaa..", ".aaaaaa.", ".aa..aa.", "a......a"] },
];
export const AVATAR_IDS = AVATARS.map((a) => a.id);
