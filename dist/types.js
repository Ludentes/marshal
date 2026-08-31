// The vocabulary, kept apart from the algorithm so a consumer that only needs
// to read a refusal does not import the decision procedure.
//
// Every name here is resource-shaped on purpose. The nouns this package must
// never learn -- arc, seat, project, stack, repo, host -- are asserted absent
// by boundary.test.ts, because the first draft of this union had three of
// them.
/** Asserted by boundary.test.ts. Adding an entry is a breaking change. */
export const BLOCKED_KINDS = [
    "no-capacity",
    "resource-held",
    "not-ready",
    "budget-exhausted",
    "custom",
];
export const _kindsMatch = true;
//# sourceMappingURL=types.js.map