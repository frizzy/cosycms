// The sections of Settings. The side menu lists them while Settings is open; everyone sees their own apps and the look, the rest is the owner's.
export const settingsTabs = (owner: boolean) => [
  { id: "profile", label: "Profile" },
  ...(owner ? [{ id: "publishing", label: "Deploy" }, { id: "signin", label: "Sign-in" }, { id: "people", label: "People" }, { id: "notifications", label: "Notifications" }, { id: "history", label: "History" }, { id: "search", label: "Search" }, { id: "backups", label: "Backups" }] : []),
  { id: "apps", label: "Connected apps" },
  { id: "appearance", label: "Appearance" },
];
