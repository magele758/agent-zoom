export type CompanyNote = { id: string; title: string; body: string; reference: string };
export type CompanyIdea = CompanyNote & { sources: string[]; products: string[] };
export type CompanyProject = { product: string; name: string; repos: string[] };
export type CompanyIndex = { information: CompanyNote[]; ideas: CompanyIdea[]; products: string[]; projects: CompanyProject[]; referrals: { idea: string; product: string; name: string; opportunityId: string }[] };
export type JournalExcerpt = CompanyNote & { line: number };
