import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";

const base = "/api/opc/capabilities";
const verified = new URL("../examples/repository-capabilities.json", import.meta.url);
const help =
  "opc-os capability discover <关键词> --owner <GitHub账号> | list|requests [--repo owner/repo] | show <需求ID> | import <JSON文件|-> 或 --verified [--repo owner/repo] | request <JSON文件|-> | revise|adopt <需求ID> <JSON文件|->";
const json = (file) => JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));
const gh = promisify(execFile);

export async function runCapabilities(args, request, command = gh) {
  const {
    values,
    positionals: [action, file, revisionFile, ...extra],
  } = parseArgs({
    args,
    allowPositionals: true,
    options: { repo: { type: "string" }, owner: { type: "string" }, verified: { type: "boolean" } },
  });
  if (action === "help" || !action) return { help };
  if (extra.length) throw Error(help);
  if (action === "discover") {
    if (
      !file?.trim() ||
      !/^[a-z0-9][a-z0-9-]{0,38}$/i.test(values.owner ?? "") ||
      values.verified ||
      values.repo ||
      revisionFile
    )
      throw Error(help);
    const { stdout } = await command("gh", [
      "search",
      "repos",
      "--owner",
      values.owner,
      "--visibility",
      "public",
      "--match",
      "name,description,readme",
      "--json",
      "fullName,description,url,visibility",
      "--limit",
      "50",
      "--",
      file.trim(),
    ]);
    const owner = values.owner.toLowerCase();
    const repositories = JSON.parse(stdout).filter(
      (row) => row.fullName.split("/")[0].toLowerCase() === owner && row.visibility.toLowerCase() === "public",
    );
    return { repositories, next: "查阅候选仓库的发布或具体提交，核对接口和试用凭据后登记版本。" };
  }
  if (values.owner) throw Error(help);
  if (action === "show") {
    if (!file || revisionFile || values.repo || values.verified) throw Error(help);
    return request(base + "/requests/" + encodeURIComponent(file));
  }
  if (action === "request") {
    if (!file || values.repo || values.verified || revisionFile) throw Error(help);
    return request(base + "/requests", json(file));
  }
  if (action === "revise" || action === "adopt") {
    if (!file || values.repo || values.verified || !revisionFile) throw Error(help);
    const endpoint = action === "revise" ? "revisions" : "adopt";
    return request(base + "/requests/" + encodeURIComponent(file) + "/" + endpoint, json(revisionFile));
  }
  if (revisionFile || !["list", "requests", "import"].includes(action)) throw Error(help);
  const match = (row) => !values.repo || row.repo.toLowerCase() === values.repo.toLowerCase();
  if (action === "list") {
    if (file || values.verified) throw Error(help);
    const { capabilities } = await request(base + "/versions");
    return { capabilities: capabilities.filter(match) };
  }
  if (action === "requests") {
    if (file || values.verified) throw Error(help);
    const { requests } = await request(base);
    return { requests: requests.filter((r) => match(r.capability)) };
  }
  if (Boolean(file) === Boolean(values.verified)) throw Error(help);
  const source = json(values.verified ? verified : file);
  const records = Array.isArray(source) ? source : [source];
  const required = ["repo", "name", "version", "interfaceRef", "evidence"];
  for (const [i, row] of records.entries()) {
    if (!row || required.some((field) => typeof row[field] !== "string" || !row[field].trim()))
      throw Error("能力条目 " + (i + 1) + " 需要 " + required.join("、"));
  }
  const index = await request(base);
  const result = { registered: [], unassigned: [] };
  for (const item of records.filter(match)) {
    const owners = index.projects.filter(
      (p) =>
        p.repos.some((r) => r.toLowerCase() === item.repo.toLowerCase()) &&
        (!item.product || p.product === item.product) &&
        (!item.project || p.project === item.project),
    );
    if (owners.length !== 1) {
      result.unassigned.push({
        repo: item.repo,
        name: item.name,
        reason: owners.length ? "请在输入中指定维护方 product、project" : "请先将仓库关联到维护方项目",
      });
      continue;
    }
    const { repo, name, version, interfaceRef, evidence } = item;
    const owner = owners[0];
    result.registered.push(
      await request(base, {
        repo,
        name,
        version,
        interfaceRef,
        evidence,
        product: owner.product,
        project: owner.project,
      }),
    );
  }
  return result;
}
