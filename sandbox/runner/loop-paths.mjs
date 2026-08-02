import { pathInside as containedPath } from "./filesystem-isolation.mjs";

// Shared by execute-loop.mjs (verifies) and loop-agent-environment.mjs
// (writes): both need the identical error-message contract this wrapper
// gives containedPath, so it lives in its own leaf module rather than one of
// the two importing it from the other.
export function pathInside(root, child) {
  return containedPath(root, child, "loop action path escapes the executor root");
}

// Filename convention for the root-owned nonce file that fences a per-action
// native-session profile root: execute-loop.mjs verifies it on resume,
// loop-agent-environment.mjs writes it on materialization.
export const PROFILE_ROOT_FENCE_FILE = ".ot-profile-fence";
