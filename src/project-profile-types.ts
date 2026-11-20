export type ProjectRef = { product: string; project: string };
export type ReusedResult = ProjectRef & { reference: string; purpose: string };
export type ProjectProfile = ProjectRef & {
  layer: string;
  domain: string;
  revision: number;
  uses: ReusedResult[];
};
