import { store } from "./store.svelte";

// Who did something: a person's name and picture when they have set them, else what was recorded (an email, "scheduler", an app's name).
export function person(actor: string) {
  const p = store.people[actor.toLowerCase()];
  return { name: p?.name || actor, avatar: p?.avatar ?? null, known: !!p };
}
