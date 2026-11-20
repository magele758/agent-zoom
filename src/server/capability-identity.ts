import type { RepoCapability } from "../repo-capabilities-types.ts";

export function sameCapabilityFamily(first: RepoCapability, second: RepoCapability) {
  return (
    first.product === second.product &&
    first.project === second.project &&
    first.repo.toLowerCase() === second.repo.toLowerCase() &&
    first.name === second.name
  );
}
