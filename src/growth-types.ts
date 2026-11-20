export type GrowthEvent = {
  product: string;
  eventId: string;
  customerId: string;
  at: string;
  reference: string;
} & (
  | { kind: "acquired"; channel: string; orderId?: never }
  | { kind: "activated"; channel?: never; orderId?: never }
  | { kind: "order"; orderId: string; channel?: never }
);

export type GrowthCounts = { acquired: number; activated: number; firstOrder: number; repeatOrder: number };
export type GrowthCustomer = {
  customerId: string;
  channel: string;
  acquired: GrowthEvent;
  activated?: GrowthEvent;
  firstOrder?: GrowthEvent;
  repeatOrder?: GrowthEvent;
};
export type GrowthExcluded = {
  event: GrowthEvent;
  reason: "missing_acquisition" | "activation_before_acquisition" | "missing_activation" | "order_before_activation";
};
export type GrowthReport = {
  preview?: boolean;
  products: string[];
  product: string | null;
  total: GrowthCounts;
  channels: Array<{ channel: string } & GrowthCounts>;
  customers: GrowthCustomer[];
  excluded: GrowthExcluded[];
  eventCount: number;
};
