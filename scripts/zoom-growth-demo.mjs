// Synthetic records for the isolated preview. Importing this module performs no writes.
const demoEvent = (customerId, kind, key, day, fields = {}) => ({
  product: 'OPC OS', customerId: 'demo-' + customerId, kind, eventId: 'demo-' + key,
  at: `2026-11-${String(day).padStart(2, '0')}T09:00:00+08:00`,
  reference: '示例台账/' + key, ...fields,
});

export const growthDemoEvents = [
  demoEvent('K01', 'acquired', 'signup-01', 1, { channel: '社群活动' }),
  demoEvent('K01', 'activated', 'activation-01', 2),
  demoEvent('K01', 'order', 'payment-01', 3, { orderId: 'DEMO-1001' }),
  demoEvent('K01', 'order', 'payment-02', 6, { orderId: 'DEMO-1002' }),
  demoEvent('K02', 'acquired', 'signup-02', 1, { channel: '社群活动' }),
  demoEvent('K02', 'activated', 'activation-02', 3),
  demoEvent('K02', 'order', 'payment-03', 5, { orderId: 'DEMO-1003' }),
  demoEvent('K03', 'acquired', 'signup-03', 2, { channel: '伙伴推荐' }),
  demoEvent('K03', 'activated', 'activation-03', 3),
  demoEvent('K03', 'order', 'payment-04', 5, { orderId: 'DEMO-1004' }),
  demoEvent('K04', 'acquired', 'signup-04', 2, { channel: '伙伴推荐' }),
  demoEvent('K04', 'activated', 'activation-04', 4),
  demoEvent('K05', 'acquired', 'signup-05', 3, { channel: '产品周报' }),
  demoEvent('K06', 'order', 'unmatched-payment', 4, { orderId: 'DEMO-1099' }),
];

export async function seedGrowthDemo(record) {
  const results = [];
  for (const event of growthDemoEvents) results.push(await record(event));
  return results;
}
