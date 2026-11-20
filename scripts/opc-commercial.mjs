import { parseArgs } from "node:util";

export const commercialHelp = `opc-os commercial overview
opc-os commercial bootstrap
opc-os commercial ensure
opc-os commercial closed-loop [--product <产品>] [--slug <清单标识>] [--channel <渠道>]
opc-os commercial sync-analytics [--product <产品>]
opc-os commercial playbook <模板ID> [--no-trial]`;

export async function runCommercial(args, request) {
  const [action, ...rest] = args;
  if (!action || action === "help" || action === "--help") {
    return { help: commercialHelp };
  }
  if (action === "overview") return request("/api/opc/commercial/overview");
  if (action === "bootstrap") return request("/api/opc/commercial/bootstrap", {});
  if (action === "ensure") return request("/api/opc/commercial/services/ensure", {});
  if (action === "sync-analytics") {
    const { values } = parseArgs({ args: rest, options: { product: { type: "string" } } });
    return request("/api/opc/commercial/actions/sync-analytics", values.product ? { product: values.product } : {});
  }
  if (action === "closed-loop") {
    const { values } = parseArgs({
      args: rest,
      options: {
        product: { type: "string" },
        slug: { type: "string" },
        channel: { type: "string" },
      },
    });
    return request("/api/opc/commercial/actions/closed-loop", values);
  }
  if (action === "playbook") {
    const { positionals, values } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { "no-trial": { type: "boolean" } },
    });
    if (positionals.length !== 1) throw new Error(commercialHelp);
    return request(`/api/opc/commercial/playbooks/${encodeURIComponent(positionals[0])}/apply`, {
      startTrial: !values["no-trial"],
    });
  }
  throw new Error(commercialHelp);
}
