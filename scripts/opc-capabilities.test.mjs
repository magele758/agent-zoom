import test from "node:test";
import assert from "node:assert/strict";
import { runCapabilities } from "./opc-capabilities.mjs";

test("公开仓库检索直接使用 GitHub，本地服务离线也能查", async () => {
  const result = await runCapabilities(
    ["discover", "chrome", "--owner", "magele758"],
    () => assert.fail("unexpected request"),
    async (bin, args) => {
      assert.equal(bin, "gh");
      assert.deepEqual(args.slice(-2), ["--", "chrome"]);
      return {
        stdout: JSON.stringify([
          { fullName: "magele758/tool", visibility: "public" },
          { fullName: "elsewhere/tool", visibility: "public" },
          { fullName: "magele758/private", visibility: "private" },
        ]),
      };
    },
  );
  assert.deepEqual(
    result.repositories.map((r) => r.fullName),
    ["magele758/tool"],
  );
});

test("登记核对过的能力只会采用已关联的维护项目，重复操作使用同一份版本资料", async () => {
  const writes = [];
  const request = async (path, value) => {
    assert.equal(path, "/api/opc/capabilities");
    if (value) {
      writes.push(value);
      return { ...value, id: "registry-id" };
    }
    return {
      projects: [{ product: "ChromeGate", project: "gateway", repos: ["magele758/chromegate-gateway"] }],
      capabilities: [],
      requests: [],
    };
  };
  const first = await runCapabilities(["import", "--verified"], request);
  const second = await runCapabilities(
    ["import", "--verified", "--repo", "MAGELE758/CHROMEGATE-GATEWAY"],
    request,
  );
  assert.deepEqual(first.registered, second.registered);
  assert.equal(first.unassigned.length, 5);
  assert.equal(second.unassigned.length, 0);
  assert.deepEqual(writes[0], writes[1]);
  assert.ok(writes[0].evidence.includes(writes[0].version));
});

test("发起方按原需求读取修订、批准和反馈", async () => {
  const result = await runCapabilities(["show", "abc"], async (path, payload) => {
    assert.equal(path, "/api/opc/capabilities/requests/abc");
    assert.equal(payload, undefined);
    return { revisions: [{ revision: 1, status: "changes", feedback: "给出验收样例" }] };
  });
  assert.equal(result.revisions[0].feedback, "给出验收样例");
});

test("查已有接口只取版本，按指定仓库筛选", async () => {
  const result = await runCapabilities(["list", "--repo", "ACME/picker"], async (path) => {
    assert.equal(path, "/api/opc/capabilities/versions");
    return {
      capabilities: [
        { repo: "acme/picker", version: "v1.2" },
        { repo: "acme/gateway", version: "v3" },
      ],
    };
  });
  assert.deepEqual(result.capabilities, [{ repo: "acme/picker", version: "v1.2" }]);
});
