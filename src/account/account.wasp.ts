import { type Spec, action } from "@wasp.sh/spec";
import { deleteAccount } from "./operations" with { type: "ref" };

// Account-deletion cascade (PRD Phase 2).
export const accountSpec: Spec = [
  action(deleteAccount, { entities: ["User"] }),
];
