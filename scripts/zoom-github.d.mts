import type { RepositorySnapshot } from "../src/project-types.ts";
export function readGithubRepository(fullName: string): Promise<RepositorySnapshot>;
